import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createOwnerStore } from "../lib/owner-store.js";

test("owner persistence omits transient Map and Set launch guards", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "genbio-owner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createOwnerStore(root, "/workspace");
  const state = await store.create("a".repeat(64), { target: "genbioh100" });
  state.aizymeH100InFlight = new Set(["stage2"]);
  state.h100DirectInFlight = new Map([["project:operation", true]]);
  await store.save(state);
  const text = await readFile(join(root, "owners", `${state.ownerHandle}.json`), "utf8");
  assert.doesNotMatch(text, /aizymeH100InFlight|h100DirectInFlight/u);
});
