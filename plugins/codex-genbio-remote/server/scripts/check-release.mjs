import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkRelease } from "../lib/release-check.js";

const plugin = fileURLToPath(new URL("../../", import.meta.url));
const installed = process.argv.includes("--installed");
console.log(JSON.stringify(await checkRelease(plugin, installed ? { globalSkillsRoot: join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "skills") } : {})));
