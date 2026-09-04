---
name: operate-genbio-hpc-remote
description: >-
  Run and operate Genbio lab compute over native OpenSSH: inspect, stage,
  submit, monitor, cancel, transfer, install, retrieve, and record jobs on the
  Genbio Slurm cluster via `HPC`, or direct work on the lab workstation via
  `genbio_mdanh`. Enforces strict known-host verification, the single-node
  resource envelope, no account/time/memory directives, fresh live scheduler
  checks, approval before remote actions, and immutable run records. Use only
  native OpenSSH and the bundled validator/recorder; do not use Paramiko,
  password fallback, daemon mode, or agent forwarding for these lab hosts.
---

# Operate Genbio HPC Remote

This skill is the Genbio lab compute policy, not a generic SSH toolkit. Treat
the current computer as an SSH client and every lab host as remote.

Before any Genbio workload, read
[references/remote-cluster-policy.md](references/remote-cluster-policy.md)
completely.

## Targets

- `HPC`: original Genbio Slurm control host. Active nodes are `gpu04` and `cpu01`; `gpu01`/`gpu02` are forbidden on this target.
- `NHPC`: new Genbio Slurm control host. The former physical `gpu03` is now named `gpu01` here, in partition `gpu`; this does not make `HPC/gpu01` valid.
- `genbio_mdanh`: direct lab workstation. Use this for detached direct jobs.
- `genbioh100`: direct GPU workstation. Use this only under its separate target policy.
- `genbio` is legacy and must not be used.
- `HPC-cliproxy`, `Neuron`, and `Nurion` are outside this skill. Do not use them for a Genbio workload.
- Use the exact target alias for each cluster; never substitute `HPC` and `NHPC`.

Target policies are defined in [references/genbio-compute-policy.yaml](references/genbio-compute-policy.yaml)
(the executable source of truth) and must be loaded and validated before any remote action.
The policy is target-specific: do not apply Slurm rules to direct workstations or direct-workstation
rules to HPC. If the policy is missing, malformed, inconsistent, or changed during an operation,
fail closed.

## Non-Negotiable SSH Contract

Use native OpenSSH only. The Genbio workflow must not import Paramiko or use a
password, daemon, interactive prompt, SSH agent forwarding, or a generic SSH
helper.

Every command uses bounded connection setup and strict known-host verification:

```bash
ssh -T -o BatchMode=yes -o ConnectTimeout=10 \
  -o StrictHostKeyChecking=yes -- HPC '<remote command>'
# For the new cluster, replace only the target token with NHPC; keep all options identical.
```

Never use `StrictHostKeyChecking=no`, `accept-new`,
`UserKnownHostsFile=/dev/null`, password fallback, daemon mode, or a retry with
weaker settings or another alias. Treat unknown or changed host keys as a hard
failure.

Do not inspect, print, copy, create, or modify private keys, SSH agent state,
authentication tokens, or SSH configuration without a separate explicit request.

## Workflow

### 1. Preflight

Run bounded checks before relying on the connection:

```bash
hostname -f
command -v ssh scp bash python3
ssh -T -o BatchMode=yes -o ConnectTimeout=10 \
  -o StrictHostKeyChecking=yes -- HPC 'set -eu
hostname -f
command -v sbatch squeue sacct scontrol sinfo scancel
sinfo -N -p gpus
sinfo -N -p cpus
squeue -u "$USER"'
```

Verify the remote endpoint is the Genbio control host and exposes the allowed
nodes and partitions. Refresh this state again immediately before submission.
Hostname and hardware output are sanity checks; the strict known-host check is
authoritative.

### 2. Resolve The Workload

Resolve the exact command, inputs, outputs, remote project/run directory,
environment, logs, and success criteria. Use absolute remote paths.

Resolve software remotely in this order:

1. Live-confirmed module.
2. Existing reusable installation under `/data01/genbiolab/mdanh/data/tools/`.
3. Existing or newly approved project-specific installation.

Require separate approval before cloning, downloading, installing, compiling,
or materially transferring data.

### 3. Establish The Session Envelope

Before the first allocating or direct-launch command, ask once for the exact target and its
policy-specific envelope.

For `HPC`, ask for:

- exactly one node: `gpu04` or `cpu01`;
- its matching partition;
- maximum aggregate concurrent CPUs;
- maximum aggregate concurrent GPUs, or zero for CPU-only work;
- acknowledgement that account, time, and memory directives will be omitted.

For `NHPC`, ask for exactly `gpu01` in partition `gpu`, a maximum aggregate envelope no larger than 80 CPUs and 4 GPUs, and acknowledgement that account, time, and memory directives will be omitted.

For `genbio_mdanh`, ask for the remote run root, maximum CPU/GPU use,
concurrency, and success criteria.

