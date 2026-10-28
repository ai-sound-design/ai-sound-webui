# AI Sound Design web UI: the built frontend plus the session server in one image.
#
#   docker compose up -d --build        # http://localhost:8030
#
# Stage 1 builds the static site, stage 2 runs the FastAPI server with ffmpeg.

FROM node:22-alpine AS frontend
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html tsconfig.json vite.config.ts ./
COPY public ./public
COPY src ./src
RUN npm run build

FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY server/app ./app
COPY server/ptsession ./ptsession
COPY --from=frontend /build/dist ./dist
ENV STATIC_DIR=/app/dist \
    SESSIONS_DIRS=/sessions \
    CACHE_DIR=/cache \
    PYTHONUNBUFFERED=1
EXPOSE 8030
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD curl -fsS http://localhost:8030/api/health || exit 1
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8030", "--proxy-headers"]
