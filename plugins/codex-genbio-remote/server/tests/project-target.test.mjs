import test from "node:test";
import assert from "node:assert/strict";
import { parseProjectManifest, resolveRecipe, buildOperationPlan } from "../lib/project.js";
import { validatePinnedSbatch } from "../lib/slurm-policy.js";
import { reconcileSubmission, validateEnvelope, statusJob, cancelOwnedJob } from "../lib/execution-core.js";
import { startTrackedJob } from "../lib/execution-core.js";
import { fetchArtifacts } from "../lib/execution-core.js";
import { stageRecipeWrapper } from "../lib/execution-core.js";

test("NHPC wrapper directory transport ambiguity is never retried", async () => {
  let calls = 0;
  await assert.rejects(stageRecipeWrapper({
    manifest: { target: "NHPC", project: "test", remoteRoot: "/approved/test" },
    wrapperBytes: "#!/bin/bash\ntrue\n", operation: "run", manifestSha: "a".repeat(64),
    exec: {}, config: {},
    shell: { resolve: () => assert.fail("no upload after ambiguous mkdir") },
    runRemote: async (target, command) => {
      calls++; assert.equal(target, "NHPC"); assert.match(command, /mkdir -p/u);
      return { exitCode: 255, stderr: "Connection reset" };
    }
  }), /failed to create remote/);
  assert.equal(calls, 1);
});
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

test("NHPC fetch uses only NHPC transport and publishes verified nested destination", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "genbio-target-fetch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const body = "fixture\n";
  const hash = createHash("sha256").update(body).digest("hex");
  let reads = 0;
  let transfers = 0;
  const result = await fetchArtifacts({
    manifest: { target: "NHPC", project: "test", remoteRoot: "/approved/test", localRoot: root,
      fetch: { files: ["report.txt"], maxBytes: 1024, dest: "nested/output" } },
    exec: {}, config: {},
    userQuestions: { ask: async ({ questions }) => ({ answers: [{ id: questions[0].id, selected: ["Approve this retrieval"] }] }) },
    runRemote: async (target, command) => {
      reads++; assert.equal(target, "NHPC"); assert.match(command, /-- NHPC /u);
      return { exitCode: 0, stdout: "OK|report.txt|8|" + hash };
    },
    shell: { resolve: (request) => request, run: async ({ command }) => {
      transfers++; assert.match(command, /nhpc:\/approved\/test\/report.txt/u);
      assert.doesNotMatch(command, / hpc:/u);
      const destination = command.match(/'([^']+)'$/u)?.[1];
      assert.ok(destination);
      await writeFile(destination, body);
      return { exitCode: 0 };
    } }
  });
  assert.equal(reads, 2); assert.equal(transfers, 1);
  assert.equal(await readFile(join(root, "nested/output/report.txt"), "utf8"), body);
  const receipt = JSON.parse(await readFile(result.receiptPath, "utf8"));
  assert.equal(receipt.rclone_remote, "nhpc");
  assert.equal(receipt.files[0].sha256, hash);
});

for (const row of ["noise", "MISSING|report.txt", "OK|report.txt|1e3|", "OK|other.txt|1|"]) {
  test("NHPC fetch rejects malformed discovery before approval or transfer: " + row, async () => {
    let calls = 0;
    await assert.rejects(fetchArtifacts({
      manifest: { target: "NHPC", project: "test", remoteRoot: "/approved/test",
        localRoot: "/tmp/test", fetch: { files: ["report.txt"], maxBytes: 1024, dest: "output" } },
      exec: {}, config: {}, userQuestions: { ask: () => assert.fail("unexpected approval") },
      shell: { run: () => assert.fail("unexpected transfer") },
      runRemote: async (target, command) => {
        calls++; assert.equal(target, "NHPC"); assert.match(command, /-- NHPC /u);
        return { exitCode: 0, stdout: row + "a".repeat(64) };
      }
    }), /discovery evidence/);
    assert.equal(calls, 1);
  });
}

test("NHPC fetch rejects duplicate discovery rows before transfer", async () => {
  const row = "OK|report.txt|1|" + "a".repeat(64);
  await assert.rejects(fetchArtifacts({
    manifest: { target: "NHPC", project: "test", remoteRoot: "/approved/test",
      fetch: { files: ["report.txt"], maxBytes: 1024, dest: "output" } },
    exec: {}, config: {}, runRemote: async () => ({ exitCode: 0, stdout: row + "\n" + row })
  }), /duplicate remote artifact/);
});

test("tracked run identities are target-bound and independent of clock resolution", (t) => {
  t.mock.method(Date, "now", () => 1234);
  const kinds = [];
  const jobs = { start: ({ kind }) => { kinds.push(kind); return "test"; } };
  const state = { envelope: { target: "NHPC" }, policy: { hash: "test" }, runs: [] };
  const args = { jobs, exec: { agent: {} }, state, project: "test", operation: "fetch",
    resources: { cpus: 0, gpus: 0, concurrency: 1 }, runBody: async () => ({ exitCode: 0 }) };
  const first = startTrackedJob(args);
  const second = startTrackedJob(args);
  assert.match(first.runId, /^NHPC-project-[a-f0-9]{32}$/u);
  assert.notEqual(first.runId, second.runId);
  assert.equal(first.startedAt, second.startedAt);
  assert.deepEqual(kinds, ["genbio-NHPC-project", "genbio-NHPC-project"]);
});

