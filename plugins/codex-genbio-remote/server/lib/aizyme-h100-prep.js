import { createHash, randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { RCLONE_TRANSFER_ARGS, resolveRcloneRemote } from "./transfer.js";

const LOCAL_REMOTE = join(import.meta.dirname, "..", "fixtures", "aizyme-h100");
const PROJECT_ROOT = "/home/work/GenbioLAB/shared/daes_enzyme";
const PREP_ROOT = `${PROJECT_ROOT}/workflow/aizyme_v1/runs/stage2-prep`;
const SCRIPT = "stage2_prepare_genbioh100.sh";
const ARCHIVE = "AIzymes-52176ff.tar.gz";
const ARCHIVE_SHA = "f408113ab7c2fbbfa2771312d0c0eaae308565da521f0d01f713ddc04441a70a";
const RESOURCES = Object.freeze({ cpus: 16, gpus: 1, memGb: 32, concurrency: 1 });
const SSH = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=yes"];
const quote = (v) => { const s = String(v); if (!/^[A-Za-z0-9_./:=+@,-]+$/u.test(s)) throw new Error(`unsafe fixed value: ${s}`); return `'${s}'`; };
const remote = (body) => `ssh ${SSH.join(" ")} -- genbioh100 ${JSON.stringify(body).replace(/\$/g, "\\$")}`;
const digest = (b) => createHash("sha256").update(b).digest("hex");

async function files() {
  const out = [];
  for (const name of [SCRIPT, ARCHIVE]) {
    const path = join(LOCAL_REMOTE, name); const info = await stat(path); if (!info.isFile()) throw new Error(`${path} is not a regular file`);
    const content = await readFile(path); out.push({ name, path, content, size: info.size, sha256: digest(content) });
  }
  if (out.find((x) => x.name === ARCHIVE).sha256 !== ARCHIVE_SHA) throw new Error("preparation archive SHA-256 mismatch");
  const syntax = spawnSync("/bin/bash", ["--noprofile", "--norc", "-n", "-"], { input: out[0].content, env: { PATH: "/usr/bin:/bin", BASH_ENV: "/dev/null" }, encoding: "utf8", timeout: 5000 });
  if (syntax.status !== 0) throw new Error(`preparation script bash -n failed: ${syntax.stderr}`);
  return out;
}
function validate(state, policy) {
  const p = policy.targets.genbioh100; if (!p || p.surface !== "direct" || p.login_shell !== false) throw new Error("genbioh100 direct/no-login policy required");
  if (JSON.stringify(p.limits.gpus_allowed) !== "[0]") throw new Error("GPU 0 must be the only allowed GPU");
  const e = state.envelope; if (!e || e.target !== "genbioh100" || e.partition !== null) throw new Error("set a direct genbioh100 envelope first");
  if (e.maxCpus < 16 || e.maxGpus !== 1 || e.memGb === null || e.memGb < 32 || e.concurrency < 1) throw new Error("preparation requires 16 CPUs, GPU 0, 32 GB, concurrency 1");
  if (state.runs.some((r) => ["running", "reconciling"].includes(r.status) && ["aizyme-h100-stage2", "aizyme-h100-stage2-prep"].includes(r.operation))) throw new Error("an AI.zymes H100 Stage-2/preparation operation is already active");
}
async function localCopy(shell, command, exec) { const r = await shell.run(shell.resolve({ command, timeoutMs: 120000, signal: exec.signal })); return { stdout: r.stdout?.text ?? "", stderr: r.stderr?.text ?? "", exitCode: r.exitCode ?? null }; }

export function createAizymeH100PrepTools({ makeTool, requirePolicy, requireState, publicState, runRemote, shell, userQuestions, jobs, config, requireRemoteAccess, runRegistry }) {
  const prepareTool = makeTool("genbio_aizyme_h100_prepare", "Prepare the persistent AI.zymes Stage-2 environment on genbioh100. Exact-once, GPU 0 only, 16 CPUs/32 GB. May create a conda environment and download the approved ESMFold cache; requires explicit execution approval. It cannot certify G2.", {}, async (_args, exec) => {
    const state = requireState(exec), policy = requirePolicy(); validate(state, policy); const staged = await files();
    const grants = await requireRemoteAccess("genbioh100", [{ root: PROJECT_ROOT, write: true }], exec, state);
      if (!userQuestions) throw new Error("AI.zymes preparation requires MCP elicitation");
      const answer = await userQuestions.ask({ agent: exec.agent, signal: exec.signal, questions: [{ id: "aizyme-h100-prep-execute", header: "AI.zymes environment preparation", question: "Approve one exact-once genbioh100 preparation run? It may create the project conda environment and download facebook/esmfold_v1 into the project cache. It uses GPU 0 only and cannot write G2_PASS.", options: [{ label: "Approve preparation", description: "Stage the pinned inputs and run dependency preparation once." }, { label: "Reject", description: "Do not transfer, install, or download anything." }] }] });
    if (!(answer.answers?.find((x) => x.id === "aizyme-h100-prep-execute")?.selected ?? []).includes("Approve preparation")) throw new Error("AI.zymes H100 preparation was not approved");
    const sessionId = exec.agent.session.id; let registryRunId = null;
    if (runRegistry) registryRunId = (await runRegistry.record(sessionId, { source: "aizyme", project: "aizyme", operation: "stage2-prep", status: "in-flight", note: "H100 environment preparation admitted" })).runId;
    const token = randomBytes(16).toString("hex"), runDir = `${PREP_ROOT}/prep-h100-${token}`, lock = `${PREP_ROOT}/.prep.lock`;
    const run = { runId: `genbioh100-aizyme-stage2-prep-${token}`, target: "genbioh100", operation: "aizyme-h100-stage2-prep", status: "running", startedAt: Date.now(), finishedAt: null, stdout: "", stderr: "", error: null, pid: null, jobId: null, resources: { ...RESOURCES }, policyHash: state.policy.hash, node: "genbioh100", partition: null, envelope: JSON.parse(JSON.stringify(state.envelope)), remoteRunDir: runDir, runToken: token, remoteLockDir: lock, remoteGrants: JSON.parse(JSON.stringify(grants)), registryRunId, finalization: null, memory: { status: "not-finalized", error: null, openVikingSessionId: null, traceId: null } };
    run.jobId = jobs.start({ kind: "genbio-h100-aizyme-prep", label: "genbioh100 AI.zymes environment preparation", owner: exec.agent, run: () => { const done = (async () => { try {
      const init = `set -eu; root=${quote(PREP_ROOT)}; lock=${quote(lock)}; mkdir -p "$root"; if ! mkdir "$lock" 2>/dev/null; then printf 'LOCK_CONFLICT=1\\n'; exit 0; fi; printf 'token=%s\\nlocked_utc=%s\\n' '${token}' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$lock/token.txt"; if ! mkdir ${quote(runDir)}; then rm -f "$lock/token.txt"; rmdir "$lock"; exit 2; fi; printf 'LOCK_ACQUIRED=1\\n'`;
      const i = await runRemote("genbioh100", remote(init), exec, 30000); if (i.exitCode !== 0 || !String(i.stdout).includes("LOCK_ACQUIRED=1")) throw new Error(String(i.stdout).includes("LOCK_CONFLICT=1") ? "preparation lock conflict; no launch" : "preparation initialization ambiguous");
      const rr = resolveRcloneRemote(config, "genbioh100"); for (const f of staged) { const c = await localCopy(shell, `rclone copyto ${RCLONE_TRANSFER_ARGS.join(" ")} ${quote(f.path)} ${quote(`${rr}:${runDir}/${f.name}`)}`, exec); if (c.exitCode !== 0) throw new Error(`rclone failed for ${f.name}: ${c.stderr || c.stdout}`); }
      const hashes = await runRemote("genbioh100", remote(`set -eu; cd ${quote(runDir)}; sha256sum ${staged.map((f) => quote(f.name)).join(" ")}; env -i PATH=/usr/bin:/bin BASH_ENV=/dev/null /bin/bash --noprofile --norc -n -- ${quote(SCRIPT)}`), exec, 30000); if (hashes.exitCode !== 0) throw new Error("remote checksum/syntax verification failed"); for (const f of staged) if (!String(hashes.stdout).includes(`${f.sha256}  ${f.name}`)) throw new Error(`remote SHA mismatch: ${f.name}`);
      const launch = `set -eu; cd ${quote(runDir)}; setsid env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin CUDA_VISIBLE_DEVICES=0 OMP_NUM_THREADS=16 AIZH100_PREP_RUN_DIR=${quote(runDir)} AIZH100_PREP_RUN_TOKEN='${token}' /bin/bash --noprofile --norc -- ${quote(SCRIPT)} < /dev/null > ${quote(runDir + "/stdout.log")} 2> ${quote(runDir + "/stderr.log")} & sleep 1; cat ${quote(runDir + "/run_identity")} 2>/dev/null || printf 'LAUNCH_AMBIGUITY=1\\n'`;
      const l = await runRemote("genbioh100", remote(launch), exec, 30000); const m = String(l.stdout).match(/pid=(\d+)/u); if (l.exitCode !== 0 || !m) { run.status = "reconciling"; run.error = "preparation launch ambiguous"; return { status: "reconciling", detail: run.error }; } run.pid = Number(m[1]); run.stdout = l.stdout; return { status: "running", detail: `preparation launched pid=${run.pid}` };
    } catch (e) { run.status = "reconciling"; run.error = String(e?.message ?? e); return { status: "reconciling", detail: run.error }; } })(); return { cancel: () => {}, done, readOutput: () => [run.stdout, run.error].filter(Boolean).join("\n") }; } });
    state.runs.push(run); return { ok: true, status: { ...publicState(state), started: run } };
  });

  const statusTool = makeTool("genbio_aizyme_h100_prepare_status", "Reconcile one AI.zymes H100 preparation run. Completion requires exit 0, token-bound PREPARATION_PASS, checksum verification, and exactly one stdout PREPARATION_PASS. Releases only the exact-token preparation lock.", { run_id: { type: "string", required: true } }, async (args, exec) => {
    const state = requireState(exec), id = String(args.run_id ?? ""); let run = state.runs.find((r) => r.runId === id && r.operation === "aizyme-h100-stage2-prep");
    if (!run) {
      const token = id.match(/^genbioh100-aizyme-stage2-prep-([a-f0-9]{32})$/u)?.[1];
      const records = runRegistry ? await runRegistry.list(exec.agent.session.id) : [];
      const durable = token ? [...records].reverse().find((item) => item.project === "aizyme" && item.operation === "stage2-prep" && ["in-flight", "reconciling"].includes(item.status)) : null;
      if (!token || !durable) return { ok: true, status: { ...publicState(state), preparationStatus: { found: false, runId: id } } };
      run = { runId: id, target: "genbioh100", operation: "aizyme-h100-stage2-prep", status: "reconciling", startedAt: durable.startedAt, finishedAt: null, stdout: "", stderr: "", error: null, pid: null, jobId: null, resources: { ...RESOURCES }, policyHash: state.policy?.hash ?? null, node: "genbioh100", partition: null, envelope: state.envelope ? JSON.parse(JSON.stringify(state.envelope)) : null, remoteRunDir: `${PREP_ROOT}/prep-h100-${token}`, runToken: token, remoteLockDir: `${PREP_ROOT}/.prep.lock`, remoteGrants: [], registryRunId: durable.runId, finalization: null, memory: { status: "not-finalized", error: null, openVikingSessionId: null, traceId: null } };
      state.runs.push(run);
    }
    await requireRemoteAccess("genbioh100", [{ root: PROJECT_ROOT, write: false }], exec, state);
    const cmd = `set -eu; cd ${quote(run.remoteRunDir)}; printf 'TOKEN='; sed -n 's/^token=//p' run_identity 2>/dev/null | head -1; printf '\\nEXIT='; cat exit_code 2>/dev/null || printf pending; printf '\\nPID='; pid=$(sed -n 's/^pid=//p' run_identity 2>/dev/null|head -1); if test -n "$pid" && kill -0 "$pid" 2>/dev/null; then printf alive; else printf dead; fi; printf '\\nCHECKSUM='; if test -f manifests/checksums.sha256 && (cd manifests && sha256sum -c checksums.sha256 >/dev/null 2>&1); then printf ok; else printf bad; fi; printf '\\nPASS='; cat manifests/PREPARATION_PASS 2>/dev/null || printf absent; printf '\\nPASS_COUNT='; grep -xc '^PREPARATION_PASS$' stdout.log 2>/dev/null || true; printf '\\nPROCESS\\n'; if test -n "$pid" && kill -0 "$pid" 2>/dev/null; then ps -o pid=,ppid=,stat=,etime=,rss=,comm= -p "$pid" 2>/dev/null || true; children=$(pgrep -P "$pid" 2>/dev/null | head -20 | paste -sd, -); if test -n "$children"; then ps -o pid=,ppid=,stat=,etime=,rss=,comm= -p "$children" 2>/dev/null || true; fi; fi; printf '\\nCONDA_LOG\\n'; tail -c 6000 manifests/conda_create.log 2>/dev/null || true; printf '\\nSTDOUT\\n'; tail -c 4000 stdout.log 2>/dev/null || true; printf '\\nSTDERR\\n'; tail -c 4000 stderr.log 2>/dev/null || true`;
    let r; try { r = await runRemote("genbioh100", remote(cmd), exec, 30000); } catch (e) { return { ok: true, status: { ...publicState(state), preparationStatus: { found: true, runId: id, reconciled: "reconciling", error: String(e) } } }; }
    const text = String(r.stdout), token = text.match(/^TOKEN=(.*)$/mu)?.[1], exitRaw = text.match(/^EXIT=(.*)$/mu)?.[1], pid = text.match(/^PID=(.*)$/mu)?.[1], checksum = text.match(/^CHECKSUM=(.*)$/mu)?.[1], pass = text.match(/^PASS=(.*)$/mu)?.[1], count = Number(text.match(/^PASS_COUNT=(\d+)$/mu)?.[1] ?? 0); const exit = exitRaw === "pending" ? null : Number(exitRaw); let reconciled = pid === "alive" ? "running" : "reconciling";
    if (token === run.runToken && exit !== null && pid === "dead") reconciled = exit === 0 && checksum === "ok" && pass?.includes(`token=${run.runToken}`) && count === 1 ? "completed" : "failed";
    if (["completed", "failed"].includes(reconciled)) { const release = `set -eu; lock=${quote(run.remoteLockDir)}; t=$(sed -n 's/^token=//p' "$lock/token.txt" 2>/dev/null|head -1); test "$t" = '${run.runToken}'; rm -f "$lock/token.txt"; rmdir "$lock"`; const rel = await runRemote("genbioh100", remote(release), exec, 15000); if (rel.exitCode === 0) { run.status = reconciled; run.finishedAt ??= Date.now(); run.remoteLockDir = null; if (runRegistry && run.registryRunId) await runRegistry.update(exec.agent.session.id, run.registryRunId, { status: reconciled, note: `preparation ${reconciled}` }); } else reconciled = "reconciling"; }
    const processEvidence = text.split("\nPROCESS\n")[1]?.split("\nCONDA_LOG\n")[0]?.slice(-4000) ?? ""; const condaLogTail = text.split("\nCONDA_LOG\n")[1]?.split("\nSTDOUT\n")[0]?.slice(-6000) ?? "";
    run.stdout = text.split("\nSTDOUT\n")[1]?.split("\nSTDERR\n")[0]?.slice(-4000) ?? ""; run.stderr = text.split("\nSTDERR\n")[1]?.slice(-4000) ?? "";
    return { ok: true, status: { ...publicState(state), preparationStatus: { found: true, runId: id, reconciled, exitCode: exit, pidAlive: pid, checksumOk: checksum === "ok", passRunBound: Boolean(pass?.includes(`token=${run.runToken}`)), passCount: count, processEvidence, condaLogTail, stdoutTail: run.stdout, stderrTail: run.stderr, runDir: run.remoteRunDir } } };
  });
  return { prepareTool, statusTool };
}

export { PREP_ROOT, SCRIPT as H100_PREP_SCRIPT, ARCHIVE_SHA as H100_PREP_ARCHIVE_SHA, RESOURCES as H100_PREP_RESOURCES };
