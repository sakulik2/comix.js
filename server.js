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

    const list = await Promise.all(Object.keys(mapping).map(async (id) => {
        const index = await getIndex(id);
        
        // 尝试读取本地已提取好的元数据
        let localMeta = {};
        const metaPath = path.join(config.CACHE_LIBRARY_PATH, `comic_${id}`, 'metadata.json');
        try { 
            if (await fs.pathExists(metaPath)) {
                localMeta = await fs.readJson(metaPath); 
            }
        } catch (e) {}

        return {
            id,
            originalName: mapping[id],
            coverUrl: `/api/comics/${id}/page/1`,
            isReady: index !== null,
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

    const list = await Promise.all(Object.keys(mapping).map(async (id) => {
        const index = await getIndex(id);
        
        let localMeta = {};
        const metaPath = path.join(config.CACHE_LIBRARY_PATH, `comic_${id}`, 'metadata.json');
        try { 
            if (await fs.pathExists(metaPath)) {
                localMeta = await fs.readJson(metaPath); 
            }
        } catch (e) {}

        return {
            id,
            originalName: mapping[id],
            coverUrl: `/api/comics/${id}/page/1`,
            isReady: index !== null,
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

    const filename = mapping[comicId];
    if (!filename) {
        return res.status(404).json({ error: '未找到该 ID 映射' });
    }

    const index = await getIndex(comicId);
    
    // 尝试读取该漫画的专属元数据
    let localMeta = {};
    const metaPath = path.join(config.CACHE_LIBRARY_PATH, `comic_${comicId}`, 'metadata.json');
    try { 
        if (await fs.pathExists(metaPath)) {
            localMeta = await fs.readJson(metaPath); 
        }
    } catch (e) {}

    res.json({
        id: comicId,
        originalName: filename,
        coverUrl: `/api/comics/${comicId}/page/1`,
        totalPages: index ? index.length : 0,
        isReady: index !== null,
        status: index !== null ? 'ready' : 'processing',
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

    const index = await getIndex(comicId);

    if (!index) {
        const mapping = await getMapping();
        const filename = mapping[comicId];

        if (!filename) {
            return res.status(404).json({ error: '未找到 ID 映射' });
        }

        const rawFilePath = path.join(config.RAW_LIBRARY_PATH, filename);
        if (!(await fs.pathExists(rawFilePath))) {
            return res.status(404).json({ error: '物理文件不存在' });
        }

        addBookToQueue(comicId, rawFilePath, config.CACHE_LIBRARY_PATH);
        return res.status(202).json({ status: 'processing', message: '正在启动后台解压...' });
    }

    const imageFile = index[pageNumber - 1];
    if (!imageFile) {
        return res.status(404).json({ error: '页码越界' });
    }

    const imagePath = path.resolve(config.CACHE_LIBRARY_PATH, `comic_${comicId}`, imageFile);
    
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
        res.sendFile(imagePath);
    }
});

app.listen(PORT, async () => {
    console.log(`[Server] 服务已启动: http://localhost:${PORT}`);
    if (config.AUTO_SCAN_ON_STARTUP) {
        console.log('[Server] 正在执行启动自扫...');
        await runActiveScan();
        // 扫描完成后失效 mapping 缓存，确保新发现的漫画立即可见
        mappingCache = null;
    }
});
