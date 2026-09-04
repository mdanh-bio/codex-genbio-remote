#!/usr/bin/env python3

import sys
import unittest
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))

from validate_sbatch import SessionEnvelope, validate_text  # noqa: E402


def script(
    *,
    node="gpu04",
    partition="gpus",
    tasks=2,
    cpus=4,
    array=None,
    gres=None,
    output=None,
    error_log=None,
    extra_directives=None,
    body=None,
):
    lines = [
        "#!/bin/bash",
        "#SBATCH --job-name=test_job",
        f"#SBATCH --partition={partition}",
        "#SBATCH --nodes=1",
        f"#SBATCH --nodelist={node}",
        f"#SBATCH --ntasks={tasks}",
        f"#SBATCH --cpus-per-task={cpus}",
    ]
    if gres:
        lines.append(f"#SBATCH --gres={gres}")
    if array:
        lines.append(f"#SBATCH --array={array}")
        lines.append(f"#SBATCH --output={output or '%x_%A_%a.out'}")
        lines.append(f"#SBATCH --error={error_log or '%x_%A_%a.err'}")
    else:
        lines.append(f"#SBATCH --output={output or '%x_%j.out'}")
        lines.append(f"#SBATCH --error={error_log or '%x_%j.err'}")
    if extra_directives:
        lines.extend(extra_directives)
    lines.extend(
        body
        or [
            "",
            "set -euo pipefail",
            'cd "$SLURM_SUBMIT_DIR"',
            "printf 'ok\\n'",
        ]
    )
    return "\n".join(lines) + "\n"


