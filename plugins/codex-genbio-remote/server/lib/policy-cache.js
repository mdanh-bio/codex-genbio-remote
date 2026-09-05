import { stat } from "node:fs/promises";

export function createPolicyAccessor(policyPath, loadPolicy, { readonlyTtlMs = 1000 } = {}) {
  let cached = null;
  let cachedStat = null;
  let cachedAt = 0;
  return async function getPolicy({ consequential = true } = {}) {
    const now = Date.now();
    const currentStat = await stat(policyPath);
    const unchanged = cached && cachedStat && currentStat.mtimeMs === cachedStat.mtimeMs && currentStat.size === cachedStat.size;
    if (!consequential && unchanged && now - cachedAt < readonlyTtlMs) return cached;
    const loaded = await loadPolicy(policyPath);
    cached = loaded;
    cachedStat = currentStat;
    cachedAt = now;
    return loaded;
  };
}
