# Stage 1: Build client frontend
FROM node:22-alpine AS builder
WORKDIR /app/client
COPY client/package*.json ./
RUN npm install --legacy-peer-deps
COPY client/ ./
RUN npm run build

# Stage 2: Build server and run
FROM node:22-alpine
WORKDIR /app

# 有声书管线依赖 ffmpeg / ffprobe（Alpine 官方 ffmpeg 包同时提供两者；
# 原生 aac 编码 + adts→mp4 封装足够生成 m4b，不需要 libfdk_aac）
# 构建时顺带断言两个二进制都在，避免部署后才发现缺 ffprobe
RUN apk add --no-cache ffmpeg \
  && ffmpeg -version | head -1 \
  && ffprobe -version | head -1

COPY server/package*.json ./server/
RUN cd server && npm install --omit=dev --legacy-peer-deps
COPY server/ ./server/
COPY --from=builder /app/client/dist ./client/dist

# Create necessary directories for volumes
# audiobook/ 与 book/ 是成品导出目录（挂载宿主机后可直接在文件管理里看到）
RUN mkdir -p /app/projects /app/data /app/audiobook /app/book

EXPOSE 5001
ENV PORT=5001
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=4096"
# 前端填写的 MiMo Key 存在这个文件，挂载 ./data 后重建容器不丢
ENV AUDIOBOOK_ENV_FILE=/app/data/audiobook.env
# 成品自动导出的位置：m4b → /app/audiobook，epub → /app/book
ENV AUDIOBOOK_EXPORT_DIR=/app/audiobook
ENV EPUB_EXPORT_DIR=/app/book

# Start Node.js server
CMD ["node", "server/index.js"]
