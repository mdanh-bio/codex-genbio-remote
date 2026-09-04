import { z } from "zod";
import { createExecutionRegistry } from "../lib/execution-registry.js";
import { createOwnerStore } from "../lib/owner-store.js";
import { createProjectSource } from "../lib/project-source.js";
import { createJobRegistry, createQuestionAdapter, createRemoteRunner, createShellAdapter } from "../lib/runtime-adapters.js";
import { createProjectTools } from "../lib/project-tools.js";
import { TARGETS } from "../lib/policy.js";
import { result } from "./results.js";

const WRITE = Object.freeze({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
const DESTRUCTIVE = Object.freeze({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
const LOCAL_WRITE = Object.freeze({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
const HANDLE = z.string().regex(/^own_[a-f0-9]{32}$/u);
const NAME = z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/u);

function remoteInside(candidate, root) { return candidate === root || candidate.startsWith(`${root.replace(/\/$/u, "")}/`); }

export function registerExecutionTools(server, context) {
  const owners = createOwnerStore(context.config.dataRoot, context.workspaceRoot);
  const shell = createShellAdapter();
  const jobs = createJobRegistry();
  const runRemote = createRemoteRunner();
  const userQuestions = createQuestionAdapter(server);
  const executionRegistry = createExecutionRegistry(context.config.executionRegistryDir);
  const projectSource = createProjectSource(context.config);
  const publicState = (state) => ({ policy: state.policy, envelope: state.envelope, runs: state.runs, submissions: state.submissions, allocations: state.allocations, remoteGrants: state.remoteGrants });
  const requirePolicy = () => { if (!context.activePolicy) throw new Error("policy is not loaded"); return context.activePolicy.policy; };
  const requireState = (exec) => exec.__state;
  const requireRemoteAccess = async (target, needs, exec, state) => {
    const uncovered = needs.filter((need) => !state.remoteGrants.some((grant) => grant.target === target && remoteInside(need.root, grant.root) && (!need.write || grant.mode === "rw")));
    if (uncovered.length === 0) return state.remoteGrants;
    const response = await userQuestions.ask({ questions: [{ id: "remote-grant", header: "Remote access", question: `Grant access to ${uncovered.map((item) => item.root).join(", ")} on ${target} for this owner handle?`, options: [{ label: "Approve this access", description: "Grant only the listed roots to this workspace-bound owner handle." }, { label: "Reject", description: "Do not access these remote roots." }] }] });
    if (!response.answers[0].selected.includes("Approve this access")) throw new Error("remote folder access was not granted");
    for (const need of uncovered) state.remoteGrants.push({ target, root: need.root, mode: need.write ? "rw" : "ro" });
    return state.remoteGrants;
  };
  const execFor = (state) => ({ agent: { id: state.ownerHandle, session: { id: state.ownerHandle, header: { cwd: state.workspaceRoot } } }, signal: new AbortController().signal, __state: state });
  const captured = new Map();
  const makeTool = (name, description, parameters, execute) => { const tool = { name, description, parameters, execute }; captured.set(name, tool); return tool; };
  createProjectTools({ makeTool, requirePolicy, requireState, publicState, config: context.config, runRemote, shell, userQuestions, jobs, requireRemoteAccess, projectSource, executionRegistry });
  const wrappedTool = (tool, inputSchema, annotations) => server.registerTool(tool.name, { description: tool.description, inputSchema: { owner_handle: HANDLE, ...inputSchema }, annotations }, async ({ owner_handle, ...args }) => {
    const loaded = await context.getPolicy(); context.activePolicy = loaded;
    const state = await owners.load(owner_handle);
    if (state.policy.hash !== loaded.hash) throw new Error("policy hash changed; create a new owner envelope");
    const output = await tool.execute(args, execFor(state));
    await owners.save(state);
    return result(output, `${tool.name} completed.`);
  });

  server.registerTool("genbio_set_envelope", { description: "Create a persisted workspace-bound owner handle and policy-valid resource envelope.", inputSchema: { target: z.enum(TARGETS), node: z.string().min(1).max(64), partition: z.string().max(64).optional(), workload_class: z.string().min(1).max(64), max_cpus: z.number().int().min(1), max_gpus: z.number().int().min(0), mem_gb: z.number().int().min(1).optional(), concurrency: z.number().int().min(1), acknowledge_restrictions: z.literal(true) }, annotations: LOCAL_WRITE }, async (args) => {
    const loaded = await context.getPolicy(); context.activePolicy = loaded;
    const targetPolicy = loaded.policy.targets[args.target];
    if (["HPC", "NHPC"].includes(args.target) && targetPolicy.allowlist?.[args.node]?.partition !== args.partition) throw new Error("node and partition do not match policy");
    if (!["HPC", "NHPC"].includes(args.target) && args.node !== args.target) throw new Error("direct target node must equal target");
    if (args.target === "genbioh100" && (args.max_gpus > 1 || args.max_cpus > targetPolicy.limits.cpu_threads_per_job || args.concurrency > (args.max_gpus > 0 ? targetPolicy.limits.concurrent_gpu_jobs : targetPolicy.limits.concurrent_cpu_jobs ?? 1))) throw new Error("genbioh100 envelope exceeds policy");
    const envelope = { target: args.target, node: args.node, partition: args.partition ?? null, workloadClass: args.workload_class, maxCpus: args.max_cpus, maxGpus: args.max_gpus, memGb: args.mem_gb ?? null, concurrency: args.concurrency, usedCpus: 0, usedGpus: 0 };
    const state = await owners.create(loaded.hash, envelope);
    return result({ ok: true, owner_handle: state.ownerHandle, envelope }, "Created a workspace-bound Genbio owner handle.");
  });
  server.registerTool("genbio_validate_resources", { description: "Validate requested resources against an owner envelope without allocating.", inputSchema: { owner_handle: HANDLE, cpus: z.number().int().min(1), gpus: z.number().int().min(0), mem_gb: z.number().int().min(1).optional(), concurrency: z.number().int().min(1) }, annotations: LOCAL_WRITE }, async ({ owner_handle, ...requested }) => { const state = await owners.load(owner_handle); const e = state.envelope; const fits = requested.cpus <= e.maxCpus && requested.gpus <= e.maxGpus && requested.concurrency <= e.concurrency && (requested.mem_gb === undefined || e.memGb === null || requested.mem_gb <= e.memGb); if (!fits) throw new Error("requested resources exceed owner envelope; create a new explicit envelope"); return result({ ok: true, fits, requested, envelope: e }, "Resources fit the owner envelope."); });
  wrappedTool(captured.get("genbio_project_plan"), { project: NAME, operation: NAME, parameters: z.record(z.string(), z.unknown()).optional() }, LOCAL_WRITE);
  wrappedTool(captured.get("genbio_project_execute"), { plan_hash: z.string().regex(/^[a-f0-9]{64}$/u) }, WRITE);
  wrappedTool(captured.get("genbio_project_cancel"), { project: NAME, operation: NAME, job_id: z.string().regex(/^[0-9]{1,10}$/u) }, DESTRUCTIVE);
  wrappedTool(captured.get("genbio_project_fetch"), { project: NAME, run_id: z.string().min(1).max(192), files: z.array(z.string().min(1).max(1024)).max(64).optional() }, WRITE);
  server.registerTool("genbio_monitor", { description: "Return the current bounded owner-run state.", inputSchema: { owner_handle: HANDLE, run_id: z.string().max(192).optional() }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }, async ({ owner_handle, run_id }) => { const state = await owners.load(owner_handle); const runs = run_id ? state.runs.filter((run) => run.runId === run_id) : state.runs; return result({ ok: true, runs }, `Returned ${runs.length} owner runs.`); });
}
