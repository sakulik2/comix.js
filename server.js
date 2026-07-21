import { config, saveConfig } from './config.js';
import { runActiveScan } from './scanner.js';
import { addBookToQueue, queue, pendingTasks } from './queueManager.js';
import express from 'express';
import cors from 'cors';
import fs from 'fs-extra';
import path from 'path';
import sharp from 'sharp';
import crypto from 'crypto';

// --- 内存日志收集 (Ring Buffer, 限制最新 200 条，不落盘) ---
const LOG_LIMIT = 200;
const memoryLogs = [];

function addLogToMemory(message) {
    memoryLogs.push(message);
    if (memoryLogs.length > LOG_LIMIT) {
        memoryLogs.shift();
    }
}

const originalConsoleLog = console.log;
const originalConsoleError = console.error;

function getLogTimestamp() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `[${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}]`;
}

console.log = function (...args) {
    const formatted = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
    originalConsoleLog.apply(console, args);
    addLogToMemory(`${getLogTimestamp()} ${formatted}`);
};

console.error = function (...args) {
    const formatted = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
    originalConsoleError.apply(console, args);
    addLogToMemory(`${getLogTimestamp()} [ERROR] ${formatted}`);
};

const app = express();
app.use(cors()); // 允许跨域请求，方便 Android 客户端或 Web 端调用
app.use(express.json()); // 用于解析控制面板修改配置时的 JSON 载荷

// 重写 res.json，强制在返回的 JSON 串末尾追加换行符，以便在 curl 等终端下输出干净的换行
app.use((req, res, next) => {
    res.json = function (obj) {
        res.setHeader('Content-Type', 'application/json');
        const spaces = app.get('json spaces');
        const str = JSON.stringify(obj, null, spaces) + '\n';
        return res.send(str);
    };
    next();
});

// 控制页面请求日志频率的内存 Map (Key: IP-comicId, Value: lastLoggedTime)
const lastPageLogTimeMap = new Map();

// 请求日志中间件：记录请求类型、路径、状态码、处理耗时、来源 IP 及客户端 User-Agent（限频图片页请求）
app.use((req, res, next) => {
    const start = Date.now();
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'] || 'Unknown';

    res.on('finish', () => {
        // 过滤管理面板背景高频轮询的静默日志（当状态为 200 或 304 成功，且来自管理面板时，静默 /api/queue, /api/comics, /api/config, /api/logs）
        const isFromDashboard = req.headers['x-comix-client'] === 'dashboard';
        const pathOnly = req.originalUrl.split('?')[0];
        const isPollingUrl = pathOnly === '/api/queue' || pathOnly === '/api/comics' || pathOnly === '/api/config' || pathOnly === '/api/logs';
        if (isFromDashboard && isPollingUrl && (res.statusCode === 200 || res.statusCode === 304)) {
            return;
        }

        // 如果是高频的页面图片请求，进行频率限制（首包必报，之后每隔 5 分钟限制报一次）
        if (req.originalUrl.includes('/page/')) {
            const match = req.originalUrl.match(/\/api\/comics\/([^/]+)\/page/);
            if (match) {
                const comicId = match[1];
                const key = `${ip}-${comicId}`;
                const now = Date.now();
                const lastLogged = lastPageLogTimeMap.get(key) || 0;

                if (now - lastLogged > 5 * 60 * 1000) {
                    lastPageLogTimeMap.set(key, now);
                    const duration = Date.now() - start;
                    console.log(`[Server] ${req.method} ${req.originalUrl} - 状态: ${res.statusCode} (${duration}ms) | 来源: ${ip} | 客户端: ${userAgent} (已进入漫画阅读，后续5分钟该读者此类日志将静默)`);
                }
            }
            return;
        }
        const duration = Date.now() - start;
        console.log(`[Server] ${req.method} ${req.originalUrl} - 状态: ${res.statusCode} (${duration}ms) | 来源: ${ip} | 客户端: ${userAgent}`);
    });
    next();
});

const PORT = config.PORT;

// --- 内存缓存 ---

// mapping.json 缓存：null 表示未加载，加载后一直有效直到手动失效
let mappingCache = null;

