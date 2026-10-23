# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Juraj Liska. AI Networking Academy: noncommercial use only, see LICENSE.
"""Tests for check grading: required measurements, performance targets and declared tasks, so a lab
cannot pass without its main objective. Run on Linux:  python3 -m unittest discover -s labs/hw-toolkit/tests -v"""
import contextlib
import glob
import json
import os
import re
import shutil
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLKIT = os.path.dirname(HERE)
LABS = os.path.dirname(TOOLKIT)
sys.path.insert(0, TOOLKIT)
import aina_hw  # noqa: E402


def record(output, code=0, only=None):
    return aina_hw.build_check_record("hw-x", output, code, "s", 1.0, {}, only, host="h", finished="f")


class Grading(unittest.TestCase):
    def test_required_measurement_skipped_is_inconclusive(self):
        r = record("REQUIRE: 2 transport NCCL used RDMA\nPASS: tools installed\nSKIP: no RDMA transport\n")
        self.assertEqual((r["verdict"], r["passed"], r["functional"], r["complete"]), ("INCONCLUSIVE", False, True, False))
        self.assertEqual(r["missing"], ["transport"])
        self.assertEqual(r["required"], [{"task": 2, "key": "transport", "text": "NCCL used RDMA"}])

    def test_below_target_is_not_verified(self):
        r = record("REQUIRE: 5 bw bandwidth\nPASS: tools\nWARN: 35% of line rate\nMET: bw\nPERF: bw low\n")
        self.assertEqual((r["verdict"], r["passed"], r["complete"], r["performance"]), ("BELOW_TARGET", False, True, "low"))

    def test_declared_task_not_run_is_inconclusive(self):
        r = record("TASKS: 1 2 3\nTASK: 1 Setup\nPASS: setup ok\n")
        self.assertEqual((r["verdict"], r["passed"], r["notrun"]), ("INCONCLUSIVE", False, [2, 3]))

    def test_everything_met_passes(self):
        r = record("TASKS: 5\nREQUIRE: 5 bw bandwidth\nPASS: tools\nTASK: 5 Bandwidth\nPASS: 96%\nMET: bw\nPERF: bw ok\n")
        self.assertEqual((r["verdict"], r["passed"], r["performance"], r["met"], r["perf"]), ("PASSED", True, "ok", ["bw"], {"bw": "ok"}))

    def test_failure_wins(self):
        r = record("REQUIRE: 1 x y\nPASS: a\nFAIL: b\nMET: x\n", code=1)
        self.assertEqual(r["verdict"], "FAILED")
        self.assertEqual(record("REQUIRE: 1 x y\nPASS: a\nMET: x\n", code=1)["verdict"], "FAILED")  # exit status counts

    def test_single_task_owes_only_its_own_requirements(self):
        out = "REQUIRE: 0 tools t\nREQUIRE: 2 bw b\nREQUIRE: 3 seq s\nPASS: tools\nMET: tools\nTASK: 2 Bw\nPASS: x\nMET: bw\n"
        r = record(out, only=2)
        self.assertEqual((r["verdict"], r["passed"], r["missing"]), ("PASSED", False, []))  # never verifies the lab
        self.assertEqual(record(out.replace("MET: tools\n", ""), only=2)["missing"], ["tools"])  # prerequisites always owed
        self.assertEqual(record(out)["missing"], ["seq"])

    def test_old_output_without_requirements(self):
        r = record("PASS: a\nWARN: b\n")
        self.assertEqual((r["verdict"], r["passed"], r["performance"], r["required"]), ("PASSED", True, None, []))

    def test_one_low_result_makes_a_key_low(self):
        self.assertEqual(aina_hw.parse_perf("PERF: bw ok\nPERF: bw low\nPERF: bw ok\nPERF: lat ok\n"), {"bw": "low", "lat": "ok"})
        self.assertEqual(aina_hw.parse_requirements("REQUIRE: 1 a x\nREQUIRE: 2 a y\nREQUIRE: x b\n"), [{"task": 1, "key": "a", "text": "x"}])

    @unittest.skipUnless(shutil.which("bash"), "needs bash")
    def test_lib_sh_end_to_end(self):
        """require / pass_met / perf_low through lib.sh and `aina-hw check`: verdicts and the script's own summary."""
        script = (". %s/lib.sh\naina_tasks 1 2\nrequire 1 one 'task one measured'\nrequire 2 two 'task two measured'\n"
                  "pass prereq\nif task 1 One; then pass_met one 'one ok'; fi\n"
                  "if task 2 Two; then if [[ -n \"${MAKE_TWO:-}\" ]]; then perf_${MAKE_TWO} two 'two measured'; else skip 'two not measured'; fi; fi\n"
                  "aina_finish\n") % TOOLKIT
        verdicts = {}
        with tempfile.TemporaryDirectory() as labs:
            os.makedirs(os.path.join(labs, "hw-98-test"))
            with open(os.path.join(labs, "hw-98-test", "check.sh"), "w") as f:
                f.write(script)
            for case, extra in (("missing", {}), ("low", {"MAKE_TWO": "low"}), ("ok", {"MAKE_TWO": "ok"})):
                res = os.path.join(labs, "results-" + case)
                env = dict({"AINA_RESULTS": res, "AINA_ENV": os.path.join(labs, "none.env")}, **extra)
                buf = []
                with mock.patch.object(aina_hw, "LABS_DIR", labs), mock.patch.dict(os.environ, env), \
                        open(os.devnull, "w") as null, contextlib.redirect_stdout(null):
                    code = aina_hw.main(["check", "hw-98-test"])
                    task1 = aina_hw.main(["check", "hw-98-test", "--task", "1"])
                for n in sorted(os.listdir(res)):
                    with open(os.path.join(res, n)) as f:
                        buf.append(json.load(f))
                full = [r for r in buf if r["only_task"] is None][0]
                verdicts[case] = (full["verdict"], code, task1)
        self.assertEqual(verdicts, {"missing": ("INCONCLUSIVE", 1, 0), "low": ("BELOW_TARGET", 1, 0), "ok": ("PASSED", 0, 0)})

    @unittest.skipUnless(shutil.which("bash"), "needs bash")
    def test_finish_message(self):
        def run(body):
            with tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False) as f:
                f.write(". %s/lib.sh\n%s\naina_finish\n" % (TOOLKIT, body))
            try:
                import subprocess
                p = subprocess.run(["bash", f.name], capture_output=True, text=True)
                return p.returncode, p.stdout.strip().splitlines()[-1]
            finally:
                os.unlink(f.name)
        self.assertEqual(run("require 1 b x\nrequire 1 a y\npass p"),
                         (0, "Inconclusive: nothing failed, but required measurement(s) were not made: a b"))
        self.assertEqual(run("require 1 a y\nperf_low a 'slow'"), (0, "Functional checks passed, but 1 measurement(s) are below the performance target."))
        self.assertEqual(run("require 1 a y\nperf_ok a fine"), (0, "All checks passed."))
        self.assertEqual(run("require 1 a y\nfail bad"), (1, "1 check(s) failed."))


