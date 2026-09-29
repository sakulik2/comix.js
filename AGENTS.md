# Repository Guidelines

## Project Structure & Module Organization

This Node.js 18+ ESM service manages comic archives. The HTTP app is in `server.js`; extraction is in `extractor.js`. `scanner.js` discovers files, `queueManager.js` schedules work, and `resourcePolicy.js` validates paths. `config.js` loads settings. `dashboard.html` is the management UI. `mapper.js` and `deleter.js` are CLI utilities. Tests use `test/*.test.js`. Runtime data is under `library/`; do not commit generated output.

## Build, Test, and Development Commands

Install dependencies with `npm install`.

- `npm test` runs all tests through Node's built-in test runner.
- `npm start` starts the production server on the configured port (default `3000`).
- `npm run dev` starts `server.js` with Node watch mode.
- `npm run scan` scans the configured raw library and queues missing cache entries.
- `npm run reprocess` and `npm run reprocess-all` rebuild selected or all cached items.

## Coding Style & Naming Conventions

Use four spaces, semicolons, and single-quoted strings. Keep ESM syntax (`import`/`export`). Use `camelCase` for functions and locals, `PascalCase` for classes, and uppercase names for configuration constants. Prefer small validated helpers and async/await for filesystem work. No formatter or linter is configured; match nearby code.

## Testing Guidelines

Write focused unit tests with `node:test` and `node:assert/strict`. Name files `test/<module>.test.js` and cover path containment, archive limits, and API errors. Avoid real libraries or external services; use temporary directories and fixtures. Run `npm test` before submitting changes.

## Commit & Pull Request Guidelines

Follow the existing Conventional Commit style: `feat:`, `fix:`, `style:`, or a concise imperative message. Keep commits focused. Pull requests should describe behavior changes, affected API/configuration fields, test results, and deployment steps. Include screenshots for `dashboard.html` changes.

## Security & Configuration Tips

Never commit API keys, credentials, `settings.json`, or generated comic/cache files. Configure paths, port, API key, and resource limits through environment variables or local settings. Preserve the validation helpers in `resourcePolicy.js` when adding file or comic ID routes; do not construct filesystem paths directly from request input.

## Client Coordination

The Android/client application is maintained in the sibling repository `E:\code\comicreader`. Treat API routes, request parameters, response JSON, status codes, authentication headers, and metadata fields as shared contracts. When changing a server endpoint, inspect the corresponding client call, document the compatibility impact in the pull request, and test both sides against the same example payloads. Client changes that depend on a server change should be coordinated in the reverse direction as well; avoid merging one side with an undocumented contract change.
