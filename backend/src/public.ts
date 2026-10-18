import type { Raw, SourceState } from "./collect.js";

// What the world sees. Every field here is picked by hand from the cluster's objects; a raw object
// never passes through. Things that must never show (internal addresses, settings, secret names,
// client ids) are simply never picked, and scrub() at the end catches anything that slips by.

export type Status = "healthy" | "degraded" | "down" | "unknown";
export interface Usage { cpuMillicores: number; memoryMiB: number }
export interface ImageView { repository: string; tag: string }
export interface DeploymentView {
  name: string;
  ready: number;
  desired: number;
  restarts: number;
  image: ImageView | null;
  since: string | null;
}
export interface AppView {
  namespace: string;
  name: string;
  status: Status;
  hosts: string[];
  deployments: DeploymentView[];
  // a namespace of per-client services is shown as a count, never by name
  clients: { total: number; ready: number } | null;
  usage: Usage | null;
  flux: { name: string; ready: boolean; revision: string | null } | null;
  blueGreen: { name: string; phase: string }[];
  dependsOn: string[];
}
export interface NodeView {
  name: string;
  ready: boolean;
  kubeletVersion: string | null;
  osImage: string | null;
  architecture: string | null;
  createdAt: string | null;
  capacity: Usage;
  usage: Usage | null;
}
export interface DeployView {
  namespace: string;
  deployment: string;
  revision: string | null;
  tag: string | null;
  at: string | null;
  active: boolean;
}
export interface CertificateView {
  name: string;
  namespace: string;
  dnsNames: string[];
  notAfter: string | null;
  ready: boolean;
}
export interface TopologyNode {
  id: string;
  kind: "internet" | "gateway" | "host" | "app" | "infra" | "external";
  label: string;
  status?: Status;
}
export interface TopologyEdge { from: string; to: string; kind: "routes" | "serves" | "uses" | "deploys" | "blue-green" | "certificates" }
export interface Snapshot {
  generatedAt: string;
  summary: {
    nodes: NodeView[];
    counts: { apps: number; pods: number; podsRunning: number; routes: number; certificates: number };
    sources: SourceState;
  };
  apps: AppView[];
  topology: { nodes: TopologyNode[]; edges: TopologyEdge[] };
  deploys: DeployView[];
  certificates: CertificateView[];
}

// the cluster's own parts: shown as infrastructure, never as apps
const SYSTEM = new Set([
  "default", "kube-system", "kube-public", "kube-node-lease",
  "flux-system", "flagger-system", "envoy-gateway-system", "cert-manager",
]);
const INFRA: { namespace: string; id: string; label: string }[] = [
  { namespace: "flux-system", id: "infra:flux", label: "Flux" },
  { namespace: "flagger-system", id: "infra:flagger", label: "Flagger" },
  { namespace: "cert-manager", id: "infra:cert-manager", label: "cert-manager" },
];
const GATEWAY_NS = "envoy-gateway-system";

// The namespace annotations RemOps reads (set in Fleet, next to each namespace):
//   remops.remservers.me/name        the label to show (else the namespace)
//   remops.remservers.me/depends-on  "a,b": other namespaces, or outside services (postgres, gemini)
//   remops.remservers.me/kind        "clients": per-client services, shown as a count only
const A = "remops.remservers.me/";
// rem raas's client services are a count even before their namespace carries the annotation
const CLIENT_NAMESPACES = new Set(["rem-raas-clients"]);
const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
// a label to show: plain words only, so an annotation cannot carry markup to whoever draws it
const LABEL_RE = /^[\w .()&-]{1,40}$/;
const DEPLOYS_SHOWN = 50;

const meta = (o: any): any => o?.metadata ?? {};
const nsOf = (o: any): string => meta(o).namespace ?? "";
const isReady = (o: any): boolean =>
  (o?.status?.conditions ?? []).some((c: any) => c?.type === "Ready" && c?.status === "True");
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    m.set(k, [...(m.get(k) ?? []), it]);
  }
  return m;
}

// --- quantities, as Kubernetes writes them ---

export function cpuMillicores(q: unknown): number {
  const m = /^([0-9]+(?:\.[0-9]+)?)(n|u|m|k|M|G)?$/.exec(String(q ?? ""));
  if (!m) return 0;
  const v = Number(m[1]);
  const scale: Record<string, number> = { n: 1e-6, u: 1e-3, m: 1, "": 1000, k: 1e6, M: 1e9, G: 1e12 };
  return v * scale[m[2] ?? ""]!;
}

