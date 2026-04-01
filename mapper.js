import fs from 'fs-extra';
import { config } from './config.js';

const MAPPING_FILE = './mapping.json';

async function loadMapping() {
    try {
        return await fs.readJson(MAPPING_FILE);
    } catch (e) {
        return {};
    }
}

async function saveMapping(mapping) {
    await fs.writeJson(MAPPING_FILE, mapping, { spaces: 2 });
}

async function main() {
    const args = process.argv.slice(2);
    const mapping = await loadMapping();

    if (args.includes('--bind')) {
        const idIndex = args.indexOf('--bind') + 1;
        const fileIndex = idIndex + 1;
        const id = args[idIndex];
        const filename = args[fileIndex];

        if (!id || !filename) {
            console.error('用法: node mapper.js --bind <ID> <文件名>');
            process.exit(1);
        }

        mapping[id] = filename;
        await saveMapping(mapping);
        console.log(`[Mapper] 绑定成功: ${id} -> ${filename}`);
    } 
    else if (args.includes('--list')) {
        console.log('[Mapper] 当前映射列表:');
        console.table(Object.entries(mapping).map(([id, file]) => ({ ID: id, "文件名": file })));
    }
    else {
        console.log('可用指令:');
        console.log('  --bind <ID> <文件名> : 手动建立映射');
        console.log('  --list              : 查看所有映射');
    }
}

main();
