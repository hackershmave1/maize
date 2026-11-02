# Moqesh AI Dashboard (web)

The dashboard frontend: React + TypeScript + Vite + Tailwind. It consumes the API at
`/api`, real-time updates over WebSocket at `/hubs/stream`, and downloads at `/download`.

## Development

```bash
npm install
npm run dev     # http://localhost:5173 (proxies /api, /hubs, and /download → :5000)
```

Also start the backend (`moqesh` in the repo root) to get real data.

## Build

```bash
npm run build   # type-check (tsc) + production build to web/dist
```

In production the backend serves `web/dist` as an SPA (same origin as the API). In the
Docker image the build runs in a Node stage and is copied into the Python server.

## Structure

- `src/pages/` — Dashboard, Sessions, Requests, Alerts, Rules, Scenarios, Blocks, **Sensors**.
- `src/services/api.ts` — typed REST client. `src/services/realtime.ts` — native WebSocket.
- `src/types/index.ts` — contract types (camelCase, mirroring `moqesh/schemas.py`).
