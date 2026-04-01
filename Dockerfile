FROM node:20-bookworm-slim

# 安装系统级依赖
# unrar: 解压 CBR/RAR 文件 (non-free 源)
# unzip: 解压 CBZ/ZIP 文件
# poppler-utils: pdftoppm，用于 PDF 转图片
RUN echo "deb http://deb.debian.org/debian bookworm main contrib non-free non-free-firmware" > /etc/apt/sources.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        unrar \
        unzip \
        poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先复制 package 文件，利用 Docker 层缓存加速重复构建
COPY package*.json ./
RUN npm ci --omit=dev

# 复制应用代码
COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
