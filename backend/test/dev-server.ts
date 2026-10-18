// npm run dev:fixtures: the API on the fixture cluster, no cluster needed
import { createApp, Store } from "../src/app.js";
import { startPoller } from "../src/collect.js";
import { fixtureFetcher } from "./fixtures.js";

const port = Number(process.env.PORT) || 3000;
const store = new Store();
startPoller(fixtureFetcher(), 5000, (s) => store.set(s));
createApp(store, { corsOrigin: "*", maxStreams: 10 }).listen(port, () => {
  console.log(`remops (fixtures) on http://localhost:${port}`);
});
