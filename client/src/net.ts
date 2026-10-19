// WebSocket connection to the authoritative server.

import type { C2S, S2C } from "../../shared/protocol.ts";

type Handler = (m: S2C) => void;

export class Net {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  rtt = 0;
  connected = false;
  onClose: (() => void) | null = null;

  connect(): Promise<void> {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    return new Promise((resolve, reject) => {
      ws.onopen = () => {
        this.connected = true;
        resolve();
        setInterval(() => this.send({ t: "ping", ts: performance.now() }), 3000);
      };
      ws.onerror = () => reject(new Error("Не вдалося з'єднатися з сервером"));
      ws.onclose = () => { this.connected = false; this.onClose?.(); };
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data as string) as S2C;
        if (m.t === "pong") this.rtt = performance.now() - m.ts;
        for (const h of this.handlers) h(m);
      };
    });
  }

  on(h: Handler) {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  send(m: C2S) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }
}

export const net = new Net();
