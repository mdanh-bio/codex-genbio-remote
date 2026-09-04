#!/bin/bash
#SBATCH --job-name=__JOB_NAME__
#SBATCH --partition=__PARTITION__
#SBATCH --nodes=1
#SBATCH --nodelist=__SESSION_NODE__
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=__CPUS_PER_TASK__
#SBATCH --array=__ARRAY_RANGE__%__ARRAY_CONCURRENCY__
#SBATCH --output=%x_%A_%a.out
#SBATCH --error=%x_%A_%a.err

set -euo pipefail
cd "$SLURM_SUBMIT_DIR"
printf 'GENBIO_JOB_START job_id=%s array_task=%s host=%s date=%s\n' "${SLURM_ARRAY_JOB_ID:-${SLURM_JOB_ID:-}}" "${SLURM_ARRAY_TASK_ID:-}" "$(hostname)" "$(date -Is)"
__EXACT_COMMAND_WITH_ARRAY_TASK_ID__
printf 'GENBIO_JOB_COMPLETE job_id=%s array_task=%s exit_code=0\n' "${SLURM_ARRAY_JOB_ID:-${SLURM_JOB_ID:-}}" "${SLURM_ARRAY_TASK_ID:-}"
