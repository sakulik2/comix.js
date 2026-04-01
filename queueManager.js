import PQueue from 'p-queue';
import { extractComic } from './extractor.js';
import path from 'path';

// 实例化任务队列，限制并发数为 2，保护 CPU
const queue = new PQueue({ concurrency: 2 });

// 用于存储正在排队中的 comicId，防止重复入队
const pendingTasks = new Set();

/**
 * 将漫画解压任务推入队列
 * @param {string} comicId 漫画 ID
 * @param {string} rawFilePath 原始文件物理路径 (位于 /library/raw/)
 * @param {string} cacheBaseDir 缓存根目录 (位于 /library/cache/)
 */
export function addBookToQueue(comicId, rawFilePath, cacheBaseDir) {
    // 如果该任务已在队列中或正在解压，则跳过
    if (pendingTasks.has(comicId)) {
        console.log(`[Queue] 任务已在队列中: ${comicId}`);
        return;
    }

    const cacheDir = path.join(cacheBaseDir, `comic_${comicId}`);
    
    // 将任务推入队列，不阻塞主线程
    queue.add(async () => {
        pendingTasks.add(comicId);
        console.log(`[Queue] 开始解压任务: ${comicId}`);
        
        try {
            await extractComic(rawFilePath, cacheDir);
            console.log(`[Queue] 解压任务完成: ${comicId}`);
        } catch (error) {
            console.error(`[Queue] 解压任务失败: ${comicId}`, error);
        } finally {
            pendingTasks.delete(comicId);
        }
    });

    console.log(`[Queue] 任务已成功加入队列: ${comicId}`);
}
