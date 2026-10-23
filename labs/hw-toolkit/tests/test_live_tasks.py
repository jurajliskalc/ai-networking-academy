# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Juraj Liska. AI Networking Academy: noncommercial use only, see LICENSE.
"""Tests for the live counters (/api/live, rates, remote streaming), the new inventory facts and per-task
check results. Run on Linux:  python3 -m unittest discover -s labs/hw-toolkit/tests -v"""
import contextlib
import http.client
import json
import os
import shutil
import socket
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLKIT = os.path.dirname(HERE)
sys.path.insert(0, TOOLKIT)
import aina_hw  # noqa: E402
from test_aina_hw import _w  # noqa: E402

ETHTOOL_S = """NIC statistics:
     rx_packets: 10
     rx_vport_rdma_unicast_bytes: %d
     tx_vport_rdma_unicast_bytes: %d
     rx_prio3_bytes: %d
     tx_prio3_bytes: 0
     rx_prio3_pause: %d
     tx_prio3_pause: 0
     rx_discards_phy: 0
     tx_pause_storm_warning_events: 0
"""


def live_tree(root, ooo=0, cnp=0):
    pb = "/sys/class/infiniband/mlx5_0/ports/1"
    _w(root, pb + "/state", "4: ACTIVE")
    _w(root, pb + "/phys_state", "5: LinkUp")
    _w(root, pb + "/rate", "100 Gb/sec (4X EDR)")
    _w(root, pb + "/link_layer", "Ethernet")
    for k, v in {"out_of_sequence": ooo, "packet_seq_err": 0, "np_cnp_sent": cnp, "rp_cnp_handled": 0,
                 "np_ecn_marked_roce_packets": 0, "local_ack_timeout_err": 0}.items():
        _w(root, "%s/hw_counters/%s" % (pb, k), str(v))
    _w(root, "/sys/class/net/ens64f0np0/operstate", "up")
    _w(root, "/sys/class/net/ens64f0np0/statistics/rx_bytes", "1000")
    _w(root, "/sys/class/net/ens64f0np0/statistics/tx_bytes", "2000")


def snap(t, rdma_tx, pause, ooo, host="node-a", **extra):
    c = {"tx_vport_rdma_unicast_bytes": rdma_tx, "rx_vport_rdma_unicast_bytes": 0, "rx_prio3_pause": pause,
         "out_of_sequence": ooo, "np_cnp_sent": 0}
    c.update(extra)
    return {"schema": aina_hw.LIVE_SCHEMA, "host": host, "t": t, "prio": 3,
            "ports": [{"dev": "mlx5_0", "port": 1, "counters": c}]}


class LiveRates(unittest.TestCase):
    def test_gbps_and_per_second(self):
        # 12.5 GB in 1 s = 100 Gb/s; 500 pauses in 2 s = 250/s
        r = aina_hw.live_rates(snap(10.0, 0, 0, 0), snap(11.0, 12_500_000_000, 250, 7))[("mlx5_0", 1)]
        self.assertAlmostEqual(r["rdma_tx_gbps"], 100.0)
        self.assertEqual(r["pfc_rx_ps"], 250)
        self.assertEqual(r["oos_ps"], 7)
        self.assertEqual(r["rdma_rx_gbps"], 0)
        r = aina_hw.live_rates(snap(10.0, 0, 0, 0), snap(12.0, 0, 500, 0))[("mlx5_0", 1)]
        self.assertEqual(r["pfc_rx_ps"], 250)

    def test_missing_reset_and_bad_time(self):
        r = aina_hw.live_rates(snap(10.0, 5000, 0, 0), snap(11.0, 100, 0, 0))[("mlx5_0", 1)]
        self.assertIsNone(r["rdma_tx_gbps"])  # counter went backwards (driver reload): no negative rate
        self.assertIsNone(r["cnp_handled_ps"])  # absent in both
        self.assertIsNone(r["global_pause_rx_ps"])
        r = aina_hw.live_rates(snap(10.0, 0, 0, 0), snap(10.0, 100, 1, 1))[("mlx5_0", 1)]
        self.assertTrue(all(v is None for v in r.values()))  # dt = 0
        self.assertEqual(aina_hw.live_rates(snap(1, 0, 0, 0), snap(2, 0, 0, 0, host="other")), {})
        self.assertEqual(aina_hw.live_rates(None, snap(2, 0, 0, 0)), {})

    def test_ib_words(self):
        r = aina_hw.live_rates(snap(0.0, 0, 0, 0, port_xmit_data=0), snap(1.0, 0, 0, 0, port_xmit_data=250_000_000))
        self.assertAlmostEqual(r[("mlx5_0", 1)]["ib_tx_gbps"], 8.0)  # 4-octet words


