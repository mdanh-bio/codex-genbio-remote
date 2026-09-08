import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createOwnerStore } from "../lib/owner-store.js";
import { startTrackedJob } from "../lib/execution-core.js";
import { createJobRegistry } from "../lib/runtime-adapters.js";

test("completion persistence failure rejects the background result", async () => {
  const jobs = createJobRegistry();
  const state = { envelope: { target: "NHPC" }, policy: { hash: "test" }, runs: [] };
  const run = startTrackedJob({ jobs, exec: { agent: {}, saveState: async () => { throw new Error("disk unavailable"); } },
    state, project: "test", operation: "fetch", resources: { cpus: 0, gpus: 0, concurrency: 1 },
    runBody: async () => ({ exitCode: 0 }) });
  await assert.rejects(jobs.get(run.jobId).done, /disk unavailable/);
  assert.equal(run.persistenceError, "disk unavailable");
});

for (const fails of [false, true]) test("background project completion survives owner reload: failure=" + fails, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "genbio-completion-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createOwnerStore(root, "/workspace");
  const state = await store.create("a".repeat(64), { target: "NHPC" });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const jobs = createJobRegistry();
  const run = startTrackedJob({ jobs, exec: { agent: {}, saveState: () => store.save(state) },
    state, project: "test", operation: "fetch", resources: { cpus: 0, gpus: 0, concurrency: 1 },
    runBody: async () => { await gate; if (fails) throw new Error("fixture failure");
      return { exitCode: 0, stdout: "verified fixture" }; } });
  await store.save(state);
  release();
  await jobs.get(run.jobId).done;
  const loaded = await createOwnerStore(root, "/workspace").load(state.ownerHandle);
  assert.equal(loaded.runs[0].status, fails ? "failed" : "completed");
  assert.equal(loaded.runs[0].target, "NHPC");
  assert.ok(loaded.runs[0].finishedAt);
  if (fails) assert.equal(loaded.runs[0].error, "fixture failure");
  else assert.equal(loaded.runs[0].stdout, "verified fixture");
});

test("overlapping owner saves persist the final state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "genbio-save-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createOwnerStore(root, "/workspace");
  const state = await store.create("a".repeat(64), { target: "NHPC" });
  const saves = [];
  for (let i = 0; i < 20; i++) { state.sequence = i; saves.push(store.save(state)); }
  await Promise.all(saves);
  const loaded = await createOwnerStore(root, "/workspace").load(state.ownerHandle);
  assert.equal(loaded.sequence, 19);
});

test("owner persistence omits transient Map and Set launch guards", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "genbio-owner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createOwnerStore(root, "/workspace");
  const state = await store.create("a".repeat(64), { target: "genbioh100" });
  state.aizymeH100InFlight = new Set(["stage2"]);
  state.h100DirectInFlight = new Map([["project:operation", true]]);
  await store.save(state);
  const text = await readFile(join(root, "owners", `${state.ownerHandle}.json`), "utf8");
  assert.doesNotMatch(text, /aizymeH100InFlight|h100DirectInFlight/u);
});
