import { z } from "zod";
import { createFinalizationRuntime, assertTerminalEvidence } from "../lib/finalization.js";
import { result } from "./results.js";
const HANDLE = z.string().regex(/^own_[a-f0-9]{32}$/u);
const RUN_ID = z.string().min(1).max(192);
const WRITE = Object.freeze({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });

export function registerFinalizationTools(server, context) {
  const runtime = context.execution;
  const finalization = createFinalizationRuntime({ publisher: context.openVikingPublisher || null });
  const invoke = async (args, finalize) => {
    const loaded = await context.getPolicy({ consequential: true }); context.activePolicy = loaded;
    const state = await runtime.owners.load(args.owner_handle);
    if (state.policy.hash !== loaded.hash) throw new Error("policy hash changed; create a new owner envelope");
    const run = state.runs.find((x) => x.runId === args.run_id);
    if (!run) throw new Error("unknown session-owned Genbio run " + args.run_id);
    assertTerminalEvidence(run);
    const answer = await runtime.userQuestions.ask({ approval: { run_id: run.runId, target: run.target, requested_resources: run.resources, transfer: "curated metadata only; no raw logs or datasets" }, questions: [{ id: "finalize", header: "Finalize or publish", question: finalize ? "Freeze this verified terminal run and attempt configured metadata publication?" : "Retry configured publication of this already frozen run?", options: [{ label: "Approve record", description: "Persist the frozen record before optional metadata publication." }, { label: "Reject", description: "Do not finalize or publish." }] }] });
    if (!answer.answers[0].selected.includes("Approve record")) throw new Error("finalization/publication not approved");
    if (finalize) finalization.finalize(run, args);
    await runtime.owners.save(state);
    const fresh = await context.getPolicy({ consequential: true });
    if (fresh.hash !== state.policy.hash) throw new Error("policy changed before publication");
    const out = await finalization.publish(run, args.owner_handle);
    await runtime.owners.save(state);
    return result({ ok: out.ok !== false, status: runtime.publicState(state), ...(out.error ? { error: out.error } : {}) }, "Genbio finalization state updated.");
  };
  const artifact = z.object({ kind: z.string().min(1).max(64), location: z.string().min(1).max(2048), sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(), description: z.string().max(1000).optional() }).strict();
  server.registerTool("genbio_finalize_run", { description: "Approve and freeze a redacted terminal Genbio run record before optional OpenViking publication.", inputSchema: { owner_handle: HANDLE, run_id: RUN_ID, project: z.string().min(1).max(200), summary: z.string().min(1).max(12000), significance: z.string().max(6000).optional(), limitations: z.array(z.string().max(2000)).max(32).optional(), next_steps: z.array(z.string().max(2000)).max(32).optional(), artifacts: z.array(artifact).max(32).optional() }, annotations: WRITE }, async (args) => invoke(args, true));
  server.registerTool("genbio_publish_run", { description: "Approve retrying optional publication without changing finalized compute evidence.", inputSchema: { owner_handle: HANDLE, run_id: RUN_ID }, annotations: WRITE }, async (args) => invoke(args, false));
}
