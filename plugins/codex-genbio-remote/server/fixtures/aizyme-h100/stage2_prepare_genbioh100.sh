#!/bin/bash
# AI.zymes v1 Stage-2 dependency preparation for genbioh100.
# This is a preparation payload, not a G2 verifier. It never writes G2_PASS.
set -euo pipefail

export CUDA_VISIBLE_DEVICES=0
export OMP_NUM_THREADS=16
export MKL_NUM_THREADS=16
ulimit -v 33554432

ROOT=/home/work/GenbioLAB/shared/daes_enzyme
WF="$ROOT/workflow/aizyme_v1"
ENV_PREFIX="$WF/env/ai"
HF_HOME="$WF/env/hf_cache"
EXPECTED_ARCHIVE_SHA=f408113ab7c2fbbfa2771312d0c0eaae308565da521f0d01f713ddc04441a70a
CONDA=/home/work/GenbioLAB/miniconda3/bin/conda
RUN_DIR="${AIZH100_PREP_RUN_DIR:?AIZH100_PREP_RUN_DIR must be set by the launcher}"
ARCHIVE="$RUN_DIR/AIzymes-52176ff.tar.gz"
RUN_TOKEN="${AIZH100_PREP_RUN_TOKEN:?AIZH100_PREP_RUN_TOKEN must be set by the launcher}"
MANIFESTS="$RUN_DIR/manifests"
mkdir -p "$MANIFESTS" "$WF/env" "$HF_HOME"

write_status() {
  printf 'state=%s\nupdated=%s\npid=%s\ndetail=%s\n' "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$$" "${2:-}" > "$RUN_DIR/status"
}
{
  printf 'pid=%s\npgroup=%s\nstarted_utc=%s\nhostname=%s\ntoken=%s\n' "$$" "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(hostname -f)" "$RUN_TOKEN"
} > "$RUN_DIR/run_identity"
trap 'ec=$?; echo "$ec" > "$RUN_DIR/exit_code"; if test "$ec" -eq 0; then write_status completed "preparation exit 0"; else write_status failed "preparation exit $ec"; fi' EXIT
write_status running "dependency preparation started"

test -x "$CONDA"
test -f "$ARCHIVE"
test "$(sha256sum "$ARCHIVE" | awk '{print $1}')" = "$EXPECTED_ARCHIVE_SHA"
rm_guard="$RUN_DIR/source"
mkdir -p "$rm_guard"
tar -xzf "$ARCHIVE" -C "$rm_guard" ./environment.yml
ENV_YML="$rm_guard/environment.yml"
test -s "$ENV_YML"
sha256sum "$ENV_YML" > "$MANIFESTS/environment_yml.sha256"

if test -x "$ENV_PREFIX/bin/python3"; then
  printf 'environment_action=reuse\n' > "$MANIFESTS/preparation_actions.txt"
else
  "$CONDA" env create -p "$ENV_PREFIX" -f "$ENV_YML" > "$MANIFESTS/conda_create.log" 2>&1
  printf 'environment_action=create\n' > "$MANIFESTS/preparation_actions.txt"
fi
PY="$ENV_PREFIX/bin/python3"
test -x "$PY"
export PATH="$ENV_PREFIX/bin:/home/work/GenbioLAB/miniconda3/bin:/usr/bin:/bin"

"$PY" - <<'PYEOF' > "$MANIFESTS/python_probe.txt"
import importlib
mods = "numpy pandas Bio torch transformers scipy sklearn matplotlib PIL".split()
for mod in mods:
    importlib.import_module(mod)
print("required_imports=ok")
PYEOF

"$PY" - <<'PYEOF' > "$MANIFESTS/cuda_probe.txt"
import os, torch
assert os.environ.get("CUDA_VISIBLE_DEVICES") == "0"
assert torch.cuda.is_available()
assert torch.cuda.device_count() == 1
x = torch.ones((8, 8), device="cuda:0")
assert float((x @ x).sum().item()) == 512.0
print("cuda_gpu0=ok")
print("device=", torch.cuda.get_device_name(0))
print("torch=", torch.__version__)
PYEOF

# Preparation may download the approved ESMFold model. Verification later is offline-only.
HF_HOME="$HF_HOME" "$PY" - <<'PYEOF' > "$MANIFESTS/esmfold_prepare.txt"
from huggingface_hub import snapshot_download
path = snapshot_download(repo_id="facebook/esmfold_v1")
print("snapshot=", path)
PYEOF
HF_HOME="$HF_HOME" HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 "$PY" - <<'PYEOF' >> "$MANIFESTS/esmfold_prepare.txt"
from transformers import AutoTokenizer, EsmForProteinFolding
m = EsmForProteinFolding.from_pretrained("facebook/esmfold_v1", local_files_only=True, low_cpu_mem_usage=True)
AutoTokenizer.from_pretrained("facebook/esmfold_v1", local_files_only=True)
print("offline_load=ok", m.num_parameters())
PYEOF

# Existing approved backends/tools must be present; this payload does not clone Rosetta or MPNN.
mpnn=""
for cand in "$ROOT/resources/repos/LASErMPNN" "$ROOT/resources/repos/LaSERMPNN" "$WF/env/LaSERMPNN" "$WF/env/ProteinMPNN"; do
  if test -f "$cand/protein_mpnn_run.py"; then mpnn="$cand"; break; fi
done
test -n "$mpnn"
(cd "$mpnn" && "$PY" -c "import sys; sys.path.insert(0,'.'); import protein_mpnn_run")
printf 'mpnn_root=%s\n' "$mpnn" > "$MANIFESTS/mpnn_probe.txt"

rosetta=""
for cand in "$ROOT/containers/rosetta_ml420.sif" /home/work/GenbioLAB/containers/rosetta_ml420.sif; do
  if test -f "$cand"; then rosetta="$cand"; break; fi
done
test -n "$rosetta"
if command -v singularity >/dev/null 2>&1; then
  singularity exec "$rosetta" rosetta_scripts.linuxgccrelease -help > "$MANIFESTS/rosetta_help.txt" 2>&1
elif command -v apptainer >/dev/null 2>&1; then
  apptainer exec "$rosetta" rosetta_scripts.linuxgccrelease -help > "$MANIFESTS/rosetta_help.txt" 2>&1
else
  echo "no singularity/apptainer" >&2; exit 1
fi
sha256sum "$rosetta" > "$MANIFESTS/rosetta.sha256"

for exe in tleap sander cpptraj pdb4amber; do
  command -v "$exe" >> "$MANIFESTS/amber_paths.txt"
done

"$CONDA" list -p "$ENV_PREFIX" --explicit > "$MANIFESTS/conda_explicit.txt"
find "$MANIFESTS" -maxdepth 1 -type f ! -name PREPARATION_PASS ! -name checksums.sha256 -exec sha256sum {} + | sort > "$MANIFESTS/checksums.sha256"
(cd "$MANIFESTS" && sha256sum -c checksums.sha256)
printf 'PREPARATION_PASS token=%s env=%s hf_home=%s\n' "$RUN_TOKEN" "$ENV_PREFIX" "$HF_HOME" > "$MANIFESTS/PREPARATION_PASS"
echo PREPARATION_PASS
