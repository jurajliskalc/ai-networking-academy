# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Juraj Liska. AI Networking Academy: noncommercial use only, see LICENSE.
"""Write the web app's illustrative demo report by running the real collector on two fake hosts.

    python3 labs/hw-toolkit/tests/make_demo_report.py      (Linux; writes frontend/src/hw/demo-report.json)
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import test_aina_hw as t  # noqa: E402

report = t.aina_hw.build_report([t.fake_host(h) for h in t.DEMO_HOSTS], {"LAB_NAME": "demo-lab (illustrative)", "FABRIC": "roce"})
report["generated"] = "2026-10-22T09:00:00+00:00"
out = os.path.join(HERE, "..", "..", "..", "frontend", "src", "hw", "demo-report.json")
with open(out, "w", encoding="utf-8", newline="\n") as f:
    json.dump(report, f, indent=1)
    f.write("\n")
print("wrote " + os.path.normpath(out))
