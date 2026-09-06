import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createSmokeService, classifySmoke, smokeWrapper } from "../lib/smoke-launch.js";
import { createExecutionRegistry } from "../lib/execution-registry.js";
import { createOwnerStore } from "../lib/owner-store.js";
import { loadPolicy } from "../lib/policy.js";
import { assertTerminalEvidence } from "../lib/finalization.js";

const sha = (x) => createHash("sha256").update(x).digest("hex");
const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
function evidence(run, overrides = {}) {
  const values = { IDENTITY: `${run.token}|123|456`, EXIT: "0", CHECKSUM: "ok", WRAPPER_SHA: run.wrapperSha,
    RESULT_SHA: sha(`GENBIO_SMOKE_OK ${run.token}\n`), SQUEUE: "", PROCESS: "exited",
    SACCT: `${run.slurmJobId}|${run.uniqueJobName}|COMPLETED|0:0|00:01`, ...overrides };
  return Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n");
}
async function harness(t, target = "HPC") {
  const root = await mkdtemp(join(tmpdir(), "genbio-smoke-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const loaded = await loadPolicy(new URL("../../skills/operate-genbio-hpc-remote/references/genbio-compute-policy.yaml", import.meta.url).pathname);
  const owners = createOwnerStore(root, root);
  const direct = !["HPC", "NHPC"].includes(target);
  const envelope = { target, node: direct ? target : target === "HPC" ? "gpu04" : "gpu01", partition: direct ? null : target === "HPC" ? "gpus" : "gpu", maxCpus: 2, maxGpus: 0, concurrency: 1, memGb: direct ? 1 : null };
  const state = await owners.create(loaded.hash, envelope);
  const registry = createExecutionRegistry(join(root, "execution-registry"));
  const calls = []; let mode = "success", approval = true, policyValid = true;
  const runRemote = async (host, command) => {
    calls.push({ host, command });
    assert.equal(spawnSync("/bin/bash", ["-n"], { input: command }).status, 0, "every emitted SSH command must be syntactically valid");
    const run = state.runs.at(-1);
    assert.ok(await registry.find(run.runId), "durable reservation must precede remote access");
    if (command.includes("NODE_PROBE")) return ok(`NODE_PROBE=NodeName=${envelope.node} State=IDLE CPUTot=80 CPUAlloc=0 CfgTRES=cpu=80,gres/gpu=4 AllocTRES=cpu=0,gres/gpu=0`);
    if (command.includes("MEM_KB")) return ok("CPUS=16\nMEM_KB=67108864");
    if (command.includes("STAGED=")) {
      const wrapper = smokeWrapper(run);
      assert.equal(spawnSync("/bin/bash", ["-n"], { input: wrapper }).status, 0);
      if (mode === "stage-failure") throw new Error("stage transport failed");
      return ok(`STAGED=${run.token}`);
    }
    if (command.includes("sbatch --parsable wrapper.sh") || command.includes("setsid /bin/bash")) {
      const durable = await registry.find(run.runId);
      assert.equal(durable.workloadEvidence, "dispatch-intent-persisted");
      const disk = JSON.parse(await readFile(join(root, "owners", `${state.ownerHandle}.json`), "utf8"));
      assert.equal(disk.runs.at(-1).dispatchIssued, true);
      if (mode === "ambiguous") throw new Error("transport lost");
      if (mode === "empty-dispatch") return ok();
      return ok(direct ? "" : "12345\n");
    }
    if (command.includes("--name=")) return ok(`12345|${run.uniqueJobName}`);
    return ok(evidence(run, mode === "bad-output" ? { CHECKSUM: "missing" } : {}));
  };
  const deps = { config: { smokeTimeoutMs: 30000, logMaxBytes: 65536, smokeRoots: { [target]: "/approved/smoke" } }, registry, owners, runRemote,
    execFor: (s) => ({ __state: s }), requireRemoteAccess: async () => [],
    userQuestions: { ask: async () => ({ answers: [{ selected: [approval ? "Approve this launch" : "Reject"] }] }) },
    assertPolicy: async () => { if (!policyValid) throw new Error("policy changed"); return loaded; } };
  const args = { target, operation: target === "HPC" ? "gpu04-smoke" : "preflight-smoke", cpus: 1, gpus: 0, concurrency: 1, ...(direct ? { mem_gb: 1 } : {}) };
  return { root, state, owners, registry, calls, args, deps, service: createSmokeService(deps), mode: (x) => { mode = x; }, approve: (x) => { approval = x; }, policy: (x) => { policyValid = x; } };
}

for (const target of ["HPC", "NHPC", "genbio_mdanh", "genbioh100"]) test(`${target} smoke persists before dispatch and requires bound completion evidence`, async (t) => {
  const h = await harness(t, target);
  const run = await h.service.launch(h.state, h.args);
  assert.equal(run.status, "completed", run.error);
  assert.match(run.token, /^[a-f0-9]{32}$/u);
  assert.equal(run.terminalEvidence.checksumOk, true);
  assert.doesNotThrow(() => assertTerminalEvidence(run));
  assert.equal((await h.registry.find(run.runId)).allocationStatus, "terminal");
  const stdout = run.stdout;
  await h.service.monitor(h.state, run);
  assert.equal(run.stdout, stdout);
  assert.equal(h.calls.filter((x) => x.command.includes("sbatch --parsable wrapper.sh") || x.command.includes("setsid /bin/bash")).length, 1);
});

test("ambiguous submission survives restart, blocks another launch, and reconciles without replay", async (t) => {
  const h = await harness(t); h.mode("ambiguous");
  const run = await h.service.launch(h.state, h.args);
  assert.equal(run.status, "reconciling");
  await assert.rejects(h.service.launch(h.state, h.args), /durable active attempt/);
  const restartedOwners = createOwnerStore(h.root, h.root);
  const restored = await restartedOwners.load(h.state.ownerHandle);
  const service = createSmokeService({ ...h.deps, owners: restartedOwners, registry: createExecutionRegistry(join(h.root, "execution-registry")) });
  h.mode("success");
  // Mock remote evidence must reflect the recovered job id, not any live process.
  h.state.runs.at(-1).slurmJobId = "12345";
  const final = await service.monitor(restored, restored.runs[0]);
  assert.equal(final.status, "completed", final.error);
  assert.equal(h.calls.filter((x) => x.command.includes("sbatch --parsable wrapper.sh")).length, 1);
});

test("declined approval and policy failure cause zero remote calls", async (t) => {
  const h = await harness(t); h.approve(false);
  await assert.rejects(h.service.launch(h.state, h.args), /rejected/);
  h.approve(true); h.policy(false);
  await assert.rejects(h.service.launch(h.state, h.args), /policy changed/);
  assert.equal(h.calls.length, 0);
});

test("stage failure never dispatches; transport exit zero alone never completes", async (t) => {
  const h = await harness(t); h.mode("stage-failure");
  const run = await h.service.launch(h.state, h.args);
  assert.equal(run.status, "failed");
  assert.equal(run.terminalEvidence.dispatched, false);
  assert.equal(h.calls.filter((x) => x.command.includes("sbatch --parsable wrapper.sh")).length, 0);
  assert.equal(classifySmoke(run, ok()).status, "reconciling");
});

test("wrong identity, scheduler ownership, missing marker, or corrupt checksum never completes", async (t) => {
  const h = await harness(t); const run = await h.service.launch(h.state, h.args);
  for (const override of [{ IDENTITY: "wrong|123|456" }, { SACCT: `12345|another-job|COMPLETED|0:0|00:01` }, { EXIT: "pending" }, { CHECKSUM: "missing" }, { WRAPPER_SHA: "0".repeat(64) }, { RESULT_SHA: "0".repeat(64) }, { SQUEUE: `12345|${run.uniqueJobName}|RUNNING` }]) assert.notEqual(classifySmoke(run, ok(evidence(run, override))).status, "completed");
  assert.notEqual(classifySmoke(run, ok(evidence(run) + "\nIDENTITY=extra")).status, "completed");
});
