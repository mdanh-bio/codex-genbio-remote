#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, resolveConfigPath } from "../lib/config.js";
import { createGenbioServer } from "../mcp/server.js";

try {
  const configPath = resolveConfigPath();
  process.env.GENBIO_CONFIG_PATH = configPath;
  const server = createGenbioServer(await loadConfig(configPath));
  await server.connect(new StdioServerTransport());
} catch (error) {
  console.error(`codex-genbio-remote failed: ${error?.message ?? error}`);
  console.error("Configuration: set GENBIO_CONFIG_PATH to an absolute YAML file or create $CODEX_HOME/codex-genbio-remote/config.yaml.");
  process.exitCode = 1;
}
