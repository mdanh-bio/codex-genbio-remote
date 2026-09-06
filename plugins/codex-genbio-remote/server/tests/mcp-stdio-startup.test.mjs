import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolveConfigPath } from "../lib/config.js";
import pluginMcp from "../../.mcp.json" with { type: "json" };

const pluginRoot = fileURLToPath(new URL("../../", import.meta.url));
const entrypoint = join(pluginRoot, "server/bin/mcp-server.js");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "genbio-stdio-"));
  const configPath = join(root, "config.yaml");
  const policyPath = join(root, "policy.yaml");
  const dataRoot = join(root, "state");
  const projectsDir = join(root, "projects");
  const workspaceRoot = join(root, "workspace");
  await Promise.all([mkdir(dataRoot), mkdir(projectsDir), mkdir(workspaceRoot)]);
  await writeFile(policyPath, `schema_version: 1\npolicy: genbio-remote-compute\nupdated: 2026-09-05\nssh:\n  client: openssh-native\n  noninteractive: true\n  options: {tty: false, batch_mode: true, connect_timeout_s: 10, strict_host_key_checking: yes, agent_forwarding: false, x11_forwarding: false, port_forwarding: false}\ntargets:\n  HPC:\n    ssh_target: HPC\n    surface: slurm\n    allowlist:\n      gpu04: {partition: gpus}\n      cpu01: {partition: cpus}\n  NHPC:\n    ssh_target: NHPC\n    surface: slurm\n    allowlist:\n      gpu01: {partition: gpu}\n  genbio_mdanh: {ssh_target: genbio_mdanh, surface: direct}\n  genbioh100:\n    ssh_target: genbioh100\n    surface: direct\n    limits: {gpus_allowed: [0]}\n    hardware: {reserved_gpu: 1, protected_process: gpu_util}\n`);
  await writeFile(configPath, `policyPath: ${policyPath}\ndataRoot: ${dataRoot}\nprojectsDir: ${projectsDir}\nworkspaceRoot: ${workspaceRoot}\nremoteReadEnabled: false\n`);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, configPath };
}

test("plugin MCP manifest fixes the plugin working directory and forwards config variables", () => {
  const definition = pluginMcp.mcpServers["codex-genbio-remote"];
  assert.equal(definition.command, "/opt/homebrew/bin/node");
  assert.equal(definition.cwd, ".");
  assert.equal(definition.env_vars, undefined);
  assert.equal(definition.env.GENBIO_CONFIG_PATH, "/Users/mdanh/.codex/codex-genbio-remote/config.yaml");
  assert.equal(definition.startup_timeout_sec, 60);
});

test("configuration resolver uses an explicit path or the stable Codex home fallback", () => {
  assert.equal(resolveConfigPath({ GENBIO_CONFIG_PATH: "/tmp/genbio.yaml" }), "/tmp/genbio.yaml");
  assert.equal(resolveConfigPath({ CODEX_HOME: "/tmp/codex-home" }), "/tmp/codex-home/codex-genbio-remote/config.yaml");
  assert.throws(() => resolveConfigPath({ GENBIO_CONFIG_PATH: "relative.yaml" }), /absolute bounded path/u);
});

test("STDIO entrypoint initializes from plugin cwd and exposes all 37 typed tools", async (t) => {
  const { configPath } = await fixture(t);
  const definition = pluginMcp.mcpServers["codex-genbio-remote"];
  const client = new Client({ name: "stdio-regression", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: definition.command,
    args: definition.args,
    cwd: pluginRoot,
    env: { GENBIO_CONFIG_PATH: configPath },
    stderr: "pipe",
  });
  await client.connect(transport);
  t.after(() => client.close());
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 37);
  assert.ok(listed.tools.every((tool) => tool.name.startsWith("genbio_")));
});

test("missing default config and relative explicit config fail clearly without echoing values", async (t) => {
  const { root } = await fixture(t);
  const baseEnv = { PATH: process.env.PATH, HOME: process.env.HOME, CODEX_HOME: join(root, "missing-codex-home") };
  const missing = spawnSync(process.execPath, [entrypoint], { cwd: dirname(root), env: baseEnv, encoding: "utf8", timeout: 5000 });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Unable to read Genbio configuration file \(ENOENT\)/u);
  assert.match(missing.stderr, /set GENBIO_CONFIG_PATH to an absolute YAML file/u);

  const marker = "relative-secret-marker.yaml";
  const relative = spawnSync(process.execPath, [entrypoint], { cwd: dirname(root), env: { ...baseEnv, GENBIO_CONFIG_PATH: marker }, encoding: "utf8", timeout: 5000 });
  assert.equal(relative.status, 1);
  assert.match(relative.stderr, /GENBIO_CONFIG_PATH must be an absolute bounded path/u);
  assert.doesNotMatch(relative.stderr, new RegExp(marker, "u"));
});
