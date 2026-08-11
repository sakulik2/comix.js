import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs-extra';
import path from 'path';
import sharp from 'sharp';
import PQueue from 'p-queue';
import { config } from './config.js';

const execFileAsync = promisify(execFile);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.gif', '.webp']);
const EXTRACT_TIMEOUT_MS = 30 * 60 * 1000;

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

        await validateExtractedFiles(cacheDir);

        // 根据配置进行图片处理：转码优化或轻量化整理
        if (config.OPTIMIZE_IMAGES) {
            await optimizeImages(cacheDir);
        } else {
            await flattenAndCleanDirectory(cacheDir);
        }

        // 统一后处理：自然排序并生成索引
        await generateIndex(cacheDir);
    } catch (error) {
        await fs.emptyDir(cacheDir).catch(() => {});
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
    await execFileAsync(
        'unrar',
        ['e', '-y', '-inul', source, `${target}${path.sep}`],
        { timeout: EXTRACT_TIMEOUT_MS, maxBuffer: 1024 * 1024 }
    );
}

/**
 * 处理 CBZ/ZIP (使用 unzip)
 */
async function extractCBZ(source, target) {
    // -j: 忽略目录结构 (junk paths)，摊平提取
    // -q: 静默模式
    await execFileAsync(
        'unzip',
        ['-j', '-q', source, '-d', target],
        { timeout: EXTRACT_TIMEOUT_MS, maxBuffer: 1024 * 1024 }
    );
}

/**
 * 处理 PDF (使用 pdftoppm)
 */
async function extractPDF(source, target) {
    // -jpeg: 输出为 JPEG
    // -rx 150 -ry 150: 设置分辨率为 150 DPI
    // 输出文件名前缀为 "page" -> 将生成 page-1.jpg, page-2.jpg 等
    await execFileAsync(
        'pdftoppm',
        ['-jpeg', '-rx', '150', '-ry', '150', source, path.join(target, 'page')],
        { timeout: EXTRACT_TIMEOUT_MS, maxBuffer: 1024 * 1024 }
    );
}

async function validateExtractedFiles(cacheDir) {
    const pendingDirectories = [cacheDir];
    let entryCount = 0;
    let totalBytes = 0;

    while (pendingDirectories.length > 0) {
        const currentDirectory = pendingDirectories.pop();
        const entries = await fs.readdir(currentDirectory, { withFileTypes: true });
        for (const entry of entries) {
            const entryPath = path.join(currentDirectory, entry.name);
            if (entry.isDirectory()) {
                pendingDirectories.push(entryPath);
                continue;
            }

            entryCount++;
            if (entryCount > config.MAX_ARCHIVE_ENTRIES) {
                throw new Error(`压缩包条目超过 ${config.MAX_ARCHIVE_ENTRIES} 个限制`);
            }

            const stat = await fs.stat(entryPath);
            totalBytes += stat.size;
            if (totalBytes > config.MAX_EXTRACTED_BYTES) {
                throw new Error(`漫画解压总量超过 ${Math.floor(config.MAX_EXTRACTED_BYTES / 1024 / 1024)}MB 限制`);
            }

            const extension = path.extname(entry.name).toLowerCase();
            if (IMAGE_EXTENSIONS.has(extension) && stat.size > config.MAX_PAGE_BYTES) {
                throw new Error(`页面 ${entry.name} 超过 ${Math.floor(config.MAX_PAGE_BYTES / 1024 / 1024)}MB 限制`);
            }
            if ((extension === '.xml' || extension === '.json') && stat.size > config.MAX_METADATA_BYTES) {
                throw new Error(`元数据 ${entry.name} 超过 ${Math.floor(config.MAX_METADATA_BYTES / 1024 / 1024)}MB 限制`);
            }
        }
    }
}

