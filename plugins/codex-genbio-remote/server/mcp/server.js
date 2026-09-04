import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadPolicy } from "../lib/policy.js";
import { registerReadonlyTools } from "./readonly-tools.js";
import { registerExecutionTools } from "./execution-tools.js";
import { registerH100Tools } from "./h100-tools.js";
import { registerWorkflowTools } from "./workflow-tools.js";

export function createGenbioServer(config) {
  const server = new McpServer({ name: "codex-genbio-remote", version: "0.2.0" }, { instructions: "Read policy before Genbio work. Use only genbio_* tools. Never substitute generic shell, SSH, scheduler, or transfer commands." });
  let policyPromise;
  const context = { config, workspaceRoot: config.workspaceRoot, workflowToolsEnabled: true, remoteOptions: { enabled: config.remoteReadEnabled, timeoutMs: config.commandTimeoutMs }, getPolicy: () => policyPromise ??= loadPolicy(config.policyPath) };
  registerReadonlyTools(server, context);
  registerExecutionTools(server, context);
  registerWorkflowTools(server, context);
  registerH100Tools(server, context);
  return server;
}
