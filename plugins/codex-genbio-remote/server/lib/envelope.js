import { genbioh100ConcurrencyCap } from "./slurm-policy.js";

export function validateEnvelopeArgs(args, policy) {
  const p = policy.targets[args.target];
  if (!p) throw new Error("unknown envelope target");
  for (const key of ["max_cpus", "max_gpus", "concurrency"]) {
    if (!Number.isSafeInteger(args[key]) || args[key] < (key === "max_gpus" ? 0 : 1)) throw new Error(`invalid ${key}`);
  }
  if (p.surface === "slurm") {
    const caps = p.allowlist?.[args.node]?.caps ?? {};
    if (p.allowlist?.[args.node]?.partition !== args.partition) throw new Error("node and partition do not match policy");
    if (args.mem_gb !== undefined) throw new Error("Slurm envelopes must omit mem_gb");
    if (args.max_cpus > (caps.max_aggregate_cpus ?? Number.MAX_SAFE_INTEGER) || args.max_gpus > (caps.max_gpus ?? caps.max_aggregate_gpus ?? Number.MAX_SAFE_INTEGER)) throw new Error("envelope exceeds policy");
    if (args.max_gpus > 0 && args.concurrency > (caps.max_concurrent_gpu_jobs ?? Number.MAX_SAFE_INTEGER)) throw new Error("envelope concurrency exceeds policy");
  } else if (args.node !== args.target || args.partition !== undefined) throw new Error("direct node must equal target and omit partition");
  if (args.target === "genbioh100" || p.envelope?.fields?.includes("mem_gb")) {
    if (!Number.isSafeInteger(args.mem_gb) || args.mem_gb < 1) throw new Error("mem_gb is required by target policy");
    if (args.mem_gb > (p.limits?.mem_gb_per_job ?? 32)) throw new Error("memory exceeds policy");
  }
  if (args.target === "genbioh100" && (args.max_cpus > (p.limits.cpu_threads_per_job ?? 16) || args.max_gpus > 1 || args.concurrency > genbioh100ConcurrencyCap(policy, args.max_gpus))) throw new Error("genbioh100 envelope exceeds policy");
}
