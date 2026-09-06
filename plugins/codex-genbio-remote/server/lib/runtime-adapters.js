import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const STRICT_SSH = /^ssh -T -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes -- (HPC|NHPC|genbio_mdanh|genbioh100) /u;

function runProcess(command, timeoutMs, signal, logMaxBytes = 65536) {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/bash", ["-c", command], { stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), settled = false, timedOut = false, killTimer;
    const kill = (sig) => { try { if (child.pid) process.kill(-child.pid, sig); } catch (error) { if (error.code !== "ESRCH") child.kill(sig); } };
    const stop = () => { kill("SIGTERM"); killTimer ??= setTimeout(() => kill("SIGKILL"), 1000); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener("abort", stop); };
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    child.stdout.on("data", (chunk) => { stdout = Buffer.concat([stdout, chunk]).subarray(-logMaxBytes); });
    child.stderr.on("data", (chunk) => { stderr = Buffer.concat([stderr, chunk]).subarray(-logMaxBytes); });
    child.once("error", (error) => { settled = true; cleanup(); reject(error); });
    child.once("close", (exitCode, sig) => { if (settled) return; settled = true; cleanup(); resolve({ stdout: { text: stdout.toString("utf8") }, stderr: { text: stderr.toString("utf8") }, exitCode, signal: sig, timedOut }); });
  });
}

export function createShellAdapter(beforeRun = async () => {}, logMaxBytes = 65536) {
  return Object.freeze({ resolve: (request) => request, run: async (request) => { await beforeRun(); return runProcess(request.command, request.timeoutMs ?? 30000, request.signal, logMaxBytes); } });
}
export function createRemoteRunner(beforeRun = async () => {}, logMaxBytes = 65536) {
  return async (target, command, exec, timeoutMs = 30000) => {
    const match = STRICT_SSH.exec(command);
    if (!match || match[1] !== target) throw new Error("remote command violates the strict native OpenSSH contract");
    await beforeRun(exec);
    const result = await runProcess(command, timeoutMs, exec.signal, logMaxBytes);
    return { target, stdout: result.stdout.text, stderr: result.stderr.text, exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut };
  };
}
export function createJobRegistry() {
  const jobs = new Map(); let sequence = 0;
  return Object.freeze({
    start(spec) { const id = `job-${++sequence}`; const job = spec.run(); jobs.set(id, job); void job.done.catch(() => {}); return id; },
    get(id) { return jobs.get(id) ?? null; },
  });
}
export function createQuestionAdapter(server, { getContext = async () => ({}), persist = async () => {}, verify = async () => {} } = {}) {
  return Object.freeze({ async ask({ questions, approval }) {
    const question = questions?.[0];
    if (!question) throw new Error("approval request is malformed");
    if (questions.length !== 1 || question.options?.length !== 2) throw new Error("approval requires one explicit binary decision");
    const details = { ...(await getContext()), ...(approval ?? {}), consequence: question.options[0].description, rejection: question.options[1].description, question: question.question };
    const approvalId = createHash("sha256").update(JSON.stringify(details)).digest("hex");
    let response;
    try { response = await server.server.elicitInput({ mode: "form", message: `${question.question}\n\nServer-bound approval details:\n${JSON.stringify(details, null, 2)}`, requestedSchema: { type: "object", properties: { approved: { type: "boolean", title: question.header ?? "Approval", description: question.options[0].description }, approval_id: { type: "string", title: "Approval identity", enum: [approvalId] } }, required: ["approved", "approval_id"] } }); }
    catch { throw new Error("MCP elicitation is unavailable; consequential operation refused"); }
    const approved = response?.action === "accept" && response.content?.approved === true && response.content?.approval_id === approvalId;
    if (approved) { await verify(details); await persist({ approvalId, ...details, approvedAt: Date.now() }); }
    const selected = approved ? [question.options?.[0]?.label].filter(Boolean) : [question.options?.at(-1)?.label].filter(Boolean);
    return { answers: [{ id: question.id, selected }] };
  } });
}
