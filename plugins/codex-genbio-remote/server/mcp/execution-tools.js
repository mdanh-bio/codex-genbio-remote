import { z } from "zod";
import { createExecutionRegistry } from "../lib/execution-registry.js";
import { createOwnerStore } from "../lib/owner-store.js";
import { createProjectSource } from "../lib/project-source.js";
import { createJobRegistry, createQuestionAdapter, createRemoteRunner, createShellAdapter } from "../lib/runtime-adapters.js";
import { createProjectTools } from "../lib/project-tools.js";
import { TARGETS } from "../lib/policy.js";
import { createRunRegistry } from "../lib/run-registry.js";
import { validateEnvelopeArgs } from "../lib/envelope.js";
import { createSmokeService } from "../lib/smoke-launch.js";
import { result } from "./results.js";

const WRITE = Object.freeze({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
const DESTRUCTIVE = Object.freeze({ ...WRITE, destructiveHint: true });
const LOCAL_WRITE = Object.freeze({ ...WRITE, openWorldHint: false });
const HANDLE = z.string().regex(/^own_[a-f0-9]{32}$/u);
const NAME = z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/u);
const positive = () => z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const nonnegative = () => z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
function remoteInside(candidate, root) { return candidate === root || candidate.startsWith(root.replace(/\/$/u, "") + "/"); }

export function registerExecutionTools(server, context) {
  const owners = createOwnerStore(context.config.dataRoot, context.workspaceRoot);
  const scope = () => context.scope?.getStore();
  const assertPolicy = async (state) => {
    const loaded = await context.getPolicy({ consequential: true });
    if (state && state.policy.hash !== loaded.hash) throw new Error("policy hash changed; create a new owner envelope");
    context.activePolicy = loaded;
    return loaded;
  };
  const beforeRun = async (exec) => {
    const handle = scope()?.args?.owner_handle;
    await assertPolicy(exec?.__state ?? (handle ? await owners.load(handle) : null));
  };
  const shell = createShellAdapter(beforeRun, context.config.logMaxBytes);
  const jobs = createJobRegistry();
  const runRemote = createRemoteRunner(beforeRun, context.config.logMaxBytes);
  const userQuestions = createQuestionAdapter(server, {
    getContext: async () => {
      const current = scope();
      const state = current?.args?.owner_handle ? await owners.load(current.args.owner_handle) : null;
      const loaded = await assertPolicy(state);
      return { operation: current?.operation ?? "genbio-operation", owner_handle: state?.ownerHandle ?? null,
        target: current?.approvalTarget ?? current?.args?.target ?? state?.envelope?.target ?? null,
        roots: current?.roots ?? state?.remoteGrants ?? [], requested_resources: current?.args ?? {},
        envelope: state?.envelope ?? null, current_use: state?.allocations ?? [], policy_hash: loaded.hash,
        transfer: "See exact operation and transfer classification in the question" };
    },
    verify: async (details) => {
      const loaded = await context.getPolicy({ consequential: true });
      if (loaded.hash !== details.policy_hash) throw new Error("policy changed while approval was pending");
    },
    persist: async (receipt) => {
      if (!receipt.owner_handle) { if (scope()) scope().envelopeApproval = receipt; return; }
      const state = await owners.load(receipt.owner_handle);
      state.approvals ??= [];
      if (state.approvals.length >= 128) throw new Error("approval journal full; no further action authorized");
      state.approvals.push(receipt);
      await owners.save(state);
    }
  });
  const executionRegistry = createExecutionRegistry(context.config.executionRegistryDir);
  const runRegistry = createRunRegistry(context.config.runRegistryDir);
  const projectSource = createProjectSource(context.config);
  const publicState = (state) => ({ policy: state.policy, envelope: state.envelope, runs: state.runs, submissions: state.submissions, allocations: state.allocations, remoteGrants: state.remoteGrants });
  const requirePolicy = () => { if (!context.activePolicy) throw new Error("policy is not loaded"); return context.activePolicy.policy; };
  const requireState = (exec) => exec.__state;
  const requireRemoteAccess = async (target, needs, exec, state) => {
    await assertPolicy(state);
    const roots = needs.map((need) => ({ root: need.root, mode: need.write ? "rw" : "ro" }));
    if (scope()) { scope().roots = roots; scope().approvalTarget = target; }
    const uncovered = needs.filter((need) => !state.remoteGrants.some((grant) => grant.target === target && grant.policyHash === state.policy.hash && remoteInside(need.root, grant.root) && (!need.write || grant.mode === "rw")));
    if (uncovered.length === 0) return state.remoteGrants;
    const response = await userQuestions.ask({ approval: { target, roots }, questions: [{ id: "remote-grant", header: "Remote access", question: "Grant the listed remote roots to this owner handle?", options: [{ label: "Approve this access", description: "Grant only the listed target, roots, and read/write modes under this policy hash." }, { label: "Reject", description: "Do not access these remote roots." }] }] });
    if (!response.answers[0].selected.includes("Approve this access")) throw new Error("remote folder access was not granted");
    await assertPolicy(state);
    for (const need of uncovered) state.remoteGrants.push({ target, root: need.root, mode: need.write ? "rw" : "ro", policyHash: state.policy.hash });
    await owners.save(state);
    return state.remoteGrants;
  };
  const execFor = (state) => ({ agent: { id: state.ownerHandle, session: { id: state.ownerHandle, header: { cwd: state.workspaceRoot } } }, signal: new AbortController().signal, __state: state, saveState: () => owners.save(state) });
  const captured = new Map();
  const makeTool = (name, description, parameters, execute) => { const tool = { name, description, parameters, execute }; captured.set(name, tool); return tool; };
  createProjectTools({ makeTool, requirePolicy, requireState, publicState, config: context.config, runRemote, shell, userQuestions, jobs, requireRemoteAccess, projectSource, executionRegistry });
  context.execution = { owners, captured, execFor, publicState, requirePolicy, requireState, projectSource, runRemote, shell, userQuestions, jobs, requireRemoteAccess, runRegistry };
  const wrappedTool = (tool, inputSchema, annotations) => server.registerTool(tool.name, { description: tool.description, inputSchema: { owner_handle: HANDLE, ...inputSchema }, annotations }, async ({ owner_handle, ...args }) => {
    const state = await owners.load(owner_handle);
    await assertPolicy(state);
    const output = await tool.execute(args, execFor(state));
    await owners.save(state);
    return result(output, tool.name + " completed.");
  });
  server.registerTool("genbio_set_envelope", { description: "Approve and persist a workspace-bound owner resource envelope.", inputSchema: { target: z.enum(TARGETS), node: z.string().min(1).max(64), partition: z.string().max(64).optional(), workload_class: z.string().min(1).max(64), max_cpus: positive(), max_gpus: nonnegative(), mem_gb: positive().optional(), concurrency: positive(), acknowledge_restrictions: z.literal(true) }, annotations: LOCAL_WRITE }, async (args) => {
    const loaded = await assertPolicy();
    validateEnvelopeArgs(args, loaded.policy);
    const answer = await userQuestions.ask({ questions: [{ id: "envelope", header: "Resource envelope", question: "Approve the displayed target and maximum resource envelope for this owner?", options: [{ label: "Approve envelope", description: "Authorize only this workload, target, resources, and policy snapshot." }, { label: "Reject", description: "Do not create an owner envelope." }] }] });
    if (!answer.answers[0].selected.includes("Approve envelope")) throw new Error("envelope was not approved");
    const envelope = { target: args.target, node: args.node, partition: args.partition ?? null, workloadClass: args.workload_class, maxCpus: args.max_cpus, maxGpus: args.max_gpus, memGb: args.mem_gb ?? null, concurrency: args.concurrency, usedCpus: 0, usedGpus: 0 };
    const state = await owners.create(loaded.hash, envelope);
    state.approvals = [{ ...scope()?.envelopeApproval, owner_handle: state.ownerHandle }];
    await owners.save(state);
    return result({ ok: true, owner_handle: state.ownerHandle, envelope }, "Created an approved owner envelope.");
  });
  server.registerTool("genbio_validate_resources", { description: "Validate resources against the current policy and owner envelope without allocating.", inputSchema: { owner_handle: HANDLE, cpus: positive(), gpus: nonnegative(), mem_gb: positive().optional(), concurrency: positive() }, annotations: LOCAL_WRITE }, async ({ owner_handle, ...requested }) => {
    const state = await owners.load(owner_handle); await assertPolicy(state); const e = state.envelope;
    if (e.memGb !== null && requested.mem_gb === undefined) throw new Error("mem_gb is required by envelope");
    if (!(requested.cpus <= e.maxCpus && requested.gpus <= e.maxGpus && requested.concurrency <= e.concurrency && (requested.mem_gb === undefined || (e.memGb !== null && requested.mem_gb <= e.memGb)))) throw new Error("requested resources exceed owner envelope");
    return result({ ok: true, fits: true, requested, envelope: e }, "Resources fit the owner envelope.");
  });
  wrappedTool(captured.get("genbio_project_plan"), { project: NAME, operation: NAME, parameters: z.record(z.string(), z.unknown()).optional() }, LOCAL_WRITE);
  wrappedTool(captured.get("genbio_project_execute"), { plan_hash: z.string().regex(/^[a-f0-9]{64}$/u) }, WRITE);
  const projectStatus = captured.get("genbio_project_status");
  wrappedTool({ name: "genbio_project_reconcile",
    description: "Reconcile one exact owned project run using bounded scheduler and job-output evidence. Never submits or advances work.",
    execute: (args, exec) => projectStatus.execute({ ...args, reconcile: true }, exec)
  }, { project: NAME, run_id: z.string().min(1).max(192) }, WRITE);
  wrappedTool(captured.get("genbio_project_cancel"), { project: NAME, operation: NAME, job_id: z.string().regex(/^[0-9]{1,10}$/u) }, DESTRUCTIVE);
  wrappedTool(captured.get("genbio_project_fetch"), { project: NAME, run_id: z.string().min(1).max(192), files: z.array(z.string().min(1).max(1024)).max(64).optional() }, WRITE);
  const smoke = createSmokeService({ config: context.config, registry: executionRegistry, owners, runRemote, execFor, requireRemoteAccess, userQuestions, assertPolicy });
  server.registerTool("genbio_launch", { description: "Launch one fixed diagnostic smoke with durable exact-once dispatch and terminal evidence; not an arbitrary workload launcher.", inputSchema: { owner_handle: HANDLE, target: z.enum(TARGETS), operation: z.enum(["preflight-smoke", "gpu04-smoke"]), cpus: positive(), gpus: nonnegative(), mem_gb: positive().optional(), concurrency: positive() }, annotations: WRITE }, async ({ owner_handle, ...args }) => {
    const state = await owners.load(owner_handle);
    const run = await smoke.launch(state, args);
    return result({ ok: run.status !== "failed", status: { ...publicState(state), started: run } }, "Smoke run recorded; inspect its evidence status.");
  });
  server.registerTool("genbio_monitor", { description: "Read owner-run state; reconcile=true collects bounded evidence for an exact smoke run without replaying it.", inputSchema: { owner_handle: HANDLE, run_id: z.string().max(192).optional(), reconcile: z.boolean().optional() }, annotations: WRITE }, async ({ owner_handle, run_id, reconcile = false }) => {
    const state = await owners.load(owner_handle);
    if (reconcile) {
      if (!run_id) throw new Error("reconciliation requires exact run_id");
      await assertPolicy(state);
      const run = state.runs.find((item) => item.runId === run_id);
      if (!run) throw new Error("unknown owner run");
      await smoke.monitor(state, run);
    }
    const runs = run_id ? state.runs.filter((run) => run.runId === run_id) : state.runs;
    return result({ ok: true, runs }, "Returned bounded owner runs.");
  });
}
