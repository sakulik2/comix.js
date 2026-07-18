import fs from 'fs-extra';
import path from 'path';
import { config } from './config.js';

async function main() {
    const comicId = process.argv[2];
    if (!comicId) {
        console.error('用法: node deleter.js <漫画ID>');
        process.exit(1);
    }

    const PORT = config.PORT || 3000;
    const API_KEY = config.API_KEY || '';
    const url = `http://127.0.0.1:${PORT}/api/comics/${comicId}`;

    console.log(`[Deleter] 优先尝试通过 HTTP API 向正在运行的 Express 服务发送删除指令...`);
    try {
        const headers = {};
        if (API_KEY) {
            headers['x-comix-token'] = API_KEY;
        }

        // 使用 Node.js 18+ 内置 fetch
        const response = await fetch(url, {
            method: 'DELETE',
            headers: headers
        });

        if (response.ok) {
            const data = await response.json();
            console.log(`[Deleter] 接口响应成功: ${data.message}`);
            console.log(`🎉 远程一键物理删除成功！运行中的服务已即时清除内存缓存，App 可立即刷新同步。`);
            process.exit(0);
        } else {
            const errData = await response.json().catch(() => ({}));
            console.warn(`[Deleter] 接口返回失败状态码 (${response.status}): ${errData.error || '未知错误'}`);
            console.log(`[Deleter] 将尝试通过本地文件系统强制删除...`);
        }
    } catch (e) {
        console.log(`[Deleter] 无法连接到本地 HTTP 服务（端口: ${PORT}，原因: ${e.message}）。已自动回落到文件系统物理删除...`);
    }

    // --- 本地物理删除回落逻辑 ---
    const MAPPING_FILE = config.MAPPING_FILE;
    let mapping = {};
    try {
        mapping = await fs.readJson(MAPPING_FILE);
    } catch (e) {
        console.error('读取映射表失败:', e.message);
        process.exit(1);
    }

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
        console.error(`错误: 未找到 ID / 编号 为 [${comicId}] 的漫画映射`);
        process.exit(1);
    }

    try {
        // 1. 删除原始物理文件
        const rawFilePath = path.join(config.RAW_LIBRARY_PATH, filename);
        if (await fs.pathExists(rawFilePath)) {
            await fs.remove(rawFilePath);
            console.log(`[Deleter] 已物理删除原始文件: ${rawFilePath}`);
        } else {
            console.log(`[Deleter] 提示: 物理原始文件不存在: ${rawFilePath}`);
        }

        // 2. 删除缓存文件夹
        const cacheDir = path.join(config.CACHE_LIBRARY_PATH, `comic_${actualId}`);
        if (await fs.pathExists(cacheDir)) {
            await fs.remove(cacheDir);
            console.log(`[Deleter] 已清理缓存文件夹: ${cacheDir}`);
        } else {
            console.log(`[Deleter] 提示: 缓存文件夹不存在: ${cacheDir}`);
        }

        // 3. 更新 mapping 映射并保存
        delete mapping[actualId];
        await fs.writeJson(MAPPING_FILE, mapping, { spaces: 2 });
        console.log(`[Deleter] 映射表已更新，ID [${actualId}] 已安全移除。`);

        console.log('\n🎉 本地删除完成！请注意：如果 Express 服务正在后台运行，您稍后需要向 /api/scan 发送 POST 请求以同步刷新其内存缓存。');
    } catch (e) {
        console.error('本地删除过程中发生错误:', e);
    }
}

main();
