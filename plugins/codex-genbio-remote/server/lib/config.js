import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { load as parseYaml } from "js-yaml";

function absolute(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || value.length > 2048) throw new Error(`${label} must be an absolute bounded path`);
  return resolve(value);
}
export function validateConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Genbio config must be a mapping");
  const allowed = new Set(["policyPath", "dataRoot", "projectsDir", "workspaceRoot", "remoteReadEnabled", "commandTimeoutMs", "rcloneRemote", "h100DirectProjectsDir", "h100MirrorManifestPath"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Genbio config contains unknown field ${key}`);
  const dataRoot = absolute(value.dataRoot, "dataRoot");
  const commandTimeoutMs = value.commandTimeoutMs ?? 30000;
  if (!Number.isSafeInteger(commandTimeoutMs) || commandTimeoutMs < 1000 || commandTimeoutMs > 180000) throw new Error("commandTimeoutMs must be 1000..180000");
  return Object.freeze({ policyPath: absolute(value.policyPath, "policyPath"), dataRoot, projectsDir: value.projectsDir ? absolute(value.projectsDir, "projectsDir") : join(dataRoot, "projects"), workspaceRoot: value.workspaceRoot ? absolute(value.workspaceRoot, "workspaceRoot") : process.cwd(), remoteReadEnabled: value.remoteReadEnabled === true, commandTimeoutMs, rcloneRemote: value.rcloneRemote ?? {}, h100DirectProjectsDir: value.h100DirectProjectsDir ? absolute(value.h100DirectProjectsDir, "h100DirectProjectsDir") : null, h100MirrorManifestPath: value.h100MirrorManifestPath ? absolute(value.h100MirrorManifestPath, "h100MirrorManifestPath") : null, executionRegistryDir: join(dataRoot, "execution-registry"), workflowRegistryDir: join(dataRoot, "workflow-registry"), runRegistryDir: join(dataRoot, "run-registry") });
}
export async function loadConfig(path = process.env.GENBIO_CONFIG_PATH) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error("GENBIO_CONFIG_PATH must name an absolute YAML file");
  return validateConfig(parseYaml(await readFile(path, "utf8")));
}
