#!/bin/bash
#SBATCH --job-name=__JOB_NAME__
#SBATCH --partition=gpus
#SBATCH --nodes=1
#SBATCH --nodelist=__SESSION_NODE__
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=__CPUS_PER_TASK__
#SBATCH --gres=gpu:__GPUS__
#SBATCH --output=%x_%j.out
#SBATCH --error=%x_%j.err

set -euo pipefail
cd "$SLURM_SUBMIT_DIR"
printf 'GENBIO_JOB_START job_id=%s host=%s date=%s\n' "${SLURM_JOB_ID:-}" "$(hostname)" "$(date -Is)"
export CUDA_DEVICE_ORDER=PCI_BUS_ID
export OMP_NUM_THREADS="${SLURM_CPUS_PER_TASK:-1}"
printf 'GENBIO_GPU_VISIBLE=%s\n' "${CUDA_VISIBLE_DEVICES:-}"
# Load only live-verified software here.
__EXACT_COMMAND__
printf 'GENBIO_JOB_COMPLETE job_id=%s exit_code=0\n' "${SLURM_JOB_ID:-}"