class LiveSnapshot(unittest.TestCase):
    def test_ethtool_select(self):
        got = aina_hw.parse_ethtool_select(ETHTOOL_S % (1, 2, 3, 4), aina_hw.live_eth_keys(3))
        self.assertEqual(got, {"rx_vport_rdma_unicast_bytes": 1, "tx_vport_rdma_unicast_bytes": 2, "rx_prio3_bytes": 3,
                               "tx_prio3_bytes": 0, "rx_prio3_pause": 4, "tx_prio3_pause": 0, "rx_discards_phy": 0})

    def test_snapshot_from_fake_tree(self):
        with tempfile.TemporaryDirectory() as root:
            live_tree(root, ooo=5, cnp=2)
            with mock.patch.object(aina_hw, "SYSROOT", root), \
                    mock.patch.object(aina_hw, "run", lambda cmd, timeout=15: ETHTOOL_S % (10, 20, 30, 40)):
                s = aina_hw.live_snapshot([("mlx5_0", 1, "ens64f0np0")], 3, "A")
        self.assertEqual(s["schema"], aina_hw.LIVE_SCHEMA)
        p = s["ports"][0]
        self.assertEqual((p["state"], p["rate_gbps"], p["link_layer"], p["operstate"]), ("ACTIVE", 100.0, "Ethernet", "up"))
        c = p["counters"]
        self.assertEqual((c["out_of_sequence"], c["np_cnp_sent"], c["tx_vport_rdma_unicast_bytes"], c["rx_prio3_pause"], c["netdev_rx_bytes"]), (5, 2, 20, 40, 1000))
        self.assertNotIn("rx_global_pause", c)  # absent counters stay absent, not 0

    def test_ports_from_env(self):
        env = {"A_RDMA_DEV": "mlx5_0", "A_NETDEV": "ens64f0np0", "RDMA_PORT": "1", "B_RDMA_DEV": "x; rm -rf /"}
        self.assertEqual(aina_hw.live_ports_from_env(env, "A"), [("mlx5_0", 1, "ens64f0np0")])
        self.assertEqual(aina_hw.live_ports_from_env(env, "B"), [])  # names that are not plain names are refused


class FakeLive:
    remote = True

    def __init__(self):
        self.calls = 0

    def get(self):
        self.calls += 1
        return {"schema": aina_hw.LIVE_SCHEMA, "hosts": [{"role": "A", "ok": True, "snapshot": snap(time.time(), self.calls, 0, 0)}]}


