import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { load as parseYaml } from "js-yaml";

export const TARGETS = Object.freeze(["HPC", "NHPC", "genbio_mdanh", "genbioh100"]);

export function validatePolicy(policy) {
  if (!policy || policy.schema_version !== 1 || policy.policy !== "genbio-remote-compute") throw new Error("invalid policy identity");
  const options = policy.ssh?.options ?? {};
  if (policy.ssh?.client !== "openssh-native" || policy.ssh?.noninteractive !== true) throw new Error("policy must require native noninteractive OpenSSH");
  if (options.tty !== false || options.batch_mode !== true || options.connect_timeout_s !== 10 || options.strict_host_key_checking !== "yes") throw new Error("policy SSH contract is not strict");
  if (options.agent_forwarding !== false || options.x11_forwarding !== false || options.port_forwarding !== false) throw new Error("policy forwarding contract is not strict");
  if (!policy.targets || Object.keys(policy.targets).sort().join(",") !== [...TARGETS].sort().join(",")) throw new Error("policy targets must match required target set");
  if (policy.targets.HPC?.ssh_target !== "HPC" || policy.targets.HPC?.surface !== "slurm") throw new Error("HPC policy is invalid");
  for (const [node, partition] of [["gpu04", "gpus"], ["cpu01", "cpus"]]) if (policy.targets.HPC.allowlist?.[node]?.partition !== partition) throw new Error(`HPC ${node}/${partition} mapping is invalid`);
  if (policy.targets.NHPC?.ssh_target !== "NHPC" || policy.targets.NHPC?.allowlist?.gpu01?.partition !== "gpu") throw new Error("NHPC policy is invalid");
  const h100 = policy.targets.genbioh100;
  if (h100?.ssh_target !== "genbioh100" || h100?.surface !== "direct" || JSON.stringify(h100?.limits?.gpus_allowed) !== "[0]") throw new Error("genbioh100 policy is invalid");
  if (h100.hardware?.reserved_gpu !== 1 || h100.hardware?.protected_process !== "gpu_util") throw new Error("genbioh100 GPU 1 protection is required");
  if (policy.targets.genbio_mdanh?.ssh_target !== "genbio_mdanh" || policy.targets.genbio_mdanh?.surface !== "direct") throw new Error("genbio_mdanh policy is invalid");
  return policy;
}

export async function loadPolicy(policyPath) {
  if (typeof policyPath !== "string" || !policyPath.startsWith("/")) throw new Error("policyPath must be absolute");
  const text = await readFile(policyPath, "utf8");
  const policy = validatePolicy(parseYaml(text));
  return Object.freeze({ policy, text, hash: createHash("sha256").update(text).digest("hex"), updated: policy.updated ?? null });
}
