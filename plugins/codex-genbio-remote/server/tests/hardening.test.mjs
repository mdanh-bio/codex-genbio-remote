import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, utimes, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPolicyAccessor } from "../lib/policy-cache.js";
import { loadPolicy } from "../lib/policy.js";
import { validateConfig, CONFIG_DEFAULTS } from "../lib/config.js";
import { createQuestionAdapter } from "../lib/runtime-adapters.js";
import { validateEnvelopeArgs } from "../lib/envelope.js";

test("policy reload sees same-size replacement with preserved timestamp and rejects invalid replacement", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "genbio-policy-refresh-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "policy.yaml");
  const text = await readFile(new URL("../fixtures/genbio-compute-policy.test.yaml", import.meta.url), "utf8");
  await writeFile(file, text);
  const get = createPolicyAccessor(file, loadPolicy);
  const first = await get(); const info = await stat(file);
  await writeFile(file, text.replace("updated:", "changed:"));
  await utimes(file, info.atime, info.mtime);
  assert.notEqual((await get({ consequential: true })).hash, first.hash);
  await writeFile(file, "broken: true");
  await assert.rejects(get(), /policy/);
  await writeFile(file, text);
  assert.equal((await get()).hash, first.hash);
});

test("numeric configuration accepts defaults and rejects invalid explicit values", () => {
  const base = { policyPath: "/tmp/policy", dataRoot: "/tmp/state" };
  const config = validateConfig(base);
  for (const [key, value] of Object.entries(CONFIG_DEFAULTS)) assert.equal(config[key], value);
  for (const key of Object.keys(CONFIG_DEFAULTS)) for (const value of [null, 0, -1, NaN, Infinity, 1.5, "30000", Number.MAX_SAFE_INTEGER]) assert.throws(() => validateConfig({ ...base, [key]: value }), new RegExp(key));
  assert.throws(() => validateConfig({ ...base, smokeRoots: { genbioh100: "/tmp/../other" } }), /smokeRoots/);
});

test("approval binds details and persists only exact positive responses", async () => {
  const questions = [{ id: "launch", header: "Launch", question: "Launch?", options: [{ label: "Approve", description: "Dispatch once" }, { label: "Reject", description: "No launch" }] }];
  for (const mode of ["accept", "decline", "cancel", "wrong-id", "string-true", "missing", "unavailable"]) {
    const receipts = []; let verified = 0;
    const server = { server: { elicitInput: async (request) => {
      assert.match(request.message, /policy_hash/);
      if (mode === "unavailable") throw new Error("no elicitation");
      if (mode === "missing") return undefined;
      return { action: ["accept", "wrong-id", "string-true"].includes(mode) ? "accept" : mode, content: { approved: mode === "string-true" ? "true" : true, approval_id: mode === "wrong-id" ? "wrong" : request.requestedSchema.properties.approval_id.enum[0] } };
    } } };
    const adapter = createQuestionAdapter(server, { getContext: async () => ({ policy_hash: "a".repeat(64), target: "HPC", owner_handle: "owner" }), persist: async (receipt) => receipts.push(receipt), verify: async () => { verified++; } });
    if (mode === "unavailable") await assert.rejects(adapter.ask({ questions }), /MCP elicitation failed.*no elicitation/);
    else assert.deepEqual((await adapter.ask({ questions })).answers[0].selected, [mode === "accept" ? "Approve" : "Reject"]);
    assert.equal(receipts.length, mode === "accept" ? 1 : 0);
    assert.equal(verified, mode === "accept" ? 1 : 0);
  }
});

test("approval uses a bounded extended elicitation timeout and preserves abort wiring", async () => {
  const questions = [{ id: "launch", header: "Launch", question: "Launch?", options: [{ label: "Approve", description: "Dispatch once" }, { label: "Reject", description: "No launch" }] }];
  let requestOptions;
  const server = { server: { elicitInput: async (_request, options) => {
    requestOptions = options;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { action: "accept", content: { approved: true, approval_id: _request.requestedSchema.properties.approval_id.enum[0] } };
  } } };
  const controller = new AbortController();
  const adapter = createQuestionAdapter(server, { getContext: async () => ({ policy_hash: "a".repeat(64) }) });
  const result = await adapter.ask({ questions, signal: controller.signal });
  assert.deepEqual(result.answers[0].selected, ["Approve"]);
  assert.equal(requestOptions.timeout, 300000);
  assert.equal(requestOptions.maxTotalTimeout, 300000);
  assert.equal(requestOptions.signal, controller.signal);
});

test("approval timeout remains fail-closed and does not persist", async () => {
  const questions = [{ id: "launch", question: "Launch?", options: [{ label: "Approve", description: "Dispatch once" }, { label: "Reject", description: "No launch" }] }];
  const receipts = [];
  const server = { server: { elicitInput: async () => { const error = new Error("Request timed out"); error.code = -1; throw error; } } };
  const adapter = createQuestionAdapter(server, { persist: async (receipt) => receipts.push(receipt), elicitationTimeoutMs: 1000 });
  await assert.rejects(adapter.ask({ questions }), /Request timed out/);
  assert.deepEqual(receipts, []);
});

test("envelopes require H100 memory and honor NHPC and CPU-only hard caps", async () => {
  const { policy } = await loadPolicy(new URL("../../skills/operate-genbio-hpc-remote/references/genbio-compute-policy.yaml", import.meta.url).pathname);
  const h100 = { target: "genbioh100", node: "genbioh100", max_cpus: 1, max_gpus: 0, concurrency: 1 };
  assert.throws(() => validateEnvelopeArgs(h100, policy), /mem_gb/);
  validateEnvelopeArgs({ ...h100, mem_gb: 1 }, policy);
  assert.throws(() => validateEnvelopeArgs({ ...h100, mem_gb: 33 }, policy), /memory/);
  assert.throws(() => validateEnvelopeArgs({ target: "NHPC", node: "gpu01", partition: "gpu", max_cpus: 81, max_gpus: 0, concurrency: 1 }, policy), /exceeds/);
  assert.throws(() => validateEnvelopeArgs({ target: "HPC", node: "cpu01", partition: "cpus", max_cpus: 1, max_gpus: 1, concurrency: 1 }, policy), /exceeds/);
});