async function getMapping() {
    if (mappingCache) return mappingCache;
    try { mappingCache = await fs.readJson(config.MAPPING_FILE); } catch (e) { mappingCache = {}; }
    return mappingCache;
}

// index.json 缓存：key = comicId, value = string[]
// 只缓存成功读取的结果（漫画已就绪）；未就绪时不缓存，确保下次重新检查
const indexCache = new Map();

async function getIndex(comicId) {
    if (indexCache.has(comicId)) return indexCache.get(comicId);
    const indexPath = path.join(config.CACHE_LIBRARY_PATH, `comic_${comicId}`, 'index.json');
    try {
        const index = await fs.readJson(indexPath);
        indexCache.set(comicId, index);
        return index;
    } catch (e) {
        return null; // 未就绪，不写入缓存
    }
}

// metadata.json 缓存：key = comicId, value = object
// 只缓存就绪状态的元数据，未就绪时不缓存，确保解压后能读取最新元数据
const metadataCache = new Map();

async function getMetadata(comicId, isReady) {
    if (metadataCache.has(comicId)) return metadataCache.get(comicId);
    const metaPath = path.join(config.CACHE_LIBRARY_PATH, `comic_${comicId}`, 'metadata.json');
    try {
        if (await fs.pathExists(metaPath)) {
            const meta = await fs.readJson(metaPath);
            if (isReady) {
                metadataCache.set(comicId, meta);
            }
            return meta;
        }
    } catch (e) { }
    return {};
}

function clearAllCaches() {
    mappingCache = null;
    indexCache.clear();
    metadataCache.clear();
}

// --- 安全鉴权中间件 ---
// 拦截所有以 /api 开头的请求
app.use('/api', (req, res, next) => {
    if (req.method === 'OPTIONS') return next(); // 放行 CORS 预检

    if (!config.API_KEY || config.API_KEY === '') return next(); // 未配置则不设防

    // 优先读取 HTTP Header，兼容 Query string 方式 (便于某些极简客户端或直链请求)
    const clientToken = req.headers['x-comix-token'] || req.query.token;

    if (clientToken === config.API_KEY) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized: Invalid or missing x-comix-token' });
    }
});

// --- 路由 ---

/**
 * 根路径：托管控制面板单页 HTML
 */
app.get('/', (_req, res) => {
    res.sendFile(path.resolve('dashboard.html'));
});

/**
 * 状态检查：搬迁至 /api 路由
 */
app.get('/api', (_req, res) => {
    res.json({
        service: "comix.js",
        status: "Running",
        apiVersion: "1.4.0"
    });
});

/**
 * 获取全量漫画列表 (书架模式)
 * GET /api/comics
 */
app.get('/api/comics', async (_req, res) => {
    const mapping = await getMapping();
    const keys = Object.keys(mapping);

    const list = await Promise.all(keys.map(async (id) => {
        const index = await getIndex(id);
        const isReady = index !== null;

        // 尝试读取本地已提取好的元数据（使用缓存）
        const localMeta = await getMetadata(id, isReady);
        const filename = mapping[id];
        const defaultTitle = filename.substring(0, filename.lastIndexOf('.')) || filename;
        const title = localMeta.title || defaultTitle;
        const numId = keys.indexOf(id) + 1;

        return {
            id,
            numId,
            title,
            originalName: filename,
            coverUrl: `/api/comics/${id}/page/1`,
            isReady,
            totalPages: index ? index.length : 0,
            ...localMeta
        };
    }));

    res.json(list);
});

/**
 * 后端元数据检索 (服务端模糊搜索)
 * GET /api/comics/search?q=keyword
 */
app.get('/api/comics/search', async (req, res) => {
    const query = (req.query.q || '').toLowerCase();
    const mapping = await getMapping();
    const keys = Object.keys(mapping);

    const list = await Promise.all(keys.map(async (id) => {
        const index = await getIndex(id);
        const isReady = index !== null;

        const localMeta = await getMetadata(id, isReady);
        const filename = mapping[id];
        const defaultTitle = filename.substring(0, filename.lastIndexOf('.')) || filename;
        const title = localMeta.title || defaultTitle;
        const numId = keys.indexOf(id) + 1;

        return {
            id,
            numId,
            title,
            originalName: filename,
            coverUrl: `/api/comics/${id}/page/1`,
            isReady,
            totalPages: index ? index.length : 0,
            ...localMeta
        };
    }));

    // 根据查询词在内存中过滤结果
    const filteredList = list.filter(comic => {
        const titleLower = (comic.title || '').toLowerCase();
        const originLower = (comic.originalName || '').toLowerCase();
        const authorLower = (comic.authors || '').toLowerCase();
        return titleLower.includes(query) || originLower.includes(query) || authorLower.includes(query);
    });

    res.json(filteredList);
});

