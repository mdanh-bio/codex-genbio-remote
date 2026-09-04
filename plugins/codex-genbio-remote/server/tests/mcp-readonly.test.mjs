import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { validateConfig } from "../lib/config.js";
import { createGenbioServer } from "../mcp/server.js";

async function harness(t) {
  const root = await mkdtemp(join(tmpdir(), "genbio-mcp-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const config = validateConfig({ policyPath: join(root, "policy.yaml"), dataRoot: join(root, "state"), projectsDir: join(root, "projects"), workspaceRoot: workspace, remoteReadEnabled: false });
  await mkdir(config.projectsDir, { recursive: true });
  await writeFile(config.policyPath, `schema_version: 1\npolicy: genbio-remote-compute\nupdated: 2026-09-04\nssh:\n  client: openssh-native\n  noninteractive: true\n  options: {tty: false, batch_mode: true, connect_timeout_s: 10, strict_host_key_checking: yes, agent_forwarding: false, x11_forwarding: false, port_forwarding: false}\ntargets:\n  HPC:\n    ssh_target: HPC\n    surface: slurm\n    allowlist:\n      gpu04: {partition: gpus}\n      cpu01: {partition: cpus}\n  NHPC:\n    ssh_target: NHPC\n    surface: slurm\n    allowlist:\n      gpu01: {partition: gpu}\n  genbio_mdanh: {ssh_target: genbio_mdanh, surface: direct}\n  genbioh100:\n    ssh_target: genbioh100\n    surface: direct\n    limits: {gpus_allowed: [0]}\n    hardware: {reserved_gpu: 1, protected_process: gpu_util}\n`);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createGenbioServer(config);
  const client = new Client({ name: "phase-2-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); });
  return { client };
}

test("read-only MCP advertises bounded annotated tools", async (t) => {
  const { client } = await harness(t);
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  for (const name of ["genbio_policy_status", "genbio_preflight", "genbio_slurm_discovery", "genbio_projects", "genbio_project_describe", "genbio_project_inventory", "genbio_project_status", "genbio_projects_status", "genbio_workflow_status", "genbio_runs", "genbio_h100_direct_status"]) assert.ok(names.includes(name), name);
  assert.equal(listed.tools.find((tool) => tool.name === "genbio_policy_status").annotations.readOnlyHint, true);
  assert.equal(listed.tools.find((tool) => tool.name === "genbio_preflight").annotations.openWorldHint, true);
});

test("policy status returns structured content and disabled remote reads fail closed", async (t) => {
  const { client } = await harness(t);
  const status = await client.callTool({ name: "genbio_policy_status", arguments: {} });
  assert.equal(status.structuredContent.ok, true);
  assert.match(status.structuredContent.policy.hash, /^[a-f0-9]{64}$/u);
  const remote = await client.callTool({ name: "genbio_preflight", arguments: { target: "HPC" } });
  assert.equal(remote.isError, true);
  assert.match(remote.content[0].text, /disabled by configuration/u);
});

test("config rejects relative paths and unknown fields", () => {
  assert.throws(() => validateConfig({ policyPath: "relative", dataRoot: "/tmp/x" }), /policyPath/u);
  assert.throws(() => validateConfig({ policyPath: "/tmp/p", dataRoot: "/tmp/x", surprise: true }), /unknown field/u);
});
