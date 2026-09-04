import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { load as parseYaml } from "js-yaml";
import { genbioh100ConcurrencyCap } from "../lib/slurm-policy.js";

const root = path.resolve(import.meta.dirname, "..");
const policyPath = path.join(root, "fixtures/genbio-compute-policy.test.yaml");
const policy = parseYaml(fs.readFileSync(policyPath, "utf8"));

test("policy target and ordered live-test invariants", () => {
  assert.deepEqual(Object.keys(policy.targets).sort(), ["HPC", "NHPC", "genbio_mdanh", "genbioh100"].sort());
  assert.equal(policy.targets.HPC.test_gate.real_submission, "gpu04");
  assert.equal(policy.targets.NHPC.test_gate.real_submission, "gpu01");
  assert.equal(policy.targets.NHPC.allowlist.gpu01.partition, "gpu");
  assert.deepEqual(policy.targets.genbioh100.limits.gpus_allowed, [0]);
  assert.equal(policy.targets.genbioh100.limits.cpu_threads_per_job, 16);
  assert.equal(policy.targets.genbioh100.hardware.reserved_gpu, 1);
});

test("GPU-class workloads (gpus>0) are bounded by concurrent_gpu_jobs", () => {
  const limits = { gpus_allowed: [0], cpu_threads_per_job: 16, mem_gb_per_job: 32, concurrent_gpu_jobs: 1, concurrent_cpu_jobs: 8 };
  const mockPolicy = { targets: { genbioh100: { limits } } };
  assert.equal(genbioh100ConcurrencyCap(mockPolicy, 1), 1);
  assert.equal(genbioh100ConcurrencyCap(mockPolicy, 4), 1);
});
