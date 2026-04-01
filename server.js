import express from 'express';
import fs from 'fs-extra';
import path from 'path';
import { addBookToQueue } from './queueManager.js';

const app = express();
const PORT = process.env.PORT || 3000;

// 配置存放区路径 (可根据实际挂载点调整)
const RAW_LIBRARY_PATH = '/library/raw/';
const CACHE_LIBRARY_PATH = '/library/cache/';

/**
 * 极速页面访问 API
 * GET /api/comics/:id/page/:pageNumber (页码从 1 开始)
 */
app.get('/api/comics/:id/page/:pageNumber', async (req, res) => {
    const comicId = req.params.id;
    const pageNumber = parseInt(req.params.pageNumber, 10);

    // 参数校验
    if (isNaN(pageNumber) || pageNumber < 1) {
        return res.status(400).json({ error: '无效的页码' });
    }

    const comicCacheDir = path.join(CACHE_LIBRARY_PATH, `comic_${comicId}`);
    const indexPath = path.join(comicCacheDir, 'index.json');

    // 1. 检查索引文件是否存在 (指示解压是否已完成)
    const isReady = await fs.pathExists(indexPath);

    if (!isReady) {
        // 解压尚未完成，尝试将该书推入队列 (addBookToQueue 会执行幂等检查)
        // 注意：此处假设文件名可通过 ID 获取，您可以根据实际需求调整
        // 为演示场景，我们假设文件名为 "comic_{id}.cbr"（或 .cbz, .pdf）
        // 建议在生产环境中通过数据库查询实际物理路径
        
        // 动态查找支持的原始文件后缀
        const extensions = ['.cbr', '.rar', '.cbz', '.zip', '.pdf'];
        let rawFilePath = null;

        for (const ext of extensions) {
            const potentialPath = path.join(RAW_LIBRARY_PATH, `comic_${comicId}${ext}`);
            if (await fs.pathExists(potentialPath)) {
                rawFilePath = potentialPath;
                break;
            }
        }

        if (!rawFilePath) {
            return res.status(404).json({ error: '找不到对应的原始漫画文件' });
        }

        // 推入后台队列
        addBookToQueue(comicId, rawFilePath, CACHE_LIBRARY_PATH);

        // 返回 202 Accepted，提示正在处理中
        return res.status(202).json({
            status: 'processing',
            message: '漫画正在进行影子解压/转码中，请稍后刷新重试'
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

app.listen(PORT, () => {
    console.log(`[Server] 高性能漫画分发服务已启动在端口: ${PORT}`);
    console.log(`[Server] 原始库路径: ${RAW_LIBRARY_PATH}`);
    console.log(`[Server] 缓存库路径: ${CACHE_LIBRARY_PATH}`);
});
