import fs from 'fs-extra';
import { config } from './config.js';

const MAPPING_FILE: string = config.MAPPING_FILE;

/**
 * 漫画映射表结构定义
 * 
 * 用于建立内部固定 ID 到实际物理文件路径的映射关系。
 * 这样做的好处是，后续不论物理文件名怎么变，只要映射关系在此更新，系统对外暴露的 ID 就可以永远保持不变。
 */
interface ComicMapping {
    /** 
     * 键名 (Key): 固定的漫画专属 ID，如 'comic_001'
     * 键值 (Value): 漫画目前对应的实际文件路径，如 'naruto_vol_1.cbz'
     */
    [comicId: string]: string;
}

async function loadMapping(): Promise<ComicMapping> {
    try {
        return await fs.readJson(MAPPING_FILE);
    } catch (e) {
        return {};
    }
}

async function saveMapping(mapping: ComicMapping): Promise<void> {
    await fs.writeJson(MAPPING_FILE, mapping, { spaces: 2 });
}

async function main(): Promise<void> {
    const args: string[] = process.argv.slice(2);
    const mapping: ComicMapping = await loadMapping();

    if (args.includes('--bind')) {
        const idIndex = args.indexOf('--bind') + 1;
        const fileIndex = idIndex + 1;
        const id = args[idIndex];
        const filename = args[fileIndex];

        if (!id || !filename) {
            console.error('用法: npx tsx mapper.ts --bind <ID> <文件名>');
            process.exit(1);
        }

        mapping[id] = filename;
        await saveMapping(mapping);
        console.log(`[Mapper-TS] 绑定成功: ${id} -> ${filename}`);
    } 
    else if (args.includes('--list')) {
        console.log('[Mapper-TS] 当前映射列表:');
        console.table(Object.entries(mapping).map(([id, file]) => ({ ID: id, "文件名": file })));
    }
    else {
        console.log('\n📚 漫画映射管理器 (Mapper) 帮助菜单 📚\n');
        console.log('可用指令 (Command Usage):\n');
        
        console.log('  ✨ 绑定漫画:');
        console.log('  npx tsx mapper.ts --bind <ID> <文件路径>');
        console.log('    示例: npx tsx mapper.ts --bind comic_01 ./raw_comics/naruto_01.cbz\n');
        
        console.log('  📋 查看映射:');
        console.log('  npx tsx mapper.ts --list');
        console.log('    说明: 以表格形式显式列出当前系统中所有的对应关系\n');
    }
}

main();
