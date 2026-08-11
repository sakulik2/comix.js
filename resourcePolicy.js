import crypto from 'crypto';
import path from 'path';
import { config } from './config.js';

export function validateComicId(comicId) {
    if (typeof comicId !== 'string' || comicId.trim() === '') {
        throw new Error('漫画 ID 不能为空');
    }
    if (comicId.length > config.MAX_COMIC_ID_LENGTH || /[\\/\u0000-\u001f\u007f]/u.test(comicId)) {
        throw new Error('漫画 ID 包含不安全字符或长度超限');
    }
    return comicId;
}

export function createComicId(filename, extension, mapping) {
    const basename = path.basename(filename, extension);
    const canUseBasename = (() => {
        try {
            validateComicId(basename);
            return !mapping[basename];
        } catch {
            return false;
        }
    })();
    if (canUseBasename) return basename;
    return crypto.createHash('sha256').update(filename).digest('hex');
}

export function resolveContainedPath(rootDirectory, relativePath) {
    const root = path.resolve(rootDirectory);
    const target = path.resolve(root, relativePath);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
        throw new Error('目标路径超出允许目录');
    }
    return target;
}

export function resolveComicCacheDirectory(cacheRoot, comicId) {
    const validComicId = validateComicId(comicId);
    const requiresPortableName = /[<>:"|?*]/u.test(validComicId) || /[. ]$/u.test(validComicId);
    const cacheName = requiresPortableName
        ? `comic_sha256_${crypto.createHash('sha256').update(validComicId).digest('hex')}`
        : `comic_${validComicId}`;
    return resolveContainedPath(cacheRoot, cacheName);
}

export function sanitizeLibraryFilename(filename) {
    if (typeof filename !== 'string' || filename === '' || filename.length > 255) {
        throw new Error('文件名为空或长度超限');
    }
    if (path.basename(filename) !== filename || /[\\/\u0000-\u001f\u007f]/u.test(filename)) {
        throw new Error('文件名包含不安全字符');
    }
    return filename;
}

export function resolveLibraryFile(rawLibraryPath, filename) {
    return resolveContainedPath(rawLibraryPath, sanitizeLibraryFilename(filename));
}
