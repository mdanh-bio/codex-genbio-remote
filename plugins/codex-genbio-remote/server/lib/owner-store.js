import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const HANDLE_RE = /^own_[a-f0-9]{32}$/u;
const MAX_BYTES = 4 * 1024 * 1024;

export function createOwnerStore(dataRoot, workspaceRoot) {
  const root = join(dataRoot, "owners");
  const cache = new Map();
  const fileFor = (handle) => join(root, `${handle}.json`);
  function validateHandle(handle) { if (!HANDLE_RE.test(handle ?? "")) throw new Error("owner_handle is invalid"); return handle; }
  function normalize(state) {
    if (!state || state.schema !== "genbio-owner/1" || !HANDLE_RE.test(state.ownerHandle) || state.workspaceRoot !== workspaceRoot) throw new Error("owner state is invalid or belongs to another workspace");
    if (!Array.isArray(state.plans) || !Array.isArray(state.runs) || !Array.isArray(state.remoteGrants)) throw new Error("owner state shape is invalid");
    return state;
  }
  async function persist(state) {
    await mkdir(root, { recursive: true });
    const text = `${JSON.stringify(state, (_key, value) => value instanceof Map || value instanceof Set ? undefined : value, 2)}\n`;
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("owner state exceeds persistence limit");
    const tmp = `${fileFor(state.ownerHandle)}.tmp-${randomBytes(6).toString("hex")}`;
    await writeFile(tmp, text, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, fileFor(state.ownerHandle));
    cache.set(state.ownerHandle, state);
  }
  async function create(policyHash, envelope) {
    const ownerHandle = `own_${randomBytes(16).toString("hex")}`;
    const state = { schema: "genbio-owner/1", ownerHandle, workspaceRoot, policy: { valid: true, hash: policyHash }, envelope, plans: [], runs: [], submissions: [], allocations: [], remoteGrants: [], createdAt: Date.now(), updatedAt: Date.now() };
    await persist(state); return state;
  }
  async function load(handle) {
    validateHandle(handle);
    if (cache.has(handle)) return cache.get(handle);
    let text; try { text = await readFile(fileFor(handle), "utf8"); } catch { throw new Error("unknown owner_handle"); }
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("owner state exceeds persistence limit");
    const state = normalize(JSON.parse(text)); cache.set(handle, state); return state;
  }
  async function save(state) { state.updatedAt = Date.now(); await persist(normalize(state)); }
  return Object.freeze({ create, load, save, validateHandle });
}