/**
 * 漫画元数据详细展示
 * GET /api/comics/:id
 */
app.get('/api/comics/:id', async (req, res) => {
    const comicId = req.params.id;
    const mapping = await getMapping();

    let actualId = comicId;
    let filename = mapping[actualId];

    // 如果输入的是数字 ID，根据 1-based 索引解析出真实的 MD5 ID
    if (!filename && /^\d+$/.test(comicId)) {
        const keys = Object.keys(mapping);
        const index = parseInt(comicId, 10) - 1;
        if (index >= 0 && index < keys.length) {
            actualId = keys[index];
            filename = mapping[actualId];
        }
    }

    if (!filename) {
        return res.status(404).json({ error: '未找到该 ID 映射' });
    }

    const index = await getIndex(actualId);
    const isReady = index !== null;

    // 尝试读取该漫画的专属元数据（使用缓存）
    const localMeta = await getMetadata(actualId, isReady);
    const defaultTitle = filename.substring(0, filename.lastIndexOf('.')) || filename;
    const title = localMeta.title || defaultTitle;
    const numId = Object.keys(mapping).indexOf(actualId) + 1;

    res.json({
        id: actualId,
        numId,
        title,
        originalName: filename,
        coverUrl: `/api/comics/${actualId}/page/1`,
        totalPages: index ? index.length : 0,
        isReady,
        status: isReady ? 'ready' : 'processing',
        ...localMeta
    });
});

/**
 * 极速页面图片访问
 * GET /api/comics/:id/page/:pageNumber
 */
app.get('/api/comics/:id/page/:pageNumber', async (req, res) => {
    const comicId = req.params.id;
    const pageNumber = parseInt(req.params.pageNumber, 10);

    if (isNaN(pageNumber) || pageNumber < 1) {
        return res.status(400).json({ error: '无效的页码' });
    }

    const mapping = await getMapping();
    let actualId = comicId;
    let filename = mapping[actualId];

    // 如果输入的是数字 ID，根据 1-based 索引解析出真实的 MD5 ID
    if (!filename && /^\d+$/.test(comicId)) {
        const keys = Object.keys(mapping);
        const indexKey = parseInt(comicId, 10) - 1;
        if (indexKey >= 0 && indexKey < keys.length) {
            actualId = keys[indexKey];
            filename = mapping[actualId];
        }
    }

    if (!filename) {
        return res.status(404).json({ error: '未找到 ID 映射' });
    }

    const index = await getIndex(actualId);

    if (!index) {
        const rawFilePath = path.join(config.RAW_LIBRARY_PATH, filename);
        if (!(await fs.pathExists(rawFilePath))) {
            return res.status(404).json({ error: '物理文件不存在' });
        }

        addBookToQueue(actualId, rawFilePath, config.CACHE_LIBRARY_PATH);
        return res.status(202).json({ status: 'processing', message: '正在启动后台解压...' });
    }

    const imageFile = index[pageNumber - 1];
    if (!imageFile) {
        return res.status(404).json({ error: '页码越界' });
    }

    const imagePath = path.resolve(config.CACHE_LIBRARY_PATH, `comic_${actualId}`, imageFile);

    // 支持按需缩放，利用 sharp 将内存计算压力下放到请求时，解约磁盘空间
    const targetWidth = parseInt(req.query.width, 10);

    // 追加 HTTP 缓存强控制，减轻服务端压力
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable'); // 强制缓存 1 星期

    if (!isNaN(targetWidth) && targetWidth > 0 && targetWidth < 4000) {
        res.type('image/webp');
        // 将源图片通过 sharp 管道流式吐给客户端，不产生临时文件
        sharp(imagePath)
            .resize({ width: targetWidth, withoutEnlargement: true })
            .webp({ quality: parseInt(req.query.quality, 10) || 85 })
            .pipe(res)
            .on('error', (e) => {
                if (!res.headersSent) res.status(500).json({ error: '原图处理失败' });
                console.error("[Server] 缩放流崩溃", e);
            });
    } else {
        // 无缩放要求或参数非法则直出原文件
        res.sendFile(imagePath, (err) => {
            if (err) {
                // 过滤客户端主动断开连接引起的 ECONNABORTED 错误，避免日志泛滥
                if (err.code === 'ECONNABORTED' || err.message === 'Request aborted') {
                    return;
                }
                console.error("[Server] 发送文件失败:", err);
                if (!res.headersSent) {
                    res.status(500).json({ error: "读取页面图片失败" });
                }
            }
        });
    }
});

