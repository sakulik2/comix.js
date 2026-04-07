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
                // 移除硬编码的分辨率缩放，保留全尺寸原图精度，动态缩放交给 /page 路由
                .webp({ quality: 85 })
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

import { XMLParser } from 'fast-xml-parser';

/**
 * 解析包内的 ComicInfo.xml 元数据 (采用更健壮的 XML 库方案)
 */
async function extractMetadata(cacheDir) {
    const infoPath = path.join(cacheDir, 'ComicInfo.xml');
    if (!(await fs.pathExists(infoPath))) return;

    try {
        const content = await fs.readFile(infoPath, 'utf8');
        const parser = new XMLParser();
        const jsonObj = parser.parse(content);
        const info = jsonObj?.ComicInfo || {};

        // 规范化字段映射
        const metadata = {
            title: info.Title,
            series: info.Series,
            summary: info.Summary,
            authors: info.Writer || info.Penciller,
            genres: info.Genre,
            publisher: info.Publisher,
            year: info.Year ? info.Year.toString() : null,
            issueNumber: info.Number ? info.Number.toString() : null,
            rating: info.Rating ? parseFloat(info.Rating) : null,
            isCompleted: info.Manga === 'Completed' || info.Status === 'Completed'
        };

        // 这里的逻辑很关键：剔除空字段，保持数据纯粹
        const filtered = Object.fromEntries(
            Object.entries(metadata).filter(([_, v]) => v != null && v !== "")
        );

        if (Object.keys(filtered).length > 0) {
            await fs.writeJson(path.join(cacheDir, 'metadata.json'), filtered, { spaces: 2 });
            console.log(`[Extractor] 结构化解析成功: ${filtered.title || 'ComicInfo'}`);
        }

        // 解析后删除 xml 临时文件，保持 WebP 目录下只有核心资源
        await fs.remove(infoPath);
    } catch (e) {
        console.error(`[Extractor] 结构化解析元数据失败 [XML库]:`, e);
    }
}

/**
 * 统一收尾逻辑：扫描图片文件，自然排序，生成 index.json
 */
async function generateIndex(cacheDir) {
    // 提升元数据提取权重：在生成索引前优先尝试提取元数据
    await extractMetadata(cacheDir);

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