const policy = { targets: {
  HPC: { allowlist: { gpu04: { partition: "gpus" } }, test_gate: { real_submission: "gpu04" } },
  NHPC: { allowlist: { gpu01: { partition: "gpu" } }, test_gate: { real_submission: "gpu01" } }
} };
const raw = { schema_version: 2, project: "test", local_root: "/tmp/test",
  remote_root: "/approved/test", files: ["run.sh"], jobs: {
    run: { cpus: 4, gpus: 1, recipe: { name: "test", script: "run.sh" } }
  } };
const envelope = (target) => ({ target, node: target === "NHPC" ? "gpu01" : "gpu04",
  partition: target === "NHPC" ? "gpu" : "gpus", maxCpus: 8, maxGpus: 1, concurrency: 1 });

for (const target of ["HPC", "NHPC"]) test(target + " recipe binds target, node, partition and hash", () => {
  const manifest = parseProjectManifest("test", { ...raw, target });
  const resolution = resolveRecipe({ manifest, operation: "run", policy, envelope: envelope(target) });
  assert.equal(resolution.target, target);
  assert.equal(resolution.node, envelope(target).node);
  validatePinnedSbatch(resolution.sbatchText, manifest.jobs.run, { policy, envelope: envelope(target), target });
  const args = { project: "test", operation: "run", policyHash: "a".repeat(64), manifestSha: "b".repeat(64), packageSha: "c".repeat(64), resolution };
  const built = buildOperationPlan(args);
  assert.equal(built.plan.target, target);
  assert.notEqual(built.planHash, buildOperationPlan({ ...args, resolution: { ...resolution, target: target === "HPC" ? "NHPC" : "HPC" } }).planHash);
  assert.throws(() => resolveRecipe({ manifest, operation: "run", policy, envelope: envelope(target === "HPC" ? "NHPC" : "HPC") }), /target.*envelope/);
  assert.doesNotThrow(() => validateEnvelope({ envelope: envelope(target) }, { cpus: 4, gpus: 1, concurrency: 1 }, target));
});

test("legacy manifest remains HPC; invalid explicit targets never default", () => {
  const manifest = parseProjectManifest("test", raw);
  assert.equal(Object.hasOwn(manifest, "target"), false);
  assert.equal(resolveRecipe({ manifest, operation: "run", policy, envelope: envelope("HPC") }).target, "HPC");
  for (const target of [null, "", "hpc", "genbioh100", "NHPC;bad"]) {
    assert.throws(() => parseProjectManifest("test", { ...raw, target }), /target/);
  }
});

test("NHPC reconciliation never invokes HPC transport", async () => {
  const calls = [];
  await reconcileSubmission({ target: "NHPC", jobName: "test.12345678", exec: {},
    runRemote: async (target, command) => {
      calls.push({ target, command });
      assert.equal(target, "NHPC");
      assert.match(command, /-- NHPC /);
      assert.doesNotMatch(command, /-- HPC /);
      return { exitCode: 0, stdout: "SQUEUE_BEGIN\n\nSQUEUE_END\nSACCT_BEGIN\n\nSACCT_END" };
    }
  });
  assert.equal(calls.length, 1);
});

test("NHPC status and cancellation use owned target, not a colliding HPC job ID", async () => {
  const run = { target: "NHPC", slurmJobId: "830", operation: "project-test-run", workloadStatus: "submitted" };
  const state = { envelope: envelope("NHPC"), runs: [{ ...run, target: "HPC" }, run],
    submissions: [{ project: "test", operation: "run", slurmJobId: "830", uniqueJobName: "test.12345678" }],
    allocations: [{ project: "test", operation: "run", slurmJobId: "830", status: "nonterminal" }] };
  const calls = [];
  const runRemote = async (target, command) => {
    assert.equal(target, "NHPC"); assert.match(command, /-- NHPC /);
    calls.push(command);
    return { exitCode: 0, stdout: "SACCT_BEGIN\n830|test.12345678|RUNNING|0:0|00:01\nSACCT_END", stderr: "" };
  };
  await statusJob({ manifest: { ...parseProjectManifest("test", { ...raw, target: "NHPC" }) }, jobId: "830", state, exec: {}, runRemote });
  assert.equal(state.runs[0].workloadStatus, "submitted");
  assert.equal(run.slurmStatus, "RUNNING");
  await cancelOwnedJob({ state, project: "test", operation: "run", jobId: "830", exec: {}, runRemote,
    userQuestions: { ask: async ({ questions }) => ({ answers: [{ id: questions[0].id, selected: ["Cancel this job"] }] }) } });
  assert.equal(calls.length, 2);
  assert.match(calls[1], /scancel/);
  assert.equal(state.allocations[0].status, "cancel-requested");
});