/**
 * 手动触发全库扫描并清除缓存
 * POST /api/scan
 */
app.post('/api/scan', async (req, res) => {
    try {
        console.log('[Server] 收到手动扫描请求...');
        await runActiveScan();
        clearAllCaches();
        res.json({ status: 'success', message: '全库扫描完成，缓存已刷新' });
    } catch (e) {
        console.error('[Server] 扫描异常:', e);
        res.status(500).json({ error: '扫描库失败: ' + e.message });
    }
});

/**
 * 触发所有已映射漫画的缓存重建 (重处理)
 * POST /api/comics/reprocess
 */
app.post('/api/comics/reprocess', async (req, res) => {
    try {
        console.log('[Server] 收到全库重建缓存请求...');
        const mapping = await getMapping();
        const keys = Object.keys(mapping);
        let count = 0;

        for (const id of keys) {
            const filename = mapping[id];
            const cacheDir = path.join(config.CACHE_LIBRARY_PATH, `comic_${id}`);
            if (await fs.pathExists(cacheDir)) {
                await fs.remove(cacheDir);
            }

            // 清除内存缓存
            indexCache.delete(id);
            metadataCache.delete(id);

            const rawFilePath = path.join(config.RAW_LIBRARY_PATH, filename);
            if (await fs.pathExists(rawFilePath)) {
                addBookToQueue(id, rawFilePath, config.CACHE_LIBRARY_PATH);
                count++;
            }
        }

        console.log(`[Server] 已触发全库 ${count} 本漫画的缓存重建`);
        res.json({ status: 'success', message: `已清空全库共计 ${count} 本漫画的缓存，并已全部重新推入后台解压队列` });
    } catch (e) {
        console.error('[Server] 全库缓存重建失败:', e);
        res.status(500).json({ error: '全库缓存重建失败: ' + e.message });
    }
});

/**
 * 触发指定漫画的缓存重建 (重处理)
 * POST /api/comics/:id/reprocess
 */
app.post('/api/comics/:id/reprocess', async (req, res) => {
    const comicId = req.params.id;
    const mapping = await getMapping();

    let actualId = comicId;
    let filename = mapping[actualId];

    // 如果输入的是数字 ID，根据 1-based 索引解析出真实的 MD5 ID
    if (!filename && /^\d+$/.test(comicId)) {
        const keys = Object.keys(mapping);
        const index = parseInt(comicId, 10) - 1;
        if (index >= 0 && index < keys.length) {
            actualId = keys[index];
            filename = mapping[actualId];
        }
    }

    if (!filename) {
        return res.status(404).json({ error: '未找到该 ID 映射' });
    }

    try {
        console.log(`[Server] 收到漫画缓存重建请求: ${filename} (ID: ${actualId})...`);
        const cacheDir = path.join(config.CACHE_LIBRARY_PATH, `comic_${actualId}`);
        if (await fs.pathExists(cacheDir)) {
            await fs.remove(cacheDir);
        }

        // 清除内存缓存
        indexCache.delete(actualId);
        metadataCache.delete(actualId);

        const rawFilePath = path.join(config.RAW_LIBRARY_PATH, filename);
        if (!(await fs.pathExists(rawFilePath))) {
            return res.status(404).json({ error: '物理文件不存在，无法重建缓存' });
        }

        addBookToQueue(actualId, rawFilePath, config.CACHE_LIBRARY_PATH);

        console.log(`[Server] 已成功触发漫画重建并入队: ${filename} (ID: ${actualId})`);
        res.json({ status: 'success', message: `漫画 ${filename} 的缓存已成功清空并重新推入解压队列` });
    } catch (e) {
        console.error(`[Server] 重建漫画 [${actualId}] 缓存失败:`, e);
        res.status(500).json({ error: '重建缓存失败: ' + e.message });
    }
});

