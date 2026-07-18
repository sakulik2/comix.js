import { config } from './config.js';
import { runActiveScan } from './scanner.js';
import { addBookToQueue } from './queueManager.js';
import express from 'express';
import cors from 'cors';
import fs from 'fs-extra';
import path from 'path';
import sharp from 'sharp';

const app = express();
app.use(cors()); // 允许跨域请求，方便 Android 客户端或 Web 端调用

// 控制页面请求日志频率的内存 Map (Key: IP-comicId, Value: lastLoggedTime)
const lastPageLogTimeMap = new Map();

// 请求日志中间件：记录请求类型、路径、状态码、处理耗时、来源 IP 及客户端 User-Agent（限频图片页请求）
app.use((req, res, next) => {
    const start = Date.now();
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'] || 'Unknown';

    res.on('finish', () => {
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
    } catch (e) {}
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
 * 根路径状态检查
 */
app.get('/', (_req, res) => {
    res.json({
        service: "Sakulik Comix Streaming Service",
        status: "Running",
        apiVersion: "1.2.0 (Metadata Enhanced)"
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
