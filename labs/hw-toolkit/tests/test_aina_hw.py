# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Juraj Liska. AI Networking Academy: noncommercial use only, see LICENSE.
"""Tests for aina_hw.py. Run on Linux (fake sysfs trees use symlinks):

    python3 -m unittest discover -s labs/hw-toolkit/tests -v

`fake_host` builds an illustrative host (sysfs tree + canned command output) and runs the real collector
against it. make_demo_report.py uses the same builder to write the web app's demo report, so the demo,
the collector and the browser's parser cannot drift apart.
"""
import json
import os
import socket
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import aina_hw  # noqa: E402


def _w(root, path, text):
    p = os.path.join(root, path.lstrip("/"))
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write(text + "\n")


def ip_gid(ip):
    a, b, c, d = (int(x) for x in ip.split("."))
    return "0000:0000:0000:0000:0000:ffff:%02x%02x:%02x%02x" % (a, b, c, d)


def build_tree(root, h):
    """h: dict with name, ip, mtu, pcie (speed, width), fw, numa, governor, trust, pfc."""
    pci = "0000:3b:00.0"
    _w(root, "/sys/devices/pci0000:3a/%s/numa_node" % pci, str(h["numa"]))
    _w(root, "/sys/devices/pci0000:3a/%s/current_link_speed" % pci, "%.1f GT/s PCIe" % h["pcie"][0])
    _w(root, "/sys/devices/pci0000:3a/%s/current_link_width" % pci, str(h["pcie"][1]))
    _w(root, "/sys/devices/pci0000:3a/%s/max_link_speed" % pci, "16.0 GT/s PCIe")
    _w(root, "/sys/devices/pci0000:3a/%s/max_link_width" % pci, "16")
    os.makedirs(os.path.join(root, "sys/devices/pci0000:3a/%s/net/ens1f0np0" % pci), exist_ok=True)
    ib = os.path.join(root, "sys/class/infiniband/mlx5_0")
    os.makedirs(ib, exist_ok=True)
    os.symlink(os.path.join(root, "sys/devices/pci0000:3a", pci), os.path.join(ib, "device"))
    base = "/sys/class/infiniband/mlx5_0"
    _w(root, base + "/node_type", "1: CA")
    _w(root, base + "/fw_ver", h["fw"])
    _w(root, base + "/board_id", "MT_0000000222")
    _w(root, base + "/hca_type", "MT4123")
    _w(root, base + "/node_guid", "b83f:d203:00aa:bb01")
    pb = base + "/ports/1"
    _w(root, pb + "/state", "4: ACTIVE")
    _w(root, pb + "/phys_state", "5: LinkUp")
    _w(root, pb + "/rate", "100 Gb/sec (2X HDR)")
    _w(root, pb + "/link_layer", "Ethernet")
    _w(root, pb + "/lid", "0x0")
    _w(root, pb + "/sm_lid", "0x0")
    gids = [("fe80:0000:0000:0000:ba3f:d2ff:feaa:bb01", "IB/RoCE v1"), ("fe80:0000:0000:0000:ba3f:d2ff:feaa:bb01", "RoCE v2"),
            (ip_gid(h["ip"]), "IB/RoCE v1"), (ip_gid(h["ip"]), "RoCE v2")]
    for i, (g, t) in enumerate(gids):
        _w(root, "%s/gids/%d" % (pb, i), g)
        _w(root, "%s/gid_attrs/types/%d" % (pb, i), t)
        _w(root, "%s/gid_attrs/ndevs/%d" % (pb, i), "ens1f0np0")
    _w(root, "%s/gids/4" % pb, "0000:0000:0000:0000:0000:0000:0000:0000")
    for c, v in {"symbol_error": h.get("symbol_error", 0), "link_downed": 0, "port_rcv_errors": 0, "port_xmit_data": 123456789}.items():
        _w(root, "%s/counters/%s" % (pb, c), str(v))
    for c, v in {"out_of_sequence": h.get("ooo", 0), "packet_seq_err": 0, "np_cnp_sent": 0, "rp_cnp_handled": 0}.items():
        _w(root, "%s/hw_counters/%s" % (pb, c), str(v))
    nb = "/sys/class/net/ens1f0np0"
    _w(root, nb + "/mtu", str(h["mtu"]))
    _w(root, nb + "/operstate", "up")
    _w(root, nb + "/speed", "100000")
    _w(root, nb + "/address", "b8:3f:d2:aa:bb:01")
    _w(root, "/etc/os-release", 'NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"')
    _w(root, "/proc/cpuinfo", "processor\t: 0\nmodel name\t: Illustrative 32-Core CPU @ 2.80GHz")
    _w(root, "/proc/meminfo", "MemTotal:       263921408 kB")
    _w(root, "/proc/cmdline", "BOOT_IMAGE=/vmlinuz root=/dev/sda2 ro iommu=pt quiet")
    for n in ("node0", "node1"):
        os.makedirs(os.path.join(root, "sys/devices/system/node", n), exist_ok=True)
    _w(root, "/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor", h["governor"])
    for m in ("mlx5_core", "mlx5_ib", "ib_core", "ib_uverbs", "rdma_ucm"):
        os.makedirs(os.path.join(root, "sys/module", m), exist_ok=True)


