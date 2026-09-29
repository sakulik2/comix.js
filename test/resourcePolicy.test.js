import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';

import {
    validateComicId,
    createComicId,
    resolveContainedPath,
    resolveComicCacheDirectory,
    sanitizeLibraryFilename,
    resolveLibraryFile
} from '../resourcePolicy.js';

test('validateComicId accepts a normal id and rejects unsafe values', () => {
    assert.equal(validateComicId('one-piece'), 'one-piece');
    for (const value of ['', '   ', '../secret', 'a/b', `a${String.fromCharCode(0)}b`]) {
        assert.throws(() => validateComicId(value), /漫画 ID/);
    }
});

test('createComicId uses an available basename and hashes collisions or unsafe names', () => {
    assert.equal(createComicId('/library/raw/book.cbz', '.cbz', {}), 'book');

    const filename = '/library/raw/book.cbz';
    const expected = crypto.createHash('sha256').update(filename).digest('hex');
    assert.equal(createComicId(filename, '.cbz', { book: 'other.cbz' }), expected);
});

test('resolveContainedPath keeps targets under the root', () => {
    const root = path.join('tmp', 'cache');
    assert.equal(resolveContainedPath(root, 'comic-1/page.webp'), path.resolve(root, 'comic-1/page.webp'));
    assert.throws(() => resolveContainedPath(root, '../outside'), /超出允许目录/);
    assert.throws(() => resolveContainedPath(root, path.resolve(root, '..', 'outside')), /超出允许目录/);
});

test('resolveComicCacheDirectory hashes names that are not portable', () => {
    assert.equal(resolveComicCacheDirectory('cache', 'normal'), path.resolve('cache', 'comic_normal'));
    const result = resolveComicCacheDirectory('cache', 'trailing.');
    assert.match(result, /comic_sha256_[a-f0-9]{64}$/);
});

test('library filename validation blocks traversal and control characters', () => {
    assert.equal(sanitizeLibraryFilename('book.cbz'), 'book.cbz');
    assert.equal(resolveLibraryFile('library/raw', 'book.cbz'), path.resolve('library/raw', 'book.cbz'));
    for (const value of ['../book.cbz', 'dir/book.cbz', `book${String.fromCharCode(10)}.cbz`, '']) {
        assert.throws(() => sanitizeLibraryFilename(value), /文件名/);
    }
});
