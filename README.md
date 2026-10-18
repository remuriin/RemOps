# RemOps

The live status of my k3s cluster as a read-only public API, at `https://ops.remservers.me`. It shows which apps run, whether they are healthy, how they connect, what was deployed and when, the certificates, and how much CPU and memory everything uses. It is headless: [MyPortfolio](../MyPortfolio) draws it.

## How it works

- Every 15 seconds it reads the cluster's API, once, and builds one snapshot in memory. Requests only ever get that snapshot, so public traffic never reaches the cluster. The front door rate-limits each visitor to 20 requests a second and 300 a minute.
- It only reads. Its account in the cluster (Fleet, `apps/ops/rbac.yaml`) may `get` and `list` namespaces, nodes, pods, deployments, replicasets, routes, Flux kustomizations, Flagger canaries, certificates and metrics. It has no access to secrets, configmaps, logs or exec, and it can't change anything.
- What goes out is picked field by field (`backend/src/public.ts`). Internal addresses, settings, secret names and the RAG clients' ids are never picked, and a last pass blanks anything shaped like a private IP or a UUID. The tests check this against a fixture cluster full of such values.
- No database: deploy history comes from the ReplicaSets Kubernetes keeps (the last 10 per app).

## Endpoints

All `GET`, JSON. CORS is open (`CORS_ORIGIN`, default `*`).

| Path | What |
|---|---|
| `/`, `/healthz` | answers while the process runs; `ready` says whether a snapshot exists |
| `/v1/summary` | the node (version, arch, capacity, use), counts, which sources could be read |
| `/v1/apps` | per app (one namespace): status, hosts, deployments (ready, restarts, image tag), use, Flux, blue-green |
| `/v1/topology` | nodes and edges to draw: internet, gateway, hosts, apps, outside services, Flux / Flagger / cert-manager |
| `/v1/deploys` | the newest 50 rollouts, newest first |
| `/v1/certs` | certificates and when they expire |
| `/v1/snapshot` | all of the above in one |
| `/v1/stream` | Server-Sent Events: the snapshot at once and on every change. The front door ends a request after 60 s; `EventSource` reconnects by itself |

Before the first snapshot the `/v1/*` paths answer `503`.

## How apps are connected

From annotations on each namespace, in Fleet next to the namespace:

```yaml
metadata:
  annotations:
    remops.remservers.me/name: Rem RaaS API                                # the label shown
    remops.remservers.me/depends-on: rem-raas-clients,postgres,gemini      # namespaces or outside services
    remops.remservers.me/kind: clients                                     # per-client services: a count only
```

A name in `depends-on` that is a namespace becomes an edge to that app; any other name becomes an outside service. A new app shows up by itself; its connections are one annotation.

## Running it

```bash
cd backend
npm ci
npm test                 # the tests, fixture cluster only
npm run dev:fixtures     # the API on the fixture cluster, http://localhost:3000
```

Against the real cluster, through `kubectl proxy` (your own access, not the pod's):

```bash
kubectl proxy --port 8001
KUBE_API=http://127.0.0.1:8001 KUBE_TOKEN=unused npm run dev
```

Settings (all optional): `PORT` (3000), `POLL_MS` (15000), `CORS_ORIGIN` (`*`), `MAX_STREAMS` (100), and for local runs `KUBE_API`, `KUBE_TOKEN`, `KUBE_TOKEN_FILE`.

## Deploying

It was launched with `Cluster/k8s-launch` as an API-only project: namespace `app-ops`, image `ghcr.io/remuriin/ops-api`. A push to `main` that touches `backend/` runs the checks (type check, tests), builds the image, and Flux rolls it out.
