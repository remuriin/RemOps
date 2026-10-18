import { SOURCES, type Fetcher, type SourceName } from "../src/kube.js";

// A small cluster shaped like the real one, as the API returns it. It carries things that must never
// reach the public output: internal addresses, settings, secret names, a client's id.
export const SENTINELS = ["10.0.0.135", "10.42.0.17", "10.43.0.81", "SENTINEL-SECRET-VALUE", "management-env", "ops-sa-token"];
export const CLIENT_ID = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b";
const T1 = "main-0123456789abcdef0123456789abcdef01234567-1791975494";
const T0 = "main-fedcba9876543210fedcba9876543210fedcba98-1791900000";

const ns = (name: string, annotations: Record<string, string> = {}) => ({ metadata: { name, annotations } });
const owner = (kind: string, name: string) => [{ kind, name }];

const deployment = (namespace: string, name: string, image: string, ready: number, replicas = 1) => ({
  metadata: { namespace, name, creationTimestamp: "2026-10-01T00:00:00Z" },
  spec: {
    replicas,
    template: {
      spec: {
        serviceAccountName: "ops-sa-token",
        containers: [{
          name,
          image,
          env: [{ name: "DB_HOST", value: "10.0.0.135" }, { name: "API_KEY", value: "SENTINEL-SECRET-VALUE" }],
          envFrom: [{ secretRef: { name: "management-env" } }],
        }],
      },
    },
  },
  status: { readyReplicas: ready },
});
const rs = (namespace: string, name: string, dep: string, image: string, at: string, replicas: number, revision: string) => ({
  metadata: {
    namespace, name, creationTimestamp: at, ownerReferences: owner("Deployment", dep),
    annotations: { "deployment.kubernetes.io/revision": revision },
  },
  spec: { template: { spec: { containers: [{ image }] } } },
  status: { replicas },
});
const pod = (namespace: string, name: string, rsName: string, restarts: number, phase = "Running") => ({
  metadata: { namespace, name, ownerReferences: owner("ReplicaSet", rsName) },
  spec: { nodeName: "rem-vm", containers: [{ env: [{ name: "DB_HOST", value: "10.0.0.135" }] }] },
  status: { phase, podIP: "10.42.0.17", hostIP: "10.0.0.135", containerStatuses: [{ restartCount: restarts }] },
});
const ready = { conditions: [{ type: "Ready", status: "True" }] };

const raasWeb = `ghcr.io/remuriin/raas-web:${T1}`;
const ragApi = `ghcr.io/remuriin/rag-api:${T1}`;

