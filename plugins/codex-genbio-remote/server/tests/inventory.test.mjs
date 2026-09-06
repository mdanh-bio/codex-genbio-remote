// Phase 2: content-addressed package inventory — deterministic digests from
// manifest files (local reads only), plus the read-only inventory tool.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildPackageInventory } from "../lib/inventory.js";

const sha = (data) => createHash("sha256").update(data).digest("hex");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "inventory-"));
  const localRoot = join(root, "local");
  const projectsDir = join(root, "projects");
  await mkdir(localRoot, { recursive: true });
  await mkdir(projectsDir, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(localRoot, "a.sh"), "alpha bytes\n");
  await writeFile(join(localRoot, "b.dat"), "beta bytes\n");
  return { root, localRoot, projectsDir };
}

function manifest(localRoot, files = ["a.sh", "b.dat"], overrides = {}) {
  return { project: "demo", localRoot, files, ...overrides };
}

test("inventory is deterministic, content-addressed, and order-insensitive", async (t) => {
  const fx = await fixture(t);
  const manifestSha = sha("manifest text");
  const first = await buildPackageInventory(manifest(fx.localRoot), manifestSha);
  const again = await buildPackageInventory(manifest(fx.localRoot), manifestSha);
  assert.equal(first.packageSha, again.packageSha, "rebuild is deterministic");
  const reordered = await buildPackageInventory(manifest(fx.localRoot, ["b.dat", "a.sh"]), manifestSha);
  assert.equal(reordered.packageSha, first.packageSha, "file order in the manifest does not change the digest");
  assert.equal(first.files[0].rel, "a.sh", "entries are canonical-sorted by rel");
  assert.equal(first.files[0].sha256, sha("alpha bytes\n"));
  assert.equal(first.files[1].sha256, sha("beta bytes\n"));
  assert.equal(first.files[0].size, 12);
  assert.equal(first.files[1].size, 11);
  assert.equal(first.totalBytes, 23);
  // A content change MUST move the digest.
  await writeFile(join(fx.localRoot, "b.dat"), "beta bytes CHANGED\n");
  const changed = await buildPackageInventory(manifest(fx.localRoot), manifestSha);
  assert.notEqual(changed.packageSha, first.packageSha, "a byte change moves the package digest");
  // A manifest digest change MUST move the package digest too.
  await writeFile(join(fx.localRoot, "b.dat"), "beta bytes\n");
  const otherManifest = await buildPackageInventory(manifest(fx.localRoot), sha("other manifest"));
  assert.notEqual(otherManifest.packageSha, first.packageSha, "the package digest binds the manifest digest");
});

test("inventory fails closed on missing files, non-regular files, and bad inputs", async (t) => {
  const fx = await fixture(t);
  const manifestSha = sha("m");
  await assert.rejects(buildPackageInventory(manifest(fx.localRoot, ["missing.bin"]), manifestSha), /package file is missing/u);
  await mkdir(join(fx.localRoot, "adir"));
  await assert.rejects(buildPackageInventory(manifest(fx.localRoot, ["adir"]), manifestSha), /not a regular file/u);
  await assert.rejects(buildPackageInventory(manifest(fx.localRoot, ["/abs/path"]), manifestSha), /relative path/u);
  await assert.rejects(buildPackageInventory(manifest(fx.localRoot, ["../escape"]), manifestSha), /unsafe path segment/u, "traversal cannot escape localRoot");
  await assert.rejects(buildPackageInventory(manifest(fx.localRoot, ["a/../../x"]), manifestSha), /unsafe path segment/u);
  await assert.rejects(buildPackageInventory(manifest(fx.localRoot), "not-a-hash"), /manifest SHA-256/u);
  await assert.rejects(buildPackageInventory(manifest(fx.localRoot, []), manifestSha), /1..64 manifest files/u);
  await assert.rejects(buildPackageInventory(null, manifestSha), /parsed manifest/u);
});

test("inventory records are frozen, JSON-safe, and never carry file contents", async (t) => {
  const fx = await fixture(t);
  const inventory = await buildPackageInventory(manifest(fx.localRoot), sha("m"));
  assert.equal(Object.isFrozen(inventory), true);
  assert.equal(Object.isFrozen(inventory.files[0]), true);
  const text = JSON.stringify(inventory);
  assert.equal(text.includes("alpha bytes"), false, "contents never leak into the record");
  assert.equal(text.includes(fx.localRoot), false, "absolute local roots never leak into the record");
  assert.deepEqual(Object.keys(inventory).sort(), ["files", "manifestSha", "packageSha", "project", "schema", "totalBytes"]);
});
