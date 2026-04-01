import { config } from './config.js';
import { runActiveScan } from './scanner.js';
import { addBookToQueue } from './queueManager.js';
import express from 'express';
import cors from 'cors';
import fs from 'fs-extra';
import path from 'path';

const app = express();
app.use(cors()); // 允许跨域请求，方便 Android 客户端或 Web 端调用
const PORT = config.PORT;

/**
 * 根路径状态检查
 */
app.get('/', (req, res) => {
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
app.get('/api/comics', async (req, res) => {
    const MAPPING_FILE = './mapping.json';
    let mapping = {};
    try { mapping = await fs.readJson(MAPPING_FILE); } catch (e) { }

    const list = await Promise.all(Object.keys(mapping).map(async (id) => {
        const comicCacheDir = path.join(config.CACHE_LIBRARY_PATH, `comic_${id}`);
        const indexPath = path.join(comicCacheDir, 'index.json');
        const isReady = await fs.pathExists(indexPath);

        let totalPages = 0;
        if (isReady) {
            try {
                const index = await fs.readJson(indexPath);
                totalPages = index.length;
            } catch (e) { }
        }

        return {
            id,
            originalName: mapping[id], // 完整的原始文件名
            coverUrl: `/api/comics/${id}/page/1`,
            isReady,
            totalPages
        };
    }));

    res.json(list);
});

/**
 * 漫画元数据详细展示
 * GET /api/comics/:id
 */
app.get('/api/comics/:id', async (req, res) => {
    const comicId = req.params.id;

    const MAPPING_FILE = './mapping.json';
    let mapping = {};
    try { mapping = await fs.readJson(MAPPING_FILE); } catch (e) { }

    const filename = mapping[comicId];
    if (!filename) {
        return res.status(404).json({ error: '未找到该 ID 映射' });
    }

    const comicCacheDir = path.join(config.CACHE_LIBRARY_PATH, `comic_${comicId}`);
    const indexPath = path.join(comicCacheDir, 'index.json');
    const isReady = await fs.pathExists(indexPath);

    let totalPages = 0;
    if (isReady) {
        try {
            const index = await fs.readJson(indexPath);
            totalPages = index.length;
        } catch (e) { }
    }

    res.json({
        id: comicId,
        originalName: filename,
        coverUrl: `/api/comics/${comicId}/page/1`,
        totalPages: totalPages,
        isReady: isReady,
        status: isReady ? 'ready' : 'processing'
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

    const comicCacheDir = path.join(config.CACHE_LIBRARY_PATH, `comic_${comicId}`);
    const indexPath = path.join(comicCacheDir, 'index.json');
    const isReady = await fs.pathExists(indexPath);

    if (!isReady) {
        const MAPPING_FILE = './mapping.json';
        let mapping = {};
        try { mapping = await fs.readJson(MAPPING_FILE); } catch (e) { }
        const filename = mapping[comicId];

        if (!filename) {
            return res.status(404).json({ error: '未找到 ID 映射' });
        }

        const rawFilePath = path.join(config.RAW_LIBRARY_PATH, filename);
        if (!(await fs.pathExists(rawFilePath))) {
            return res.status(404).json({ error: '物理文件不存在' });
        }

        // 推入后台队列
        addBookToQueue(comicId, rawFilePath, config.CACHE_LIBRARY_PATH);
        return res.status(202).json({ status: 'processing', message: '正在启动后台解压...' });
    }

    try {
        const indexList = await fs.readJson(indexPath);
        const imageFile = indexList[pageNumber - 1];
        if (!imageFile) {
            return res.status(404).json({ error: '页码越界' });
        }
        const imagePath = path.resolve(comicCacheDir, imageFile);
        res.sendFile(imagePath);
    } catch (error) {
        res.status(500).json({ error: '服务端内部错误' });
    }
});

app.listen(PORT, async () => {
    console.log(`[Server] 服务已启动: http://localhost:${PORT}`);
    if (config.AUTO_SCAN_ON_STARTUP) {
        console.log('[Server] 正在执行启动自扫...');
        await runActiveScan();
    }
});
