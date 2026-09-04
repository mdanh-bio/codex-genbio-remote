import { spawn } from "node:child_process";
import { TARGETS } from "./policy.js";
import { parseSlurmDiscovery } from "./slurm-discovery.js";

const SSH_ARGS = Object.freeze(["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=yes"]);
const COMMANDS = Object.freeze({ preflight: "set -eu; hostname -f; command -v bash python3; command -v sbatch squeue sacct scontrol sinfo scancel || true", slurm: "set -eu; hostname -f; sinfo -N -h -o '%N|%P|%T|%c|%G'; squeue -h -u \"$USER\" -o '%i|%j|%T|%P|%R'", direct: "set -eu; hostname -f; nproc; nvidia-smi -L 2>/dev/null || true" });
export function runStrictRead(target, kind, { timeoutMs = 30000, enabled = false } = {}) {
  if (!enabled) throw new Error("read-only remote access is disabled by configuration");
  if (!TARGETS.includes(target) || !Object.hasOwn(COMMANDS, kind)) throw new Error("unsupported read-only operation");
  const command = kind === "slurm" && !["HPC", "NHPC"].includes(target) ? COMMANDS.direct : COMMANDS[kind];
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [...SSH_ARGS, "--", target, command], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", settled = false;
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`read-only ${target} operation timed out`)); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-65536); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-65536); });
    child.once("error", (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
    child.once("close", (code) => { if (settled) return; settled = true; clearTimeout(timer); if (code !== 0) reject(new Error(`read-only ${target} operation failed: ${stderr.trim() || `exit ${code}`}`)); else resolve({ target, stdout, stderr, discovery: kind === "slurm" ? parseSlurmDiscovery(stdout) : null }); });
  });
}
