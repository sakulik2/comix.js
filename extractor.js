import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs-extra';
import path from 'path';
import sharp from 'sharp';

const execAsync = promisify(exec);

/**
 * 核心解压 Worker
 * @param {string} rawFilePath 原始文件路径 (CBR, CBZ, PDF)
 * @param {string} cacheDir 目标缓存目录
 */
export async function extractComic(rawFilePath, cacheDir) {
    const ext = path.extname(rawFilePath).toLowerCase();
    
    // 确保缓存目录存在并清空旧缓存
    await fs.ensureDir(cacheDir);
    await fs.emptyDir(cacheDir);

    try {
        if (ext === '.cbr' || ext === '.rar') {
            await extractCBR(rawFilePath, cacheDir);
        } else if (ext === '.cbz' || ext === '.zip') {
            await extractCBZ(rawFilePath, cacheDir);
        } else if (ext === '.pdf') {
            await extractPDF(rawFilePath, cacheDir);
        } else {
            throw new Error(`不支持的文件格式: ${ext}`);
        }

        // 统一后处理：优化图片 (缩放 + 转码 WebP)
        await optimizeImages(cacheDir);

        // 统一后处理：自然排序并生成索引
        await generateIndex(cacheDir);
    } catch (error) {
        console.error(`[Extractor] 任务失败: ${rawFilePath}`, error);
        throw error;
    }
}

/**
 * 处理 CBR/RAR (使用 unrar)
 */
async function extractCBR(source, target) {
    // e: 提取内容到当前目录
    // -y: 自动确认
    // -inul: 禁用所有输出 (静默模式)
    const cmd = `unrar e -y -inul "${source}" "${target}/"`;
    await execAsync(cmd);
}

/**
 * 处理 CBZ/ZIP (使用 unzip)
 */
async function extractCBZ(source, target) {
    // -j: 忽略目录结构 (junk paths)，摊平提取
    // -q: 静默模式
    const cmd = `unzip -j -q "${source}" -d "${target}/"`;
    await execAsync(cmd);
}

/**
 * 处理 PDF (使用 pdftoppm)
 */
async function extractPDF(source, target) {
    // -jpeg: 输出为 JPEG
    // -rx 150 -ry 150: 设置分辨率为 150 DPI
    // 输出文件名前缀为 "page" -> 将生成 page-1.jpg, page-2.jpg 等
    const cmd = `pdftoppm -jpeg -rx 150 -ry 150 "${source}" "${target}/page"`;
    await execAsync(cmd);
}

/**
 * 图像优化处理：递归扫描目录，将所有图片缩放并转为 WebP
 */
async function optimizeImages(cacheDir) {
    // 递归获取所有文件
    const getAllFiles = async (dir, allFiles = []) => {
        const files = await fs.readdir(dir);
        for (const file of files) {
            const name = path.join(dir, file);
            if ((await fs.stat(name)).isDirectory()) {
                await getAllFiles(name, allFiles);
            } else {
                allFiles.push(name);
            }
        }
        return allFiles;
    };

    const allFiles = await getAllFiles(cacheDir);
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.bmp', '.gif', '.webp']; 
    const maxWidth = 1400;

    console.log(`[Extractor] 开始递归优化, 发现总文件数: ${allFiles.length}`);

    const optimizePromises = allFiles.map(async (filePath) => {
        const ext = path.extname(filePath).toLowerCase();
        if (!imageExtensions.includes(ext)) return;

        // 如果已经是 webp 且在根目录，跳过
        if (ext === '.webp' && path.dirname(filePath) === cacheDir) return;

        // 统一输出到 cacheDir 根目录，平铺文件
        const fileName = path.basename(filePath, ext);
        const outputPath = path.join(cacheDir, `${fileName}.webp`);

        try {
            await sharp(filePath)
                .resize({ width: maxWidth, withoutEnlargement: true })
                .webp({ quality: 80 })
                .toFile(outputPath);

            // 处理完成后删除原文件
            await fs.remove(filePath);
        } catch (err) {
            console.error(`[Extractor] 优化图片失败: ${filePath}`, err);
        }
    });

    await Promise.all(optimizePromises);

    // 清理可能存在的空子目录
    const items = await fs.readdir(cacheDir);
    for (const item of items) {
        const fullPath = path.join(cacheDir, item);
        if ((await fs.stat(fullPath)).isDirectory()) {
            await fs.remove(fullPath);
        }
    }
}

/**
 * 统一收尾逻辑：扫描图片文件，自然排序，生成 index.json
 */
async function generateIndex(cacheDir) {
    const files = await fs.readdir(cacheDir);
    
    // 此时目录下应该全是平铺在根部的 .webp
    const imageFiles = files.filter(file => path.extname(file).toLowerCase() === '.webp');

    const collator = new Intl.Collator(undefined, {
        numeric: true,
        sensitivity: 'base'
    });
    
    imageFiles.sort(collator.compare);

    const indexPath = path.join(cacheDir, 'index.json');
    await fs.writeJson(indexPath, imageFiles, { spaces: 2 });
    
    console.log(`[Extractor] 索引生成成功: ${imageFiles.length} 页 (已平铺并转码为 WebP)`);
}
