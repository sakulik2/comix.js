import fs from 'fs-extra';
import path from 'path';
import { config } from './config.js';
import { addBookToQueue } from './queueManager.js';

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
        
        const existingFilenames = new Set(Object.values(mapping));
        let discoveryCount = 0;
        let mappingUpdateCount = 0;

        for (const file of files) {
            const ext = path.extname(file).toLowerCase();
            
            // 过滤支持的后缀
            if (config.SUPPORTED_EXTENSIONS.includes(ext)) {
                discoveryCount++;

                // 1. 自动生成 ID 映射逻辑
                // 如果文件名还没有被任何 ID 关联：
                if (!existingFilenames.has(file)) {
                    let defaultId = path.basename(file, ext);
                    
                    // 检查生成的默认 ID 是否已被其他文件占用（避免冲突）
                    if (mapping[defaultId]) {
                        defaultId = `${defaultId}_${Math.floor(Math.random() * 1000)}`;
                    }

                    mapping[defaultId] = file;
                    existingFilenames.add(file);
                    mappingUpdateCount++;
                    console.log(`[Scanner] 发现未映射新书: ${file} -> 自动生成 ID: ${defaultId}`);
                }

                // 2. 解压任务排队逻辑 (通过 ID 查找)
                // 找到文件关联的 ID
                const currentId = Object.keys(mapping).find(key => mapping[key] === file);
                const rawPath = path.join(config.RAW_LIBRARY_PATH, file);
                const indexPath = path.join(config.CACHE_LIBRARY_PATH, `comic_${currentId}`, 'index.json');
                
                const isCached = await fs.pathExists(indexPath);
                if (!isCached) {
                    addBookToQueue(currentId, rawPath, config.CACHE_LIBRARY_PATH);
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
            const keys = Object.keys(mapping);
            for (const id of keys) {
                const cacheDir = path.join(config.CACHE_LIBRARY_PATH, `comic_${id}`);
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
                const keys = Object.keys(mapping);
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
                const response = await fetch(`http://127.0.0.1:${PORT}/api/comics/${actualId}/reprocess`, {
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
            const cacheDir = path.join(config.CACHE_LIBRARY_PATH, `comic_${actualId}`);
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
