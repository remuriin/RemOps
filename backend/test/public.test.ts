import assert from "node:assert/strict";
import { test } from "node:test";
import { collect } from "../src/collect.js";
import { cpuMillicores, memoryMiB, parseImage, scrub, shortRevision, type Snapshot } from "../src/public.js";
import { buildSnapshot } from "../src/public.js";
import { CLIENT_ID, SENTINELS, fixtureFetcher } from "./fixtures.js";
import type { SourceName } from "../src/kube.js";

async function snapshot(deny: SourceName[] = []): Promise<Snapshot> {
  const { raw, sources } = await collect(fixtureFetcher(deny));
  return buildSnapshot(raw, sources, new Date("2026-10-18T12:00:00Z"));
}
const app = (s: Snapshot, ns: string) => s.apps.find((a) => a.namespace === ns)!;

test("nothing internal reaches the output: addresses, settings, secret names, client ids", async () => {
  const json = JSON.stringify(await snapshot());
  for (const s of [...SENTINELS, CLIENT_ID, "wildcard-remservers-me-tls", "podIP", "hostIP", "envFrom", "serviceAccountName"]) {
    assert.ok(!json.includes(s), `leaked: ${s}`);
  }
  assert.ok(!/\b10\.\d+\.\d+\.\d+\b/.test(json), "a 10.x address leaked");
});

test("apps are the non-system namespaces, with their labels and hosts", async () => {
  const s = await snapshot();
  assert.deepEqual(s.apps.map((a) => a.namespace), ["rem-raas", "rem-raas-backend", "rem-raas-clients", "rem-servers"]);
  assert.equal(app(s, "rem-raas").name, "Rem RaaS web");
  assert.deepEqual(app(s, "rem-raas").hosts, ["rag.140-245-60-8.sslip.io", "rag.remservers.me"]);
  // a label with markup is not shown: the namespace is
  assert.equal(app(s, "rem-servers").name, "rem-servers");
});

test("status: a scaled-down blue-green target is ignored, a down pod or failed canary counts", async () => {
  const s = await snapshot();
  assert.equal(app(s, "rem-raas").status, "healthy");
  assert.equal(app(s, "rem-raas-backend").status, "healthy");
  assert.equal(app(s, "rem-servers").status, "down");
  assert.deepEqual(app(s, "rem-servers").blueGreen, [{ name: "api", phase: "Failed" }]);
  assert.equal(app(s, "rem-servers").flux?.ready, false);
});

test("deployments: restarts from their pods, short image tags, digests named as such", async () => {
  const s = await snapshot();
  const mgmt = app(s, "rem-raas-backend").deployments.find((d) => d.name === "management-primary")!;
  assert.equal(mgmt.restarts, 3);
  assert.deepEqual(mgmt.image, { repository: "ghcr.io/remuriin/rag-api", tag: "main-0123456" });
  assert.equal(mgmt.since, "2026-10-15T10:00:00Z");
  assert.equal(app(s, "rem-servers").deployments[0]!.image?.tag, "digest");
});

test("client services are a count only: no names, no hosts, no deploys", async () => {
  const s = await snapshot();
  const c = app(s, "rem-raas-clients");
  assert.deepEqual(c.clients, { total: 1, ready: 1 });
  assert.deepEqual(c.deployments, []);
  assert.deepEqual(c.hosts, []);
  assert.ok(!s.deploys.some((d) => d.namespace === "rem-raas-clients"));
});

test("flux: each app's kustomization, found by the namespace it made", async () => {
  const s = await snapshot();
  assert.deepEqual(app(s, "rem-raas").flux, { name: "raas", ready: true, revision: "main@0123456" });
  assert.equal(app(s, "rem-raas-clients").flux?.name, "rag-api");
  assert.equal(app(s, "rem-servers").flux?.name, "rem-servers");
});

test("usage sums each app's pods; without metrics it is null, the rest still works", async () => {
  const s = await snapshot();
  assert.deepEqual(app(s, "rem-raas-backend").usage, { cpuMillicores: 20, memoryMiB: 176 });
  assert.deepEqual(app(s, "rem-raas").usage, { cpuMillicores: 2, memoryMiB: 8 });
  const noMetrics = await snapshot(["podMetrics"]);
  assert.equal(app(noMetrics, "rem-raas").usage, null);
  assert.equal(noMetrics.summary.sources.podMetrics, "unavailable");
  assert.equal(app(noMetrics, "rem-raas").status, "healthy");
});

