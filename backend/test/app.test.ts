import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import { createApp, Store } from "../src/app.js";
import { collect } from "../src/collect.js";
import { buildSnapshot, type Snapshot } from "../src/public.js";
import { fixtureFetcher } from "./fixtures.js";

let server: Server;
let base: string;
const store = new Store();
let snap: Snapshot;

before(async () => {
  const { raw, sources } = await collect(fixtureFetcher());
  snap = buildSnapshot(raw, sources, new Date("2026-10-18T12:00:00Z"));
  server = createApp(store, { corsOrigin: "*", maxStreams: 1 }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

test("before the first snapshot: the health address answers, the data says warming up", async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ready, false);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/v1/apps`)).status, 503);
});

test("after it: every endpoint answers, public and briefly cacheable", async () => {
  store.set(snap);
  for (const path of ["/v1/summary", "/v1/apps", "/v1/topology", "/v1/deploys", "/v1/certs", "/v1/snapshot"]) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.equal(res.headers.get("cache-control"), "public, max-age=5");
    assert.equal((await res.json()).generatedAt, snap.generatedAt);
  }
  assert.equal((await (await fetch(`${base}/v1/apps`)).json()).apps.length, 4);
  assert.equal((await fetch(`${base}/`)).headers.get("x-powered-by"), null);
});

test("read only: other methods are refused, a preflight is answered, unknown paths are 404", async () => {
  assert.equal((await fetch(`${base}/v1/apps`, { method: "POST" })).status, 405);
  assert.equal((await fetch(`${base}/v1/apps`, { method: "DELETE" })).status, 405);
  assert.equal((await fetch(`${base}/v1/apps`, { method: "OPTIONS" })).status, 204);
  assert.equal((await fetch(`${base}/v1/nope`)).status, 404);
});

test("the store signals a change only when more than the time changed", () => {
  let changes = 0;
  const s = new Store();
  s.on("change", () => changes++);
  s.set(snap);
  s.set({ ...snap, generatedAt: "2026-10-18T12:00:15Z" });
  assert.equal(changes, 1);
  s.set({ ...snap, apps: [] });
  assert.equal(changes, 2);
});

test("the stream sends the snapshot at once and on each change; one stream too many is refused", async () => {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/v1/stream`, { signal: ctrl.signal });
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  assert.equal((await fetch(`${base}/v1/stream`)).status, 503);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const readUntil = async (n: number) => {
    while ((text.match(/event: snapshot/g) ?? []).length < n) text += decoder.decode((await reader.read()).value);
  };
  await readUntil(1);
  store.set({ ...snap, deploys: [] });
  await readUntil(2);
  assert.match(text, /^retry: 3000/);
  ctrl.abort();
});
