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
        const files = await fs.readdir(config.RAW_LIBRARY_PATH);
        const MAPPING_FILE = './mapping.json';
        
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

// 支持 CLI 手动调用支持： node scanner.js --run
if (process.argv.includes('--run')) {
    runActiveScan().then(() => {
        console.log('[Scanner] 手动扫描脚本执行完毕。由于队列可能仍在后台解压，进程将维持运行状态，直至任务清空。');
        // 注意：PQueue 为后台运行，无需立即退出进程
    });
}
