// Slurm 22.05 can omit GPU TRES at node level. Queue fallback is limited
// to stable, fully accounted single-node allocations; Slurm remains allocator.
export function gpuCount(text) {
  if (text == null) return null;
  let aggregate = null, typed = 0, found = false;
  const seen = new Set();
  for (const item of text.split(/,(?![^(]*\))/u)) {
    if (!/^(?:gres\/)?gpu(?:[:=]|$)/u.test(item)) continue;
    const match = /^(?:gres\/)?gpu(?::([A-Za-z0-9_.-]+))?(?:=|:)([0-9]+)(?:\(S:[0-9]+(?:-[0-9]+)?(?:,[0-9]+(?:-[0-9]+)?)*\))?$/u.exec(item);
    if (!match || !Number.isSafeInteger(Number(match[2]))) throw new Error("malformed GPU count");
    const key = match[1] ?? "aggregate";
    if (seen.has(key)) throw new Error("duplicate GPU count");
    seen.add(key);
    if (match[1]) { typed += Number(match[2]); found = true; }
    else aggregate = Number(match[2]);
  }
  if (!Number.isSafeInteger(typed) || (aggregate !== null && found && aggregate !== typed)) throw new Error("conflicting GPU counts");
  return aggregate ?? (found ? typed : null);
}

export function queueProbeBody(node) {
  // Width zero avoids silent truncation of TRES or node-list fields.
  const format = "JobID:0|,State:0|,NodeList:0|,NumCPUs:0|,tres-alloc:0|,tres-per-node:0|,tres-per-job:0|,tres-per-task:0|,tres-per-socket:0|";
  const queue = `squeue --local --all --array --states=all --nodelist=${node} -h --sort=i -O '${format}'`;
  return `set -eu; export LC_ALL=C; jobs=$(${queue}); test "\${#jobs}" -le 32768; after=$(scontrol show node ${node} -o); again=$(${queue}); test "$jobs" = "$again"; printf 'GPU_JOBS_BEGIN\\n%s\\nGPU_JOBS_END\\nNODE_AFTER=%s\\nGPU_QUEUE_OK=1\\n' "$jobs" "$after"`;
}

export function parseQueueGpuAllocation(stdout, node, original) {
  const fail = (message) => { throw new Error(`${node} pre-submit probe: ${message}; failing closed before sbatch`); };
  if (Buffer.byteLength(stdout) > 49152) fail("oversized queue evidence");
  const lines = stdout.trim().split(/\r?\n/u).map((line) => line.trim());
  if (lines[0] !== "GPU_JOBS_BEGIN" || lines.at(-1) !== "GPU_QUEUE_OK=1" || lines.filter((line) => line === "GPU_JOBS_END").length !== 1) fail("incomplete allocated-GPU evidence: missing queue framing");
  const end = lines.indexOf("GPU_JOBS_END");
  if (end !== lines.length - 3 || !lines[end + 1].startsWith("NODE_AFTER=")) fail("malformed queue evidence");
  const after = lines[end + 1].slice("NODE_AFTER=".length);
  const get = (row, name) => new RegExp(`(?:^|\\s)${name}=([^\\s]+)`, "u").exec(row)?.[1] ?? null;
  for (const name of ["NodeName", "State", "CPUAlloc", "CPUTot", "CPUEfctv", "CfgTRES", "AllocTRES", "Gres"]) {
    if (get(after, name) !== get(original, name)) fail("node allocation changed during queue snapshot");
  }
  const rows = lines.slice(1, end).filter(Boolean);
  if (rows.length > 256) fail("too many queue rows");
  const ids = new Set();
  let cpus = 0, gpus = 0, gpuJobs = 0;
  const count = (text) => {
    if (["N/A", "(null)", "None"].includes(text)) return null;
    if (text === "") return null;
    if (!/^[A-Za-z0-9_./:=,+()\x2d]+$/u.test(text)) fail("unparseable GPU request");
    return gpuCount(text);
  };
  for (const row of rows) {
    const fields = row.split("|").map((part) => part.trim());
    if (fields.length !== 10 || fields[9] !== "") fail("malformed active-job evidence");
    const [id, state, nodes, cpuText, alloc, perNode, perJob, perTask, perSocket] = fields;
    if (!/^[0-9]+(?:_[0-9]+)?(?:\+[0-9]+)?$/u.test(id) || ids.has(id)) fail("duplicate or malformed job identity");
    ids.add(id);
    // Suspended, pending, multi-node and transitional rows are not a safe
    // basis for reconstructing this node's allocated resources.
    if (nodes !== node || state !== "RUNNING") fail("unsupported active-job state or node allocation");
    if (!/^[1-9][0-9]*$/u.test(cpuText) || !Number.isSafeInteger(Number(cpuText))) fail("malformed active-job CPU count");
    cpus += Number(cpuText);
    const allocated = count(alloc);
    const requests = [count(perNode), count(perJob)];
    const task = count(perTask), socket = count(perSocket);
    let jobGpus;
    if (allocated !== null) {
      if (requests.some((value) => value !== null && value > allocated) || (task ?? 0) > allocated || (socket ?? 0) > allocated) fail("conflicting job GPU evidence");
      jobGpus = allocated;
    } else {
      if ((task ?? 0) > 0 || (socket ?? 0) > 0) fail("per-task or per-socket GPU allocation unavailable");
      const present = requests.filter((value) => value !== null);
      if (new Set(present).size > 1) fail("conflicting job GPU requests");
      jobGpus = present[0] ?? 0;
    }
    gpus += jobGpus;
    if (jobGpus > 0) gpuJobs++;
  }
  if (!Number.isSafeInteger(cpus) || cpus !== Number(get(original, "CPUAlloc"))) fail("incomplete queue CPU coverage");
  if (!Number.isSafeInteger(gpus)) fail("invalid queue GPU total");
  return { allocatedGpus: gpus, gpuJobs };
}