class Endpoint(unittest.TestCase):
    def setUp(self):
        from http.server import ThreadingHTTPServer
        self.dir = tempfile.mkdtemp()
        self.live = FakeLive()
        handler = aina_hw.make_handler(self.dir, aina_hw.DEFAULT_ORIGINS, False, "127.0.0.1", self.live)
        handler.log_message = lambda *a: None
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        shutil.rmtree(self.dir)

    def req(self, path, method="GET", headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        h = {"Host": "127.0.0.1:%d" % self.port}
        h.update(headers or {})
        c.request(method, path, headers=h)
        r = c.getresponse()
        body = r.read()
        c.close()
        return r, body

    def test_live_json(self):
        r, body = self.req("/api/live", headers={"Origin": "http://localhost:5173"})
        self.assertEqual(r.status, 200)
        self.assertEqual(r.getheader("Access-Control-Allow-Origin"), "http://localhost:5173")
        self.assertEqual(r.getheader("Cache-Control"), "no-store")
        data = json.loads(body)
        self.assertEqual(data["schema"], aina_hw.LIVE_SCHEMA)
        r, _ = self.req("/api/live?x=1")
        self.assertEqual(r.status, 200)
        self.assertEqual(self.live.calls, 2)

    def test_security_model_applies(self):
        r, _ = self.req("/api/live", headers={"Host": "rebind.evil.example:%d" % self.port})
        self.assertEqual(r.status, 403)
        self.assertEqual(self.live.calls, 0)
        r, _ = self.req("/api/live", headers={"Origin": "https://evil.example"})
        self.assertIsNone(r.getheader("Access-Control-Allow-Origin"))
        for m in ("POST", "PUT", "DELETE"):
            r, _ = self.req("/api/live", method=m)
            self.assertEqual(r.status, 501, m)  # GET only

    def test_status_advertises_live(self):
        r, body = self.req("/api/status")
        s = json.loads(body)
        self.assertTrue(s["live"])
        self.assertTrue(s["live_remote"])
        r, body = self.req("/nope")
        self.assertIn("/api/live", json.loads(body)["endpoints"])

    def test_without_live_source(self):
        from http.server import ThreadingHTTPServer
        handler = aina_hw.make_handler(self.dir, aina_hw.DEFAULT_ORIGINS, False, "127.0.0.1")
        handler.log_message = lambda *a: None
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            c = http.client.HTTPConnection("127.0.0.1", httpd.server_address[1], timeout=5)
            c.request("GET", "/api/live", headers={"Host": "localhost"})
            self.assertEqual(c.getresponse().status, 404)
            c.close()
        finally:
            httpd.shutdown()
            httpd.server_close()


# Stands in for `ssh host python3 - live --stream`: reads the script from stdin, then streams JSON lines.
FAKE_REMOTE = r"""
import json, sys, time
sys.stdin.read()
for i in range(50):
    print(json.dumps({"schema": "aina.hw.live/1", "host": "node-b", "t": time.time(), "ports": [], "i": i}), flush=True)
    time.sleep(0.05)
"""


class Remote(unittest.TestCase):
    def test_one_session_streams_snapshots(self):
        r = aina_hw.RemoteLive("B", [sys.executable, "-c", FAKE_REMOTE], "script", idle=5, backoff=0.1)
        snap0, _ = r.get()
        self.assertIsNone(snap0)
        deadline = time.time() + 5
        latest = None
        while time.time() < deadline:
            latest, err = r.get()
            if latest and latest["i"] >= 3:
                break
            time.sleep(0.05)
        self.assertEqual(latest["host"], "node-b")
        self.assertGreaterEqual(latest["i"], 3)
        self.assertIsNone(err)
        r.idle = 0  # stop the session
        r.thread.join(5)
        self.assertFalse(r.thread.is_alive())

    def test_failed_session_reports_error(self):
        r = aina_hw.RemoteLive("B", [sys.executable, "-c", "import sys; sys.stdin.read(); sys.stderr.write('Permission denied'); sys.exit(255)"],
                               "", idle=5, backoff=0.2)
        r.get()
        deadline = time.time() + 5
        err = None
        while time.time() < deadline and not err:
            _, err = r.get()
            time.sleep(0.05)
        self.assertIn("Permission denied", err)
        r.idle = 0
        r.thread.join(5)

    def test_live_source_builds_quoted_ssh_command(self):
        env = {"HOST_A": "localhost", "HOST_B": "192.0.2.20", "SSH_USER": "aina", "B_RDMA_DEV": "mlx5_0",
               "B_NETDEV": "ens64f0np0", "A_RDMA_DEV": "mlx5_0", "RDMA_PORT": "1", "ROCE_PRIO": "3"}
        with mock.patch.object(aina_hw, "is_local", lambda h: h == "localhost"):
            src = aina_hw.LiveSource(env, remote=True, interval=2)
        cmd = src.remotes["B"].cmd
        self.assertEqual(cmd[:2], ["ssh", "-o"])
        self.assertIn("aina@192.0.2.20", cmd)
        self.assertIn("live --stream --interval 2 --duration 900 --role B --dev mlx5_0 --port 1 --prio 3 --netdev ens64f0np0", cmd[-1])
        self.assertEqual(aina_hw.LiveSource(env, remote=False).remotes, {})


class Facts(unittest.TestCase):
    def test_lockdown_and_secure_boot(self):
        self.assertEqual(aina_hw.parse_lockdown("[none] integrity confidentiality"), "none")
        self.assertEqual(aina_hw.parse_lockdown("none [integrity] confidentiality"), "integrity")
        self.assertIsNone(aina_hw.parse_lockdown(None))
        self.assertTrue(aina_hw.parse_secure_boot(b"\x06\x00\x00\x00\x01"))
        self.assertFalse(aina_hw.parse_secure_boot(b"\x06\x00\x00\x00\x00"))  # as read on host A with Secure Boot off
        self.assertIsNone(aina_hw.parse_secure_boot(b"\x06"))

    def test_rdma_cm_and_umad(self):
        with tempfile.TemporaryDirectory() as root:
            with mock.patch.object(aina_hw, "SYSROOT", root):
                self.assertIsNone(aina_hw.collect_rdma_cm("mlx5_0", 1))  # no configfs
                os.makedirs(os.path.join(root, "sys/kernel/config/rdma_cm"))
                self.assertEqual(aina_hw.collect_rdma_cm("mlx5_0", 1), {"configured": False, "default_roce_tos": None, "default_roce_mode": None})
                _w(root, "/sys/kernel/config/rdma_cm/mlx5_0/ports/1/default_roce_tos", "106")
                _w(root, "/sys/kernel/config/rdma_cm/mlx5_0/ports/1/default_roce_mode", "RoCE v2")
                self.assertEqual(aina_hw.collect_rdma_cm("mlx5_0", 1), {"configured": True, "default_roce_tos": 106, "default_roce_mode": "RoCE v2"})
                for i, dev in ((1, "mlx5_1"), (0, "mlx5_0"), (10, "mlx5_2")):
                    _w(root, "/sys/class/infiniband_mad/umad%d/ibdev" % i, dev)
                    _w(root, "/sys/class/infiniband_mad/umad%d/port" % i, "1")
                _w(root, "/sys/class/infiniband_mad/abi_version", "5")
                self.assertEqual([u["ibdev"] for u in aina_hw.collect_umad()], ["mlx5_0", "mlx5_1", "mlx5_2"])


OUTPUT = """INFO: expecting PFC on priority 3
PASS: ib_write_bw is installed
TASK: 2 Trust DSCP
PASS: host A: trusts DSCP
FAIL: host B: trust is 'pcp'
TASK: 3 PFC on priority 3, and only there
PASS: host A: PFC on 3
WARN: host B: odd
TASK: 5 ECN
INFO: absent
"""


class Tasks(unittest.TestCase):
    def test_parse_and_summarize(self):
        res = aina_hw.parse_check_output(OUTPUT)
        self.assertEqual([r.get("task") for r in res], [None, 2, 2, 3, 3])
        self.assertNotIn("task", res[0])
        tasks = aina_hw.summarize_tasks(res, aina_hw.parse_task_markers(OUTPUT))
        self.assertEqual([(t["n"], t["status"]) for t in tasks], [(0, "PASS"), (2, "FAIL"), (3, "PASS"), (5, "NONE")])
        self.assertEqual(tasks[0]["title"], "Before you start")
        self.assertEqual(tasks[2]["counts"], {"PASS": 1, "FAIL": 0, "WARN": 1, "SKIP": 0})
        self.assertEqual(aina_hw.summarize_tasks(aina_hw.parse_check_output("PASS: a"), []), [])  # old scripts: no tasks

    def test_declared_tasks_not_reached(self):
        out = "TASKS: 1 2 6\nPASS: tool\nFAIL: cannot SSH to host B\n"
        self.assertEqual(aina_hw.parse_declared_tasks(out), [1, 2, 6])
        self.assertEqual(aina_hw.parse_check_output(out)[1], {"status": "FAIL", "text": "cannot SSH to host B"})
        rec = aina_hw.build_check_record("hw-09", out, 1, "s", 1.0, {}, host="h", finished="f")
        self.assertEqual([(t["n"], t["status"]) for t in rec["tasks"]], [(0, "FAIL"), (1, "NOTRUN"), (2, "NOTRUN"), (6, "NOTRUN")])
        part = aina_hw.build_check_record("hw-09", out + "TASK: 2 SM\nPASS: x\n", 0, "s", 1.0, {}, only=2, host="h", finished="f")
        self.assertEqual([t["n"] for t in part["tasks"]], [0, 2])

    def test_record_and_partial_runs(self):
        full = aina_hw.build_check_record("hw-03", "PASS: x\nTASK: 1 One\nPASS: y\n", 0, "2026-10-23T10:00:00+00:00", 1.0, {}, host="h", finished="2026-10-23T10:00:10+00:00")
        self.assertTrue(full["passed"])
        self.assertIsNone(full["only_task"])
        part = aina_hw.build_check_record("hw-03", "TASK: 1 One\nPASS: y\n", 0, "2026-10-23T11:00:00+00:00", 1.0, {}, only=1, host="h", finished="2026-10-23T11:00:10+00:00")
        self.assertFalse(part["passed"])  # one task never verifies the whole lab
        self.assertEqual(part["tasks"], [{"n": 1, "title": "One", "status": "PASS", "counts": {"PASS": 1, "FAIL": 0, "WARN": 0, "SKIP": 0}}])
        old = dict(full, finished="2026-10-23T09:00:00+00:00", only_task=2)  # a single-task run older than the full run
        with tempfile.TemporaryDirectory() as d:
            for name, rec in (("check-a.json", full), ("check-b.json", part), ("check-c.json", old)):
                with open(os.path.join(d, name), "w") as f:
                    json.dump(rec, f)
            got = aina_hw.latest_checks(d)
        self.assertEqual([(r["lab"], r["only_task"]) for r in got], [("hw-03", None), ("hw-03", 1)])

    @unittest.skipUnless(shutil.which("bash"), "needs bash")
    def test_check_command_with_lib_sh(self):
        """A lab script using lib.sh's task guards, run through `aina-hw check` with and without --task."""
        with tempfile.TemporaryDirectory() as labs:
            os.makedirs(os.path.join(labs, "hw-99-test"))
            with open(os.path.join(labs, "hw-99-test", "check.sh"), "w") as f:
                f.write(". %s/lib.sh\npass 'prereq ok'\nif task 1 'First'; then pass one; fi\n"
                        "if task 2 'Second'; then fail two; fi\nif task_selected 2 3; then info shared; fi\naina_finish\n" % TOOLKIT)
            env = {"AINA_RESULTS": os.path.join(labs, "results"), "AINA_ENV": os.path.join(labs, "none.env")}
            with mock.patch.object(aina_hw, "LABS_DIR", labs), mock.patch.dict(os.environ, env), \
                    open(os.devnull, "w") as null, contextlib.redirect_stdout(null):
                self.assertEqual(aina_hw.main(["check", "hw-99-test"]), 1)
                self.assertEqual(aina_hw.main(["check", "hw-99-test", "--task", "1"]), 0)
                self.assertEqual(aina_hw.main(["check", "--task", "2", "hw-99-test"]), 1)
            recs = []
            for n in sorted(os.listdir(env["AINA_RESULTS"])):
                with open(os.path.join(env["AINA_RESULTS"], n)) as f:
                    recs.append(json.load(f))
        by = {r["only_task"]: r for r in recs}
        self.assertEqual([(t["n"], t["status"]) for t in by[None]["tasks"]], [(0, "PASS"), (1, "PASS"), (2, "FAIL")])
        self.assertEqual([t["n"] for t in by[1]["tasks"]], [0, 1])  # prerequisites always run
        self.assertEqual([t["n"] for t in by[2]["tasks"]], [0, 2])
        self.assertFalse(by[1]["passed"])


if __name__ == "__main__":
    unittest.main()
