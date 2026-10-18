import { createApp, Store } from "./app.js";
import { startPoller } from "./collect.js";
import { CORS_ORIGIN, MAX_STREAMS, POLL_MS, PORT } from "./config.js";
import { kubeFetcher } from "./kube.js";

const store = new Store();
const stop = startPoller(kubeFetcher(), POLL_MS, (s) => store.set(s));
const server = createApp(store, { corsOrigin: CORS_ORIGIN, maxStreams: MAX_STREAMS }).listen(PORT, () => {
  console.log(`remops listening on ${PORT}, reading the cluster every ${POLL_MS / 1000} s`);
});

// Kubernetes stops a pod with SIGTERM: finish what is in flight, then go
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    stop();
    server.close(() => process.exit(0));
    // open event streams would keep it waiting
    server.closeAllConnections();
  });
}