class ValidateSbatchTests(unittest.TestCase):
    def test_valid_array_job(self):
        errors, summary = validate_text(
            script(array="1-4%2", gres="gpu:1"),
            envelope=SessionEnvelope("gpu04", 80, 2),
        )
        self.assertEqual(errors, [])
        self.assertEqual(summary["aggregate_concurrent_cpus"], "16")
        self.assertEqual(summary["aggregate_concurrent_gpus"], "2")

    def test_nhpc_gpu01_is_target_scoped(self):
        errors, summary = validate_text(
            script(node="gpu01", partition="gpu", tasks=2, cpus=4, gres="gpu:1"),
            envelope=SessionEnvelope("gpu01", 80, 4),
            target="NHPC",
        )
        self.assertEqual(errors, [])
        self.assertEqual(summary["node"], "gpu01")
        cross_errors, _ = validate_text(
            script(node="gpu01", partition="gpu"),
            envelope=SessionEnvelope("gpu01", 80, 0),
            target="HPC",
        )
        self.assertTrue(any("nodelist" in item for item in cross_errors))

    def test_unknown_directive_is_rejected(self):
        errors, _ = validate_text(
            script(extra_directives=["#SBATCH --mail-user=example@example.com"]),
            envelope=SessionEnvelope("gpu04", 80, 0),
        )
        self.assertTrue(any("unknown or disallowed" in item for item in errors))

    def test_missing_strict_shell_is_rejected(self):
        body = [
            "",
            'cd "$SLURM_SUBMIT_DIR"',
            "printf 'ok\\n'",
        ]
        errors, _ = validate_text(
            script(body=body), envelope=SessionEnvelope("gpu04", 80, 0)
        )
        self.assertTrue(any("strict shell mode" in item for item in errors))

    def test_missing_submit_dir_cd_is_rejected(self):
        body = [
            "",
            "set -euo pipefail",
            "printf 'ok\\n'",
        ]
        errors, _ = validate_text(
            script(body=body), envelope=SessionEnvelope("gpu04", 80, 0)
        )
        self.assertTrue(any("SLURM_SUBMIT_DIR" in item for item in errors))

    def test_nested_sbatch_is_rejected(self):
        body = [
            "",
            "set -euo pipefail",
            'cd "$SLURM_SUBMIT_DIR"',
            "sbatch other.sbatch",
        ]
        errors, _ = validate_text(
            script(body=body), envelope=SessionEnvelope("gpu04", 80, 0)
        )
        self.assertTrue(any("nested sbatch" in item for item in errors))

    def test_nested_salloc_is_rejected(self):
        body = [
            "",
            "set -euo pipefail",
            'cd "$SLURM_SUBMIT_DIR"',
            "salloc --nodes=1",
        ]
        errors, _ = validate_text(
            script(body=body), envelope=SessionEnvelope("gpu04", 80, 0)
        )
        self.assertTrue(any("nested salloc" in item for item in errors))

    def test_resource_changing_srun_is_rejected(self):
        body = [
            "",
            "set -euo pipefail",
            'cd "$SLURM_SUBMIT_DIR"',
            "srun --ntasks=2 hostname",
        ]
        errors, _ = validate_text(
            script(body=body), envelope=SessionEnvelope("gpu04", 80, 0)
        )
        self.assertTrue(any("srun must not change resources" in item for item in errors))

    def test_attached_short_srun_flag_is_rejected(self):
        body = [
            "",
            "set -euo pipefail",
            'cd "$SLURM_SUBMIT_DIR"',
            "srun -n2 hostname",
        ]
        errors, _ = validate_text(
            script(body=body), envelope=SessionEnvelope("gpu04", 80, 0)
        )
        self.assertTrue(any("srun must not change resources" in item for item in errors))

    def test_plain_srun_is_allowed(self):
        body = [
            "",
            "set -euo pipefail",
            'cd "$SLURM_SUBMIT_DIR"',
            "srun hostname",
        ]
        errors, _ = validate_text(
            script(body=body), envelope=SessionEnvelope("gpu04", 80, 0)
        )
        self.assertEqual(errors, [])

    def test_prohibited_memory_is_rejected(self):
        errors, _ = validate_text(
            script(extra_directives=["#SBATCH --mem=16G"]),
            envelope=SessionEnvelope("gpu04", 80, 0),
        )
        self.assertTrue(any("prohibited directive" in item and "--mem" in item for item in errors))

    def test_comma_nodelist_is_rejected(self):
        text = script().replace("#SBATCH --nodelist=gpu04", "#SBATCH --nodelist=gpu04,cpu01")
        errors, _ = validate_text(text, envelope=SessionEnvelope("gpu04", 80, 0))
        self.assertTrue(any("comma/range lists" in item for item in errors))

    def test_envelope_cpu_overflow_is_rejected(self):
        errors, _ = validate_text(
            script(array="1-4%2"),
            envelope=SessionEnvelope("gpu04", 80, 0, used_cpus=70, used_gpus=0),
        )
        self.assertTrue(any("session concurrent CPU envelope exceeded" in item for item in errors))

    def test_envelope_gpu_overflow_is_rejected(self):
        errors, _ = validate_text(
            script(array="1-4%2", gres="gpu:1"),
            envelope=SessionEnvelope("gpu04", 80, 1, used_cpus=0, used_gpus=1),
        )
        self.assertTrue(any("session concurrent GPU envelope exceeded" in item for item in errors))

    def test_step_array_uses_effective_concurrency(self):
        errors, summary = validate_text(
            script(array="1-10:2%4", tasks=2, cpus=4),
            envelope=SessionEnvelope("gpu04", 80, 0),
        )
        self.assertEqual(errors, [])
        self.assertEqual(summary["array_task_count"], "5")
        self.assertEqual(summary["array_concurrency"], "4")
        self.assertEqual(summary["aggregate_concurrent_cpus"], "32")

    def test_single_task_array_uses_one_concurrent_task(self):
        errors, summary = validate_text(
            script(array="7%20", tasks=2, cpus=4),
            envelope=SessionEnvelope("gpu04", 80, 0),
        )
        self.assertEqual(errors, [])
        self.assertEqual(summary["array_concurrency"], "1")
        self.assertEqual(summary["aggregate_concurrent_cpus"], "8")

    def test_array_log_uses_task_template(self):
        errors, _ = validate_text(
            script(array="1-3%2", output="logs/%x_%A_%a.out", error_log="logs/%x_%A_%a.err"),
            envelope=SessionEnvelope("gpu04", 80, 0),
        )
        self.assertEqual(errors, [])

    def test_array_log_with_job_template_is_rejected(self):
        errors, _ = validate_text(
            script(array="1-3%2", output="logs/%x_%j.out", error_log="logs/%x_%j.err"),
            envelope=SessionEnvelope("gpu04", 80, 0),
        )
        self.assertTrue(any("%A_%a" in item for item in errors))

    def test_dependency_must_be_session_owned(self):
        errors, _ = validate_text(
            script(extra_directives=["#SBATCH --dependency=afterok:123"]),
            envelope=SessionEnvelope("gpu04", 80, 0),
            session_job_ids={"123"},
        )
        self.assertEqual(errors, [])

        errors, _ = validate_text(
            script(extra_directives=["#SBATCH --dependency=afterok:456"]),
            envelope=SessionEnvelope("gpu04", 80, 0),
            session_job_ids={"123"},
        )
        self.assertTrue(any("not in this session" in item for item in errors))

    def test_duplicate_job_name_is_rejected(self):
        errors, _ = validate_text(
            script(), envelope=SessionEnvelope("gpu04", 80, 0), session_job_names={"test_job"}
        )
        self.assertTrue(any("already used in this session" in item for item in errors))


if __name__ == "__main__":
    unittest.main()
