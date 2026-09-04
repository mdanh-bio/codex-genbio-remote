import { z } from "zod";
import { createWorkflowRegistry } from "../lib/workflow-registry.js";
import { createWorkflowTools } from "../lib/workflow-tools.js";
import { result } from "./results.js";

const HANDLE = z.string().regex(/^own_[a-f0-9]{32}$/u);
const ID = z.string().min(1).max(128);
const NAME = z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/u);
const LOCAL_WRITE = Object.freeze({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
const WRITE = Object.freeze({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
const READ = Object.freeze({ readOnlyHint: true, destructiveHint: false, openWorldHint: true });
const DESTRUCTIVE = Object.freeze({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });

export function registerWorkflowTools(server, context) {
  const runtime = context.execution;
  if (!runtime) throw new Error("workflow tools require the execution runtime");
  const workflowRegistry = createWorkflowRegistry(context.config.workflowRegistryDir);
  const captured = new Map();
  const makeTool = (name, description, parameters, execute) => { const tool = { name, description, parameters, execute }; captured.set(name, tool); return tool; };
  createWorkflowTools({ makeTool, requirePolicy: runtime.requirePolicy, requireState: runtime.requireState, publicState: runtime.publicState, config: context.config, projectSource: runtime.projectSource, projectPlanTool: runtime.captured.get("genbio_project_plan"), projectExecuteTool: runtime.captured.get("genbio_project_execute"), projectStatusTool: runtime.captured.get("genbio_project_status"), projectCancelTool: runtime.captured.get("genbio_project_cancel"), workflowRegistry });
  const register = (name, inputSchema, annotations) => {
    const tool = captured.get(name);
    server.registerTool(name, { description: tool.description, inputSchema: { owner_handle: HANDLE, ...inputSchema }, annotations }, async ({ owner_handle, ...args }) => {
      const loaded = await context.getPolicy(); context.activePolicy = loaded;
      const state = await runtime.owners.load(owner_handle);
      if (state.policy.hash !== loaded.hash) throw new Error("policy hash changed; create a new owner envelope");
      const output = await tool.execute(args, runtime.execFor(state));
      await runtime.owners.save(state);
      return result(output, `${name} completed.`);
    });
  };
  register("genbio_workflow_plan", { workflow: NAME }, LOCAL_WRITE);
  register("genbio_workflow_execute", { plan_hash: z.string().regex(/^[a-f0-9]{64}$/u) }, WRITE);
  register("genbio_workflow_status", { workflow_run_id: ID }, READ);
  register("genbio_workflow_advance", { workflow_run_id: ID }, WRITE);
  register("genbio_workflow_pause", { workflow_run_id: ID }, LOCAL_WRITE);
  register("genbio_workflow_resume", { workflow_run_id: ID }, LOCAL_WRITE);
  register("genbio_workflow_cancel", { workflow_run_id: ID, node_id: NAME }, DESTRUCTIVE);
}