def fake_commands(h):
    pfc_flags = " ".join("1" if p in h["pfc"] else "0" for p in range(8))
    outputs = {
        ("rdma", "-j", "link", "show"): json.dumps([{"ifindex": 1, "ifname": "mlx5_0", "port": 1, "state": "ACTIVE", "physical_state": "LINK_UP", "netdev": "ens1f0np0", "netdev_index": 4}]),
        ("ibv_devinfo", "-d", "mlx5_0", "-i", "1"): "hca_id:\tmlx5_0\n\t\tport:\t1\n\t\t\tstate:\t\t\tPORT_ACTIVE (4)\n\t\t\tmax_mtu:\t\t4096 (5)\n\t\t\tactive_mtu:\t\t%d (%d)\n" % ((4096, 5) if h["mtu"] >= 4200 else (1024, 3)),
        ("ethtool", "-a", "ens1f0np0"): "Pause parameters for ens1f0np0:\nAutonegotiate:\toff\nRX:\t\ton\nTX:\t\ton\n",
        ("ethtool", "-S", "ens1f0np0"): "NIC statistics:\n     rx_packets: 1000\n     rx_prio3_bytes: 52428800\n     tx_prio3_pause: 0\n     rx_prio3_pause: 0\n     rx_discards_phy: 0\n     rx_crc_errors_phy: %d\n     rx_symbol_err_phy: 0\n     rx_out_of_buffer: 0\n" % h.get("crc", 0),
        ("ethtool", "-i", "ens1f0np0"): "driver: mlx5_core\nversion: 6.8.0-45-generic\nfirmware-version: %s (MT_0000000222)\nbus-info: 0000:3b:00.0\n" % h["fw"],
        ("ip", "-j", "addr", "show", "dev", "ens1f0np0"): json.dumps([{"ifname": "ens1f0np0", "addr_info": [{"family": "inet", "local": h["ip"], "prefixlen": 24}, {"family": "inet6", "local": "fe80::ba3f:d2ff:feaa:bb01", "prefixlen": 64}]}]),
        ("mlnx_qos", "-i", "ens1f0np0"): "DCBX mode: OS controlled\nPriority trust state: %s\ndscp2prio mapping:\n\tprio:0 dscp:07,06,05,04,03,02,01,00,\n\tprio:3 dscp:31,30,29,28,27,26,25,24,\n\tprio:6 dscp:55,54,53,52,51,50,49,48,\nReceive buffer size (bytes): 130944,130944,0,0,0,0,0,0,\nPFC configuration:\n\tpriority    0   1   2   3   4   5   6   7\n\tenabled     %s\n\tbuffer      0   0   0   1   0   0   0   0\n" % (h["trust"], "   ".join(pfc_flags.split())),
        ("lldpcli", "-f", "json", "show", "neighbors"): json.dumps({"lldp": {"interface": {"ens1f0np0": {"via": "LLDP", "chassis": {"leaf1": {"id": {"type": "mac", "value": "aa:bb:cc:00:00:01"}, "descr": "Cumulus Linux"}}, "port": {"id": {"type": "ifname", "value": h["switch_port"]}, "descr": h["switch_port"]}}}}}),
        ("dpkg-query", "-W", "-f=${Version}", "rdma-core"): "50.0-2build2",
        ("dpkg-query", "-W", "-f=${Version}", "perftest"): "24.01.0-0.38.g8a3c4a7-1",
        ("sh", "-c", "ulimit -l"): h.get("memlock", "unlimited") + "\n",
    }

    def run(cmd, timeout=15):
        return outputs.get(tuple(cmd))
    return run


