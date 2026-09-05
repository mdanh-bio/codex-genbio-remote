import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { probeNodeHeadroom, shellQuote as q, strictRemote } from "./execution-core.js";
import { parseOwnedSacctTable } from "./scheduler-evidence.js";
import { posixQuote } from "./project.js";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const terminal = new Set(["completed", "failed", "cancelled"]);
const slurm = (target) => ["HPC", "NHPC"].includes(target);
const bounded = (text, max) => Buffer.from(String(text ?? "")).subarray(-max).toString("utf8");
const field = (text, name) => {
  const rows = String(text).split("\n").filter((line) => line.startsWith(`${name}=`));
  return rows.length === 1 ? rows[0].slice(name.length + 1) : null;
};

export function smokeWrapper(run) {
  const header = slurm(run.target) ? [
    `#SBATCH --job-name=${run.uniqueJobName}`, `#SBATCH --partition=${run.partition}`,
    "#SBATCH --nodes=1", `#SBATCH --nodelist=${run.node}`, "#SBATCH --ntasks=1",
    `#SBATCH --cpus-per-task=${run.resources.cpus}`,
    ...(run.resources.gpus ? [`#SBATCH --gres=gpu:${run.resources.gpus}`] : []),
    "#SBATCH --output=%x_%j.out", "#SBATCH --error=%x_%j.err"
  ] : [];
  return ["#!/bin/bash", ...header, "set -euo pipefail",
    slurm(run.target) ? 'cd "$SLURM_SUBMIT_DIR"' : `cd -- ${q(run.remoteRunDir)}`,
    `export OMP_NUM_THREADS=${run.resources.cpus}`,
    ...(!slurm(run.target) ? [run.target === "genbioh100" ? "export CUDA_VISIBLE_DEVICES=0" : 'export CUDA_VISIBLE_DEVICES=""', `ulimit -v ${run.resources.memGb * 1024 * 1024}`] : []),
    `printf '%s|%s|%s\\n' ${q(run.token)} "$$" "$(awk '{print $22}' /proc/$$/stat)" > identity.tmp`,
    "mv identity.tmp identity",
    "trap 'rc=$?; printf \"%s\\n\" \"$rc\" > exit.tmp; mv exit.tmp exit_code' EXIT",
    "hostname -f > host.txt", "date -u +%Y-%m-%dT%H:%M:%SZ > date.txt",
    `printf 'GENBIO_SMOKE_OK %s\\n' ${q(run.token)} > result.txt`,
    "sha256sum wrapper.sh result.txt host.txt date.txt identity > checksums.txt", ""
  ].join("\n");
}

export function classifySmoke(run, response) {
  if (response.exitCode !== 0) return { status: "reconciling" };
  const text = response.stdout;
  const identity = field(text, "IDENTITY")?.split("|");
  if (!identity || identity.length !== 3 || identity[0] !== run.token || !/^[1-9][0-9]*$/u.test(identity[1]) || !/^[0-9]+$/u.test(identity[2])) return { status: "reconciling" };
  const exit = field(text, "EXIT");
  const checksum = field(text, "CHECKSUM");
  const valid = checksum === "ok" && field(text, "WRAPPER_SHA") === run.wrapperSha && field(text, "RESULT_SHA") === sha(`GENBIO_SMOKE_OK ${run.token}\n`);
  let scheduler = null;
  if (slurm(run.target)) {
    const account = field(text, "SACCT");
    scheduler = parseOwnedSacctTable(account, run.slurmJobId, run.uniqueJobName);
    if (!scheduler) return { status: "reconciling" };
    const queue = field(text, "SQUEUE");
    if (queue === null) return { status: "reconciling" };
    if (queue !== "" && !queue.startsWith(`${run.slurmJobId}|${run.uniqueJobName}|`)) return { status: "reconciling" };
    if (["PENDING", "RUNNING", "CONFIGURING", "COMPLETING"].includes(scheduler.state)) return { status: "running", scheduler };
    if (queue !== "") return { status: "reconciling", scheduler };
    if (scheduler.state !== "COMPLETED") {
      if (["FAILED", "CANCELLED", "TIMEOUT", "NODE_FAIL", "OUT_OF_MEMORY", "PREEMPTED", "BOOT_FAIL", "DEADLINE", "REVOKED"].includes(scheduler.state)) return { status: "failed", scheduler };
      return { status: "reconciling", scheduler };
    }
    if (scheduler.exitCode !== "0:0") return { status: "failed", scheduler };
  }
  if (exit === null || exit === "pending") return { status: "reconciling", scheduler };
  if (!slurm(run.target) && field(text, "PROCESS") !== "exited") return { status: "reconciling", scheduler };
  if (!/^(0|[1-9][0-9]{0,2})$/u.test(exit) || Number(exit) > 255) return { status: "reconciling", scheduler };
  return { status: exit === "0" && valid ? "completed" : "failed", scheduler, pid: Number(identity[1]), processStart: identity[2], exitCode: Number(exit), checksumOk: valid };
}

