// Real-time client over NATIVE WebSocket (replacing SignalR).
// Connects to /hubs/stream (proxied to the API in dev, same origin in prod)
// and reconnects on its own if the connection drops.

export interface LiveEvent {
  event: string;
  data: Record<string, unknown>;
}

export function connectLive(onEvent: (e: LiveEvent) => void): () => void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/hubs/stream`;
  let ws: WebSocket | null = null;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const open = () => {
    ws = new WebSocket(url);
    ws.onmessage = (m) => {
      try {
        onEvent(JSON.parse(m.data) as LiveEvent);
      } catch {
        /* non-JSON message: ignore */
      }
    };
    ws.onclose = () => {
      if (!closed) retry = setTimeout(open, 3000);
    };
    ws.onerror = () => ws?.close();
  };

  open();

  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    ws?.close();
  };
}
