import { spawn } from "node:child_process";

const STRICT_SSH = /^ssh -T -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes -- (HPC|NHPC|genbio_mdanh|genbioh100) /u;

function runProcess(command, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/bash", ["-c", command], { stdio: ["ignore", "pipe", "pipe"], signal });
    let stdout = "", stderr = "", settled = false;
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-65536); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-65536); });
    child.once("error", reject);
    child.once("close", (exitCode, sig) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ stdout: { text: stdout }, stderr: { text: stderr }, exitCode, signal: sig, timedOut: exitCode === null && sig === "SIGTERM" }); });
  });
}

export function createShellAdapter() {
  return Object.freeze({ resolve: (request) => request, run: (request) => runProcess(request.command, request.timeoutMs ?? 30000, request.signal) });
}
export function createRemoteRunner() {
  return async (target, command, exec, timeoutMs = 30000) => {
    const match = STRICT_SSH.exec(command);
    if (!match || match[1] !== target) throw new Error("remote command violates the strict native OpenSSH contract");
    const result = await runProcess(command, timeoutMs, exec.signal);
    return { target, stdout: result.stdout.text, stderr: result.stderr.text, exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut };
  };
}
export function createJobRegistry() {
  const jobs = new Map(); let sequence = 0;
  return Object.freeze({
    start(spec) { const id = `job-${++sequence}`; const job = spec.run(); jobs.set(id, job); void job.done.finally(() => {}); return id; },
    get(id) { return jobs.get(id) ?? null; },
  });
}
export function createQuestionAdapter(server) {
  return Object.freeze({ async ask({ questions }) {
    const question = questions?.[0];
    if (!question) throw new Error("approval request is malformed");
    let response;
    try { response = await server.server.elicitInput({ mode: "form", message: question.question, requestedSchema: { type: "object", properties: { approved: { type: "boolean", title: question.header ?? "Approval", description: question.options?.[0]?.description ?? "Approve this operation" } }, required: ["approved"] } }); }
    catch { throw new Error("MCP elicitation is unavailable; consequential operation refused"); }
    const approved = response.action === "accept" && response.content?.approved === true;
    const selected = approved ? [question.options?.[0]?.label].filter(Boolean) : [question.options?.at(-1)?.label].filter(Boolean);
    return { answers: [{ id: question.id, selected }] };
  } });
}
