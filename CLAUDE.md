# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

See `AGENTS.md` for coding style, commit conventions, and the client-coordination rules. The points below cover what you need on top of that.

## Commands

- `npm test`: runs `node --test` (picks up `test/*.test.js`)
- Single file: `node --test test/resourcePolicy.test.js`
- Single test by name: `node --test --test-name-pattern="validateComicId" test/resourcePolicy.test.js`
- `npm run dev`: server with `--watch`; `npm start` for plain run
- `npm run scan` / `npm run reprocess <id-or-shelf-number>` / `npm run reprocess-all`
- `node mapper.js --list` / `node mapper.js --bind <ID> <filename>`: inspect or edit `mapping.json`
- `node deleter.js <ID>`: delete a comic

No build step, linter, or formatter. Extraction shells out to `unrar`, `unzip`, and `pdftoppm` (poppler-utils), so those must be on PATH for real extraction. The Dockerfile installs them.

## Architecture

The service serves comic archives (CBR/RAR, CBZ/ZIP, PDF) to an Android client (https://github.com/sakulik2/comix) as individual page images. It also serves `dashboard.html` at `/` as a management UI. The data flow:

1. Raw files live flat in `RAW_LIBRARY_PATH`. `mapping.json` (`MAPPING_FILE`) maps comic ID to raw filename. IDs come from `createComicId`: the file basename, or a sha256 of the filename when the basename is unsafe or already taken.
2. `scanner.js#runActiveScan` reads the raw dir, assigns IDs to unmapped files, writes `mapping.json`, and queues any comic whose `<cache>/comic_<id>/index.json` is missing. It runs on server startup when `AUTO_SCAN_ON_STARTUP` is on, and via `POST /api/scan`.
3. `queueManager.js` is a single in-process `PQueue` (concurrency `CONCURRENCY`). `pendingTasks` dedupes queued IDs. `taskStates` (queued/processing/ready/failed) only lives in memory and is what `/api/queue` and the 202/500 page responses report.
4. `extractor.js#extractComic` empties the cache dir, then extracts, validates against the archive limits, and either converts images to WebP (`OPTIMIZE_IMAGES`) or flattens and cleans the directory. Next it pulls ComicInfo.xml into `metadata.json`. Last it writes `index.json`, a naturally sorted list of page filenames. `index.json` is the "ready" marker. On failure the cache dir is emptied.
5. `GET /api/comics/:id/page/:n` (`server.js`) returns 202 with `Retry-After: 5` and queues extraction when the comic isn't ready yet. Once it's ready, it streams the page, resizing on the fly through sharp when `?width=` is set or the file exceeds `MAX_PAGE_RESPONSE_BYTES`. `:id` can also be a 1-based shelf number, which resolves to the Nth valid key in `mapping.json`. `scanner.js --reprocess` uses the same rule.

### Things that span files

- In-memory caches in `server.js` (`mappingCache`, `indexCache`, `metadataCache`) only reset through `clearAllCaches()`. Any route that changes mapping or cache contents has to call it, or the running server keeps serving stale data.
- The CLIs (`scanner.js --reprocess*`, `deleter.js`) first call the running server's HTTP API on `127.0.0.1:PORT`, sending the `x-comix-token` header, so that its memory caches get invalidated. They only fall back to touching the filesystem directly when the server is unreachable.
- `scanner.js` calls `handleCli()` at import time, and `server.js` imports it. That call only acts on `--run` / `--reprocess*` argv flags, so keep it that way.
- Importing `config.js` monkey-patches `console.log`/`console.error` to add timestamps. `server.js` also keeps the last 200 log lines in memory for `GET /api/logs`.
- Importing `server.js` calls `app.listen` right away, so unit tests should target the helper modules rather than import the server.
- Config precedence is `settings.json` > env var > default (`config.js`). The `MAX_*` resource limits are env-only. `POST /api/config` writes the whole config object back to `settings.json`.
- Auth: when `API_KEY` is non-empty, every `/api/*` route requires an `x-comix-token` header or a `?token=` query param. An empty key disables auth.
- `res.json` is overridden globally to add a trailing newline.
- `GET /api` advertises `apiVersion`, `protocolVersion`, `capabilities`, and `limits` to the client. Update it when you change the contract.

### Path safety

All IDs and filenames from requests or `mapping.json` go through `resourcePolicy.js`: `validateComicId`, `sanitizeLibraryFilename`, `resolveLibraryFile`, `resolveComicCacheDirectory`, and `resolveContainedPath`. Cache dirs are named `comic_<id>`, or `comic_sha256_<hash>` for IDs with Windows-unsafe characters. `getValidComicIds` silently skips bad mapping entries, so shelf numbering only counts valid entries.