For `genbioh100`, ask for workload class, remote run root, CPU threads, memory,
GPU, concurrency, and success criteria. The current hard limits are GPU 0 only,
maximum 16 CPU threads, maximum 32 GB memory, and one concurrent GPU workload.
GPU 1 and `gpu_util` are protected and must not be stopped, modified, or used by
the session.

Within an envelope, choose per-job resources and submit or retry without asking
again. Count arrays and every overlapping nonterminal job launched in this
conversation. Ask again only to expand the envelope, change target/node/partition,
or act outside the requested workload. Never carry an envelope into another
conversation.

If a proposed operation exceeds the envelope, stop before allocation and show an
interactive selection containing current use, requested resources, live headroom,
policy hard limits, safe expansion choices, wait/serialize/reduce options, rejection,
and custom guidance. Free-text guidance alone is not approval: convert it into a
concrete validated envelope and obtain an explicit selection before allocating.
A delegated child reports the constraint to its owning parent; it does not ask the
human directly.

Pin every job to exactly one allowed node with `--nodes=1`. Never use a comma
list, range, bracket expression, `gpu01`, `gpu02`, or `--exclusive`.

### 4. Prepare And Validate

For every target, validate against the active policy hash before launch. For `genbioh100`,
commands must be self-contained and avoid login-shell/rc-file dependence; source only the
explicit approved environments when needed, reset `OMP_NUM_THREADS` after sourcing GROMACS,
set `CUDA_VISIBLE_DEVICES=0`, and verify at runtime that session PIDs remain off GPU 1.


Create a versioned `.sbatch` file locally. Remove placeholders, then run:

```bash
rg -n '__[A-Z0-9_]+__|PREPARED_ONLY|TODO' slurm/<job>.sbatch
bash -n slurm/<job>.sbatch
python3 scripts/validate_sbatch.py slurm/<job>.sbatch \
  --session-node __SESSION_NODE__ \
  --session-max-cpus __SESSION_MAX_CPUS__ \
  --session-max-gpus __SESSION_MAX_GPUS__ \
  --session-used-cpus __SESSION_USED_CPUS__ \
  --session-used-gpus __SESSION_USED_GPUS__ \
  --session-job-id __PREVIOUS_SESSION_JOB_ID__ \
  --session-job-name __PREVIOUS_SESSION_JOB_NAME__
```

The validator rejects unknown `#SBATCH` directives, missing strict shell mode,
missing `cd "$SLURM_SUBMIT_DIR"`, nested `sbatch`/`salloc`, resource-changing
`srun` flags, collision-prone logs, and every prohibited resource directive. It
also accounts for array concurrency and the current session envelope.

Create a fresh remote run directory collision-first. Never overwrite an
existing run. Stage the script with strict SCP, run remote `bash -n`, and
compare local and remote SHA-256 checksums before submission.

### 5. Recheck And Submit

Immediately before submission, refresh node, queue, and session-job state.
Recalculate used resources and rerun the validator. If the job still fits,
submit:

```bash
ssh -T -o BatchMode=yes -o ConnectTimeout=10 \
  -o StrictHostKeyChecking=yes -- HPC \
  'set -eu
cd -- /absolute/remote/run
sbatch --parsable slurm/<job>.sbatch'
```

Treat nonzero SSH or remote command status as failure. Capture the complete job
ID. Never switch targets or nodes silently. Never retry a possibly successful
submission until scheduler evidence proves no job was created.

### 6. Monitor To A Terminal State

Use bounded SSH calls with `squeue`, `scontrol show job`, and `sacct`. An empty
queue is not success. Require the root job record to be `COMPLETED` with
`ExitCode=0:0`. Inspect every array element and named log. Cancel only a job
launched in this conversation or an exact job ID the user names, after the
applicable approval.

### 7. Fetch And Record

Require separate approval before material result transfer. List the remote run
directory, fetch every artifact into a fresh immutable local result directory,
and preserve the sbatch, inputs, SSH target, remote path, job ID, resource
envelope, logs, terminal scheduler state, and outputs.

Compute full SHA-256 checksums for every fetched file. Create a manifest and
record it:

```bash
python3 scripts/record_run.py --manifest results/<run>/run-manifest.json
```

Use this manifest shape:

```json
{
  "target": "HPC",
  "remote_path": "/data01/genbiolab/mdanh/data/projects/example/runs/20260816-test",
  "command": "sbatch slurm/example.sbatch",
  "envelope": {
    "node": "gpu03",
    "max_cpus": 80,
    "max_gpus": 1,
    "used_cpus": 0,
    "used_gpus": 0
  },
  "script": {
    "path": "results/20260816-test/slurm/example.sbatch",
    "sha256": "<full-sha256>"
  },
  "logs": [
    {"path": "results/20260816-test/run.log", "sha256": "<full-sha256>"}
  ],
  "expected_outputs": [
    {"path": "results/20260816-test/result.json"}
  ],
  "outputs": [
    {"path": "results/20260816-test/result.json", "sha256": "<full-sha256>"}
  ],
  "terminal_evidence": {
    "scheduler": {
      "job_id": "123456",
      "state": "COMPLETED",
      "exit_code": "0:0"
    }
  },
  "status": "ok",
  "hardware": "gpu03, 1x A6000",
  "session_id": "optional-conversation-id"
}
```

