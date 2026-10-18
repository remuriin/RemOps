import { readFile } from "node:fs/promises";
import { KUBE_API, KUBE_TOKEN, KUBE_TOKEN_FILE } from "./config.js";

// One GET on the cluster's API, the same way RAG-API's agent does it: plain fetch with the pod's
// service-account token. The cluster's certificate authority reaches Node through NODE_EXTRA_CA_CERTS
// (set in the pod), so no client library is needed.
export type Fetcher = (path: string) => Promise<unknown>;

const CALL_TIMEOUT_MS = 10000;

export class KubeError extends Error {
  constructor(readonly path: string, readonly status: number) {
    super(`GET ${path}: ${status}`);
  }
}

export function kubeFetcher(): Fetcher {
  return async (path) => {
    // read on every call: the kubelet rotates the token in place
    const token = KUBE_TOKEN || (await readFile(KUBE_TOKEN_FILE, "utf-8")).trim();
    const res = await fetch(`${KUBE_API}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (!res.ok) throw new KubeError(path, res.status);
    return res.json();
  };
}

// Everything RemOps reads, and only that. Each is listed across all namespaces; the ClusterRole in
// Fleet (apps/ops/rbac.yaml) allows get and list on exactly these.
export const SOURCES = {
  namespaces: "/api/v1/namespaces",
  nodes: "/api/v1/nodes",
  pods: "/api/v1/pods",
  deployments: "/apis/apps/v1/deployments",
  replicasets: "/apis/apps/v1/replicasets",
  routes: "/apis/gateway.networking.k8s.io/v1/httproutes",
  kustomizations: "/apis/kustomize.toolkit.fluxcd.io/v1/kustomizations",
  canaries: "/apis/flagger.app/v1beta1/canaries",
  certificates: "/apis/cert-manager.io/v1/certificates",
  podMetrics: "/apis/metrics.k8s.io/v1beta1/pods",
  nodeMetrics: "/apis/metrics.k8s.io/v1beta1/nodes",
} as const;

export type SourceName = keyof typeof SOURCES;