export function createSmokeService({ config, registry, owners, runRemote, execFor, requireRemoteAccess, userQuestions, assertPolicy }) {
  async function remote(state, run, body) {
    await assertPolicy(state);
    return runRemote(run.target, strictRemote(run.target, body), execFor(state), config.smokeTimeoutMs);
  }
  async function sync(state, run) {
    run.workloadStatus = run.status;
    run.helperStatus = run.status;
    run.allocationStatus = terminal.has(run.status) ? "terminal" : "ambiguous";
    const existing = await registry.find(run.runId);
    if (existing?.allocationStatus === "terminal") {
      if (existing.workloadStatus !== run.status) throw new Error("terminal smoke record is immutable");
      await owners.save(state);
      return;
    }
    await registry.update(run.runId, (old) => ({ ...old, status: run.status, helperStatus: run.status,
      workloadStatus: run.status, allocationStatus: terminal.has(run.status) ? "terminal" : "ambiguous",
      slurmJobId: run.slurmJobId, slurmState: run.terminalEvidence?.scheduler?.state ?? null,
      exitCode: run.terminalEvidence?.scheduler?.exitCode ?? null,
      workloadEvidence: terminal.has(run.status) ? "smoke-evidence-verified" : "smoke-outcome-unresolved",
      finishedAt: terminal.has(run.status) ? Date.now() : null }));
    await owners.save(state);
  }
  async function monitor(state, run) {
    if (terminal.has(run.status)) return run;
    if (run.smokeSchema !== 1) throw new Error("legacy smoke lacks durable identity; no automatic replay");
    const record = await registry.find(run.runId);
    if (!record || record.sessionId !== state.ownerHandle || record.token !== run.token) throw new Error("smoke ownership mismatch");
    await requireRemoteAccess(run.target, [{ root: run.remoteRunDir, write: false }], execFor(state), state);
    try {
      if (slurm(run.target) && !run.slurmJobId) {
        const out = await remote(state, run, `set -eu; squeue -h -n ${q(run.uniqueJobName)} -o '%i|%j'; sacct -X -n --name=${q(run.uniqueJobName)} --format=JobIDRaw,JobName%128 -P`);
        if (out.exitCode !== 0) throw new Error("scheduler reconciliation unavailable");
        const rows = out.stdout.trim().split("\n").filter(Boolean).map((x) => x.trim().split("|"));
        if (rows.some(([id, name]) => !/^[0-9]{1,10}$/u.test(id) || name !== run.uniqueJobName)) throw new Error("ambiguous scheduler identity");
        const ids = new Set(rows.map(([id]) => id));
        if (ids.size !== 1) throw new Error("no unique scheduler identity; submission not replayed");
        run.slurmJobId = [...ids][0];
        await sync(state, run);
      }
      const account = slurm(run.target) ? `queue=$(squeue -h -j ${run.slurmJobId} -o '%i|%j|%T'); printf 'SQUEUE=%s\\n' "$queue"; account=$(sacct -X -n -j ${run.slurmJobId} --format=JobIDRaw,JobName%128,State,ExitCode,Elapsed -P); printf 'SACCT=%s\\n' "$account";` : "";
      const out = await remote(state, run, `set -eu; cd -- ${q(run.remoteRunDir)}; ${account}
printf 'IDENTITY=%s\\n' "$(cat identity 2>/dev/null || true)"
printf 'EXIT=%s\\n' "$(cat exit_code 2>/dev/null || printf pending)"
if test -f identity; then
  IFS='|' read -r token pid start < identity
  case "$pid" in ''|*[!0-9]*) exit 1;; esac
  case "$start" in ''|*[!0-9]*) exit 1;; esac
  live=$(awk '{print $3 "|" $22}' /proc/"$pid"/stat 2>/dev/null || true)
  if test "$live" = "R|$start" || test "$live" = "S|$start" || test "$live" = "D|$start" || test "$live" = "T|$start"; then printf 'PROCESS=running\\n'; else printf 'PROCESS=exited\\n'; fi
fi
if test -s checksums.txt && sha256sum -c --quiet checksums.txt; then printf 'CHECKSUM=ok\\n'; else printf 'CHECKSUM=missing\\n'; fi
printf 'WRAPPER_SHA=%s\\n' "$(sha256sum wrapper.sh | cut -d' ' -f1)"
printf 'RESULT_SHA=%s\\n' "$(sha256sum result.txt 2>/dev/null | cut -d' ' -f1)"`);
      run.stdout = bounded(out.stdout, config.logMaxBytes); run.stderr = bounded(out.stderr, config.logMaxBytes);
      const evidence = classifySmoke(run, out);
      run.status = evidence.status;
      run.pid = evidence.pid ?? run.pid ?? null;
      run.terminalEvidence = terminal.has(evidence.status) ? evidence : null;
      if (terminal.has(run.status)) run.finishedAt = Date.now();
      run.error = run.status === "reconciling" ? "terminal evidence incomplete; no replay" : null;
    } catch (error) { run.status = "reconciling"; run.error = bounded(error.message, 2048); }
    await sync(state, run);
    return run;
  }
  async function launch(state, args) {
    const loaded = await assertPolicy(state);
    const e = state.envelope;
    if (args.target !== e.target || args.cpus > e.maxCpus || args.gpus > e.maxGpus || args.concurrency !== 1 || (args.mem_gb !== undefined && args.mem_gb > e.memGb)) throw new Error("smoke request exceeds envelope or concurrency is not one");
    if (args.target === "HPC" ? args.operation !== "gpu04-smoke" || e.node !== "gpu04" : args.operation !== "preflight-smoke") throw new Error("unsupported smoke target/operation pair");
    if (!slurm(args.target) && (args.gpus !== 0 || !Number.isSafeInteger(args.mem_gb) || args.mem_gb < 1)) throw new Error("direct diagnostic smoke is CPU-only and requires mem_gb");
    const root = config.smokeRoots?.[args.target] ?? loaded.policy.targets[args.target].test_gate?.smoke_root ?? (args.target === "HPC" ? "/data01/genbiolab/mdanh/data/projects/dsh_policy_smoke" : null);
    if (!root || root === "/" || !/^\/[A-Za-z0-9_./-]+$/u.test(root) || root.split("/").includes("..")) throw new Error("configure an explicit safe smokeRoots path for this target");
    await requireRemoteAccess(args.target, [{ root, write: true }], execFor(state), state);
    const answer = await userQuestions.ask({ approval: { target: args.target, roots: [{ root, mode: "rw" }], requested_resources: args, transfer: "small fixed wrapper; no material dataset" }, questions: [{ id: "smoke-launch", header: "Launch smoke", question: `Stage and launch one ${args.operation} on ${args.target}?`, options: [{ label: "Approve this launch", description: "Create a fresh run directory, verify the fixed wrapper, and dispatch exactly once." }, { label: "Reject", description: "Do not stage or launch." }] }] });
    if (!answer.answers[0].selected.includes("Approve this launch")) throw new Error("smoke launch rejected");
    await assertPolicy(state);
    const specHash = sha(JSON.stringify({ args, root, policy: loaded.hash }));
    const { record } = await registry.reserve({ sessionId: state.ownerHandle, workspace: state.workspaceRoot, target: args.target, project: `smoke-${args.target.toLowerCase().replaceAll("_", "-")}`, operation: args.operation,
      planHash: specHash, manifestSha: specHash, packageSha: specHash, wrapperSha: specHash, policyHash: loaded.hash, remoteBase: root,
      cpus: args.cpus, gpus: args.gpus, concurrency: 1, node: e.node, partition: e.partition ?? "direct", envelope: e });
    const run = { ...record, smokeSchema: 1, partition: e.partition ?? null, jobId: null, pid: null, policyHash: loaded.hash, resources: { cpus: args.cpus, gpus: args.gpus, memGb: args.mem_gb ?? null, concurrency: 1 }, envelope: structuredClone(e), startedAt: record.createdAt, stdout: "", stderr: "", error: null, finalization: null, memory: { status: "not-finalized" }, uniqueJobName: `genbio-smoke-${record.token}` };
    const wrapper = smokeWrapper(run); run.wrapperSha = sha(wrapper);
    state.runs.push(run);
    await registry.update(run.runId, (old) => ({ ...old, uniqueJobName: run.uniqueJobName, wrapperSha: run.wrapperSha }));
    await owners.save(state);
    let dispatchIntent = false;
    try {
      const syntax = spawnSync("/bin/bash", ["--noprofile", "--norc", "-n"], { input: wrapper, encoding: "utf8" });
      if (syntax.status !== 0) throw new Error("fixed smoke wrapper fails local bash syntax");
      const probe = async () => {
        if (slurm(args.target)) return probeNodeHeadroom({ exec: execFor(state), runRemote, cpus: args.cpus, gpus: args.gpus, node: e.node, target: args.target });
        const out = await remote(state, run, "set -eu; printf 'CPUS=%s\\n' \"$(nproc)\"; awk '/MemAvailable:/ {printf \"MEM_KB=%s\\n\", $2}' /proc/meminfo");
        if (out.exitCode !== 0 || !/^[0-9]+$/u.test(field(out.stdout, "CPUS") ?? "") || !/^[0-9]+$/u.test(field(out.stdout, "MEM_KB") ?? "") || Number(field(out.stdout, "CPUS")) < args.cpus || Number(field(out.stdout, "MEM_KB")) < args.mem_gb * 1024 * 1024) throw new Error("direct headroom unavailable");
      };
      await probe();
      const ancestors = run.remoteRunDir.split("/").filter(Boolean).map((_, i, parts) => q("/" + parts.slice(0, i + 1).join("/"))).join(" ");
      const stage = await remote(state, run, `set -eu; umask 077; for path in ${ancestors}; do test ! -L "$path"; done; mkdir -p -- ${q(`${root}/runs`)}; mkdir -- ${q(run.remoteRunDir)}; cd -- ${q(run.remoteRunDir)}; test "$(pwd -P)" = ${q(run.remoteRunDir)}; printf '%s' ${posixQuote(Buffer.from(wrapper).toString("base64"))} | base64 -d > wrapper.sh; printf '%s  wrapper.sh\\n' ${q(run.wrapperSha)} | sha256sum -c --quiet; /bin/bash --noprofile --norc -n wrapper.sh; printf 'STAGED=${run.token}\\n'`);
      if (stage.exitCode !== 0 || field(stage.stdout, "STAGED") !== run.token) throw new Error("smoke staging not verified");
      await probe();
      await assertPolicy(state);
      await registry.update(run.runId, (old) => ({ ...old, sbatchIssued: slurm(run.target), workloadEvidence: "dispatch-intent-persisted" }));
      run.status = "reconciling"; run.dispatchIssued = true;
      await owners.save(state);
      dispatchIntent = true;
      const dispatch = slurm(run.target) ? "sbatch --parsable wrapper.sh" : "setsid /bin/bash --noprofile --norc wrapper.sh </dev/null >stdout.log 2>stderr.log &";
      const out = await remote(state, run, `set -eu; cd -- ${q(run.remoteRunDir)}; printf '%s  wrapper.sh\\n' ${q(run.wrapperSha)} | sha256sum -c --quiet; ${dispatch}`);
      run.stdout = bounded(out.stdout, config.logMaxBytes); run.stderr = bounded(out.stderr, config.logMaxBytes);
      if (out.exitCode !== 0) throw new Error("dispatch outcome ambiguous");
      if (slurm(run.target)) {
        if (!/^[0-9]{1,10}$/u.test(out.stdout.trim())) throw new Error("submission identity ambiguous");
        run.slurmJobId = out.stdout.trim();
      }
      await sync(state, run);
      return monitor(state, run);
    } catch (error) {
      run.status = dispatchIntent ? "reconciling" : "failed";
      run.error = bounded(error.message, 2048);
      if (!dispatchIntent) { run.finishedAt = Date.now(); run.terminalEvidence = { phase: "pre-dispatch", dispatched: false, error: run.error }; }
      await sync(state, run);
      return run;
    }
  }
  return Object.freeze({ launch, monitor });
}
