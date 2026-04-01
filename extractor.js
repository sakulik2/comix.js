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
 * 图像优化处理：遍历目录，将所有图片缩放并转为 WebP
 */
async function optimizeImages(cacheDir) {
    const files = await fs.readdir(cacheDir);
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.bmp', '.gif'];
    const maxWidth = 1400; // 适配移动端的主流宽度

    console.log(`[Extractor] 开始图像二次优化: ${cacheDir}`);

    const optimizePromises = files.map(async (file) => {
        const ext = path.extname(file).toLowerCase();
        if (!imageExtensions.includes(ext)) return;

        const inputPath = path.join(cacheDir, file);
        const outputPath = path.join(cacheDir, `${path.basename(file, ext)}.webp`);

        try {
            // 避免重复处理（如果已经是 webp 则跳过，但通常上面过滤了）
            if (ext === '.webp') return;

            await sharp(inputPath)
                .resize({ width: maxWidth, withoutEnlargement: true }) // 限制最大宽度，不放大原图
                .webp({ quality: 80 }) // 转换为 webp，质量 80
                .toFile(outputPath);

            // 删除原始大图
            await fs.remove(inputPath);
        } catch (err) {
            console.error(`[Extractor] 优化图片失败: ${file}`, err);
        }
    });

    await Promise.all(optimizePromises);
}

/**
 * 统一收尾逻辑：扫描图片文件，自然排序，生成 index.json
 */
async function generateIndex(cacheDir) {
    const files = await fs.readdir(cacheDir);
    
    // 此时目录下应该全是 .webp
    const imageFiles = files.filter(file => path.extname(file).toLowerCase() === '.webp');

    // 使用国际化 API 提供的自然排序算法
    const collator = new Intl.Collator(undefined, {
        numeric: true,
        sensitivity: 'base'
    });
    
    imageFiles.sort(collator.compare);

    const indexPath = path.join(cacheDir, 'index.json');
    await fs.writeJson(indexPath, imageFiles, { spaces: 2 });
    
    console.log(`[Extractor] 索引生成成功: ${imageFiles.length} 页 (已优化为 WebP)`);
}
