# Comix.js

一个自托管的漫画库后端：把 CBR/RAR、CBZ/ZIP、PDF 漫画在后台解压成逐页图片，通过 HTTP API 提供给 Android 客户端（[sakulik2/comix](https://github.com/sakulik2/comix)）阅读，并自带一个网页管理面板。

## 工作原理

1. 原始漫画平铺存放在 `RAW_LIBRARY_PATH`。
2. 扫描时为每个新文件生成一个漫画 ID（默认取文件名去掉后缀；若重名或含不安全字符，则使用文件名的 SHA-256），写入 `mapping.json`（ID → 文件名）。
3. 尚未缓存的漫画进入后台解压队列（并发数 `CONCURRENCY`）。解压结果写入 `CACHE_LIBRARY_PATH/comic_<ID>/`：
   - 页面图片（平铺到一层目录，可选转码为 WebP）
   - `metadata.json`：从包内 `ComicInfo.xml` 提取的元数据（如有）
   - `index.json`：按自然顺序排列的页面文件名列表，存在即表示该漫画已就绪
4. 客户端请求某页时，若漫画尚未就绪，服务端返回 `202` 并自动入队解压；就绪后直接返回图片，可按需缩放。

## 环境要求

- Node.js 18+（Docker 镜像使用 Node 20）
- 系统命令行工具（需在 `PATH` 中）：
  - `unrar`：解压 CBR/RAR
  - `unzip`：解压 CBZ/ZIP
  - `pdftoppm`（poppler-utils）：将 PDF 按 150 DPI 渲染为 JPEG

Ubuntu / Debian：

```bash
sudo apt update
sudo apt install unrar unzip poppler-utils   # unrar 需启用 non-free 源
```

CentOS / RHEL：

```bash
sudo yum install epel-release
sudo yum install unrar unzip poppler-utils
```

## 安装与启动

```bash
npm install
npm start          # 启动服务，默认端口 3000
npm run dev        # 开发模式（node --watch）
```

启动后访问 `http://localhost:3000/` 打开管理面板。服务启动时会自动创建库目录，并在 `AUTO_SCAN_ON_STARTUP` 开启时执行一次全库扫描。

也可使用 PM2 守护：

```bash
pm2 start server.js --name comix-backend
```

### Docker

```bash
docker compose up -d --build
```

`docker-compose.yml` 将 `./volumes/raw` 挂载为原始漫画目录，`./volumes/cache` 挂载为缓存目录，`mapping.json` 也存放在缓存卷中随之持久化。

## 配置

配置读取优先级：`settings.json` > 同名环境变量 > 默认值（见 `config.js`）。通过管理面板或 `POST /api/config` 保存的设置会写入项目根目录的 `settings.json`；端口、存储路径等参数需重启服务后生效。

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `RAW_LIBRARY_PATH` | `./library/raw/` | 原始漫画目录 |
| `CACHE_LIBRARY_PATH` | `./library/cache/` | 解压缓存目录 |
| `MAPPING_FILE` | `./mapping.json` | ID 映射表路径 |
| `SUPPORTED_EXTENSIONS` | `.cbr .rar .cbz .zip .pdf` | 扫描识别的后缀（仅 `settings.json` 可配置） |
| `CONCURRENCY` | `2` | 同时解压的漫画数 |
| `AUTO_SCAN_ON_STARTUP` | `true` | 启动时自动扫描 |
| `OPTIMIZE_IMAGES` | `false` | 解压后将图片转码为 WebP（质量 85），低配机器建议关闭 |
| `OPTIMIZE_CONCURRENCY` | `2` | WebP 转码并发数 |
| `OPTIMIZE_MIN_FILE_SIZE` | `307200`（300KB） | 小于该字节数的图片跳过转码 |
| `PORT` | `3000` | 监听端口 |
| `API_KEY` | 空 | API 鉴权密钥，为空时不鉴权，生产环境务必设置 |

资源限制只能通过环境变量设置：

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MAX_LIBRARY_ITEMS` | `20000` | 书架列表最大条目数，超出返回 `413` |
| `MAX_ARCHIVE_ENTRIES` | `10000` | 单个压缩包解压后的最大文件数 |
| `MAX_PAGES_PER_COMIC` | `10000` | 单本最大页数 |
| `MAX_PAGE_BYTES` | 96MB | 单页图片最大体积（解压时校验） |
| `MAX_PAGE_RESPONSE_BYTES` | 64MB | 超过该体积的页面在返回时强制缩放 |
| `MAX_EXTRACTED_BYTES` | 32GB | 单本解压总量上限 |
| `MAX_UPLOAD_BYTES` | 16GB | 单次上传最大体积 |
| `MAX_METADATA_BYTES` | 2MB | 包内 XML/JSON 元数据最大体积 |
| `MAX_COMIC_ID_LENGTH` | `256` | 漫画 ID 最大长度 |

超过解压限制的漫画会被标记为失败，并清空其缓存目录。

## 命令行工具

| 命令 | 说明 |
| --- | --- |
| `npm run scan` | 扫描原始目录，补全映射并将未缓存的漫画入队解压 |
| `npm run reprocess -- <ID或编号>` | 重建单本漫画的缓存 |
| `npm run reprocess-all` | 重建全部缓存 |
| `node deleter.js <ID或编号>` | 删除漫画的原始文件、缓存和映射 |
| `node mapper.js --list` | 列出所有映射及其编号 |
| `node mapper.js --bind <ID> <文件名>` | 手动绑定 ID 与文件名 |

`reprocess`、`reprocess-all` 和 `deleter.js` 会优先调用本机正在运行的服务 API（自动带上 `API_KEY`），以便同步刷新服务的内存缓存；连接失败时才回落为直接操作文件系统。回落模式下删除后，需调用 `POST /api/scan` 让运行中的服务刷新缓存。

“编号”指 `mapping.json` 中有效条目的 1-based 序号（即接口返回的 `numId`），所有接受 `:id` 的接口同样支持。

## API

配置了 `API_KEY` 时，所有 `/api/*` 请求需携带请求头 `x-comix-token: <API_KEY>`，或查询参数 `?token=<API_KEY>`。鉴权失败返回 `401`。错误响应格式为 `{ "error": "..." }`。

### 服务信息

`GET /api` 返回服务状态、协议版本、能力及限制，供客户端做兼容判断：

```json
{
  "service": "comix.js",
  "status": "Running",
  "apiVersion": "1.4.1",
  "protocolVersion": 2,
  "capabilities": { "pageResize": true, "processingStatus": true, "opaqueComicIds": true },
  "limits": { "maxLibraryItems": 20000, "maxPagesPerComic": 10000, "maxPageBytes": 67108864, "maxResizeWidth": 3840 }
}
```

### 漫画

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/comics` | 书架列表 |
| `GET /api/comics/search?q=关键词` | 按标题、原文件名、作者模糊搜索 |
| `GET /api/comics/:id` | 单本详情，额外包含 `status`（`ready` / `queued` / `processing` / `failed`）和 `error` |
| `GET /api/comics/:id/page/:pageNumber` | 获取页面图片，页码从 1 开始 |
| `POST /api/comics/:id/metadata` | 修改元数据（JSON 请求体，只更新传入的字段） |
| `POST /api/comics/:id/reprocess` | 清空并重建单本缓存 |
| `POST /api/comics/reprocess` | 清空并重建全部缓存 |
| `DELETE /api/comics/:id` | 删除原始文件、缓存及映射 |

列表项字段：`id`、`numId`、`title`、`originalName`、`coverUrl`（第 1 页地址）、`isReady`、`totalPages`，以及 `metadata.json` 中的字段（`series`、`authors`、`summary`、`genres`、`publisher`、`year`、`issueNumber`、`rating`、`isCompleted` 等）。

元数据可编辑字段：`title`、`series`、`issueTitle`、`issueNumber`、`volumeNumber`、`authors`、`summary`、`genres`、`publisher`、`year`、`rating`（0–100）、`isCompleted`。

#### 页面请求

- 漫画未就绪：返回 `202` 与 `Retry-After: 5`，body 为 `{ "status": "processing" }`，同时自动入队解压
- 解压失败：返回 `500`，body 为 `{ "status": "failed", "error": "..." }`
- 页码无效：`400`；ID、原始文件或页码不存在：`404`
- 就绪：返回原图，响应头 `Cache-Control: private, max-age=3600`
- 缩放：`?width=<1-3840>` 以 WebP 格式按宽度缩放（不放大），`?quality=<1-100>` 设置质量（默认 85）

### 上传

```bash
curl -X POST "http://localhost:3000/api/upload?filename=book.cbz" \
  -H "Content-Type: application/octet-stream" \
  -H "x-comix-token: <API_KEY>" \
  --data-binary @book.cbz
```

仅接受 `zip`、`cbz`、`rar`、`cbr`、`pdf`。同名文件已存在时自动重命名为 `book(1).cbz` 等。上传成功后立即入队解压，返回 `{ "status": "success", "id": "..." }`，其中 `id` 与扫描生成规则一致（最终文件名去掉后缀，冲突或含不安全字符时使用 SHA-256）。

### 管理

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/scan` | 执行全库扫描并刷新内存缓存 |
| `GET /api/queue` | 解压队列状态：`size`、`pendingCount`、`pendingTasks` |
| `GET /api/config` | 读取当前配置（`apiKey` 以 `******` 掩码返回） |
| `POST /api/config` | 保存配置到 `settings.json`，字段为驼峰命名（如 `rawLibraryPath`、`optimizeImages`） |
| `GET /api/logs` | 最近 200 条内存日志（不落盘） |

## 安全说明

- 所有漫画 ID 与文件名均经过 `resourcePolicy.js` 校验，拒绝路径分隔符、控制字符及越出库目录的路径。
- `API_KEY` 为空时 API 完全开放，暴露到公网前务必设置，并建议置于 HTTPS 反向代理之后。
- 不要提交 `settings.json`、`mapping.json` 内容或 `library/` 下的生成文件。

## 开发

```bash
npm test                                         # 运行全部测试（node --test）
node --test test/resourcePolicy.test.js          # 运行单个测试文件
```

代码规范、提交约定及与 Android 客户端的接口协同要求见 [AGENTS.md](AGENTS.md)。
