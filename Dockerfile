# Stage 1: Build client frontend
FROM node:20-alpine AS builder
WORKDIR /app/client
COPY client/package*.json ./
RUN npm install
COPY client/ ./
RUN npm run build

# Stage 2: Build server and run
FROM node:20-alpine
WORKDIR /app
COPY server/package*.json ./server/
RUN cd server && npm install
COPY server/ ./server/
COPY --from=builder /app/client/dist ./client/dist

# Create necessary directories for volumes
RUN mkdir -p /app/projects

EXPOSE 5001
ENV PORT=5001
ENV NODE_ENV=production

# Start Node.js server
CMD ["node", "server/index.js"]