/**
 * 物理删除特定漫画文件及解压缓存，并自动同步映射与缓存
 * DELETE /api/comics/:id
 */
app.delete('/api/comics/:id', async (req, res) => {
    const comicId = req.params.id;
    const mapping = await getMapping();

    let actualId = comicId;
    let filename = mapping[actualId];

    // 如果输入的是数字 ID，根据 1-based 索引解析出真实的 MD5 ID
    if (!filename && /^\d+$/.test(comicId)) {
        const keys = Object.keys(mapping);
        const index = parseInt(comicId, 10) - 1;
        if (index >= 0 && index < keys.length) {
            actualId = keys[index];
            filename = mapping[actualId];
        }
    }

    if (!filename) {
        return res.status(404).json({ error: '未找到该 ID 映射' });
    }

    try {
        // 1. 删除原始物理文件
        const rawFilePath = path.join(config.RAW_LIBRARY_PATH, filename);
        if (await fs.pathExists(rawFilePath)) {
            await fs.remove(rawFilePath);
        }

        // 2. 删除缓存文件夹
        const cacheDir = path.join(config.CACHE_LIBRARY_PATH, `comic_${actualId}`);
        if (await fs.pathExists(cacheDir)) {
            await fs.remove(cacheDir);
        }

        // 3. 更新 mapping 映射并保存
        delete mapping[actualId];
        await fs.writeJson(config.MAPPING_FILE, mapping, { spaces: 2 });

        // 4. 清除内存缓存
        clearAllCaches();

        console.log(`[Server] 已通过 API 物理删除远程漫画: ${filename} (ID: ${actualId})`);
        res.json({ status: 'success', message: `远程文件 ${filename} 及其缓存已成功删除` });
    } catch (e) {
        console.error(`[Server] 删除远程漫画失败:`, e);
        res.status(500).json({ error: `删除失败: ${e.message}` });
    }
});

/**
 * 修改并保存指定漫画的元数据
 * POST /api/comics/:id/metadata
 */
app.post('/api/comics/:id/metadata', async (req, res) => {
    const comicId = req.params.id;
    const mapping = await getMapping();

    let actualId = comicId;
    let filename = mapping[actualId];

    if (!filename && /^\d+$/.test(comicId)) {
        const keys = Object.keys(mapping);
        const index = parseInt(comicId, 10) - 1;
        if (index >= 0 && index < keys.length) {
            actualId = keys[index];
            filename = mapping[actualId];
        }
    }

    if (!filename) {
        return res.status(404).json({ error: '未找到该 ID 映射' });
    }

    const cacheDir = path.join(config.CACHE_LIBRARY_PATH, `comic_${actualId}`);
    try {
        await fs.ensureDir(cacheDir);
        const metaPath = path.join(cacheDir, 'metadata.json');
        
        let existingMeta = {};
        if (await fs.pathExists(metaPath)) {
            try {
                existingMeta = await fs.readJson(metaPath);
            } catch (e) {}
        }

        const newMeta = req.body;
        const updatedMeta = {
            ...existingMeta,
            title: newMeta.title !== undefined ? String(newMeta.title) : (existingMeta.title || filename.substring(0, filename.lastIndexOf('.')) || filename),
            authors: newMeta.authors !== undefined ? String(newMeta.authors) : (existingMeta.authors || ''),
            summary: newMeta.summary !== undefined ? String(newMeta.summary) : (existingMeta.summary || ''),
            genres: newMeta.genres !== undefined ? String(newMeta.genres) : (existingMeta.genres || ''),
            publisher: newMeta.publisher !== undefined ? String(newMeta.publisher) : (existingMeta.publisher || ''),
            year: newMeta.year !== undefined ? String(newMeta.year) : (existingMeta.year || ''),
            rating: newMeta.rating !== undefined ? parseFloat(newMeta.rating) : (existingMeta.rating || null),
            isCompleted: newMeta.isCompleted !== undefined ? !!newMeta.isCompleted : (existingMeta.isCompleted || false)
        };

        await fs.writeJson(metaPath, updatedMeta, { spaces: 2 });
        metadataCache.delete(actualId);

        console.log(`[Server] 漫画 ${filename} (ID: ${actualId}) 元数据已保存并更新:`, updatedMeta);
        res.json({ status: 'success', message: '元数据保存成功！', metadata: updatedMeta });
    } catch (e) {
        console.error(`[Server] 保存漫画 ${actualId} 元数据失败:`, e);
        res.status(500).json({ error: '保存元数据失败: ' + e.message });
    }
});