/**
 * 图像优化处理：根据并发限制与大小阈值进行受控 WebP 转码，免去小文件和已优化 WebP 的转码压力
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

    console.log(`[Extractor] 开始递归优化 (已启用限制并发的 WebP 转码), 发现总文件数: ${allFiles.length}`);

    // 使用 PQueue 控制并发，避免大量 sharp 实例同时运行时引发 OOM 和 CPU 瞬间占满
    const optimizeQueue = new PQueue({ concurrency: config.OPTIMIZE_CONCURRENCY });

    const optimizePromises = allFiles.map((filePath) => {
        return optimizeQueue.add(async () => {
            const ext = path.extname(filePath).toLowerCase();

            // 1. 如果是非图片文件，直接删除
            if (!imageExtensions.includes(ext)) {
                await fs.remove(filePath);
                return;
            }

            const fileName = path.basename(filePath, ext);
            const outputPath = path.join(cacheDir, `${fileName}.webp`);

            // 2. 如果已经是 WebP 格式，无需任何额外转码，直接移动到根目录
            if (ext === '.webp') {
                if (path.dirname(filePath) !== cacheDir) {
                    if (!(await fs.pathExists(outputPath))) {
                        await fs.move(filePath, outputPath);
                    } else {
                        await fs.remove(filePath);
                    }
                }
                return;
            }

            // 3. 性能优化源头：根据文件体积大小进行转码初筛
            // 如果文件小于过滤阈值 (如 300KB)，转码收益极低，直接将其原格式移动并平铺到根目录，跳过 sharp 转码
            const stat = await fs.stat(filePath);
            if (stat.size < config.OPTIMIZE_MIN_FILE_SIZE) {
                const originalNameOutputPath = path.join(cacheDir, `${fileName}${ext}`);
                if (filePath !== originalNameOutputPath) {
                    if (!(await fs.pathExists(originalNameOutputPath))) {
                        await fs.move(filePath, originalNameOutputPath);
                    } else {
                        await fs.remove(filePath);
                    }
                }
                return;
            }

            // 4. 对满足条件的大图运行 sharp 优化转码
            try {
                await sharp(filePath)
                    .webp({ quality: 85 })
                    .toFile(outputPath);

                // 处理完成后删除原文件
                await fs.remove(filePath);
            } catch (err) {
                console.error(`[Extractor] 优化图片失败: ${filePath}`, err);
            }
        });
    });

    await Promise.all(optimizePromises);

    // 清理所有子目录
    const items = await fs.readdir(cacheDir);
    for (const item of items) {
        const fullPath = path.join(cacheDir, item);
        if ((await fs.stat(fullPath)).isDirectory()) {
            await fs.remove(fullPath);
        }
    }
}

/**
 * 轻量化平铺与清理：完全跳过 WebP 转码，仅将所有图片平铺移动至缓存根目录，并清除垃圾文件
 */
async function flattenAndCleanDirectory(cacheDir) {
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

    console.log(`[Extractor] 开始轻量化文件扫描与平铺 (完全跳过 WebP 转码), 文件总数: ${allFiles.length}`);

    for (const filePath of allFiles) {
        const ext = path.extname(filePath).toLowerCase();

        // 1. 如果是非图片且非 xml/json 元数据，直接删除
        if (!imageExtensions.includes(ext) && ext !== '.xml' && ext !== '.json') {
            await fs.remove(filePath);
            continue;
        }

        // 2. 如果文件在子目录中，直接移动到缓存目录根部以平铺
        if (path.dirname(filePath) !== cacheDir) {
            const fileName = path.basename(filePath);
            const outputPath = path.join(cacheDir, fileName);
            if (!(await fs.pathExists(outputPath))) {
                await fs.move(filePath, outputPath);
            } else {
                await fs.remove(filePath);
            }
        }
    }

    // 3. 清除所有空的子目录
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
        const infoStat = await fs.stat(infoPath);
        if (infoStat.size > config.MAX_METADATA_BYTES) {
            throw new Error(`ComicInfo.xml 超过 ${Math.floor(config.MAX_METADATA_BYTES / 1024 / 1024)}MB 限制`);
        }
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

    // 目录支持混杂多种格式的图片
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.bmp', '.gif', '.webp'];
    const imageFiles = files.filter(file => imageExtensions.includes(path.extname(file).toLowerCase()));
    if (imageFiles.length > config.MAX_PAGES_PER_COMIC) {
        throw new Error(`漫画页数超过 ${config.MAX_PAGES_PER_COMIC} 页限制`);
    }

    const collator = new Intl.Collator(undefined, {
        numeric: true,
        sensitivity: 'base'
    });

    imageFiles.sort(collator.compare);

    const indexPath = path.join(cacheDir, 'index.json');
    await fs.writeJson(indexPath, imageFiles, { spaces: 2 });

    console.log(`[Extractor] 索引生成成功: ${imageFiles.length} 页 (已平铺，混杂格式排序)`);
}