export function memoryMiB(q: unknown): number {
  const m = /^([0-9]+(?:\.[0-9]+)?)(Ki|Mi|Gi|Ti|k|M|G|T)?$/.exec(String(q ?? ""));
  if (!m) return 0;
  const v = Number(m[1]);
  const bytes: Record<string, number> = {
    "": 1, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, k: 1e3, M: 1e6, G: 1e9, T: 1e12,
  };
  return (v * bytes[m[2] ?? ""]!) / 1024 ** 2;
}

const round = (u: Usage): Usage => ({
  cpuMillicores: Math.round(u.cpuMillicores),
  memoryMiB: Math.round(u.memoryMiB),
});

function sumUsage(containers: any[]): Usage {
  return containers.reduce<Usage>(
    (acc, c) => ({
      cpuMillicores: acc.cpuMillicores + cpuMillicores(c?.usage?.cpu),
      memoryMiB: acc.memoryMiB + memoryMiB(c?.usage?.memory),
    }),
    { cpuMillicores: 0, memoryMiB: 0 },
  );
}

// --- images and revisions ---

export function parseImage(image: unknown): ImageView | null {
  const s = str(image);
  if (!s) return null;
  const at = s.indexOf("@");
  if (at >= 0) return { repository: s.slice(0, at), tag: "digest" };
  const colon = s.lastIndexOf(":");
  const hasTag = colon > s.lastIndexOf("/");
  return { repository: hasTag ? s.slice(0, colon) : s, tag: shortTag(hasTag ? s.slice(colon + 1) : "latest") };
}

// main-<40 hex>-<time> and bare commit hashes become their short commit
export function shortTag(tag: string): string {
  const flux = /^main-([0-9a-f]{40})-[0-9]+$/.exec(tag);
  if (flux) return `main-${flux[1]!.slice(0, 7)}`;
  return /^[0-9a-f]{40}$/.test(tag) ? tag.slice(0, 7) : tag;
}

// Flux writes "main@sha1:<40 hex>"
export function shortRevision(rev: unknown): string | null {
  const s = str(rev);
  if (!s) return null;
  const m = /^(.*)@sha1:([0-9a-f]{40})$/.exec(s);
  return m ? `${m[1]}@${m[2]!.slice(0, 7)}` : s;
}

// --- the last line of defence: anything shaped like an internal address or an id is blanked ---

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const PRIVATE_IP_RE =
  /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g;
const LONG_HEX_RE = /\b[0-9a-f]{64}\b/gi;

export function scrub<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(UUID_RE, "[id]").replace(PRIVATE_IP_RE, "[ip]").replace(LONG_HEX_RE, "[hash]") as T;
  }
  if (Array.isArray(value)) return value.map(scrub) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)])) as T;
  }
  return value;
}

// --- the snapshot ---

