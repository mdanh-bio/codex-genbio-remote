import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
let checked = 0;
for (const dir of ["lib", "mcp", "bin", "scripts", "tests"]) {
  for (const file of readdirSync(join(root, dir)).filter((x) => /\.(?:mjs|js)$/u.test(x)).sort()) {
    const result = spawnSync(process.execPath, ["--check", join(root, dir, file)], { stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status ?? 1);
    checked++;
  }
}
console.log(`Syntax checked ${checked} JavaScript files.`);