export const FIXTURES: Record<SourceName, { items: unknown[] }> = {
  namespaces: {
    items: [
      ns("kube-system"), ns("flux-system"), ns("flagger-system"), ns("envoy-gateway-system"), ns("cert-manager"),
      ns("rem-raas", { "remops.remservers.me/name": "Rem RaaS web", "remops.remservers.me/depends-on": "rem-raas-backend,firebase" }),
      ns("rem-raas-backend", { "remops.remservers.me/name": "Rem RaaS API", "remops.remservers.me/depends-on": "rem-raas-clients, postgres ,gemini,firebase,<script>" }),
      ns("rem-raas-clients", { "remops.remservers.me/name": "RAG client services", "remops.remservers.me/depends-on": "postgres,gemini" }),
      ns("rem-servers", { "remops.remservers.me/name": "<b>bad label</b>", "remops.remservers.me/depends-on": "postgres,pterodactyl" }),
    ],
  },
  nodes: {
    items: [{
      metadata: { name: "rem-vm", creationTimestamp: "2026-09-01T00:00:00Z" },
      status: {
        ...ready,
        addresses: [{ type: "InternalIP", address: "10.0.0.135" }],
        capacity: { cpu: "2", memory: "12249752Ki" },
        nodeInfo: { kubeletVersion: "v1.36.5+k3s1", osImage: "Ubuntu 22.04.5 LTS", architecture: "arm64" },
      },
    }],
  },
  pods: {
    items: [
      pod("rem-raas", "web-primary-abc12-x1", "web-primary-abc12", 0),
      pod("rem-raas-backend", "management-primary-def34-x1", "management-primary-def34", 2),
      pod("rem-raas-backend", "management-primary-def34-x2", "management-primary-def34", 1),
      pod("rem-raas-backend", "agent-ghi56-x1", "agent-ghi56", 0),
      pod("rem-raas-clients", `rag-${CLIENT_ID}-jkl78-x1`, `rag-${CLIENT_ID}-jkl78`, 0),
      pod("rem-servers", "api-primary-mno90-x1", "api-primary-mno90", 5, "Pending"),
      pod("kube-system", "coredns-1", "coredns-rs", 0),
    ],
  },
  deployments: {
    items: [
      deployment("rem-raas", "web", raasWeb, 0, 0),
      deployment("rem-raas", "web-primary", raasWeb, 1),
      deployment("rem-raas-backend", "management-primary", ragApi, 2, 2),
      deployment("rem-raas-backend", "agent", ragApi, 1),
      deployment("rem-raas-clients", `rag-${CLIENT_ID}`, ragApi, 1),
      deployment("rem-servers", "api-primary", "ghcr.io/remuriin/remservers-api@sha256:" + "a".repeat(64), 0),
      deployment("kube-system", "coredns", "rancher/mirrored-coredns-coredns:1.12.0", 1),
    ],
  },
  replicasets: {
    items: [
      rs("rem-raas", "web-primary-abc12", "web-primary", raasWeb, "2026-10-16T10:00:00Z", 1, "7"),
      rs("rem-raas", "web-primary-old11", "web-primary", `ghcr.io/remuriin/raas-web:${T0}`, "2026-10-10T10:00:00Z", 0, "6"),
      rs("rem-raas-backend", "management-primary-def34", "management-primary", ragApi, "2026-10-15T10:00:00Z", 2, "3"),
      rs("rem-raas-backend", "agent-ghi56", "agent", ragApi, "2026-10-15T10:01:00Z", 1, "3"),
      rs("rem-raas-clients", `rag-${CLIENT_ID}-jkl78`, `rag-${CLIENT_ID}`, ragApi, "2026-10-15T10:02:00Z", 1, "1"),
      rs("rem-servers", "api-primary-mno90", "api-primary", "ghcr.io/remuriin/remservers-api:main", "2026-10-14T10:00:00Z", 1, "2"),
      rs("kube-system", "coredns-rs", "coredns", "rancher/mirrored-coredns-coredns:1.12.0", "2026-09-01T00:00:00Z", 1, "1"),
    ],
  },
  routes: {
    items: [
      { metadata: { namespace: "rem-raas", name: "web" }, spec: { hostnames: ["rag.remservers.me", "rag.140-245-60-8.sslip.io"] } },
      { metadata: { namespace: "rem-raas-backend", name: "management" }, spec: { hostnames: ["rag.remservers.me"] } },
      { metadata: { namespace: "rem-raas-clients", name: `rag-${CLIENT_ID}` }, spec: { hostnames: ["rag.remservers.me"] } },
      { metadata: { namespace: "rem-servers", name: "portal" }, spec: { hostnames: ["portal.remservers.me"] } },
      { metadata: { namespace: "flux-system", name: "flux-route" }, spec: { hostnames: ["flux.remservers.me"] } },
    ],
  },
  kustomizations: {
    items: [
      {
        metadata: { namespace: "flux-system", name: "flux-system" },
        status: { ...ready, lastAppliedRevision: "main@sha1:0123456789abcdef0123456789abcdef01234567", inventory: { entries: [{ id: "_flux-system__Namespace" }, { id: "flux-system_raas_kustomize.toolkit.fluxcd.io_Kustomization" }] } },
      },
      {
        metadata: { namespace: "flux-system", name: "raas" },
        status: { ...ready, lastAppliedRevision: "main@sha1:0123456789abcdef0123456789abcdef01234567", inventory: { entries: [{ id: "_rem-raas__Namespace" }, { id: "rem-raas_web-primary_apps_Deployment" }] } },
      },
      {
        metadata: { namespace: "flux-system", name: "rag-api" },
        status: { ...ready, lastAppliedRevision: "main@sha1:0123456789abcdef0123456789abcdef01234567", inventory: { entries: [{ id: "_rem-raas-backend__Namespace" }, { id: "_rem-raas-clients__Namespace" }] } },
      },
      {
        metadata: { namespace: "flux-system", name: "rem-servers" },
        status: { conditions: [{ type: "Ready", status: "False" }], lastAppliedRevision: "main@sha1:0123456789abcdef0123456789abcdef01234567", inventory: { entries: [{ id: "rem-servers_api_apps_Deployment" }] } },
      },
    ],
  },
  canaries: {
    items: [
      { metadata: { namespace: "rem-raas", name: "web" }, status: { phase: "Succeeded" } },
      { metadata: { namespace: "rem-servers", name: "api" }, status: { phase: "Failed" } },
    ],
  },
  certificates: {
    items: [
      { metadata: { namespace: "envoy-gateway-system", name: "wildcard-remservers-me" }, spec: { dnsNames: ["*.remservers.me"], secretName: "wildcard-remservers-me-tls" }, status: { ...ready, notAfter: "2027-01-10T00:00:00Z" } },
    ],
  },
  podMetrics: {
    items: [
      { metadata: { namespace: "rem-raas", name: "web-primary-abc12-x1" }, containers: [{ usage: { cpu: "1500000n", memory: "8Mi" } }] },
      { metadata: { namespace: "rem-raas-backend", name: "management-primary-def34-x1" }, containers: [{ usage: { cpu: "12m", memory: "90112Ki" } }] },
      { metadata: { namespace: "rem-raas-backend", name: "management-primary-def34-x2" }, containers: [{ usage: { cpu: "8m", memory: "90112Ki" } }] },
    ],
  },
  nodeMetrics: {
    items: [{ metadata: { name: "rem-vm" }, usage: { cpu: "350m", memory: "4Gi" } }],
  },
};

const BY_PATH = new Map(Object.entries(SOURCES).map(([name, path]) => [path, name as SourceName]));

// stands in for the cluster: answers each source's path from FIXTURES; `deny` ones answer 403
export function fixtureFetcher(deny: SourceName[] = []): Fetcher {
  return async (path) => {
    const name = BY_PATH.get(path);
    if (!name || deny.includes(name)) throw new Error(`GET ${path}: 403`);
    return structuredClone(FIXTURES[name]);
  };
}