export function buildSnapshot(raw: Raw, sources: SourceState, now: Date): Snapshot {
  const namespaces = raw.namespaces.map((n) => ({ name: String(meta(n).name ?? ""), ann: meta(n).annotations ?? {} }));
  const nsNames = new Set(namespaces.map((n) => n.name));
  const appNamespaces = namespaces.filter((n) => n.name && !SYSTEM.has(n.name));
  const appNames = new Set(appNamespaces.map((n) => n.name));

  // which Deployment each ReplicaSet and pod belongs to
  const rsOwner = new Map<string, string>();
  for (const rs of raw.replicasets) {
    const owner = (meta(rs).ownerReferences ?? []).find((o: any) => o?.kind === "Deployment");
    if (owner) rsOwner.set(`${nsOf(rs)}/${meta(rs).name}`, String(owner.name));
  }
  const deploymentOfPod = (p: any): string | null => {
    const owner = (meta(p).ownerReferences ?? []).find((o: any) => o?.kind === "ReplicaSet");
    return owner ? rsOwner.get(`${nsOf(p)}/${owner.name}`) ?? null : null;
  };
  const restarts = new Map<string, number>();
  for (const p of raw.pods) {
    const d = deploymentOfPod(p);
    if (!d) continue;
    const n = (p?.status?.containerStatuses ?? []).reduce((a: number, c: any) => a + (Number(c?.restartCount) || 0), 0);
    const k = `${nsOf(p)}/${d}`;
    restarts.set(k, (restarts.get(k) ?? 0) + n);
  }
  const rsByDeployment = groupBy(
    raw.replicasets.filter((rs) => rsOwner.has(`${nsOf(rs)}/${meta(rs).name}`)),
    (rs) => `${nsOf(rs)}/${rsOwner.get(`${nsOf(rs)}/${meta(rs).name}`)}`,
  );
  const newestRs = (key: string): any =>
    [...(rsByDeployment.get(key) ?? [])]
      .filter((rs) => (Number(rs?.status?.replicas) || 0) > 0)
      .sort((a, b) => String(meta(b).creationTimestamp).localeCompare(String(meta(a).creationTimestamp)))[0];

  // which Flux Kustomization made each namespace: its inventory lists the Namespace object
  // ("_<name>__Namespace"), else the objects inside it ("<namespace>_<name>_<group>_<kind>")
  const fluxOf = new Map<string, any>();
  for (const k of raw.kustomizations) {
    for (const e of k?.status?.inventory?.entries ?? []) {
      const [, name, , kind] = String(e?.id ?? "").split("_");
      if (kind === "Namespace" && name) fluxOf.set(name, k);
    }
  }
  for (const k of raw.kustomizations) {
    if (meta(k).name === "flux-system") continue;
    for (const e of k?.status?.inventory?.entries ?? []) {
      const ns = String(e?.id ?? "").split("_")[0];
      if (ns && !fluxOf.has(ns)) fluxOf.set(ns, k);
    }
  }

  const deploymentsByNs = groupBy(raw.deployments, nsOf);
  const routesByNs = groupBy(raw.routes, nsOf);
  const canariesByNs = groupBy(raw.canaries, nsOf);
  const metricsByNs = groupBy(raw.podMetrics, nsOf);
  const metricsOk = sources.podMetrics === "ok";

  const apps: AppView[] = appNamespaces
    .map(({ name: ns, ann }) => {
      const isClients = CLIENT_NAMESPACES.has(ns) || ann[`${A}kind`] === "clients";
      const deployments: DeploymentView[] = (deploymentsByNs.get(ns) ?? [])
        .map((d) => {
          const key = `${ns}/${meta(d).name}`;
          const rs = newestRs(key);
          return {
            name: String(meta(d).name),
            ready: Number(d?.status?.readyReplicas) || 0,
            desired: d?.spec?.replicas === undefined ? 1 : Number(d.spec.replicas) || 0,
            restarts: restarts.get(key) ?? 0,
            image: parseImage(d?.spec?.template?.spec?.containers?.[0]?.image),
            since: str(meta(rs ?? d).creationTimestamp),
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      const running = deployments.filter((d) => d.desired > 0);
      const k = fluxOf.get(ns);
      const flux = k ? { name: String(meta(k).name), ready: isReady(k), revision: shortRevision(k?.status?.lastAppliedRevision) } : null;
      const blueGreen = (canariesByNs.get(ns) ?? [])
        .map((c) => ({ name: String(meta(c).name), phase: String(c?.status?.phase ?? "Unknown") }))
        .sort((a, b) => a.name.localeCompare(b.name));

      let status: Status = "unknown";
      if (running.length > 0) {
        const up = running.filter((d) => d.ready > 0).length;
        const full = running.every((d) => d.ready >= d.desired);
        if (up === 0) status = "down";
        else if (!full || (flux && !flux.ready) || blueGreen.some((c) => c.phase === "Failed")) status = "degraded";
        else status = "healthy";
      }

      const dependsOn = String(ann[`${A}depends-on`] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => NAME_RE.test(s) && s !== ns);

      return {
        namespace: ns,
        name: LABEL_RE.test(String(ann[`${A}name`] ?? "")) ? String(ann[`${A}name`]) : ns,
        status,
        hosts: isClients
          ? []
          : [...new Set((routesByNs.get(ns) ?? []).flatMap((r) => (r?.spec?.hostnames ?? []).map(String)))].sort(),
        deployments: isClients ? [] : deployments,
        clients: isClients
          ? { total: running.length, ready: running.filter((d) => d.ready >= d.desired).length }
          : null,
        usage: metricsOk ? round(sumUsage((metricsByNs.get(ns) ?? []).flatMap((p) => p?.containers ?? []))) : null,
        flux,
        blueGreen,
        dependsOn: [...new Set(dependsOn)],
      };
    })
    .sort((a, b) => a.namespace.localeCompare(b.namespace));

  const nodeMetrics = new Map(raw.nodeMetrics.map((m) => [String(meta(m).name), m]));
  const nodes: NodeView[] = raw.nodes.map((n) => {
    const m = nodeMetrics.get(String(meta(n).name));
    return {
      name: String(meta(n).name),
      ready: isReady(n),
      kubeletVersion: str(n?.status?.nodeInfo?.kubeletVersion),
      osImage: str(n?.status?.nodeInfo?.osImage),
      architecture: str(n?.status?.nodeInfo?.architecture),
      createdAt: str(meta(n).creationTimestamp),
      capacity: round({ cpuMillicores: cpuMillicores(n?.status?.capacity?.cpu), memoryMiB: memoryMiB(n?.status?.capacity?.memory) }),
      usage: m ? round({ cpuMillicores: cpuMillicores(m?.usage?.cpu), memoryMiB: memoryMiB(m?.usage?.memory) }) : null,
    };
  });

  const clientNs = new Set(apps.filter((a) => a.clients).map((a) => a.namespace));
  const deploys: DeployView[] = [...rsByDeployment.entries()]
    .filter(([key]) => appNames.has(key.split("/")[0]!) && !clientNs.has(key.split("/")[0]!))
    .flatMap(([key, list]) =>
      list.map((rs) => ({
        namespace: key.split("/")[0]!,
        deployment: key.split("/")[1]!,
        revision: str(meta(rs).annotations?.["deployment.kubernetes.io/revision"]),
        tag: parseImage(rs?.spec?.template?.spec?.containers?.[0]?.image)?.tag ?? null,
        at: str(meta(rs).creationTimestamp),
        active: (Number(rs?.status?.replicas) || 0) > 0,
      })),
    )
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, DEPLOYS_SHOWN);

  const certificates: CertificateView[] = raw.certificates
    .map((c) => ({
      name: String(meta(c).name),
      namespace: nsOf(c),
      dnsNames: (c?.spec?.dnsNames ?? []).map(String),
      notAfter: str(c?.status?.notAfter),
      ready: isReady(c),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const pods = raw.pods.filter((p) => appNames.has(nsOf(p)));
  const snapshot: Snapshot = {
    generatedAt: now.toISOString(),
    summary: {
      nodes,
      counts: {
        apps: apps.length,
        pods: pods.length,
        podsRunning: pods.filter((p) => p?.status?.phase === "Running").length,
        routes: raw.routes.length,
        certificates: certificates.length,
      },
      sources,
    },
    apps,
    topology: buildTopology(apps, nsNames),
    deploys,
    certificates,
  };
  return scrub(snapshot);
}

// internet -> gateway -> hosts -> apps -> what they use, and the parts of the cluster that run them
export function buildTopology(apps: AppView[], namespaces: Set<string>): Snapshot["topology"] {
  const nodes = new Map<string, TopologyNode>();
  const edges = new Map<string, TopologyEdge>();
  const node = (n: TopologyNode) => nodes.has(n.id) || nodes.set(n.id, n);
  const edge = (e: TopologyEdge) => edges.set(`${e.from}>${e.to}`, e);
  const appIds = new Set(apps.map((a) => a.namespace));

  node({ id: "internet", kind: "internet", label: "Internet" });
  const front = namespaces.has(GATEWAY_NS) ? "gateway" : "internet";
  if (front === "gateway") {
    node({ id: "gateway", kind: "gateway", label: "Envoy Gateway" });
    edge({ from: "internet", to: "gateway", kind: "routes" });
  }
  for (const app of apps) {
    const id = `app:${app.namespace}`;
    node({
      id,
      kind: "app",
      label: app.clients ? `${app.name} (${app.clients.total})` : app.name,
      status: app.status,
    });
    for (const h of app.hosts) {
      node({ id: `host:${h}`, kind: "host", label: h });
      edge({ from: front, to: `host:${h}`, kind: "routes" });
      edge({ from: `host:${h}`, to: id, kind: "serves" });
    }
    for (const dep of app.dependsOn) {
      const to = appIds.has(dep) ? `app:${dep}` : `ext:${dep}`;
      if (!appIds.has(dep)) node({ id: to, kind: "external", label: dep });
      edge({ from: id, to, kind: "uses" });
    }
  }
  for (const infra of INFRA) {
    if (!namespaces.has(infra.namespace)) continue;
    node({ id: infra.id, kind: "infra", label: infra.label });
  }
  for (const app of apps) {
    if (app.flux && nodes.has("infra:flux")) edge({ from: "infra:flux", to: `app:${app.namespace}`, kind: "deploys" });
    if (app.blueGreen.length && nodes.has("infra:flagger"))
      edge({ from: "infra:flagger", to: `app:${app.namespace}`, kind: "blue-green" });
  }
  if (nodes.has("infra:cert-manager") && nodes.has("gateway"))
    edge({ from: "infra:cert-manager", to: "gateway", kind: "certificates" });

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}
