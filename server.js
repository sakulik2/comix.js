import { config } from './config.js';
import { runActiveScan } from './scanner.js';
import { addBookToQueue } from './queueManager.js';
import express from 'express';
import fs from 'fs-extra';
import path from 'path';


const app = express();
const PORT = config.PORT;

/**
 * 极速页面访问 API (路由逻辑保持不变，路径由 config 管理)
 */
app.get('/api/comics/:id/page/:pageNumber', async (req, res) => {
    const comicId = req.params.id;
    const pageNumber = parseInt(req.params.pageNumber, 10);

    // 参数校验
    if (isNaN(pageNumber) || pageNumber < 1) {
        return res.status(400).json({ error: '无效的页码' });
    }

    const comicCacheDir = path.join(config.CACHE_LIBRARY_PATH, `comic_${comicId}`);
    const indexPath = path.join(comicCacheDir, 'index.json');

    // 1. 检查索引文件是否存在 (指示解压是否已完成)
    const isReady = await fs.pathExists(indexPath);

    if (!isReady) {
        // 2. 加载映射表进行查找
        const MAPPING_FILE = './mapping.json';
        let mapping = {};
        try { mapping = await fs.readJson(MAPPING_FILE); } catch (e) { }

        const filename = mapping[comicId];

        if (!filename) {
            return res.status(404).json({
                error: '未找到该 ID 关联的漫画文件',
                details: '请运行 npm run scan 自动生成映射，或使用 node mapper.js 手动绑定'
            });
        }

        const rawFilePath = path.join(config.RAW_LIBRARY_PATH, filename);

        if (!(await fs.pathExists(rawFilePath))) {
            return res.status(404).json({ error: '映射指向的物理文件不存在' });
        }

        // 推入后台队列
        addBookToQueue(comicId, rawFilePath, config.CACHE_LIBRARY_PATH);

        // 返回 202 Accepted
        return res.status(202).json({
            status: 'processing',
            message: '发现关联文件，正在启动影子解压/转码...'
        });
    }

    // 2. 读取索引并返回图片
    try {
        const indexList = await fs.readJson(indexPath);

        // 页码转为 0 索引
        const imageFile = indexList[pageNumber - 1];

        if (!imageFile) {
            return res.status(404).json({ error: '请求的页码超出范围' });
        }

        const imagePath = path.resolve(comicCacheDir, imageFile);

        // 使用 Express 的 res.sendFile()
        // 高级性能支持：
        // - 自动设置 Content-Type
        // - 支持 HTTP Range Requests (用于流媒体分段请求)
        // - 自动处理 ETag, Last-Modified 缓存协议
        res.sendFile(imagePath, (err) => {
            if (err) {
                console.error(`[Server] 发送文件出错: ${imagePath}`, err);
                if (!res.headersSent) {
                    res.status(500).json({ error: '读取文件异常' });
                }
            }
        });

    } catch (error) {
        console.error(`[Server] 读取索引失败: ${comicId}`, error);
        res.status(500).json({ error: '系统内部错误' });
    }
});

app.listen(PORT, async () => {
    console.log(`[Server] 高性能漫画分发服务已启动: http://localhost:${PORT}`);

    // 如果配置了启动自扫，则执行主动扫描
    if (config.AUTO_SCAN_ON_STARTUP) {
        console.log('[Server] 检测到开启了启动自扫，正在同步库物理状态...');
        await runActiveScan();
    }
});