test("depends-on: trimmed, only plain names, never itself", async () => {
  const s = await snapshot();
  assert.deepEqual(app(s, "rem-raas-backend").dependsOn, ["rem-raas-clients", "postgres", "gemini", "firebase"]);
});

test("topology: internet, gateway, hosts, apps, what they use, and the parts that run them", async () => {
  const { topology } = await snapshot();
  const has = (from: string, to: string, kind: string) =>
    topology.edges.some((e) => e.from === from && e.to === to && e.kind === kind);
  assert.ok(has("internet", "gateway", "routes"));
  assert.ok(has("gateway", "host:rag.remservers.me", "routes"));
  assert.ok(has("host:rag.remservers.me", "app:rem-raas", "serves"));
  assert.ok(has("host:rag.remservers.me", "app:rem-raas-backend", "serves"));
  assert.ok(has("app:rem-raas", "app:rem-raas-backend", "uses"));
  assert.ok(has("app:rem-raas-backend", "app:rem-raas-clients", "uses"));
  assert.ok(has("app:rem-raas-backend", "ext:postgres", "uses"));
  assert.ok(has("infra:flux", "app:rem-raas", "deploys"));
  assert.ok(has("infra:flagger", "app:rem-servers", "blue-green"));
  assert.ok(has("infra:cert-manager", "gateway", "certificates"));
  assert.equal(topology.nodes.find((n) => n.id === "app:rem-raas-clients")?.label, "RAG client services (1)");
  assert.ok(!topology.nodes.some((n) => n.id === "host:flux.remservers.me"), "a system route became a host");
  const ids = new Set(topology.nodes.map((n) => n.id));
  assert.ok(topology.edges.every((e) => ids.has(e.from) && ids.has(e.to)), "an edge points nowhere");
});

test("deploys: newest first, from the apps' ReplicaSets, the running one marked", async () => {
  const { deploys } = await snapshot();
  assert.deepEqual(deploys[0], { namespace: "rem-raas", deployment: "web-primary", revision: "7", tag: "main-0123456", at: "2026-10-16T10:00:00Z", active: true });
  assert.ok(deploys.some((d) => d.revision === "6" && !d.active && d.tag === "main-fedcba9"));
  assert.ok(!deploys.some((d) => d.namespace === "kube-system"));
});

test("summary: the node, its capacity and use, and the counts", async () => {
  const { summary, certificates } = await snapshot();
  assert.deepEqual(summary.nodes[0], {
    name: "rem-vm", ready: true, kubeletVersion: "v1.36.5+k3s1", osImage: "Ubuntu 22.04.5 LTS", architecture: "arm64",
    createdAt: "2026-09-01T00:00:00Z", capacity: { cpuMillicores: 2000, memoryMiB: 11963 }, usage: { cpuMillicores: 350, memoryMiB: 4096 },
  });
  assert.deepEqual(summary.counts, { apps: 4, pods: 6, podsRunning: 5, routes: 5, certificates: 1 });
  assert.deepEqual(certificates, [{ name: "wildcard-remservers-me", namespace: "envoy-gateway-system", dnsNames: ["*.remservers.me"], notAfter: "2027-01-10T00:00:00Z", ready: true }]);
});

test("a cluster that cannot be read at all still gives a snapshot, every source unavailable", async () => {
  const { raw, sources } = await collect(async () => { throw new Error("403"); });
  const s = buildSnapshot(raw, sources, new Date());
  assert.deepEqual(s.apps, []);
  assert.ok(Object.values(s.summary.sources).every((v) => v === "unavailable"));
});

test("quantities, images, revisions and the scrub", () => {
  assert.equal(cpuMillicores("250m"), 250);
  assert.equal(cpuMillicores("2"), 2000);
  assert.equal(cpuMillicores("1500000n"), 1.5);
  assert.equal(cpuMillicores("junk"), 0);
  assert.equal(memoryMiB("1Gi"), 1024);
  assert.equal(memoryMiB("2048Ki"), 2);
  assert.equal(memoryMiB(String(1024 * 1024)), 1);
  assert.deepEqual(parseImage("nginx"), { repository: "nginx", tag: "latest" });
  assert.deepEqual(parseImage("localhost:5000/x:1.2"), { repository: "localhost:5000/x", tag: "1.2" });
  assert.equal(shortRevision("main@sha1:0123456789abcdef0123456789abcdef01234567"), "main@0123456");
  assert.deepEqual(scrub({ a: ["at 10.0.0.1 and 192.168.1.9", `id ${CLIENT_ID}`], b: 3 }), { a: ["at [ip] and [ip]", "id [id]"], b: 3 });
  assert.equal(scrub("140.245.60.8"), "140.245.60.8");
});
