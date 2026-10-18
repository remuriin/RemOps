import { EventEmitter } from "node:events";
import express, { type Request, type Response } from "express";
import type { Snapshot } from "./public.js";

// The last snapshot, and a signal when it changes. A snapshot that differs only in its time is not a change.
export class Store extends EventEmitter {
  snapshot: Snapshot | null = null;
  private key = "";

  set(s: Snapshot): void {
    this.snapshot = s;
    const { generatedAt: _, ...rest } = s;
    const key = JSON.stringify(rest);
    if (key !== this.key) {
      this.key = key;
      this.emit("change", s);
    }
  }
}

const ENDPOINTS = ["/v1/summary", "/v1/apps", "/v1/topology", "/v1/deploys", "/v1/certs", "/v1/snapshot", "/v1/stream"];
const HEARTBEAT_MS = 20000;

export function createApp(store: Store, opts: { corsOrigin: string; maxStreams: number }) {
  const app = express();
  app.disable("x-powered-by");
  let streams = 0;

  // read-only and public: GET from anywhere the setting allows, nothing else
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", opts.corsOrigin);
    if (opts.corsOrigin !== "*") res.setHeader("Vary", "Origin");
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET");
      res.status(204).end();
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.status(405).json({ error: "read only" });
      return;
    }
    next();
  });

  // the health address: answers as long as the process runs, also before the cluster can be read
  const index = (_req: Request, res: Response) => {
    res.json({ name: "remops", ready: store.snapshot !== null, endpoints: ENDPOINTS });
  };
  app.get("/", index);
  app.get("/healthz", index);

  const part = (pick: (s: Snapshot) => object) => (_req: Request, res: Response) => {
    const s = store.snapshot;
    if (!s) {
      res.status(503).json({ error: "warming up, try again in a few seconds" });
      return;
    }
    res.setHeader("Cache-Control", "public, max-age=5");
    res.json({ generatedAt: s.generatedAt, ...pick(s) });
  };
  app.get("/v1/summary", part((s) => s.summary));
  app.get("/v1/apps", part((s) => ({ apps: s.apps })));
  app.get("/v1/topology", part((s) => s.topology));
  app.get("/v1/deploys", part((s) => ({ deploys: s.deploys })));
  app.get("/v1/certs", part((s) => ({ certificates: s.certificates })));
  app.get("/v1/snapshot", part((s) => s));

  // Server-Sent Events: the whole snapshot now and on every change. The front door ends a request
  // after 60 s, so a browser's EventSource reconnects by itself (after "retry").
  app.get("/v1/stream", (req, res) => {
    if (streams >= opts.maxStreams) {
      res.status(503).json({ error: "too many open streams" });
      return;
    }
    streams++;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("retry: 3000\n\n");
    const send = (s: Snapshot) => res.write(`event: snapshot\ndata: ${JSON.stringify(s)}\n\n`);
    if (store.snapshot) send(store.snapshot);
    store.on("change", send);
    const beat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
    req.on("close", () => {
      streams--;
      clearInterval(beat);
      store.off("change", send);
    });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "not found", endpoints: ENDPOINTS });
  });
  return app;
}
