#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../lib/config.js";
import { createGenbioServer } from "../mcp/server.js";

try {
  const server = createGenbioServer(await loadConfig());
  await server.connect(new StdioServerTransport());
} catch (error) {
  console.error(`codex-genbio-remote failed: ${error?.message ?? error}`);
  process.exitCode = 1;
}
