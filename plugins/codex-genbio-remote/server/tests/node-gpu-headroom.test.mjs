import test from "node:test";
import assert from "node:assert/strict";
import { gpuCount, queueProbeBody, parseQueueGpuAllocation } from "../lib/node-gpu-headroom.js";
import { probeNodeHeadroom } from "../lib/execution-core.js";

test("socket-annotated Gres preserves numeric GPU count", () => {
  assert.equal(gpuCount("gpu:a6000:4(S:0-1)"), 4);
  assert.equal(gpuCount("gres/gpu=4,gres/gpu:a6000=4"), 4);
  for (const text of ["gpu:a6000:four(S:0-1)", "gpu:a6000:4(S:0-1", "gpu=4,gpu=4", "gpu=4,gpu:a6000=3"]) assert.throws(() => gpuCount(text));
});

const node = "NodeName=gpu01 CPUAlloc=8 CPUTot=64 State=MIXED Gres=gpu:a6000:4(S:0-1) CfgTRES=cpu=64 AllocTRES=cpu=8";
const queue = (row) => `GPU_JOBS_BEGIN\n${row}\nGPU_JOBS_END\nNODE_AFTER=${node}\nGPU_QUEUE_OK=1\n`;
test("empty squeue TRES fields are absent, malformed nonempty fields fail", () => {
  assert.deepEqual(parseQueueGpuAllocation(queue("830|RUNNING|gpu01|8||||||"), "gpu01", node), { allocatedGpus: 0, gpuJobs: 0 });
  assert.throws(() => parseQueueGpuAllocation(queue("830|RUNNING|gpu01|8|???|||||"), "gpu01", node));
});
test("queue command uses exact node-list filter in both snapshots", () => {
  const body = queueProbeBody("gpu01");
  assert.equal(body.split("--nodelist=gpu01").length - 1, 2);
  assert.doesNotMatch(body, /--nodes=/u);
});
test("NHPC queue concurrency uses selected node policy cap", async () => {
  const policy = { targets: { NHPC: { allowlist: { gpu01: { caps: { max_concurrent_gpu_jobs: 1 } } } } } };
  await assert.rejects(probeNodeHeadroom({ exec: {}, target: "NHPC", node: "gpu01", cpus: 8, gpus: 1, policy,
    runRemote: async (target, command) => { assert.equal(target, "NHPC"); return { exitCode: 0, stdout: command.includes("GPU_JOBS_BEGIN") ? queue("830|RUNNING|gpu01|8||gpu:1||||") : `NODE_PROBE=${node}\n` }; }
  }), /concurrent GPU job policy cap/u);
});
