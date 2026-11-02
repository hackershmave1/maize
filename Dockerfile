# --- frontend build ---
FROM node:20-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# --- Python backend ---
FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    MOQESH_DB_PATH=/app/data/moqesh.db \
    MOQESH_WEB_DIST=/app/web/dist \
    MOQESH_ENFORCE_BLOCK=true

COPY pyproject.toml ./
COPY moqesh/ ./moqesh/
RUN pip install --no-cache-dir .

# SPA build + optional forge template (if included in the context).
COPY --from=web /web/dist ./web/dist
RUN mkdir -p /app/data /app/moqesh/assets

EXPOSE 5000 8080
# Serves the honeypot (:8080) and dashboard+API (:5000) in one process.
CMD ["moqesh"]
