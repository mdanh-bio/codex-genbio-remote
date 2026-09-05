import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { load as parseYaml } from "js-yaml";

export const CONFIG_DEFAULTS = Object.freeze({ commandTimeoutMs: 30000, smokeTimeoutMs: 180000, logMaxBytes: 65536 });

function absolute(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || value.length > 2048) throw new Error(`${label} must be an absolute bounded path`);
  return resolve(value);
}
export function validateConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Genbio config must be a mapping");
  const allowed = new Set(["policyPath", "dataRoot", "projectsDir", "workspaceRoot", "remoteReadEnabled", "commandTimeoutMs", "smokeTimeoutMs", "smokeRoots", "rcloneRemote", "h100DirectProjectsDir", "h100MirrorManifestPath", "logMaxBytes"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Genbio config contains unknown field ${key}`);
  const dataRoot = absolute(value.dataRoot, "dataRoot");
  const commandTimeoutMs = value.commandTimeoutMs === undefined ? CONFIG_DEFAULTS.commandTimeoutMs : value.commandTimeoutMs;
  if (!Number.isSafeInteger(commandTimeoutMs) || commandTimeoutMs < 1000 || commandTimeoutMs > 180000) throw new Error("commandTimeoutMs must be 1000..180000");
  const smokeTimeoutMs = value.smokeTimeoutMs === undefined ? CONFIG_DEFAULTS.smokeTimeoutMs : value.smokeTimeoutMs;
  if (!Number.isSafeInteger(smokeTimeoutMs) || smokeTimeoutMs < 1000 || smokeTimeoutMs > 600000) throw new Error("smokeTimeoutMs must be 1000..600000");
  const logMaxBytes = value.logMaxBytes === undefined ? CONFIG_DEFAULTS.logMaxBytes : value.logMaxBytes;
  if (!Number.isSafeInteger(logMaxBytes) || logMaxBytes < 1024 || logMaxBytes > 4 * 1024 * 1024) throw new Error("logMaxBytes must be 1024..4194304");
  const rcloneRemote = value.rcloneRemote ?? {};
  const smokeRoots = value.smokeRoots ?? {};
  if (!smokeRoots || typeof smokeRoots !== "object" || Array.isArray(smokeRoots)) throw new Error("smokeRoots must be a mapping");
  for (const [target, root] of Object.entries(smokeRoots)) {
    if (!["HPC", "NHPC", "genbio_mdanh", "genbioh100"].includes(target) || typeof root !== "string" || !/^\/[A-Za-z0-9_./-]+$/u.test(root) || root === "/" || root.length > 1024 || root.split("/").some((x) => x === ".." || x === ".")) throw new Error("smokeRoots must use exact targets and safe absolute roots");
  }
  if (!rcloneRemote || typeof rcloneRemote !== "object" || Array.isArray(rcloneRemote)) throw new Error("rcloneRemote must be a mapping");
  for (const [target, alias] of Object.entries(rcloneRemote)) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/u.test(target) || !/^[A-Za-z0-9_.-]{1,64}$/u.test(alias)) throw new Error("rcloneRemote names must contain only safe identifier characters");
  }
  return Object.freeze({ policyPath: absolute(value.policyPath, "policyPath"), dataRoot, projectsDir: value.projectsDir ? absolute(value.projectsDir, "projectsDir") : join(dataRoot, "projects"), workspaceRoot: value.workspaceRoot ? absolute(value.workspaceRoot, "workspaceRoot") : process.cwd(), remoteReadEnabled: value.remoteReadEnabled === true, commandTimeoutMs, smokeTimeoutMs, logMaxBytes, smokeRoots: Object.freeze(smokeRoots), rcloneRemote, h100DirectProjectsDir: value.h100DirectProjectsDir ? absolute(value.h100DirectProjectsDir, "h100DirectProjectsDir") : null, h100MirrorManifestPath: value.h100MirrorManifestPath ? absolute(value.h100MirrorManifestPath, "h100MirrorManifestPath") : null, executionRegistryDir: join(dataRoot, "execution-registry"), workflowRegistryDir: join(dataRoot, "workflow-registry"), runRegistryDir: join(dataRoot, "run-registry") });
}
export async function loadConfig(path = process.env.GENBIO_CONFIG_PATH) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error("GENBIO_CONFIG_PATH must name an absolute YAML file");
  return validateConfig(parseYaml(await readFile(path, "utf8")));
}
