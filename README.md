# Comix.js 

## 🛠️ 部署

部署在 Ubuntu 或 CentOS 服务器时，必须预先安装以下原生工具：

### Ubuntu / Debian
```bash
sudo apt update
sudo apt install unrar unzip poppler-utils
```

### CentOS / RHEL
```bash
sudo yum install epel-release
sudo yum install unrar unzip poppler-utils
```

## 📦 安装与启动

1. **克隆并安装依赖**：
   ```bash
   cd comix.js
   npm install
   ```

2. **配置库路径** (在 `server.js` 中修改以下变量)：
   - `RAW_LIBRARY_PATH`: 原始漫画存放区 (如 `/library/raw/`)。
   - `CACHE_LIBRARY_PATH`: 影子缓存存放区 (如 `/library/cache/`)。

3. **赋予权限**：
   ```bash
   sudo mkdir -p /library/raw/ /library/cache/
   sudo chown -R $USER:$USER /library/
   ```

4. **启动服务**：
   ```bash
   # 直接启动
   node server.js
   # 或使用 PM2 守护进程
   pm2 start server.js --name "comix-backend"
   ```

## 📖 API 接口

### 获取漫画页面
`GET /api/comics/:id/page/:pageNumber`

- **参数说明**：
    - `id`: 漫画唯一标识符 (对应原始文件名，如 `comic_123.cbr`)。
    - `pageNumber`: 页码，从 1 开始计数。
- **逻辑流程**：
    1. 检查 `/library/cache/comic_{id}/index.json` 是否存在。
    2. **如果不存则**：返回 HTTP 202 并将解压任务推入后台队列。
    3. **如果存在**：根据索引定位物理图片路径，返回 HTTP 200 及图片流。

## 📂 目录结构

- `server.js`: 后端 Express 路由与服务网关。
- `queueManager.js`: 基于 PQueue 的异步任务调度。
- `extractor.js`: 底层解压/转码工人（支持 CBR, CBZ, PDF）。
- `index.json`: 缓存目录内的页码快照索引，确保排序一致性。