/**
 * 获取系统当前可调节参数
 * GET /api/config
 */
app.get('/api/config', (req, res) => {
    res.json({
        rawLibraryPath: config.RAW_LIBRARY_PATH,
        cacheLibraryPath: config.CACHE_LIBRARY_PATH,
        mappingFile: config.MAPPING_FILE,
        supportedExtensions: config.SUPPORTED_EXTENSIONS,
        concurrency: config.CONCURRENCY,
        autoScanOnStartup: config.AUTO_SCAN_ON_STARTUP,
        optimizeImages: config.OPTIMIZE_IMAGES,
        optimizeConcurrency: config.OPTIMIZE_CONCURRENCY,
        optimizeMinFileSize: config.OPTIMIZE_MIN_FILE_SIZE,
        port: config.PORT,
        apiKey: config.API_KEY ? '******' : ''
    });
});

/**
 * 保存修改后的配置参数
 * POST /api/config
 */
app.post('/api/config', async (req, res) => {
    try {
        const newSettings = req.body;
        const updatePayload = {};
        
        if (newSettings.rawLibraryPath !== undefined) updatePayload.RAW_LIBRARY_PATH = String(newSettings.rawLibraryPath);
        if (newSettings.cacheLibraryPath !== undefined) updatePayload.CACHE_LIBRARY_PATH = String(newSettings.cacheLibraryPath);
        if (newSettings.mappingFile !== undefined) updatePayload.MAPPING_FILE = String(newSettings.mappingFile);
        
        if (newSettings.supportedExtensions !== undefined && Array.isArray(newSettings.supportedExtensions)) {
            updatePayload.SUPPORTED_EXTENSIONS = newSettings.supportedExtensions.map(String);
        }
        
        if (newSettings.concurrency !== undefined) updatePayload.CONCURRENCY = parseInt(newSettings.concurrency, 10) || 2;
        if (newSettings.autoScanOnStartup !== undefined) updatePayload.AUTO_SCAN_ON_STARTUP = !!newSettings.autoScanOnStartup;
        if (newSettings.optimizeImages !== undefined) updatePayload.OPTIMIZE_IMAGES = !!newSettings.optimizeImages;
        if (newSettings.optimizeConcurrency !== undefined) updatePayload.OPTIMIZE_CONCURRENCY = parseInt(newSettings.optimizeConcurrency, 10) || 2;
        if (newSettings.optimizeMinFileSize !== undefined) updatePayload.OPTIMIZE_MIN_FILE_SIZE = parseInt(newSettings.optimizeMinFileSize, 10) || 300 * 1024;
        if (newSettings.port !== undefined) updatePayload.PORT = parseInt(newSettings.port, 10) || 3000;
        
        if (newSettings.apiKey !== undefined && newSettings.apiKey !== '******') {
            updatePayload.API_KEY = String(newSettings.apiKey);
        }

        await saveConfig(updatePayload);
        console.log('[Server] 配置文件已更新并保存至 settings.json:', updatePayload);

        res.json({
            status: 'success',
            message: '配置保存成功！部分核心参数（如服务监听端口、存储路径等）需要重新启动服务后生效。'
        });
    } catch (e) {
        console.error('[Server] 保存配置失败:', e);
        res.status(500).json({ error: '保存配置失败: ' + e.message });
    }
});

/**
 * 获取后台解压队列实时状态
 * GET /api/queue
 */
app.get('/api/queue', (req, res) => {
    res.json({
        size: queue.size,
        pendingCount: queue.pending,
        pendingTasks: Array.from(pendingTasks)
    });
});

