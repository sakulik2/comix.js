import fs from 'fs-extra';
import path from 'path';
import { config } from './config.js';
import { addBookToQueue } from './queueManager.js';
import {
    createComicId,
    resolveComicCacheDirectory,
    resolveLibraryFile,
    validateComicId
} from './resourcePolicy.js';

/**
 * 执行一次库内全量扫描，识别并自动映射未绑定的漫画文件
 */
export async function runActiveScan() {
    console.log(`[Scanner] 开始扫描物理库: ${config.RAW_LIBRARY_PATH}`);
    
    try {
        await fs.ensureDir(config.RAW_LIBRARY_PATH);
        const files = await fs.readdir(config.RAW_LIBRARY_PATH);
        const MAPPING_FILE = config.MAPPING_FILE;
        
        // 加载现有映射，用于去重和自动补全
        let mapping = {};
        try { mapping = await fs.readJson(MAPPING_FILE); } catch(e) {}
        
        let discoveryCount = 0;
        let mappingUpdateCount = 0;

        for (const file of files) {
            const ext = path.extname(file).toLowerCase();
            
            // 过滤支持的后缀
            if (config.SUPPORTED_EXTENSIONS.includes(ext)) {
                discoveryCount++;

                // 1. 自动生成 ID 映射逻辑
                // 旧映射可能包含路径字符等非法 ID；忽略单条坏数据，并为文件补一个安全 ID。
                let currentId = Object.keys(mapping).find((key) => {
                    if (mapping[key] !== file) return false;
                    try {
                        validateComicId(key);
                        return true;
                    } catch {
                        return false;
                    }
                });
                if (!currentId) {
                    const defaultId = createComicId(file, ext, mapping);

                    mapping[defaultId] = file;
                    currentId = defaultId;
                    mappingUpdateCount++;
                    console.log(`[Scanner] 发现未映射新书: ${file} -> 自动生成 ID: ${defaultId}`);
                }

                // 2. 解压任务排队逻辑 (通过 ID 查找)
                try {
                    const rawPath = resolveLibraryFile(config.RAW_LIBRARY_PATH, file);
                    const indexPath = path.join(
                        resolveComicCacheDirectory(config.CACHE_LIBRARY_PATH, currentId),
                        'index.json'
                    );

                    const isCached = await fs.pathExists(indexPath);
                    if (!isCached) {
                        addBookToQueue(currentId, rawPath, config.CACHE_LIBRARY_PATH);
                    }
                } catch (error) {
                    console.warn(`[Scanner] 跳过无法安全处理的文件 ${file}: ${error.message}`);
                }
            }
        }

        // 统一保存映射表
        if (mappingUpdateCount > 0) {
            await fs.writeJson(MAPPING_FILE, mapping, { spaces: 2 });
            console.log(`[Scanner] 映射列表已更新，新增 ${mappingUpdateCount} 条数据。`);
        }

        console.log(`[Scanner] 扫描完成。总计发现 ${discoveryCount} 本书。`);
    } catch (error) {
        console.error(`[Scanner] 扫描过程错误:`, error);
    }
}

// 支持 CLI 手动调用支持： node scanner.js --run / --reprocess / --reprocess-all
async function handleCli() {
    const args = process.argv;
    
    if (args.includes('--reprocess') || args.includes('--reprocess-all')) {
        let mapping = {};
        try {
            mapping = await fs.readJson(config.MAPPING_FILE);
        } catch (e) {}

        const PORT = config.PORT || 3000;
        const API_KEY = config.API_KEY || '';
        const headers = {};
        if (API_KEY) {
            headers['x-comix-token'] = API_KEY;
        }

        if (args.includes('--reprocess-all')) {
            console.log('[Scanner] CLI: 尝试发送全库缓存重建请求...');
            try {
                const response = await fetch(`http://127.0.0.1:${PORT}/api/comics/reprocess`, {
                    method: 'POST',
                    headers
                });
                if (response.ok) {
                    const data = await response.json();
                    console.log(`🎉 [Scanner] 远程触发全库重建成功: ${data.message}`);
                    process.exit(0);
                }
            } catch (e) {
                console.log(`[Scanner] 无法连接到服务，将回落至本地清理模式。原因: ${e.message}`);
            }

            // 本地回落模式
            console.log('[Scanner] 本地模式: 正在清除全库已缓存的数据...');
            const keys = Object.keys(mapping).filter((id) => {
                try { validateComicId(id); return true; } catch { return false; }
            });
            for (const id of keys) {
                const cacheDir = resolveComicCacheDirectory(config.CACHE_LIBRARY_PATH, id);
                if (await fs.pathExists(cacheDir)) {
                    await fs.remove(cacheDir);
                }
            }
            console.log('[Scanner] 本地模式: 缓存已清除，开始执行重新解压与扫描...');
            await runActiveScan();
            console.log('[Scanner] 本地模式: 重建解压队列已排满。由于后台队列可能仍在解压，进程维持运行。');
        } 
        else {
            const idx = args.indexOf('--reprocess');
            const target = args[idx + 1];
            if (!target) {
                console.error('用法: node scanner.js --reprocess <漫画ID/书架编号>');
                process.exit(1);
            }

            let actualId = target;
            let filename = mapping[actualId];

            if (!filename && /^\d+$/.test(target)) {
                const keys = Object.keys(mapping).filter((id) => {
                    try { validateComicId(id); return true; } catch { return false; }
                });
                const numIndex = parseInt(target, 10) - 1;
                if (numIndex >= 0 && numIndex < keys.length) {
                    actualId = keys[numIndex];
                    filename = mapping[actualId];
                }
            }

            if (!filename) {
                console.error(`[Scanner] 错误: 未找到对应的漫画 ID 或书架编号: ${target}`);
                process.exit(1);
            }

            console.log(`[Scanner] CLI: 尝试发送漫画缓存重建请求 (ID: ${actualId})...`);
            try {
                const response = await fetch(`http://127.0.0.1:${PORT}/api/comics/${encodeURIComponent(actualId)}/reprocess`, {
                    method: 'POST',
                    headers
                });
                if (response.ok) {
                    const data = await response.json();
                    console.log(`🎉 [Scanner] 远程触发漫画重建成功: ${data.message}`);
                    process.exit(0);
                }
            } catch (e) {
                console.log(`[Scanner] 无法连接到服务，将回落至本地清理模式。原因: ${e.message}`);
            }

            // 本地回落模式
            console.log(`[Scanner] 本地模式: 正在清除漫画 ${filename} (ID: ${actualId}) 的缓存...`);
            const cacheDir = resolveComicCacheDirectory(config.CACHE_LIBRARY_PATH, actualId);
            if (await fs.pathExists(cacheDir)) {
                await fs.remove(cacheDir);
            }
            console.log('[Scanner] 本地模式: 缓存已清除，开始执行扫描并重新入队解压...');
            await runActiveScan();
            console.log('[Scanner] 本地模式: 重建解压队列已排满。由于后台队列可能仍在解压，进程维持运行。');
        }
    } 
    else if (args.includes('--run')) {
        runActiveScan().then(() => {
            console.log('[Scanner] 手动扫描脚本执行完毕。由于队列可能仍在后台解压，进程将维持运行状态，直至任务清空。');
        });
    }
}

handleCli();