For `target=genbio_mdanh`, use `terminal_evidence.process.exit_code`. The
recorder refuses `ok` unless every declared file exists and matches its
checksum and the terminal evidence is successful.

### 8. Curate And Record Durable Evidence

After terminal scheduler or process evidence is verified, separate direct observations from interpretation. Curate only durable findings, limitations, next steps, and artifact references; do not place raw stdout/stderr, trajectories, bulk outputs, commands, credentials, or environment dumps into memory.

In the skills-only `0.1.x` bootstrap, record the verified manifest with
`scripts/record_run.py`. Automatic `genbio_finalize_run` and
`genbio_publish_run` tools are not available until the Codex MCP enforcement
server is implemented and tested. Do not claim that memory publication
occurred.

After the MCP phase is enabled, call `genbio_finalize_run` once for the
session-owned terminal run. The MCP server supplies authoritative target,
policy hash, resources, timing, scheduler identity, and terminal state; do not
restate or override those fields. Use `genbio_publish_run` only to retry an
already frozen record. Treat compute status and memory status separately.

## Direct Workstation Workflow

Use `genbio_mdanh` for direct jobs on the lab workstation, and `genbioh100` for
direct H100 work under its separate policy.

1. Read `.openscience/compute.json` only as a hint. If it lists `genbio`, do not
   use that alias; use `genbio_mdanh` after confirmation. Check live resources:
   `nproc`, `free -h`, and `nvidia-smi -L`.
2. Write `run.sh` locally. Have it write an environment manifest before the real
   work so the run can be reproduced:
   ```bash
   { python3 -V; echo "PLATFORM=$(uname -s)-$(uname -m)"; \
     echo '--- pip freeze ---'; python3 -m pip freeze; } > env.txt 2>&1 || true
   ```
3. Create a fresh remote run directory and upload the script/inputs with strict
   SCP. Confirm with the user before copying a material data set.
4. Launch fully detached through the exact SSH contract:
   ```bash
   ssh -T -o BatchMode=yes -o ConnectTimeout=10 \
     -o StrictHostKeyChecking=yes -- genbio_mdanh 'set -eu
   cd -- <remote-dir>
   setsid bash -c "bash run.sh >log 2>&1; echo \$? > exit_code" </dev/null >/dev/null 2>&1 &
   echo $! > pid
   cat pid'
   ```
   Report the PID and remote directory.
5. Track with `kill -0`, `tail`, and `nvidia-smi`. Do not poll in a loop for
   more than about two minutes. Cancel only a job launched here or a PID/dir the
   user names.
6. On completion, fetch every produced artifact into a fresh immutable local
   result directory. Record with `target=genbio_mdanh` and process exit-code
   evidence, including the run script, helper scripts, fetched outputs,
   `env_file`, and session marker.

### Direct H100 Workflow: `genbioh100`

Use only the exact `genbioh100` target and the active machine-readable policy.
Avoid login shells in automation. When required, source the approved environments
explicitly, then reset the thread count:

```bash
source /home/work/GenbioLAB/miniconda3/etc/profile.d/conda.sh
source /home/work/GenbioLAB/common/gromacs-2026.3/gmxrc_gpu.sh
export OMP_NUM_THREADS=16
export CUDA_VISIBLE_DEVICES=0
```

The current policy permits GPU 0 only, at most 16 CPU threads, at most 32 GB
memory, and one concurrent GPU workload. GPU 1 and the `gpu_util` keep-alive are
protected. Capture GPU/process state before launch, monitor session PIDs during
execution, and fail closed if a session PID appears on GPU 1 or the protected
baseline is unexpectedly disturbed. Use a fresh remote directory, detached launch,
bounded logs, PID, and exit-code evidence. Do not modify startup files, stop
`gpu_util`, or launch an unclassified workload without an explicit policy update.

## Fail Closed

Stop and report the failed check when you see any of these:

- unknown or changed host key;
- interactive authentication request;
- unexpected remote identity;
- SSH failure;
- local execution of cluster commands;
- remote login-node workload;
- missing or exceeded session envelope;
- disallowed node or partition mismatch;
- multi-node nodelist;
- account, time, memory, or exclusive directive;
- unknown `#SBATCH` directive;
- missing strict shell mode or submit-directory change;
- nested allocation or resource-changing `srun`;
- checksum mismatch;
- ambiguous remote path or overwrite risk;
- drained or down node;
- nonterminal or ambiguous scheduler evidence;
- missing manifest evidence for a successful record.

Do not guess around a blocked check. Report the smallest user decision needed to
continue.
