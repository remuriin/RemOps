// Settings, all from the environment. In the cluster none are needed: the defaults are the pod's own
// view of the cluster API. For local runs see README.md.

function num(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be a whole number of at least ${min}`);
  return n;
}

export const PORT = num("PORT", 3000, 1);
// how often the cluster is read. Requests never reach the cluster: they get the last snapshot.
export const POLL_MS = num("POLL_MS", 15000, 2000);
export const KUBE_API = process.env.KUBE_API || "https://kubernetes.default.svc";
export const KUBE_TOKEN_FILE = process.env.KUBE_TOKEN_FILE || "/var/run/secrets/kubernetes.io/serviceaccount/token";
// a token given directly wins over the file (local runs only)
export const KUBE_TOKEN = process.env.KUBE_TOKEN || "";
export const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
// open live streams at once; more get a 503
export const MAX_STREAMS = num("MAX_STREAMS", 100, 1);
