import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import packageJson from "../package.json" with { type: "json" };
import { loadPolicy } from "../lib/policy.js";
import { createPolicyAccessor } from "../lib/policy-cache.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { registerReadonlyTools } from "./readonly-tools.js";
import { registerExecutionTools } from "./execution-tools.js";
import { registerH100Tools } from "./h100-tools.js";
import { registerFinalizationTools } from "./finalization-tools.js";
import { registerWorkflowTools } from "./workflow-tools.js";

export const SERVER_INFO = Object.freeze({ name: "codex-genbio-remote", version: packageJson.version });

export function createGenbioServer(config) {
  const server = new McpServer(SERVER_INFO, { instructions: "Read policy before Genbio work. Use only genbio_* tools. Never substitute generic shell, SSH, scheduler, or transfer commands." });
  const context = { config, workspaceRoot: config.workspaceRoot, workflowToolsEnabled: true, remoteOptions: { enabled: config.remoteReadEnabled, timeoutMs: config.commandTimeoutMs }, getPolicy: createPolicyAccessor(config.policyPath, loadPolicy) };
  const scope = new AsyncLocalStorage();
  context.scope = scope;
  Object.defineProperty(context, "activePolicy", {
    get: () => scope.getStore()?.policy,
    set: (policy) => { const current = scope.getStore(); if (current) current.policy = policy; }
  });
  const register = server.registerTool.bind(server);
  server.registerTool = (name, spec, handler) => register(name, spec, (args, extra) =>
    scope.run({ operation: name, args }, () => handler(args, extra)));
  registerReadonlyTools(server, context);
  registerExecutionTools(server, context);
  registerWorkflowTools(server, context);
  registerH100Tools(server, context);
  registerFinalizationTools(server, context);
  return server;
}
