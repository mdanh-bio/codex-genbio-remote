import { z } from "zod";
import { aggregateProjects } from "../lib/aggregate.js";
import { createExecutionRegistry } from "../lib/execution-registry.js";
import { buildPackageInventory } from "../lib/inventory.js";
import { createProjectSource } from "../lib/project-source.js";
import { createRunRegistry } from "../lib/run-registry.js";
import { runStrictRead } from "../lib/remote-readonly.js";
import { TARGETS } from "../lib/policy.js";
import { createWorkflowRegistry } from "../lib/workflow-registry.js";
import { result } from "./results.js";

const READ_ONLY = Object.freeze({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
const REMOTE_READ = Object.freeze({ readOnlyHint: true, destructiveHint: false, openWorldHint: true });
const nameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/u);
const ownerSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u).optional();

async function projectSummaries(context) {
  const source = createProjectSource(context.config);
  const summaries = [];
  for (const entry of await source.listProjects(context.workspaceRoot)) {
    try {
      const loaded = await source.loadProject(entry.project, context.workspaceRoot);
      summaries.push({ project: entry.project, origin: loaded.origin.kind, valid: true, schema_version: loaded.manifest.schemaVersion, description: loaded.manifest.description ?? "", local_root: loaded.manifest.localRoot, remote_root: loaded.manifest.remoteRoot, operations: Object.entries(loaded.manifest.jobs).map(([name, job]) => ({ name, form: "recipe", cpus: job.cpus, gpus: job.gpus, concurrency: job.concurrency })) });
    } catch (error) {
      summaries.push({ project: entry.project, origin: entry.origin, valid: false, error: String(error?.message ?? error).slice(0, 300) });
    }
  }
  return summaries;
}

export function registerReadonlyTools(server, context) {
  server.registerTool("genbio_policy_status", { description: "Return the validated Genbio policy identity, targets, and SHA-256 hash.", inputSchema: {}, annotations: READ_ONLY }, async () => {
    const loaded = await context.getPolicy();
    const data = { ok: true, policy: { valid: true, hash: loaded.hash, updated: loaded.updated, targets: Object.keys(loaded.policy.targets) } };
    return result(data, `Genbio policy is valid (${loaded.hash.slice(0, 12)}).`);
  });
  server.registerTool("genbio_preflight", { description: "Run fixed bounded read-only readiness checks for one approved target.", inputSchema: { target: z.enum(TARGETS) }, annotations: REMOTE_READ }, async ({ target }) => result({ ok: true, ...await runStrictRead(target, "preflight", context.remoteOptions) }, `${target} read-only preflight completed.`));
  server.registerTool("genbio_slurm_discovery", { description: "Collect bounded read-only node and queue evidence from HPC or NHPC.", inputSchema: { target: z.enum(["HPC", "NHPC"]) }, annotations: REMOTE_READ }, async ({ target }) => result({ ok: true, ...await runStrictRead(target, "slurm", context.remoteOptions) }, `${target} scheduler evidence collected.`));
  server.registerTool("genbio_projects", { description: "List validated workspace and configured Genbio projects.", inputSchema: {}, annotations: READ_ONLY }, async () => { const projects = await projectSummaries(context); return result({ ok: true, projects }, `Found ${projects.length} Genbio projects.`); });
  server.registerTool("genbio_project_describe", { description: "Describe one validated schema-v2 Genbio project.", inputSchema: { project: nameSchema }, annotations: READ_ONLY }, async ({ project }) => { const loaded = await createProjectSource(context.config).loadProject(project, context.workspaceRoot); return result({ ok: true, project: loaded.manifest }, `Loaded project ${project}.`); });
  server.registerTool("genbio_project_inventory", { description: "Compute a deterministic SHA-256 inventory for one project package.", inputSchema: { project: nameSchema }, annotations: READ_ONLY }, async ({ project }) => { const loaded = await createProjectSource(context.config).loadProject(project, context.workspaceRoot); const inventory = await buildPackageInventory(loaded.manifest); return result({ ok: true, project, inventory }, `Inventoried project ${project}.`); });
  async function status({ project } = {}) {
    const summaries = await projectSummaries(context);
    const runs = await createExecutionRegistry(context.config.executionRegistryDir).list();
    const aggregate = aggregateProjects({ projectSummaries: summaries, plans: [], runs });
    const projects_status = project ? aggregate.projects_status.filter((entry) => entry.project === project) : aggregate.projects_status;
    return result({ ok: true, projects_status, unattributed_runs: aggregate.unattributed }, `Returned status for ${projects_status.length} projects.`);
  }
  server.registerTool("genbio_project_status", { description: "Return local durable status without remote reconciliation.", inputSchema: { project: nameSchema.optional() }, annotations: READ_ONLY }, status);
  server.registerTool("genbio_projects_status", { description: "Return bounded local status for all discovered projects.", inputSchema: {}, annotations: READ_ONLY }, status);
  if (!context.workflowToolsEnabled) server.registerTool("genbio_workflow_status", { description: "Return one durable workflow record without advancing it.", inputSchema: { workflow_run_id: z.string().min(1).max(128), owner_handle: ownerSchema }, annotations: READ_ONLY }, async ({ workflow_run_id, owner_handle }) => { const records = await createWorkflowRegistry(context.config.workflowRegistryDir).list(owner_handle ?? "default"); const workflow = records.find((item) => item.workflowRunId === workflow_run_id) ?? null; return result({ ok: workflow !== null, workflow }, workflow ? `Workflow ${workflow_run_id} is ${workflow.status}.` : `Workflow ${workflow_run_id} was not found.`); });
  server.registerTool("genbio_runs", { description: "List bounded durable run records for an owner handle.", inputSchema: { owner_handle: ownerSchema }, annotations: READ_ONLY }, async ({ owner_handle }) => { const runs = await createRunRegistry(context.config.runRegistryDir).list(owner_handle ?? "default"); return result({ ok: true, runs }, `Returned ${runs.length} durable runs.`); });
}
