# ── Stage 1: Build frontend ──────────────────────────────────────────────────
FROM node:20-alpine AS frontend-builder
WORKDIR /frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ── Stage 2: Install backend prod deps ───────────────────────────────────────
FROM node:20-alpine AS backend-builder
WORKDIR /backend
COPY backend/package*.json ./
RUN npm ci --omit=dev

# ── Stage 3: Runtime image ────────────────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app

# Copy backend
COPY --from=backend-builder /backend/node_modules ./node_modules
COPY backend/ ./

# Copy built frontend into Express static folder
COPY --from=frontend-builder /frontend/dist ./public

ENV PORT=3000
ENV NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "server.js"]
