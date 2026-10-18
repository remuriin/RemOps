import { SOURCES, type Fetcher, type SourceName } from "./kube.js";
import { buildSnapshot, type Snapshot } from "./public.js";

export type Raw = Record<SourceName, any[]>;
export type SourceState = Record<SourceName, "ok" | "unavailable">;

// One read of the cluster: every source at once. A source that fails (no permission yet, a CRD that
// is not installed, metrics-server restarting) is empty and marked unavailable; the rest still count.
export async function collect(fetcher: Fetcher): Promise<{ raw: Raw; sources: SourceState }> {
  const names = Object.keys(SOURCES) as SourceName[];
  const results = await Promise.allSettled(names.map((n) => fetcher(SOURCES[n])));
  const raw = {} as Raw;
  const sources = {} as SourceState;
  names.forEach((n, i) => {
    const r = results[i]!;
    const items = r.status === "fulfilled" ? (r.value as { items?: unknown }).items : undefined;
    raw[n] = Array.isArray(items) ? items : [];
    sources[n] = Array.isArray(items) ? "ok" : "unavailable";
  });
  return { raw, sources };
}

// Reads the cluster every `ms`, one read at a time (the next starts after the last one ends), and
// hands each snapshot on.
export function startPoller(fetcher: Fetcher, ms: number, onSnapshot: (s: Snapshot) => void): () => void {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const tick = async () => {
    try {
      const { raw, sources } = await collect(fetcher);
      onSnapshot(buildSnapshot(raw, sources, new Date()));
    } catch (err) {
      console.error("collect failed:", err instanceof Error ? err.message : err);
    }
    if (!stopped) timer = setTimeout(tick, ms);
  };
  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