DEMO_HOSTS = [
    {"name": "node-a", "role": "A", "ip": "192.168.50.11", "mtu": 9000, "pcie": (16.0, 16), "fw": "28.42.1000", "numa": 0,
     "governor": "performance", "trust": "dscp", "pfc": [3], "switch_port": "swp1"},
    {"name": "node-b", "role": "B", "ip": "192.168.50.12", "mtu": 1500, "pcie": (8.0, 16), "fw": "28.39.1002", "numa": 1,
     "governor": "powersave", "trust": "pcp", "pfc": [], "switch_port": "swp2", "crc": 17, "ooo": 42, "memlock": "8192"},
]


def fake_host(h, redact=False):
    with tempfile.TemporaryDirectory() as root:
        build_tree(root, h)
        with mock.patch.object(aina_hw, "SYSROOT", root), \
                mock.patch.object(aina_hw, "run", fake_commands(h)), \
                mock.patch.object(aina_hw, "have", lambda t: t not in ("nvidia-smi", "ofed_info", "mst", "mlxlink", "opensm", "sminfo", "mpirun")), \
                mock.patch.object(socket, "gethostname", lambda: h["name"]), \
                mock.patch.object(aina_hw.platform, "release", lambda: "6.8.0-45-generic"):
            facts = aina_hw.collect(h["role"], [], redact)
    facts["collected"] = "2026-10-22T09:00:00+00:00"
    facts["software"]["python"] = "3.12.3"
    return facts


class Parsers(unittest.TestCase):
    def test_state_and_rate(self):
        self.assertEqual(aina_hw.parse_state("4: ACTIVE"), "ACTIVE")
        self.assertEqual(aina_hw.parse_rate_gbps("400 Gb/sec (4X NDR)"), 400.0)
        self.assertEqual(aina_hw.parse_pcie_speed("32.0 GT/s PCIe"), 32.0)
        self.assertIsNone(aina_hw.parse_pcie_speed("Unknown"))

    def test_dcb(self):
        self.assertEqual(aina_hw.parse_dcb_pfc("pfc-cap 8 macsec-bypass off delay 0\nprio-pfc 0:off 1:off 2:off 3:on 4:off 5:off 6:off 7:off"), [3])
        self.assertIsNone(aina_hw.parse_dcb_pfc("garbage"))
        self.assertEqual(aina_hw.parse_dcb_dscp_prio("dscp-prio 26:3 CS6:6 AF41:4"), {"26": 3, "48": 6, "34": 4})

    def test_mlnx_qos(self):
        run = fake_commands(DEMO_HOSTS[0])
        q = aina_hw.parse_mlnx_qos(run(["mlnx_qos", "-i", "ens1f0np0"]))
        self.assertEqual(q["trust"], "dscp")
        self.assertEqual(q["pfc_enabled"], [3])
        self.assertEqual(q["dscp_prio"]["26"], 3)
        self.assertEqual(q["dscp_prio"]["48"], 6)

    def test_ethtool(self):
        s = aina_hw.parse_ethtool_stats("NIC statistics:\n     rx_packets: 10\n     rx_prio3_pause: 5\n     tx_crc: 1\n")
        self.assertEqual(s, {"rx_prio3_pause": 5, "tx_crc": 1})
        self.assertEqual(aina_hw.parse_ethtool_pause("Autonegotiate:\toff\nRX:\t\ton\nTX:\t\toff"), {"autonegotiate": False, "rx": True, "tx": False})

    def test_lldp(self):
        run = fake_commands(DEMO_HOSTS[1])
        self.assertEqual(aina_hw.parse_lldpcli(run(["lldpcli", "-f", "json", "show", "neighbors"])), {"ens1f0np0": {"system": "leaf1", "port": "swp2"}})
        self.assertEqual(aina_hw.parse_lldpcli("not json"), {})

    def test_env_and_checks(self):
        env = aina_hw.parse_env("# c\nA=1\nexport B='x y'\nC=\"z\"   # trailing\nD=~/x\n")
        self.assertEqual(env, {"A": "1", "B": "x y", "C": "z", "D": "~/x"})
        lines = aina_hw.parse_check_output("PASS: one\nINFO: no\nFAIL: two\n  WARN: three\nrandom")
        self.assertEqual([l["status"] for l in lines], ["PASS", "FAIL", "WARN"])

    def test_origins(self):
        allowed = aina_hw.DEFAULT_ORIGINS
        self.assertTrue(aina_hw.origin_allowed("http://localhost:8740", allowed, False))
        self.assertTrue(aina_hw.origin_allowed("https://jurajliskalc.github.io", allowed, False))
        self.assertFalse(aina_hw.origin_allowed("https://evil.example", allowed, False))
        self.assertFalse(aina_hw.origin_allowed("http://localhost.evil.example", allowed, False))
        self.assertFalse(aina_hw.origin_allowed(None, allowed, False))

    def test_host_header(self):
        for h in ("127.0.0.1:8765", "localhost:8765", "[::1]:8765", "localhost"):
            self.assertTrue(aina_hw.host_allowed(h, "127.0.0.1"), h)
        for h in ("rebind.evil.example:8765", "127.0.0.1.evil.example", "", None):
            self.assertFalse(aina_hw.host_allowed(h, "127.0.0.1"), h)
        self.assertTrue(aina_hw.host_allowed("lab-host:8765", "0.0.0.0"))


