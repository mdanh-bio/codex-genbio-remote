import { readFile, readdir, lstat } from "node:fs/promises";
import { join } from "node:path";

export async function checkRelease(pluginRoot, { globalSkillsRoot } = {}) {
  const plugin = JSON.parse(await readFile(join(pluginRoot, ".codex-plugin/plugin.json"), "utf8"));
  const pkg = JSON.parse(await readFile(join(pluginRoot, "server/package.json"), "utf8"));
  const lock = JSON.parse(await readFile(join(pluginRoot, "server/package-lock.json"), "utf8"));
  if (plugin.version.split("+")[0] !== pkg.version || lock.version !== pkg.version || lock.packages[""].version !== pkg.version) throw new Error("release version mismatch");
  const skills = (await readdir(join(pluginRoot, "skills"), { withFileTypes: true })).filter((x) => x.isDirectory());
  if (skills.length !== 1 || skills[0].name !== "operate-genbio-hpc-remote") throw new Error("expected exactly one packaged policy skill");
  for (const file of ["SKILL.md", "references/remote-cluster-policy.md"]) {
    const text = await readFile(join(pluginRoot, "skills/operate-genbio-hpc-remote", file), "utf8");
    if (/\bgpu03\b/u.test(text)) throw new Error(`obsolete active target in ${file}`);
  }
  if (globalSkillsRoot) {
    try { await lstat(join(globalSkillsRoot, "operate-genbio-hpc-remote")); }
    catch (error) { if (error.code === "ENOENT") return { version: pkg.version, skillCount: skills.length, duplicateAbsent: true }; throw error; }
    throw new Error("duplicate global operate-genbio-hpc-remote skill is discoverable");
  }
  return { version: pkg.version, skillCount: skills.length };
}
