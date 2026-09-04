import assert from "node:assert/strict";
import test from "node:test";
import { createFinalizationRuntime } from "../lib/finalization.js";
test("finalization freezes redacted evidence and is idempotent", () => {
  const runtime = createFinalizationRuntime();
  const run = { runId: "r1", target: "genbioh100", operation: "direct", status: "completed", startedAt: 1, finishedAt: 2, policyHash: "a".repeat(64), terminalEvidence: "verified" };
  const first = runtime.finalize(run, { project: "demo", summary: "completed", artifacts: [{ kind: "report", location: "/safe/report.txt", sha256: "b".repeat(64) }] });
  assert.equal(runtime.finalize(run, { project: "changed", summary: "ignored" }), first);
  assert.match(first.hash, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(first.text, /token=|authorization|Bearer/u);
});
test("finalization rejects nonterminal and sensitive input", () => {
  const runtime = createFinalizationRuntime();
  assert.throws(() => runtime.finalize({ status: "running" }, { project: "p", summary: "s" }), /terminal/u);
  assert.throws(() => runtime.finalize({ runId: "r2", target: "HPC", operation: "x", status: "failed" }, { project: "p", summary: "api_key=secret" }), /sensitive/u);
});
test("publication unavailable preserves finalized compute state", async () => {
  const runtime = createFinalizationRuntime();
  const run = { runId: "r3", target: "HPC", operation: "x", status: "failed" };
  runtime.finalize(run, { project: "p", summary: "failed" });
  const out = await runtime.publish(run, "owner");
  assert.equal(out.status, "unavailable");
  assert.equal(run.status, "failed");
});