class Collector(unittest.TestCase):
    def test_collect_fake_host(self):
        f = fake_host(DEMO_HOSTS[1])
        self.assertEqual(f["schema"], aina_hw.HOST_SCHEMA)
        self.assertEqual(f["host"]["hostname"], "node-b")
        self.assertEqual(f["host"]["numa_nodes"], 2)
        self.assertEqual(f["host"]["cmdline_flags"], ["iommu=pt"])
        self.assertEqual(f["host"]["memlock"], "8192")
        d = f["rdma"][0]
        self.assertEqual(d["pci"], "0000:3b:00.0")
        self.assertEqual(d["numa_node"], 1)
        self.assertEqual(d["pcie"], {"speed": 8.0, "width": 16, "max_speed": 16.0, "max_width": 16})
        p = d["ports"][0]
        self.assertEqual((p["state"], p["link_layer"], p["netdev"], p["rate_gbps"], p["active_mtu"]), ("ACTIVE", "Ethernet", "ens1f0np0", 100.0, 1024))
        self.assertEqual([g["index"] for g in p["gids"]], [0, 1, 2, 3])  # the all-zero entry is skipped
        self.assertEqual(p["hw_counters"]["out_of_sequence"], 42)
        nd = f["netdevs"][0]
        self.assertEqual((nd["mtu"], nd["ipv4"], nd["driver"], nd["qos"]["trust"], nd["qos"]["pfc_enabled"]), (1500, ["192.168.50.12/24"], "mlx5_core", "pcp", []))
        self.assertEqual(nd["lldp"], {"system": "leaf1", "port": "swp2"})
        self.assertTrue(f["modules"]["mlx5_ib"])
        self.assertFalse(f["modules"]["nvidia_peermem"])

    def test_redact(self):
        f = fake_host(DEMO_HOSTS[0], redact=True)
        self.assertTrue(f["host"]["hostname"].startswith("host-"))
        self.assertIsNone(f["rdma"][0]["node_guid"])
        self.assertIsNone(f["netdevs"][0]["mac"])
        gids = [g["gid"] for g in f["rdma"][0]["ports"][0]["gids"]]
        self.assertTrue(all("ba3f" not in g for g in gids))
        self.assertTrue(any(g.startswith("0000:0000:0000:0000:0000:ffff:") and "xxxx" not in g for g in gids))

    def test_summary_flags_problems(self):
        report = aina_hw.build_report([fake_host(h) for h in DEMO_HOSTS], {"LAB_NAME": "demo"})
        msgs = " ".join(m for _, _, m in aina_hw.quick_findings(report))
        self.assertIn("MTU differs", msgs)
        self.assertIn("PCIe link 8.0 GT/s", msgs)


if __name__ == "__main__":
    unittest.main()
