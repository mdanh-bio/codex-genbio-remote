# Remote Genbio HPC Policy

Read this file completely before preparing, submitting, or operating a Genbio
HPC job from another computer.

## Contents

- [Runtime And Precedence](#runtime-and-precedence)
- [Native SSH Contract](#native-ssh-contract)
- [Node And Partition Allowlist](#node-and-partition-allowlist)
- [Session Resource Envelope](#session-resource-envelope)
- [Remote Live Checks](#remote-live-checks)
- [Staging Contract](#staging-contract)
- [Slurm Script Contract](#slurm-script-contract)
- [Submission, Monitoring, And Cancellation](#submission-monitoring-and-cancellation)
- [Direct Workstation `genbio_mdanh`](#direct-workstation-genbio_mdanh)
- [Storage, Transfer, And Installation](#storage-transfer-and-installation)
- [Run Manifest Contract](#run-manifest-contract)
- [Known Software Rules](#known-software-rules)

## Runtime And Precedence

Treat the current computer as an SSH client and the Genbio Slurm login/control
hosts as remote. Use exact target `HPC` for the original cluster and exact target
`NHPC` for the new cluster; use `genbio_mdanh`
for direct lab workstation work. Use another exact target only when the user
confirms it for the current conversation. If the current and remote host
identities are the same, route to local scheduler work instead of SSH.

Current alias state:

- `HPC` is the original Genbio Slurm control host; only `gpu04`/`cpu01` are active here.
- `NHPC` is the new Genbio Slurm control host; the former physical `gpu03` is `gpu01` in partition `gpu` here.
- `gpu01` is forbidden on `HPC` but valid only when paired with target `NHPC`.
- `genbio_mdanh` is the current direct lab workstation alias.
- `genbio` is legacy and must not be used.
- `HPC-cliproxy` is for proxy forwarding, not scheduler compute.
- `genbioh100` is a supported direct-SSH target under its separate target policy.
- `Neuron` and `Nurion` remain outside this Genbio policy.

The executable target-specific rules live in
`references/genbio-compute-policy.yaml`. Load and validate that file before any
remote action. A missing, malformed, inconsistent, or changed policy snapshot is
a hard stop.

Use one exact SSH target throughout a session. Changing between `HPC`, `NHPC`,
and `genbio_mdanh` starts a separate session envelope and requires fresh user
confirmation.

Apply rules in this order:

1. Native SSH identity, host-key, node, and partition safeguards in this file.
2. The user's confirmed resource envelope for the current conversation.
3. Current remote Slurm state and capacity.
4. Static capacity or software snapshots only as candidates to verify remotely.

The session envelope never authorizes a prohibited node, multi-node nodelist,
unknown SSH target, weakened host verification, unrelated work, or a material
transfer or installation that requires separate approval.

## Native SSH Contract

Use noninteractive OpenSSH calls with bounded connection setup and strict
known-host verification:

```bash
ssh -T -o BatchMode=yes -o ConnectTimeout=10 \
  -o StrictHostKeyChecking=yes -- HPC '<remote command>'
```

- Let `BatchMode=yes` disable password and confirmation prompts. If public-key,
  certificate, or other noninteractive authentication is unavailable, stop.
- Keep the standard known-host database. Never use
  `StrictHostKeyChecking=no`, `accept-new`, `UserKnownHostsFile=/dev/null`, or
  another bypass. Never delete or replace a host key automatically.
- Do not request a TTY, agent forwarding, X11 forwarding, port forwarding, or an
  interactive shell for scheduler operations. For direct `genbio_mdanh` jobs,
  still use noninteractive SSH and never request password login.
- Do not import Paramiko or use a generic SSH helper for these targets. Password
  fallback, daemon mode, and agent forwarding are prohibited.
- Never inspect, print, copy, create, or modify private keys, SSH agent state,
  authentication tokens, or the user's SSH configuration without an explicit
  request that separately authorizes it.
- Use one exact SSH target throughout a session. Never scan for alternatives or
  silently fall back after a failure.
- Use single quotes around static remote command bodies so `$USER` and other
  variables expand remotely. Resolve dynamic paths first, require absolute
  remote paths, reject newlines or shell metacharacters in path inputs, and
  quote each resolved path.
- Treat a nonzero SSH exit status as a remote command failure. Distinguish a
  connection failure from a scheduler failure and retain stderr.
- Never assume that a lost connection means `sbatch` did not run. Query remote
  scheduler state using the unique job name and run path before any retry.

## Node And Partition Allowlist

| Node | Partition | Valid workload class | Durable constraints |
| --- | --- | --- | --- |
| Target | Node | Partition | Valid workload class | Durable constraints |
| --- | --- | --- | --- | --- |
| `HPC` | `gpu04` | `gpus` | GPU or approved CPU-only | One-node jobs only; at most four concurrent GPU jobs |
| `HPC` | `cpu01` | `cpus` | CPU-only | One-node jobs only; never request a GPU |
| `NHPC` | `gpu01` | `gpu` | GPU or approved CPU-only | One-node jobs only; conservative envelope cap 80 CPU / 4 GPU |

- On `HPC`, never use `gpu01` or `gpu02`.
- On `NHPC`, `gpu01` is the allowlisted node; never apply `HPC` node rules to `NHPC`.
- Never silently move a job between targets or nodes.
- Always use `--nodes=1`.
- Never set `#SBATCH --account` or `#SBATCH -A`.
- Omit `--time`, `--time-min`, `--mem`, `--mem-per-cpu`, and `--mem-per-gpu`.
  Memory is not a scheduled consumable resource on this cluster, so do not
  describe Slurm as reserving memory.
- For GPU work, use explicit `--gres=gpu:N` within the session envelope. For
  CPU-only work, omit all GPU directives.
- Never use `--exclusive`.

## Session Resource Envelope

Before the first remote `sbatch`, allocating `srun`, or `salloc`, ask once for:

- one node and its matching partition;
- node count `1`;
- maximum aggregate concurrent CPUs;
- maximum aggregate concurrent GPUs, or zero for CPU-only work;
- acknowledgement that account, time, and memory directives will be omitted.

Scope the envelope to the current conversation and requested workload. Within
it, choose each job's tasks, CPUs per task, GPUs, array, and concurrency and
submit or retry without another resource or launch approval. Ask again only to
create or expand an envelope, change node or partition, or act outside scope.

Calculate concurrent use as:

```text
job CPUs = tasks per array element x CPUs per task x effective array concurrency
job GPUs = GPUs per array element x effective array concurrency
post-submit use = overlapping nonterminal session-job use + proposed job use
```

Effective array concurrency is the declared `%CONCURRENCY` cap, bounded by the
number of array tasks. Count pending or running jobs launched under the same
envelope when they may overlap. Do not double-count dependency-linked jobs that
are guaranteed not to overlap. Require post-submit use to remain within the
session ceilings and live remote headroom. Keep a `gpu03` CPU envelope at or
below 80. On `gpu04`, keep existing and proposed concurrent GPU jobs at or
below four.

If a job does not fit, wait, serialize it with a dependency, reduce its
resource shape, or ask the user to expand the envelope. Never exceed it
silently. The expansion question must show current use, requested resources,
live headroom, policy hard limits, safe choices, rejection, and custom guidance.
Free-text guidance alone does not authorize allocation; it must be converted into
a concrete validated envelope and explicitly selected. A delegated child reports
the constraint to its owning parent rather than asking the human directly.

## Remote Live Checks

At the start of the session and immediately before submission, run bounded
remote checks:

```bash
ssh -T -o BatchMode=yes -o ConnectTimeout=10 \
  -o StrictHostKeyChecking=yes -- HPC 'set -eu
hostname -f
command -v sbatch squeue sacct scontrol sinfo scancel
sinfo -N -p gpus
sinfo -N -p cpus
squeue -u "$USER"
scontrol show partition gpus -o
scontrol show partition cpus -o'
```

After selecting a node, also run `scontrol show node __SELECTED_NODE__` remotely.
Check node state, drain reason, idle/allocated CPUs, GRES, the user's jobs, and
jobs launched in this conversation. If the node is drained, down, mismatched,
or lacks required headroom, stop. Never choose another node automatically.

## Staging Contract

- Prepare and validate scripts on the client in a task-local directory.
- Resolve an absolute remote project path. Create a new human-readable run
  directory only after `test ! -e` succeeds; never overwrite an existing run.
- Treat staging a small prepared script or manifest as normal job preparation.
  Require separate approval before material code, data, or result transfers.
- Use noninteractive SCP with strict known-host verification:

```bash
scp -o BatchMode=yes -o ConnectTimeout=10 \
  -o StrictHostKeyChecking=yes -- \
  slurm/__JOB__.sbatch HPC:/absolute/remote/run/slurm/__JOB__.sbatch
```

- Compare local and remote SHA-256 checksums after staging. Run remote
  `bash -n` on the staged path. Do not submit if content, size, syntax, owner,
  or destination is unexpected.
- Do not stream generated shell text directly into a remote shell when a
  validated file can be staged and checked instead.

## Slurm Script Contract

Use one directive per line and build scripts from this shape:

```bash
#!/bin/bash
#SBATCH --job-name=__JOB_NAME__
#SBATCH --partition=__PARTITION__
#SBATCH --nodes=1
#SBATCH --nodelist=__ONE_ALLOWED_NODE__
#SBATCH --ntasks=__NTASKS__
#SBATCH --cpus-per-task=__CPUS_PER_TASK__
# GPU work only: #SBATCH --gres=gpu:__GPUS__
# Arrays only: #SBATCH --array=1-__TASK_COUNT__%__CONCURRENCY__
#SBATCH --output=%x_%A_%a.out
#SBATCH --error=%x_%A_%a.err

set -euo pipefail
cd "$SLURM_SUBMIT_DIR"

module purge
module load __LIVE_VERIFIED_MODULES__
module -t list > modules.txt 2>&1
export OMP_NUM_THREADS="${SLURM_CPUS_PER_TASK:-1}"

required_executables=(__EXECUTABLES_AS_QUOTED_TOKENS__)
: > executable-paths.txt
for executable in "${required_executables[@]}"; do
  resolved=$(type -P -- "$executable")
  [[ -n $resolved && -x $resolved ]]
  printf '%s=%s\n' "$executable" "$resolved" >> executable-paths.txt
done

{
  printf 'date=%s\n' "$(date -Is)"
  printf 'host=%s\n' "$(hostname)"
  printf 'job_id=%s\n' "${SLURM_JOB_ID:-}"
  printf 'nodes=%s\n' "${SLURM_JOB_NODELIST:-}"
  cat executable-paths.txt
  cat modules.txt
  command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L || true
} > env.txt 2>&1

cmd=(__EXACT_COMMAND_AS_QUOTED_TOKENS__)
"${cmd[@]}" > run.log 2>&1
```

For a non-array job, use `%j` instead of `%A_%a`. Remove inapplicable GPU or
array lines rather than leaving commented directives.

The validator requires all of the following:

- `set -euo pipefail`;
- `cd "$SLURM_SUBMIT_DIR"`;
- one unique `--job-name`;
- correct `%A_%a` array templates or `%j` non-array templates;
- no unknown `#SBATCH` directive;
- no nested `sbatch` or `salloc`;
- no resource-changing `srun` flags;
- no placeholders, syntax errors, or checksum mismatch.

For a session-owned dependency, pass every referenced job ID to the validator
with repeated `--session-job-id`. A dependency on a job outside the current
session is rejected.

For GROMACS `-multidir`, express MPI slots with `--ntasks=N` and OpenMP threads
with `--cpus-per-task=<ntomp>`. Do not place all cores in one
`--cpus-per-task`. If using `mpirun --bind-to none`, do not add `mdrun -pin on`.

## Submission, Monitoring, And Cancellation

Immediately before submission, refresh remote state and envelope accounting.
When the job remains within scope and the confirmed envelope, submit without
another approval:

```bash
ssh -T -o BatchMode=yes -o ConnectTimeout=10 \
  -o StrictHostKeyChecking=yes -- HPC \
  'set -eu
cd -- /absolute/remote/run
sbatch --parsable slurm/__JOB__.sbatch'
```

Capture the complete returned job ID. If SSH disconnects or stdout is
ambiguous, do not resubmit. Query `squeue`, `sacct`, the unique job name, logs,
and run directory to determine whether Slurm accepted it.

Monitor through SSH with:

```bash
ssh -T -o BatchMode=yes -o ConnectTimeout=10 \
  -o StrictHostKeyChecking=yes -- HPC 'set -eu
squeue -j __JOB_ID__ -o "%.18i %.12P %.20j %.2t %.10M %.10l %.30R"
scontrol show job __JOB_ID__
sacct -j __JOB_ID__ --format=JobIDRaw,JobName,Partition,State,ExitCode,Elapsed,AllocCPUS,AllocTRES -P'
```

An empty queue is not success. Require the root job record to be `COMPLETED`
with `ExitCode=0:0`; inspect every array element and log. Cancel only a job
launched in the current conversation or a job ID the user explicitly names,
after the relevant approval. Never cancel another user's job.

## Direct Workstation `genbio_mdanh`

`genbio_mdanh` is the direct lab workstation alias and the current replacement
for the legacy `genbio` alias. It is a plain SSH target without a scheduler:

- Confirm live resources before launching: `nproc`, `free -h`, and
  `nvidia-smi -L` when GPU work is expected.
- Ask for the remote project/run directory, CPU/GPU selection, concurrency, and
  success criteria before launch. Do not reuse a prior resource choice.
- Use strict noninteractive SSH and key-based authentication. Never fall back to
  passwords, Paramiko, daemon mode, or interactive login.
- Use a fresh per-job remote directory and a detached process so the run
  outlives the SSH connection.
- Fetch every output and record the run with the manifest recorder using
  `target=genbio_mdanh`. A run without provenance is not complete.
- Treat the `genbio` alias and any `.openscience/compute.json` entry named
  `genbio` as stale; resolve to `genbio_mdanh` after user confirmation.

## Direct Workstation `genbioh100`

`genbioh100` is a direct SSH target without Slurm. It has a separate policy:

- Avoid login shells in automation because the handshake may hang. Commands must
  be self-contained and must not rely on `.bashrc`, `.profile`, or `~` expansion.
- Source `/home/work/GenbioLAB/miniconda3/etc/profile.d/conda.sh` only when Conda
  is required.
- For the approved GROMACS GPU environment, source
  `/home/work/GenbioLAB/common/gromacs-2026.3/gmxrc_gpu.sh`, then reset
  `OMP_NUM_THREADS` to the approved envelope value because that script exports 48.
- The current hard envelope permits GPU 0 only, at most 16 CPU threads, at most
  32 GB memory, and one concurrent GPU workload.
- GPU 1 and its `gpu_util` keep-alive are protected. Never stop, remove, modify,
  or compete with it. A session PID on GPU 1 is a hard failure.
- Before launch, capture `nproc`, memory, `nvidia-smi -L`, compute-app state, and
  the GPU 1 protected baseline. During monitoring, verify session PIDs remain on
  GPU 0 and within the CPU/memory/concurrency envelope.
- Use a fresh run directory, detached launch, bounded logs, PID, exit-code file,
  expected outputs, checksums, and a run manifest with `target=genbioh100`.
- Unclassified workloads and broader GPU use require an explicit policy edit,
  successful policy reload, and a new session envelope.

## Storage, Transfer, And Installation

- Scratch/upload root: `/data01/genbiolab/mdanh/data/simulation/`.
- Project root: `/data01/genbiolab/mdanh/data/projects/<project>/`.
- Reusable tools root: `/data01/genbiolab/mdanh/data/tools/`.
- Confirm a project slug and remote path before creation. Never invent a
  project installation directory or overwrite an existing versioned path.
- Require separate approval before cloning, downloading, installing, compiling,
  or materially transferring data or results.
- Run approved resource-heavy builds and remote data movement as Slurm jobs
  inside the session envelope, not on the remote login node.

## Run Manifest Contract

Record every finished run with `scripts/record_run.py --manifest <path>`. The
manifest must contain:

- `target`: `HPC`, `genbio_mdanh`, or `genbioh100`.
- `remote_path`: absolute remote run directory.
- `command`: exact submission or launch command.
- `envelope`: node and aggregate CPU/GPU limits plus used resources.
- `script`: local path and full SHA-256 checksum for the primary script.
- `logs`: fetched log paths and full SHA-256 checksums.
- `expected_outputs`: every output that defines successful completion.
- `outputs`: every fetched output with a full SHA-256 checksum.
- `terminal_evidence`: scheduler state for `HPC`, or process exit code for
  `genbio_mdanh`/`genbioh100`.
- `status`: exactly `ok` or `failed`.

For `status=ok`, every declared file must exist and match its checksum. `HPC`
requires scheduler `COMPLETED/0:0`; `genbio_mdanh` requires process exit code
zero. The recorder writes immutable, secret-redacted records with an atomic
locked append.

## Known Software Rules

- On CPU nodes, initialize the established conda candidate with
  `source /data01/genbiolab/modules/anaconda3/2024.10/etc/profile.d/conda.sh`.
- The cluster GROMACS executable is `gmx_mpi`; do not assume `gmx` exists.
- CPU candidates include
  `/data01/genbiolab/shared/gromacs_cpu01/gromacs/gmxrc_cpu01.sh` and
  `/data01/genbiolab/shared/gromacs_cpu01/gromacs/gmxrc_2026_cpu01.sh`.
- Treat modules and compatibility as mutable. Live-test the exact module and
  executable remotely.
- Check TPR compatibility across GROMACS versions.
- GROMACS 2025 `grompp` lacks `-I`; put include paths in the MDP with
  `include = -I/absolute/path`.
- The native PLUMED 2.10 candidate lacks libtorch; do not use it for a
  `PYTORCH_MODEL` collective variable without a compatible live-tested build.
