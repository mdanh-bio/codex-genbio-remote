import { readFile, readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

export async function releaseInventory(root) {
  const files = [];
  async function visit(relative = "") {
    for (const entry of (await readdir(join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (["node_modules", ".git", "__pycache__", ".pytest_cache", ".DS_Store"].includes(entry.name)) continue;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      const info = await lstat(join(root, path));
      if (info.isSymbolicLink()) throw new Error(`release inventory refuses symlink: ${path}`);
      if (info.isDirectory()) await visit(path);
      else if (info.isFile()) files.push({ path, size: info.size, sha256: createHash("sha256").update(await readFile(join(root, path))).digest("hex") });
      else throw new Error(`release inventory refuses non-regular entry: ${path}`);
    }
  }
  await visit();
  return { files, sha256: createHash("sha256").update(JSON.stringify(files)).digest("hex") };
}

export async function compareReleaseInventory(sourceRoot, installedRoot) {
  const source = await releaseInventory(sourceRoot);
  const installed = await releaseInventory(installedRoot);
  if (source.sha256 !== installed.sha256) {
    const expected = new Map(source.files.map((item) => [item.path, item.sha256]));
    const actual = new Map(installed.files.map((item) => [item.path, item.sha256]));
    const differing = [...new Set([...expected.keys(), ...actual.keys()])].filter((path) => expected.get(path) !== actual.get(path));
    throw new Error(`release inventory mismatch: ${differing.join(", ")}`);
  }
  return { sourceSha256: source.sha256, fileCount: source.files.length, installedMatches: true };
}

export async function checkRelease(pluginRoot, { globalSkillsRoot, installedRoot } = {}) {
  if (installedRoot) await compareReleaseInventory(pluginRoot, installedRoot);
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