/**
 * 简易文件上传接口
 * POST /api/upload?filename=xxx
 * 请求体为漫画文件的原始二进制流 (Content-Type: application/octet-stream)
 */
app.post('/api/upload', async (req, res) => {
    // 校验 Token（如果配置了 API_KEY）
    if (config.API_KEY) {
        const token = req.headers['x-comix-token'];
        if (token !== config.API_KEY) {
            return res.status(401).json({ error: 'Unauthorized: Invalid token' });
        }
    }

    const filename = req.query.filename;
    if (!filename) {
        return res.status(400).json({ error: '缺少 filename 参数，请在 URL 中提供 ?filename=xxx' });
    }

    // 只允许常见的漫画压缩包或 PDF 格式
    const ext = path.extname(filename).toLowerCase();
    if (!['.zip', '.cbz', '.rar', '.cbr', '.pdf'].includes(ext)) {
        return res.status(400).json({ error: '不支持的文件类型，仅限 zip, cbz, rar, cbr, pdf' });
    }

    const targetPath = path.join(config.RAW_LIBRARY_PATH, filename);
    
    // 确保 RAW_LIBRARY_PATH 存在
    await fs.ensureDir(config.RAW_LIBRARY_PATH);

    // 如果文件已存在，为防止覆盖，重命名文件 (如 file(1).cbz)
    let finalPath = targetPath;
    let finalFilename = filename;
    let counter = 1;
    while (await fs.pathExists(finalPath)) {
        const base = path.basename(filename, ext);
        finalFilename = `${base}(${counter})${ext}`;
        finalPath = path.join(config.RAW_LIBRARY_PATH, finalFilename);
        counter++;
    }

    try {
        console.log(`[Server] 开始接收上传文件: ${finalFilename}...`);
        const writeStream = fs.createWriteStream(finalPath);
        
        req.pipe(writeStream);

        await new Promise((resolve, reject) => {
            writeStream.on('finish', resolve);
            req.on('error', reject);
            writeStream.on('error', reject);
        });

        console.log(`[Server] 文件上传并保存成功: ${finalFilename}`);

        // 为该书文件名计算 MD5 作为唯一 ID
        const fileMd5 = crypto.createHash('md5').update(finalFilename).digest('hex');
        
        // 更新 mapping.json
        const mapping = await getMapping();
        mapping[fileMd5] = finalFilename;
        await fs.writeJson(config.MAPPING_FILE, mapping, { spaces: 2 });

        // 清空映射内存缓存
        mappingCache = null;

        // 加入后台解压解密优化队列
        addBookToQueue(fileMd5, finalPath, config.CACHE_LIBRARY_PATH);

        res.json({
            status: 'success',
            message: `文件 ${finalFilename} 上传成功，并已推入后台处理队列`,
            id: fileMd5
        });
    } catch (err) {
        console.error('[Server] 上传保存失败:', err);
        // 如果出错，清理未写完的文件
        try {
            if (await fs.pathExists(finalPath)) {
                await fs.remove(finalPath);
            }
        } catch (e) {}
        res.status(500).json({ error: '上传保存失败: ' + err.message });
    }
});

/**
 * 获取内存中的最新系统日志 (不落盘)
 * GET /api/logs
 */
app.get('/api/logs', (req, res) => {
    // 校验 Token（如果配置了 API_KEY）
    if (config.API_KEY) {
        const token = req.headers['x-comix-token'];
        if (token !== config.API_KEY) {
            return res.status(401).json({ error: 'Unauthorized: Invalid token' });
        }
    }
    res.json({ logs: memoryLogs });
});

app.listen(PORT, async () => {
    console.log(`[Server] 服务已启动: http://localhost:${PORT}`);

    // 自动确保目录存在，防止因不存在抛出 ENOENT 错误
    try {
        await fs.ensureDir(config.RAW_LIBRARY_PATH);
        await fs.ensureDir(config.CACHE_LIBRARY_PATH);
    } catch (e) {
        console.error('[Server] 初始化目录失败:', e);
    }

    if (config.AUTO_SCAN_ON_STARTUP) {
        console.log('[Server] 正在执行启动自扫...');
        await runActiveScan();
        // 扫描完成后失效所有缓存，确保最新数据立即可见
        clearAllCaches();
    }
});
