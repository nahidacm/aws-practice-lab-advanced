# ── Stage 1: Build frontend ──────────────────────────────────────────────────
FROM node:20-alpine AS frontend-builder
WORKDIR /frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
# Stage 3: API origin baked into the bundle. Empty = Vite proxy (local dev only).
ARG VITE_API_URL=""
ENV VITE_API_URL=$VITE_API_URL
# Stage 4: Cognito pool identifiers baked into the bundle (not secrets — public values).
ARG VITE_COGNITO_USER_POOL_ID=""
ENV VITE_COGNITO_USER_POOL_ID=$VITE_COGNITO_USER_POOL_ID
ARG VITE_COGNITO_CLIENT_ID=""
ENV VITE_COGNITO_CLIENT_ID=$VITE_COGNITO_CLIENT_ID
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

# Default health check for the API — hits the /health endpoint.
# The worker task definition overrides this with: CMD-SHELL, kill -0 1
# because the worker has no HTTP server.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "server.js"]
