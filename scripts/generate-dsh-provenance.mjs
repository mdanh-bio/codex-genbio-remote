#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = "/Users/mdanh/.dsh/profiles/desktop/dsh-genbio-remote";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(repoRoot, "plugins/codex-genbio-remote/provenance/dsh-genbio-remote-0.4.0.sha256.json");
const excludedDirs = new Set([".git", "backups", "node_modules", "coverage", "dist"]);
const excludedFiles = new Set(["cordis.patch.yml", ".DS_Store"]);

async function walk(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirs.has(entry.name)) continue;
    if (entry.isFile() && excludedFiles.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await walk(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

const metadata = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8"));
if (metadata.name !== "dsh-genbio-remote" || metadata.version !== "0.4.0" || metadata.license !== "MIT") {
  throw new Error("unexpected DSH source identity");
}
const files = [];
for (const path of (await walk(sourceRoot)).sort()) {
  const bytes = await readFile(path);
  files.push({ path: relative(sourceRoot, path).split(sep).join("/"), size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
}
const requiredHashes = Object.fromEntries(["package.json", "package-lock.json", "LICENSE"].map((name) => {
  const file = files.find((item) => item.path === name);
  if (!file) throw new Error(`missing ${name}`);
  return [name, file.sha256];
}));
await writeFile(output, `${JSON.stringify({ schemaVersion: 1, capturedOn: "2026-09-04", sourceRoot, package: { name: metadata.name, version: metadata.version, license: metadata.license }, exclusions: { directories: [...excludedDirs].sort(), files: [...excludedFiles].sort() }, requiredHashes, fileCount: files.length, files }, null, 2)}\n`);
console.log(`Wrote ${files.length} hashes to ${output}`);
