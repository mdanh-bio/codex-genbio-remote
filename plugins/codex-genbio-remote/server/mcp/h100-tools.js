import { z } from "zod";
import { createAizymeH100PrepTools } from "../lib/aizyme-h100-prep.js";
import { createAizymeH100Tools } from "../lib/aizyme-h100.js";
import { createH100DirectTools } from "../lib/h100-direct.js";
import { createH100MirrorTools } from "../lib/h100-mirror.js";
import { result } from "./results.js";

const HANDLE = z.string().regex(/^own_[a-f0-9]{32}$/u);
const NAME = z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/u);
const RUN_ID = z.string().min(1).max(192);
const HASH = z.string().regex(/^[a-f0-9]{64}$/u);
const WRITE = Object.freeze({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
const READ = Object.freeze({ readOnlyHint: true, destructiveHint: false, openWorldHint: true });
const RECONCILE = Object.freeze({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });

export function registerH100Tools(server, context) {
  const runtime = context.execution;
  if (!runtime) throw new Error("H100 tools require the execution runtime");
  const captured = new Map();
  const makeTool = (name, description, parameters, execute) => { const tool = { name, description, parameters, execute }; captured.set(name, tool); return tool; };
  const dependencies = { makeTool, requirePolicy: runtime.requirePolicy, requireState: runtime.requireState, publicState: runtime.publicState, runRemote: runtime.runRemote, shell: runtime.shell, userQuestions: runtime.userQuestions, jobs: runtime.jobs, config: context.config, requireRemoteAccess: runtime.requireRemoteAccess, runRegistry: runtime.runRegistry };
  createAizymeH100Tools(dependencies);
  createAizymeH100PrepTools(dependencies);
  createH100DirectTools(dependencies);
  createH100MirrorTools(dependencies);

  const register = (name, inputSchema, annotations) => {
    const tool = captured.get(name);
    if (!tool) throw new Error(`H100 tool was not created: ${name}`);
    server.registerTool(name, { description: tool.description, inputSchema: { owner_handle: HANDLE, ...inputSchema }, annotations }, async ({ owner_handle, ...args }) => {
      const loaded = await context.getPolicy({ consequential: true }); context.activePolicy = loaded;
      const state = await runtime.owners.load(owner_handle);
      if (state.policy.hash !== loaded.hash) throw new Error("policy hash changed; create a new owner envelope");
      const output = await tool.execute(args, runtime.execFor(state));
      await runtime.owners.save(state);
      return result(output, `${name} completed.`);
    });
  };

  register("genbio_aizyme_h100_stage2", {}, WRITE);
  register("genbio_aizyme_h100_status", { run_id: RUN_ID }, RECONCILE);
  register("genbio_aizyme_h100_prepare", {}, WRITE);
  register("genbio_aizyme_h100_prepare_status", { run_id: RUN_ID }, RECONCILE);
  register("genbio_h100_direct_stage", { project: NAME }, WRITE);
  register("genbio_h100_direct_job", { project: NAME, operation: NAME }, WRITE);
  register("genbio_h100_direct_status", { run_id: RUN_ID }, RECONCILE);
  register("genbio_h100_direct_fetch", { project: NAME, files: z.array(z.string().min(1).max(1024)).max(32).optional(), run_id: RUN_ID.optional() }, WRITE);
  register("genbio_h100_mirror_plan", {}, WRITE);
  register("genbio_h100_mirror_execute", { plan_hash: HASH }, WRITE);
  register("genbio_h100_mirror_status", {}, READ);
}