class LabScripts(unittest.TestCase):
    """Every real-hardware check declares its tasks and requirements, and each requirement can be met."""

    def test_every_hw_check_declares_tasks_and_requirements(self):
        scripts = sorted(glob.glob(os.path.join(LABS, "hw-*", "check.sh")))
        self.assertGreaterEqual(len(scripts), 15)
        for path in scripts:
            with open(path, encoding="utf-8") as f:
                src = f.read()
            lab = os.path.basename(os.path.dirname(path))
            with self.subTest(lab=lab):
                declared = re.search(r"^aina_tasks ([\d ]+)$", src, re.M)
                self.assertIsNotNone(declared, "no aina_tasks line")
                markers = {int(n) for n in re.findall(r"\btask (\d+) ", src)}
                self.assertEqual({int(n) for n in declared.group(1).split()}, markers, "aina_tasks differs from the task markers")
                reqs = re.findall(r"^require (\d+) ([A-Za-z0-9_.-]+) ", src, re.M)
                self.assertTrue(reqs, "no require line")
                for task, key in reqs:
                    self.assertIn(int(task), markers | {0}, "requirement %s names task %s, which has no marker" % (key, task))
                    uses = len(re.findall(r"(?:pass_met|perf_ok|perf_low|\bmet|run_bw|\brun) \"?%s\b" % re.escape(key), src))
                    self.assertGreater(uses, 0, "requirement %s is never met" % key)


if __name__ == "__main__":
    unittest.main()
