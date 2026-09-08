import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkRelease } from "../lib/release-check.js";

const plugin = fileURLToPath(new URL("../../", import.meta.url));
const installed = process.argv.includes("--installed");
const cacheIndex = process.argv.indexOf("--cache-root");
if (cacheIndex >= 0 && !process.argv[cacheIndex + 1]?.startsWith("/")) throw new Error("--cache-root requires an absolute installed plugin path");
console.log(JSON.stringify(await checkRelease(plugin, { ...(installed ? { globalSkillsRoot: join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "skills") } : {}), ...(cacheIndex >= 0 ? { installedRoot: process.argv[cacheIndex + 1] } : {}) })));
