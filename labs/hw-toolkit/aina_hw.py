#!/usr/bin/env python3
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Juraj Liska. AI Networking Academy: noncommercial use only, see LICENSE.
"""aina-hw: the AI Networking Academy real-hardware toolkit.

Collects a read-only inventory of RDMA hosts, runs lab check scripts and records their results, and
serves both to the academy web app through a read-only local HTTP agent. Standard library only, so it
runs on any Linux host with Python 3.8 or newer, and it can stream itself to remote hosts over SSH.

    aina-hw collect      [--out FILE] [--role A] [--netdev IF ...] [--redact]
    aina-hw collect-all  [--env lab.env] [--out FILE] [--sudo] [--redact]
    aina-hw summary      [REPORT]
    aina-hw check        [--task N] LAB_ID [ARGS ...]
    aina-hw live         [--env lab.env] [--interval 1] [--once | --stream]
    aina-hw serve        [--port 8765] [--bind 127.0.0.1] [--allow-origin URL ...] [--live-remote]
    aina-hw env          [--env lab.env]

Nothing here changes the system: collection only reads sysfs/procfs and runs "show"-type commands.
"""
import argparse
import datetime as _dt
import hashlib
import json
import os
import platform
import re
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time

VERSION = "1.1.0"
REPORT_SCHEMA = "aina.hw.report/1"
HOST_SCHEMA = "aina.hw.host/1"
CHECK_SCHEMA = "aina.hw.check/1"
AGENT_SCHEMA = "aina.hw.agent/1"
LIVE_SCHEMA = "aina.hw.live/1"
# EFI variable holding the Secure Boot state: 4 bytes of attributes, then one byte (1 = enabled).
SECURE_BOOT_VAR = "/sys/firmware/efi/efivars/SecureBoot-8be4df61-93ca-11d2-aa0d-00e098032b8c"

HERE = os.path.dirname(os.path.abspath(__file__))
LABS_DIR = os.path.dirname(HERE)
# Tests point this at a fake tree; on a real host it is "" (the real /sys and /proc).
SYSROOT = os.environ.get("AINA_SYSROOT", "")

TOOLS = ["rdma", "ibv_devinfo", "ib_write_bw", "ibstat", "iblinkinfo", "ethtool", "dcb", "mlnx_qos",
         "show_gids", "ibdev2netdev", "mlxlink", "mst", "nvidia-smi", "mpirun", "numactl", "lldpcli",
         "tcpdump", "opensm", "sminfo", "ofed_info"]
MODULES = ["mlx5_core", "mlx5_ib", "ib_core", "ib_uverbs", "rdma_ucm", "ib_ipoib", "rdma_rxe", "irdma",
           "bnxt_re", "nvidia", "nvidia_peermem", "nv_peer_mem"]
# ethtool -S keys worth keeping: pause, per-priority, drops, errors, buffer and congestion counters.
STAT_KEEP = re.compile(r"pause|prio\d|discard|drop|crc|symbol|err|cnp|ecn|out_of_buffer|buffer|fec|timeout", re.I)
DSCP_NAMES = {"CS0": 0, "CS1": 8, "CS2": 16, "CS3": 24, "CS4": 32, "CS5": 40, "CS6": 48, "CS7": 56,
              "AF11": 10, "AF12": 12, "AF13": 14, "AF21": 18, "AF22": 20, "AF23": 22, "AF31": 26, "AF32": 28,
              "AF33": 30, "AF41": 34, "AF42": 36, "AF43": 38, "EF": 46, "VA": 44, "LE": 1}


def now():
    return _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat()


def sys_path(p):
    return SYSROOT + p


def read(p, default=None):
    try:
        with open(sys_path(p), encoding="utf-8", errors="replace") as f:
            return f.read().strip()
    except OSError:
        return default


def listdir(p):
    try:
        return sorted(os.listdir(sys_path(p)))
    except OSError:
        return []


def to_int(s, default=None):
    try:
        return int(str(s).strip(), 0)
    except (TypeError, ValueError):
        return default


def have(tool):
    return shutil.which(tool) is not None


def run(cmd, timeout=15):
    """Run a command (list), return stdout or None. Never raises."""
    if not have(cmd[0]):
        return None
    try:
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=timeout,
                           universal_newlines=True, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    return p.stdout if p.returncode == 0 else None


# ---------------------------------------------------------------- parsers (pure, unit-tested)

def parse_state(s):
    """'4: ACTIVE' -> 'ACTIVE'; 'ACTIVE' -> 'ACTIVE'."""
    if not s:
        return None
    return s.split(":", 1)[-1].strip()


def parse_rate_gbps(s):
    """'100 Gb/sec (4X EDR)' -> 100.0"""
    m = re.match(r"\s*([\d.]+)\s*Gb/sec", s or "")
    return float(m.group(1)) if m else None


def parse_pcie_speed(s):
    """'16.0 GT/s PCIe' -> 16.0 ('Unknown' -> None)."""
    m = re.match(r"\s*([\d.]+)\s*GT/s", s or "")
    return float(m.group(1)) if m else None


def parse_ethtool_i(text):
    out = {}
    for line in (text or "").splitlines():
        k, _, v = line.partition(":")
        k, v = k.strip(), v.strip()
        if k == "driver":
            out["driver"] = v
        elif k == "version":
            out["driver_version"] = v
        elif k == "firmware-version":
            out["firmware"] = v
        elif k == "bus-info":
            out["bus"] = v
    return out


def parse_ethtool_pause(text):
    res = {}
    for line in (text or "").splitlines():
        m = re.match(r"\s*(Autonegotiate|RX|TX):\s+(on|off)", line)
        if m:
            res[m.group(1).lower()] = m.group(2) == "on"
    return res or None


def parse_ethtool_stats(text, keep=STAT_KEEP, limit=400):
    stats = {}
    for line in (text or "").splitlines():
        m = re.match(r"\s+([^:]+):\s+(-?\d+)\s*$", line)
        if m and keep.search(m.group(1)):
            stats[m.group(1).strip()] = int(m.group(2))
            if len(stats) >= limit:
                break
    return stats


def parse_dcb_pfc(text):
    """'prio-pfc 0:off 1:off 2:off 3:on ...' -> [3]"""
    m = re.search(r"prio-pfc((?:\s+\d:(?:on|off))+)", text or "")
    if not m:
        return None
    return [int(p) for p, st in re.findall(r"(\d):(on|off)", m.group(1)) if st == "on"]


def parse_dcb_dscp_prio(text):
    """'dscp-prio 26:3 CS6:6' -> {'26': 3, '48': 6}"""
    m = re.search(r"dscp-prio((?:\s+[\w]+:\d)+)", text or "")
    if not m:
        return None
    out = {}
    for name, prio in re.findall(r"([\w]+):(\d)", m.group(1)):
        dscp = int(name) if name.isdigit() else DSCP_NAMES.get(name.upper())
        if dscp is not None:
            out[str(dscp)] = int(prio)
    return out


def parse_mlnx_qos(text):
    """Best-effort parse of mlnx_qos -i <if>: trust state, PFC-enabled priorities, DSCP->priority."""
    if not text:
        return None
    res = {"trust": None, "pfc_enabled": None, "dscp_prio": None}
    m = re.search(r"trust state:\s*(\w+)", text, re.I)
    if m:
        res["trust"] = m.group(1).lower()
    pfc = re.search(r"PFC configuration:.*?\n\s*priority((?:\s+\d)+)\s*\n\s*enabled((?:\s+\d)+)", text, re.S | re.I)
    if pfc:
        prios = [int(x) for x in pfc.group(1).split()]
        flags = [int(x) for x in pfc.group(2).split()]
        res["pfc_enabled"] = [p for p, f in zip(prios, flags) if f]
    dp = {}
    for prio, dscps in re.findall(r"prio:(\d)\s+dscp:([\d,\s]+)", text):
        for d in re.findall(r"\d+", dscps):
            dp[str(int(d))] = int(prio)
    if dp:
        res["dscp_prio"] = dp
    return res


def parse_ibv_active_mtu(text):
    m = re.search(r"active_mtu:\s+(\d+)", text or "")
    return int(m.group(1)) if m else None


def parse_lldpcli(text):
    """lldpcli -f json show neighbors -> {ifname: {'system': ..., 'port': ...}}. The JSON shape varies
    with the number of neighbours (object vs list), so walk it defensively."""
    try:
        data = json.loads(text or "")
    except ValueError:
        return {}
    ifaces = (data.get("lldp") or {}).get("interface") or {}
    items = []
    if isinstance(ifaces, dict):
        items = list(ifaces.items())
    elif isinstance(ifaces, list):
        for entry in ifaces:
            if isinstance(entry, dict):
                items.extend(entry.items())
    out = {}
    for name, info in items:
        if not isinstance(info, dict):
            continue
        chassis = info.get("chassis") or {}
        # The chassis object is keyed by the neighbour's system name: {"leaf1": {"id": ..., "descr": ...}}.
        system = None
        if isinstance(chassis, dict):
            names = [k for k, v in chassis.items() if isinstance(v, dict) and k not in ("id", "name", "descr", "capability")]
            system = names[0] if names else None
        port = info.get("port") or {}
        pid = port.get("id") if isinstance(port, dict) else None
        port_name = pid.get("value") if isinstance(pid, dict) else None
        if isinstance(port, dict) and isinstance(port.get("descr"), str) and not port_name:
            port_name = port["descr"]
        out[name] = {"system": system, "port": port_name}
    return out


def parse_env(text):
    """Parse a lab.env file (KEY=value, KEY='value', KEY="value", comments)."""
    env = {}
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        m = re.match(r"([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line)
        if not m:
            continue
        try:
            parts = shlex.split(m.group(2), comments=True)
        except ValueError:
            parts = [m.group(2)]
        env[m.group(1)] = parts[0] if parts else ""
    return env


def parse_check_output(text):
    """Lines 'PASS: ...', 'FAIL: ...', 'WARN: ...', 'SKIP: ...' -> list of results.

    'TASK: <n> <title>' lines (lib.sh `task`) start the checks for the lab's Task n; every result after one
    carries "task": n. Results before the first marker belong to no task (key absent), so output of
    scripts without markers parses exactly as before."""
    out = []
    cur = None
    for line in (text or "").splitlines():
        t = re.match(r"\s*TASK:\s*(\d+)\b", line)
        if t:
            cur = int(t.group(1))
            continue
        m = re.match(r"\s*(PASS|FAIL|WARN|SKIP):\s?(.*)$", line)
        if m:
            r = {"status": m.group(1), "text": m.group(2).strip()}
            if cur is not None:
                r["task"] = cur
            out.append(r)
    return out


def parse_task_markers(text):
    """'TASK: 3 PFC on priority 3' lines -> [(3, 'PFC on priority 3')], first title per number wins."""
    seen = {}
    for line in (text or "").splitlines():
        t = re.match(r"\s*TASK:\s*(\d+)\s*(.*)$", line)
        if t and int(t.group(1)) not in seen:
            seen[int(t.group(1))] = t.group(2).strip()
    return sorted(seen.items())


def task_status(counts):
    """FAIL if anything failed; PASS if something passed (warnings allowed); WARN or SKIP if that is all
    there is; NONE for a task that printed no result lines."""
    if counts["FAIL"]:
        return "FAIL"
    if counts["PASS"]:
        return "PASS"
    if counts["WARN"]:
        return "WARN"
    if counts["SKIP"]:
        return "SKIP"
    return "NONE"


def parse_declared_tasks(text):
    """'TASKS: 1 2 3 5 8' (lib.sh aina_tasks) -> [1, 2, 3, 5, 8]: the lab tasks the script covers."""
    for line in (text or "").splitlines():
        t = re.match(r"\s*TASKS:\s*([\d\s]+)$", line)
        if t:
            return sorted({int(x) for x in t.group(1).split()})
    return []


def summarize_tasks(results, markers, declared=()):
    """Per-task summary. Task 0 ("Before you start") collects the prerequisite checks that run before the
    first marker, but only when the script uses markers at all. Declared tasks that never started (the run
    stopped at the prerequisites) are NOTRUN."""
    if not markers and not declared:
        return []
    titles = dict(markers)
    numbers = sorted(set(titles) | {r["task"] for r in results if "task" in r} | set(declared))
    pre = [r for r in results if "task" not in r]
    tasks = []
    if pre and 0 not in titles:
        numbers = [0] + numbers
        titles[0] = "Before you start"
    for n in numbers:
        mine = [r for r in results if r.get("task") == n] if n else [r for r in results if r.get("task", 0) == 0]
        counts = {s: sum(1 for r in mine if r["status"] == s) for s in ("PASS", "FAIL", "WARN", "SKIP")}
        started = n == 0 or n in titles or bool(mine)
        tasks.append({"n": n, "title": titles.get(n, ""), "status": task_status(counts) if started else "NOTRUN", "counts": counts})
    return tasks


# ---------------------------------------------------------------- collection

def collect_rdma(notes):
    devices = []
    link_json = None
    out = run(["rdma", "-j", "link", "show"])
    if out:
        try:
            link_json = json.loads(out)
        except ValueError:
            link_json = None
    for dev in listdir("/sys/class/infiniband"):
        base = "/sys/class/infiniband/" + dev
        pci_dev = None
        try:
            pci_dev = os.path.basename(os.path.realpath(sys_path(base + "/device")))
        except OSError:
            pass
        d = {
            "name": dev,
            "node_type": parse_state(read(base + "/node_type")),
            "fw_ver": read(base + "/fw_ver"),
            "board_id": read(base + "/board_id"),
            "hca_type": read(base + "/hca_type"),
            "node_guid": read(base + "/node_guid"),
            "pci": pci_dev if pci_dev and re.match(r"[0-9a-f]{4}:", pci_dev) else None,
            "numa_node": to_int(read(base + "/device/numa_node")),
            "pcie": {
                "speed": parse_pcie_speed(read(base + "/device/current_link_speed")),
                "width": to_int(read(base + "/device/current_link_width")),
                "max_speed": parse_pcie_speed(read(base + "/device/max_link_speed")),
                "max_width": to_int(read(base + "/device/max_link_width")),
            },
            "ports": [],
        }
        pci_netdevs = listdir(base + "/device/net")
        for p in listdir(base + "/ports"):
            pbase = base + "/ports/" + p
            pnum = to_int(p)
            port = {
                "port": pnum,
                "state": parse_state(read(pbase + "/state")),
                "phys_state": parse_state(read(pbase + "/phys_state")),
                "rate": read(pbase + "/rate"),
                "rate_gbps": parse_rate_gbps(read(pbase + "/rate")),
                "link_layer": read(pbase + "/link_layer"),
                "lid": to_int(read(pbase + "/lid")),
                "sm_lid": to_int(read(pbase + "/sm_lid")),
                "netdev": None,
                "active_mtu": parse_ibv_active_mtu(run(["ibv_devinfo", "-d", dev, "-i", str(pnum)])),
                "gids": [],
                "counters": {},
                "hw_counters": {},
            }
            for idx in listdir(pbase + "/gids"):
                gid = read(pbase + "/gids/" + idx)
                if not gid or set(gid.replace(":", "")) == {"0"}:
                    continue
                port["gids"].append({
                    "index": to_int(idx),
                    "gid": gid,
                    "type": read(pbase + "/gid_attrs/types/" + idx),
                    "netdev": read(pbase + "/gid_attrs/ndevs/" + idx),
                })
            port["gids"].sort(key=lambda g: g["index"])
            for sub in ("counters", "hw_counters"):
                for c in listdir(pbase + "/" + sub):
                    v = to_int(read(pbase + "/" + sub + "/" + c))
                    if v is not None:
                        port[sub][c] = v
            port["rdma_cm"] = collect_rdma_cm(dev, pnum)
            # netdev: rdma's JSON first, then the GID table, then the PCI function's net directory.
            for e in link_json or []:
                if e.get("ifname") == dev and e.get("port") == pnum and e.get("netdev"):
                    port["netdev"] = e["netdev"]
            if not port["netdev"]:
                nd = [g["netdev"] for g in port["gids"] if g.get("netdev")]
                port["netdev"] = nd[0] if nd else (pci_netdevs[0] if len(pci_netdevs) == 1 else None)
            d["ports"].append(port)
        devices.append(d)
    if not devices:
        notes.append("No RDMA devices in /sys/class/infiniband (driver not loaded, or no RDMA NIC).")
    return devices


def collect_rdma_cm(dev, port):
    """rdma_cm's per-port defaults from configfs (what cma_roce_tos / cma_roce_mode write). None when the
    rdma_cm configfs is not there (module not loaded or configfs not mounted). The per-device entry only
    exists after someone ran `mkdir /sys/kernel/config/rdma_cm/<dev>`; without it the kernel defaults apply
    (ToS 0, RoCE v2). Read-only: this never creates the entry."""
    root = "/sys/kernel/config/rdma_cm"
    if not os.path.isdir(sys_path(root)):
        return None
    base = "%s/%s/ports/%d" % (root, dev, port)
    if not os.path.isdir(sys_path(base)):
        return {"configured": False, "default_roce_tos": None, "default_roce_mode": None}
    return {"configured": True, "default_roce_tos": to_int(read(base + "/default_roce_tos")),
            "default_roce_mode": read(base + "/default_roce_mode")}


def parse_lockdown(text):
    """'[none] integrity confidentiality' -> 'none' (the bracketed mode is the active one)."""
    m = re.search(r"\[(\w+)\]", text or "")
    return m.group(1) if m else None


def parse_secure_boot(raw):
    """EFI variable bytes (4 attribute bytes + value) -> True/False, None if unreadable."""
    if raw is None or len(raw) < 5:
        return None
    return raw[4] == 1


def collect_secure_boot():
    try:
        with open(sys_path(SECURE_BOOT_VAR), "rb") as f:
            return parse_secure_boot(f.read())
    except OSError:
        return None


def collect_umad():
    """umad devices in kernel order: umad tools without -C/-P open the first one."""
    out = []
    for name in listdir("/sys/class/infiniband_mad"):
        if not re.match(r"umad\d+$", name):
            continue
        base = "/sys/class/infiniband_mad/" + name
        out.append({"name": name, "ibdev": read(base + "/ibdev"), "port": to_int(read(base + "/port"))})
    out.sort(key=lambda u: int(u["name"][4:]))
    return out


def collect_netdev(name, notes):
    base = "/sys/class/net/" + name
    if not os.path.isdir(sys_path(base)):
        notes.append("netdev %s does not exist" % name)
        return None
    speed = to_int(read(base + "/speed"))
    # ARPHRD_INFINIBAND (32): an IPoIB interface. Ethernet QoS (pause, PFC, DSCP trust) does not apply to it.
    ipoib = to_int(read(base + "/type")) == 32
    nd = {
        "name": name,
        "ipoib": ipoib,
        "mtu": to_int(read(base + "/mtu")),
        "operstate": read(base + "/operstate"),
        "speed_mbps": speed if speed and speed > 0 else None,
        "mac": read(base + "/address"),
        "ipv4": [],
        "pause": None if ipoib else parse_ethtool_pause(run(["ethtool", "-a", name])),
        "qos": None,
        "ecn": None,
        "stats": parse_ethtool_stats(run(["ethtool", "-S", name])),
        "lldp": None,
    }
    nd.update(parse_ethtool_i(run(["ethtool", "-i", name])))
    addr = run(["ip", "-j", "addr", "show", "dev", name])
    if addr:
        try:
            for entry in json.loads(addr):
                for a in entry.get("addr_info", []):
                    if a.get("family") == "inet":
                        nd["ipv4"].append("%s/%s" % (a.get("local"), a.get("prefixlen")))
        except ValueError:
            pass
    if ipoib:
        return nd
    # QoS: mlnx_qos is authoritative on NVIDIA NICs; iproute2's dcb is the generic fallback.
    q = parse_mlnx_qos(run(["mlnx_qos", "-i", name]))
    if q and (q["trust"] or q["pfc_enabled"] is not None):
        q["source"] = "mlnx_qos"
        nd["qos"] = q
    elif have("dcb"):
        pfc = parse_dcb_pfc(run(["dcb", "pfc", "show", "dev", name, "prio-pfc"]))
        dp = parse_dcb_dscp_prio(run(["dcb", "app", "show", "dev", name, "dscp-prio"]))
        if pfc is not None or dp:
            nd["qos"] = {"source": "dcb", "trust": None, "pfc_enabled": pfc, "dscp_prio": dp or None}
    if nd["qos"] is None:
        notes.append("%s: could not read QoS (install mlnx_qos or iproute2 dcb; some reads need root)" % name)
    # Per-priority RoCE ECN switches (exposed by some NVIDIA driver stacks, not by every kernel).
    ecn = {}
    for side in ("roce_np", "roce_rp"):
        prios = [p for p in range(8) if read("%s/ecn/%s/enable/%d" % (base, side, p)) == "1"]
        if os.path.isdir(sys_path("%s/ecn/%s/enable" % (base, side))):
            ecn[side] = prios
    nd["ecn"] = ecn or None
    return nd


def collect_software():
    def pkg(name):
        out = run(["dpkg-query", "-W", "-f=${Version}", name]) or run(["rpm", "-q", "--qf", "%{VERSION}", name])
        return out.strip() if out else None
    ofed = run(["ofed_info", "-s"])
    nv = read("/proc/driver/nvidia/version")
    # "... Kernel Module  550.54.15 ..." or, for the open modules, "... Open Kernel Module for x86_64  560.35.03 ..."
    m = re.search(r"Kernel Module(?:\s+for\s+\S+)?\s+([\d.]+)", nv or "")
    return {
        "rdma_core": pkg("rdma-core"),
        "perftest": pkg("perftest"),
        "ofed": ofed.strip().rstrip(":") if ofed else None,
        "nvidia_driver": m.group(1) if m else None,
        "python": platform.python_version(),
        "tools": {t: have(t) for t in TOOLS},
    }


def collect_gpus():
    gpus = []
    out = run(["nvidia-smi", "--query-gpu=index,name,pci.bus_id,driver_version", "--format=csv,noheader"])
    for line in (out or "").splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) >= 4:
            gpus.append({"index": to_int(parts[0]), "name": parts[1], "pci": parts[2], "driver": parts[3]})
    topo = run(["nvidia-smi", "topo", "-m"])
    if topo:
        topo = re.sub(r"\x1b\[[0-9;]*m", "", topo).rstrip()
    return gpus, topo


def collect_host_info():
    os_name = None
    for line in (read("/etc/os-release") or "").splitlines():
        if line.startswith("PRETTY_NAME="):
            os_name = line.split("=", 1)[1].strip('"')
    cpu = None
    for line in (read("/proc/cpuinfo") or "").splitlines():
        if line.startswith("model name"):
            cpu = line.split(":", 1)[1].strip()
            break
    mem = re.search(r"MemTotal:\s+(\d+)", read("/proc/meminfo") or "")
    cmdline = read("/proc/cmdline") or ""
    return {
        "hostname": socket.gethostname(),
        "kernel": platform.release(),
        "os": os_name,
        "arch": platform.machine(),
        "cpu": cpu,
        "numa_nodes": len([n for n in listdir("/sys/devices/system/node") if re.match(r"node\d+$", n)]) or None,
        "mem_gb": round(int(mem.group(1)) / 1048576, 1) if mem else None,
        "cmdline_flags": [t for t in cmdline.split() if re.match(r"(intel_iommu|amd_iommu|iommu|pci|pcie_\w+)=", t)],
        "governor": read("/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor"),
        "memlock": run(["sh", "-c", "ulimit -l"]),
        "secure_boot": collect_secure_boot(),
        "lockdown": parse_lockdown(read("/sys/kernel/security/lockdown")),
    }


def collect(role=None, extra_netdevs=(), redact=False):
    notes = []
    host = collect_host_info()
    if host["memlock"]:
        host["memlock"] = host["memlock"].strip()
    rdma = collect_rdma(notes)
    names = []
    for d in rdma:
        for p in d["ports"]:
            if p["netdev"] and p["netdev"] not in names:
                names.append(p["netdev"])
    for n in extra_netdevs:
        if n and n not in names:
            names.append(n)
    netdevs = [nd for nd in (collect_netdev(n, notes) for n in names) if nd]
    lldp = parse_lldpcli(run(["lldpcli", "-f", "json", "show", "neighbors"]))
    for nd in netdevs:
        nd["lldp"] = lldp.get(nd["name"])
    gpus, topo = collect_gpus()
    for t in ("rdma", "ibv_devinfo", "ethtool"):
        if not have(t):
            notes.append("%s not installed (run labs/hw-toolkit/setup-rdma-host.sh)" % t)
    facts = {
        "schema": HOST_SCHEMA,
        "toolkit": VERSION,
        "collected": now(),
        "role": role,
        "host": host,
        "software": collect_software(),
        "modules": {m: os.path.isdir(sys_path("/sys/module/" + m)) for m in MODULES},
        "rdma": rdma,
        "umad": collect_umad(),
        "netdevs": netdevs,
        "gpus": gpus,
        "gpu_topo": topo,
        "notes": notes,
    }
    return redact_facts(facts) if redact else facts


def _h(s):
    return hashlib.sha256(s.encode()).hexdigest()[:8]


def redact_facts(f):
    """Hide identifiers that are not needed for the review: hostnames, GUIDs, MACs and MAC-derived GIDs."""
    f = json.loads(json.dumps(f))
    hn = f["host"].get("hostname") or ""
    f["host"]["hostname"] = "host-" + _h(hn) if hn else None
    f["redacted"] = True
    for d in f["rdma"]:
        d["node_guid"] = None
        for p in d["ports"]:
            for g in p["gids"]:
                # IPv4-mapped GIDs only carry the data IP; every other GID ends in a MAC- or GUID-derived interface ID
                if not g["gid"].lower().startswith("0000:0000:0000:0000:0000:ffff:"):
                    g["gid"] = g["gid"][:20] + "xxxx:xxxx:xxxx:xxxx"
    for nd in f["netdevs"]:
        nd["mac"] = None
    if f.get("gpu_topo"):
        f["gpu_topo"] = f["gpu_topo"].replace(hn, f["host"]["hostname"]) if hn else f["gpu_topo"]
    return f


# ---------------------------------------------------------------- lab.env and remote collection

def env_path(arg=None):
    return arg or os.environ.get("AINA_ENV") or os.path.join(HERE, "lab.env")


def load_env(path):
    try:
        with open(path, encoding="utf-8") as f:
            return parse_env(f.read())
    except OSError:
        return None


def _give_back(path):
    """Under sudo, hand files back to the invoking user so later runs without sudo can rewrite them."""
    uid, gid = os.environ.get("SUDO_UID"), os.environ.get("SUDO_GID")
    if hasattr(os, "geteuid") and os.geteuid() == 0 and uid and gid:
        try:
            os.chown(path, int(uid), int(gid))
        except (OSError, ValueError):
            pass


def results_dir():
    d = os.environ.get("AINA_RESULTS") or os.path.join(HERE, "results")
    os.makedirs(d, exist_ok=True)
    _give_back(d)
    return d


def write_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    _give_back(path)


def roles_of(env):
    return ["A", "B", "C"][: 3 if env.get("HOST_COUNT") == "3" else 2]


def is_local(host):
    if host in ("localhost", "127.0.0.1", "::1", "local"):
        return True
    names = {socket.gethostname(), socket.getfqdn(), socket.gethostname().split(".")[0]}
    if host in names:
        return True
    # HOST_A is often a data-network name or an IP of this host: it is local if it resolves to an address that
    # a socket here can bind to (binding only works for the host's own addresses).
    try:
        infos = socket.getaddrinfo(host, None, type=socket.SOCK_DGRAM)
    except (OSError, UnicodeError):
        return False
    for family, _, _, _, sockaddr in infos:
        try:
            with socket.socket(family, socket.SOCK_DGRAM) as s:
                s.bind((sockaddr[0], 0))
            return True
        except OSError:
            continue
    return False


def collect_remote(host, user, role, netdev, sudo, redact):
    with open(os.path.abspath(__file__), encoding="utf-8") as f:
        script = f.read()
    target = "%s@%s" % (user, host) if user else host
    remote = ["sudo", "-n"] if sudo else []
    remote += ["python3", "-", "collect", "--stdout", "--role", role]
    if netdev:
        remote += ["--netdev", netdev]
    if redact:
        remote.append("--redact")
    cmd = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", target, " ".join(shlex.quote(c) for c in remote)]
    try:
        p = subprocess.run(cmd, input=script, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180,
                           universal_newlines=True, check=False)
    except (OSError, subprocess.SubprocessError) as e:
        return None, str(e)
    if p.returncode != 0:
        return None, (p.stderr or "ssh exited %d" % p.returncode).strip()[-400:]
    try:
        return json.loads(p.stdout), None
    except ValueError:
        return None, "remote collector did not return JSON"


def build_report(hosts, env):
    return {"schema": REPORT_SCHEMA, "toolkit": VERSION, "generated": now(),
            "lab": (env or {}).get("LAB_NAME"), "fabric": (env or {}).get("FABRIC"), "hosts": hosts}


# ---------------------------------------------------------------- terminal summary

def quick_findings(report):
    """A short terminal review. The academy's Connect page runs the full, explained review."""
    out = []
    mtus = {}
    for h in report.get("hosts", []):
        name = "%s (%s)" % (h["host"].get("hostname"), h.get("role") or "?")
        if not h.get("rdma"):
            out.append(("ERROR", name, "no RDMA devices"))
        for d in h.get("rdma", []):
            pc = d.get("pcie") or {}
            if pc.get("speed") and pc.get("max_speed") and (pc["speed"] < pc["max_speed"] or (pc.get("width") or 0) < (pc.get("max_width") or 0)):
                out.append(("WARN", name, "%s PCIe link %s GT/s x%s below max %s GT/s x%s" % (d["name"], pc["speed"], pc.get("width"), pc["max_speed"], pc.get("max_width"))))
            for p in d.get("ports", []):
                if p.get("state") != "ACTIVE":
                    out.append(("ERROR", name, "%s/%s state %s" % (d["name"], p["port"], p.get("state"))))
        for nd in h.get("netdevs", []):
            # IPoIB runs 2044/4092 by design; compare the Ethernet data netdevs only
            if nd.get("mtu") and not nd.get("ipoib"):
                mtus.setdefault(nd["mtu"], []).append("%s:%s" % (name, nd["name"]))
    if len(mtus) > 1:
        out.append(("ERROR", "fabric", "MTU differs between hosts: " + "; ".join("%s=%s" % (k, ", ".join(v)) for k, v in sorted(mtus.items()))))
    return out


def print_summary(report):
    for h in report.get("hosts", []):
        hi = h["host"]
        print("== %s  role %s  %s  kernel %s" % (hi.get("hostname"), h.get("role") or "-", hi.get("os") or "", hi.get("kernel")))
        sw = h.get("software", {})
        print("   rdma-core %s  perftest %s  ofed %s  nvidia %s" % (sw.get("rdma_core") or "-", sw.get("perftest") or "-", sw.get("ofed") or "-", sw.get("nvidia_driver") or "-"))
        for d in h.get("rdma", []):
            pc = d.get("pcie") or {}
            print("   %-10s fw %-12s pci %s  PCIe %s GT/s x%s (max %s x%s)  numa %s" % (
                d["name"], d.get("fw_ver") or "-", d.get("pci") or "-", pc.get("speed"), pc.get("width"), pc.get("max_speed"), pc.get("max_width"), d.get("numa_node")))
            for p in d.get("ports", []):
                print("     port %s  %-7s %-8s %-22s mtu %-5s netdev %s" % (p["port"], p.get("state"), p.get("link_layer"), p.get("rate") or "-", p.get("active_mtu") or "-", p.get("netdev") or "-"))
        for nd in h.get("netdevs", []):
            q = nd.get("qos") or {}
            print("   %-14s mtu %-5s %-5s ipv4 %s  trust %s  pfc %s" % (nd["name"], nd.get("mtu"), nd.get("operstate"), ",".join(nd.get("ipv4") or []) or "-", q.get("trust") or "-", q.get("pfc_enabled")))
        for n in h.get("notes", []):
            print("   note: " + n)
    f = quick_findings(report)
    print()
    for sev, where, msg in f:
        print("%-5s %s: %s" % (sev, where, msg))
    if not f:
        print("No obvious problems. Import the report on the academy's Connect page for the full review.")


# ---------------------------------------------------------------- commands

def cmd_collect(a):
    facts = collect(a.role, a.netdev or [], a.redact)
    text = json.dumps(facts, indent=None if a.stdout else 2)
    if a.stdout:
        sys.stdout.write(text)
        return 0
    report = build_report([facts], load_env(env_path(a.env)))
    out = a.out or os.path.join(results_dir(), "aina-report.json")
    write_json(out, report)
    print_summary(report)
    print("\nWrote " + out)
    return 0


def cmd_collect_all(a):
    path = env_path(a.env)
    env = load_env(path)
    if env is None:
        print("No lab.env at %s. Generate one on the academy's Connect page, or copy lab.env.example." % path, file=sys.stderr)
        return 2
    hosts, failed = [], 0
    for role in roles_of(env):
        host = env.get("HOST_" + role)
        netdev = env.get(role + "_NETDEV")
        if not host:
            continue
        print("collecting %s (%s) ..." % (role, host), file=sys.stderr)
        if is_local(host):
            facts = collect(role, [netdev] if netdev else [], a.redact)
        else:
            facts, error = collect_remote(host, env.get("SSH_USER"), role, netdev, a.sudo, a.redact)
            if facts is None:
                failed += 1
                print("  FAILED: %s" % error, file=sys.stderr)
                continue
        hosts.append(facts)
    report = build_report(hosts, env)
    out = a.out or os.path.join(results_dir(), "aina-report.json")
    write_json(out, report)
    print_summary(report)
    print("\nWrote %s (%d host(s)%s)" % (out, len(hosts), ", %d failed" % failed if failed else ""))
    return 1 if failed else 0


def cmd_summary(a):
    path = a.report or os.path.join(results_dir(), "aina-report.json")
    try:
        with open(path, encoding="utf-8") as f:
            report = json.load(f)
    except (OSError, ValueError) as e:
        print("Cannot read %s: %s" % (path, e), file=sys.stderr)
        return 2
    print_summary(report)
    return 0


def cmd_check(a):
    script = os.path.join(LABS_DIR, a.lab, "check.sh")
    if not re.match(r"^[a-z0-9-]+$", a.lab) or not os.path.isfile(script):
        print("No check script for lab %r (expected %s)" % (a.lab, script), file=sys.stderr)
        return 2
    args = list(a.args)
    only = a.task
    # `aina-hw check LAB --task N` as well as `aina-hw check --task N LAB`
    if "--task" in args:
        i = args.index("--task")
        if i + 1 >= len(args) or not args[i + 1].isdigit():
            print("--task needs a task number", file=sys.stderr)
            return 2
        only = int(args[i + 1])
        del args[i:i + 2]
    env = dict(os.environ)
    env.setdefault("AINA_ENV", env_path(None))
    env.pop("AINA_TASK", None)
    if only is not None:
        env["AINA_TASK"] = str(only)
    started = now()
    t0 = _dt.datetime.now()
    lines = []
    p = subprocess.Popen(["bash", script] + args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         universal_newlines=True, env=env, cwd=os.path.dirname(script))
    with p.stdout:
        for line in p.stdout:
            sys.stdout.write(line)
            sys.stdout.flush()
            lines.append(line)
    code = p.wait()
    record = build_check_record(a.lab, "".join(lines), code, started, round((_dt.datetime.now() - t0).total_seconds(), 1),
                                load_env(env["AINA_ENV"]) or {}, only)
    counts = record["counts"]
    stamp = started.replace(":", "").replace("+0000", "Z")[:17]
    suffix = "-task%d" % only if only is not None else ""
    out = os.path.join(results_dir(), "check-%s%s-%s.json" % (a.lab, suffix, stamp))
    write_json(out, record)
    if record["tasks"]:
        print()
        for t in record["tasks"]:
            print("  Task %-2s %-4s %s" % (t["n"], t["status"], t["title"]))
        if only is None and not record["passed"]:
            bad = [t for t in record["tasks"] if t["status"] == "FAIL"]
            if bad and bad[0]["n"] == 0:
                print("Fix the prerequisites (Before you start) first; the tasks did not run.")
            elif bad:
                print("Resume at Task %d; rerun just that part with: aina-hw check %s --task %d" % (bad[0]["n"], a.lab, bad[0]["n"]))
    if only is not None:
        verdict = "TASK %d %s" % (only, "PASSED" if counts["FAIL"] == 0 and counts["PASS"] > 0 and code == 0 else "NOT PASSED")
        print("\nResult: %s (a single-task run never marks the whole lab verified)  saved to %s" % (verdict, out))
        return 0 if counts["FAIL"] == 0 and counts["PASS"] > 0 and code == 0 else 1
    print("\nResult: %s  (%d pass, %d fail, %d warn, %d skip)  saved to %s" % (
        "PASSED" if record["passed"] else "NOT PASSED", counts["PASS"], counts["FAIL"], counts["WARN"], counts["SKIP"], out))
    return 0 if record["passed"] else 1


def build_check_record(lab, output, code, started, duration, labenv, only=None, host=None, finished=None):
    """The aina.hw.check/1 record for one run. `tasks` and `only_task` are additions: readers that do not know
    them still see the same results/counts/passed fields as before. A single-task run (only_task) is never
    `passed`, because it did not check the whole lab."""
    results = parse_check_output(output)
    counts = {s: sum(1 for r in results if r["status"] == s) for s in ("PASS", "FAIL", "WARN", "SKIP")}
    return {
        "schema": CHECK_SCHEMA, "toolkit": VERSION, "lab": lab, "host": host or socket.gethostname(),
        "lab_name": labenv.get("LAB_NAME"), "fabric": labenv.get("FABRIC"),
        "started": started, "finished": finished or now(), "duration_s": duration,
        "exit_code": code, "passed": only is None and code == 0 and counts["FAIL"] == 0 and counts["PASS"] > 0,
        "only_task": only, "counts": counts, "results": results,
        # A single-task run says nothing about the tasks it skipped: leave them out instead of NOTRUN.
        "tasks": summarize_tasks(results, parse_task_markers(output), parse_declared_tasks(output) if only is None else ()),
    }


def latest_checks(directory):
    latest = {}
    for name in sorted(os.listdir(directory)):
        if not (name.startswith("check-") and name.endswith(".json")):
            continue
        try:
            with open(os.path.join(directory, name), encoding="utf-8") as f:
                rec = json.load(f)
        except (OSError, ValueError):
            continue
        if not isinstance(rec, dict) or rec.get("schema") != CHECK_SCHEMA or not rec.get("lab") or not isinstance(rec.get("finished"), str):
            continue
        # Newest full run per lab, plus the newest single-task run per (lab, task) that is newer than it,
        # so the browser can show per-task progress after `aina-hw check LAB --task N`.
        only = rec.get("only_task")
        key = (rec["lab"], only if isinstance(only, int) else None)
        if key not in latest or rec["finished"] >= latest[key]["finished"]:
            latest[key] = rec
    out = []
    for (lab, only), rec in sorted(latest.items(), key=lambda kv: (kv[0][0], -1 if kv[0][1] is None else kv[0][1])):
        full = latest.get((lab, None))
        if only is not None and full and rec["finished"] < full["finished"]:
            continue
        out.append(rec)
    return out


# ---------------------------------------------------------------- live counters

# RDMA hw_counters sampled live (RoCE; the CNP/ECN ones do not exist on InfiniBand ports).
LIVE_HW = ["np_cnp_sent", "rp_cnp_handled", "np_ecn_marked_roce_packets", "out_of_sequence", "packet_seq_err",
           "local_ack_timeout_err"]
# IB port counters (sysfs counters/): port_xmit_data and port_rcv_data count 4-octet words.
LIVE_IB = ["port_xmit_data", "port_rcv_data"]
NAME_OK = re.compile(r"^[\w.:@-]+$")


def live_eth_keys(prio):
    p = int(prio)
    return ["rx_vport_rdma_unicast_bytes", "tx_vport_rdma_unicast_bytes", "rx_prio%d_bytes" % p, "tx_prio%d_bytes" % p,
            "rx_prio%d_pause" % p, "tx_prio%d_pause" % p, "rx_global_pause", "tx_global_pause", "rx_discards_phy"]


def parse_ethtool_select(text, keys):
    """ethtool -S output -> {key: value} for the wanted keys that exist (mlx5 shows prioN_pause only for
    priorities with PFC on, and *_global_pause only while 802.3x pause is on)."""
    want = set(keys)
    out = {}
    for line in (text or "").splitlines():
        m = re.match(r"\s+([^:]+):\s+(-?\d+)\s*$", line)
        if m and m.group(1).strip() in want:
            out[m.group(1).strip()] = int(m.group(2))
    return out


def live_ports_from_env(env, role):
    """The lab port of a role from lab.env: [(dev, port, netdev)]. Empty list if lab.env does not name one."""
    dev, nd = env.get(role + "_RDMA_DEV"), env.get(role + "_NETDEV")
    port = to_int(env.get("RDMA_PORT"), 1) or 1
    if dev and NAME_OK.match(dev):
        return [(dev, port, nd if nd and NAME_OK.match(nd) else None)]
    return []


def all_ports():
    out = []
    for dev in listdir("/sys/class/infiniband"):
        nds = listdir("/sys/class/infiniband/%s/device/net" % dev)
        for p in listdir("/sys/class/infiniband/%s/ports" % dev):
            out.append((dev, to_int(p), nds[0] if len(nds) == 1 else None))
    return out


def live_port(dev, port, netdev, prio):
    base = "/sys/class/infiniband/%s/ports/%d" % (dev, port)
    snap = {"dev": dev, "port": port, "netdev": netdev, "state": parse_state(read(base + "/state")),
            "phys_state": parse_state(read(base + "/phys_state")), "rate_gbps": parse_rate_gbps(read(base + "/rate")),
            "link_layer": read(base + "/link_layer"), "operstate": None, "counters": {}}
    c = snap["counters"]
    for k in LIVE_HW:
        v = to_int(read(base + "/hw_counters/" + k))
        if v is not None:
            c[k] = v
    if snap["link_layer"] == "InfiniBand":
        for k in LIVE_IB:
            v = to_int(read(base + "/counters/" + k))
            if v is not None:
                c[k] = v
    if netdev:
        nb = "/sys/class/net/" + netdev
        snap["operstate"] = read(nb + "/operstate")
        for k in ("rx_bytes", "tx_bytes"):
            v = to_int(read(nb + "/statistics/" + k))
            if v is not None:
                c["netdev_" + k] = v
        if snap["link_layer"] != "InfiniBand":
            c.update(parse_ethtool_select(run(["ethtool", "-S", netdev], timeout=5), live_eth_keys(prio)))
    return snap


def live_snapshot(ports, prio=3, role=None):
    """One timestamped reading of the lab ports. `t` is this host's clock in seconds; rates are computed
    from two snapshots of the same host, so clocks of different hosts never mix."""
    return {"schema": LIVE_SCHEMA, "toolkit": VERSION, "host": socket.gethostname(), "role": role,
            "t": round(time.time(), 3), "prio": int(prio), "ports": [live_port(d, p, n, prio) for d, p, n in ports]}


def _bytes_gbps(d, dt):
    return d * 8 / dt / 1e9


# name -> (counter key or a function of the priority, scale(delta, dt))
def rate_spec(prio):
    p = int(prio)
    per_s = lambda d, dt: d / dt  # noqa: E731
    return [
        ("rdma_rx_gbps", "rx_vport_rdma_unicast_bytes", _bytes_gbps),
        ("rdma_tx_gbps", "tx_vport_rdma_unicast_bytes", _bytes_gbps),
        ("prio_rx_gbps", "rx_prio%d_bytes" % p, _bytes_gbps),
        ("prio_tx_gbps", "tx_prio%d_bytes" % p, _bytes_gbps),
        ("pfc_rx_ps", "rx_prio%d_pause" % p, per_s),
        ("pfc_tx_ps", "tx_prio%d_pause" % p, per_s),
        ("global_pause_rx_ps", "rx_global_pause", per_s),
        ("global_pause_tx_ps", "tx_global_pause", per_s),
        ("discards_ps", "rx_discards_phy", per_s),
        ("cnp_sent_ps", "np_cnp_sent", per_s),
        ("cnp_handled_ps", "rp_cnp_handled", per_s),
        ("ecn_marked_ps", "np_ecn_marked_roce_packets", per_s),
        ("oos_ps", "out_of_sequence", per_s),
        ("seq_err_ps", "packet_seq_err", per_s),
        ("ack_timeout_ps", "local_ack_timeout_err", per_s),
        ("netdev_rx_gbps", "netdev_rx_bytes", _bytes_gbps),
        ("netdev_tx_gbps", "netdev_tx_bytes", _bytes_gbps),
        ("ib_tx_gbps", "port_xmit_data", lambda d, dt: _bytes_gbps(d * 4, dt)),
        ("ib_rx_gbps", "port_rcv_data", lambda d, dt: _bytes_gbps(d * 4, dt)),
    ]


def live_rates(prev, cur):
    """Rates between two snapshots of the same host: {(dev, port): {name: value or None}}. A counter that is
    missing in either snapshot, or went backwards (reset, driver reload), gives None, never a negative rate."""
    out = {}
    if not prev or not cur or prev.get("host") != cur.get("host"):
        return out
    dt = (cur.get("t") or 0) - (prev.get("t") or 0)
    before = {(p["dev"], p["port"]): p for p in prev.get("ports", [])}
    for p in cur.get("ports", []):
        key = (p["dev"], p["port"])
        b = before.get(key)
        r = {}
        for name, k, scale in rate_spec(cur.get("prio", 3)):
            v0 = (b or {}).get("counters", {}).get(k)
            v1 = p.get("counters", {}).get(k)
            r[name] = scale(v1 - v0, dt) if (b and dt > 0 and v0 is not None and v1 is not None and v1 >= v0) else None
        out[key] = r
    return out


class RemoteLive:
    """Live snapshots of one remote host over ONE long-lived SSH session (`aina-hw live --stream` on the far
    side prints a JSON line per interval), so polling never opens an SSH connection per sample. The session
    starts on the first request and ends after `idle` seconds without requests; a failed session is retried
    after `backoff` seconds."""

    def __init__(self, role, cmd, script, idle=60.0, backoff=10.0):
        self.role, self.cmd, self.script, self.idle, self.backoff = role, cmd, script, idle, backoff
        self.latest, self.error, self.last = None, None, time.time()
        self.thread = None
        self.lock = threading.Lock()

    def get(self):
        with self.lock:
            self.last = time.time()
            if self.thread is None or not self.thread.is_alive():
                self.thread = threading.Thread(target=self._run, name="live-" + self.role, daemon=True)
                self.thread.start()
            return self.latest, self.error

    def _idle(self):
        return time.time() - self.last > self.idle

    def _run(self):
        while not self._idle():
            err = None
            try:
                with tempfile.TemporaryFile(mode="w+") as errf:
                    proc = subprocess.Popen(self.cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errf,
                                            universal_newlines=True)
                    try:
                        proc.stdin.write(self.script)
                        proc.stdin.close()
                        for line in proc.stdout:
                            try:
                                snap = json.loads(line)
                            except ValueError:
                                continue
                            if isinstance(snap, dict) and snap.get("schema") == LIVE_SCHEMA:
                                self.latest, self.error = snap, None
                            if self._idle():
                                break
                    finally:
                        if proc.poll() is None:
                            proc.terminate()
                        proc.stdout.close()
                        try:
                            proc.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            proc.kill()
                    errf.seek(0)
                    err = errf.read().strip()[-300:] or "ssh exited %s" % proc.returncode
            except (OSError, ValueError) as e:
                err = str(e)
            if self._idle():
                break
            self.error = err
            time.sleep(self.backoff)


class LiveSource:
    """What /api/live serves: host A read locally (cached for half a second, so several browser tabs do not
    multiply the work), plus B and C over SSH when the agent was started with --live-remote."""

    def __init__(self, env, remote=False, interval=2.0, ssh_cmd=None):
        self.env = env or {}
        self.prio = to_int(self.env.get("ROCE_PRIO"), 3)
        if self.prio is None or not 0 <= self.prio <= 7:
            self.prio = 3
        self.local_ports = live_ports_from_env(self.env, "A") or all_ports()
        self.cache, self.cache_t = None, 0.0
        self.lock = threading.Lock()
        self.remotes = {}
        self.remote = remote
        if remote:
            with open(os.path.abspath(__file__), encoding="utf-8") as f:
                script = f.read()
            for role in roles_of(self.env)[1:]:
                host = self.env.get("HOST_" + role)
                ports = live_ports_from_env(self.env, role)
                if not host or not ports or is_local(host):
                    continue
                dev, port, nd = ports[0]
                user = self.env.get("SSH_USER")
                target = "%s@%s" % (user, host) if user else host
                remote_cmd = ["python3", "-", "live", "--stream", "--interval", str(interval), "--duration", "900",
                              "--role", role, "--dev", dev, "--port", str(port), "--prio", str(self.prio)]
                if nd:
                    remote_cmd += ["--netdev", nd]
                cmd = (ssh_cmd or ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=15"]) + \
                    [target, " ".join(shlex.quote(c) for c in remote_cmd)]
                self.remotes[role] = RemoteLive(role, cmd, script)

    def local(self):
        with self.lock:
            if self.cache is None or time.time() - self.cache_t >= 0.5:
                self.cache = live_snapshot(self.local_ports, self.prio, "A")
                self.cache_t = time.time()
            return self.cache

    def get(self):
        hosts = [{"role": "A", "ok": True, "error": None, "snapshot": self.local()}]
        for role, r in sorted(self.remotes.items()):
            snap, err = r.get()
            hosts.append({"role": role, "ok": snap is not None and err is None, "error": err,
                          "snapshot": snap})
        return {"schema": LIVE_SCHEMA, "toolkit": VERSION, "generated": now(), "prio": self.prio,
                "remote": self.remote, "hosts": hosts}


def cmd_live(a):
    if a.dev:
        if not NAME_OK.match(a.dev) or (a.netdev and not NAME_OK.match(a.netdev)):
            print("invalid device or netdev name", file=sys.stderr)
            return 2
        ports, prio = [(a.dev, a.port, a.netdev)], a.prio
    else:
        env = load_env(env_path(a.env)) or {}
        ports = live_ports_from_env(env, a.role or "A") or all_ports()
        prio = a.prio if a.prio is not None else to_int(env.get("ROCE_PRIO"), 3)
    prio = 3 if prio is None else prio
    if a.once:
        print(json.dumps(live_snapshot(ports, prio, a.role), indent=2))
        return 0
    t_end = time.time() + a.duration if a.duration else None
    prev = None
    try:
        while t_end is None or time.time() < t_end:
            snap = live_snapshot(ports, prio, a.role)
            if a.stream:
                sys.stdout.write(json.dumps(snap) + "\n")
                sys.stdout.flush()
            else:
                for (dev, port), r in live_rates(prev, snap).items():
                    f = lambda k, fmt: ("-" if r[k] is None else fmt % r[k])  # noqa: E731
                    print("%s %s/%s  rdma rx %s tx %s Gb/s  pfc rx %s tx %s /s  global pause rx %s /s  cnp sent %s handled %s /s  oos %s /s" % (
                        time.strftime("%H:%M:%S"), dev, port, f("rdma_rx_gbps", "%.2f"), f("rdma_tx_gbps", "%.2f"),
                        f("pfc_rx_ps", "%.0f"), f("pfc_tx_ps", "%.0f"), f("global_pause_rx_ps", "%.0f"),
                        f("cnp_sent_ps", "%.0f"), f("cnp_handled_ps", "%.0f"), f("oos_ps", "%.0f")))
                sys.stdout.flush()
            prev = snap
            time.sleep(max(0.2, a.interval))
    except (KeyboardInterrupt, BrokenPipeError):
        pass
    return 0


DEFAULT_ORIGINS = ["https://jurajliskalc.github.io", "http://localhost", "http://127.0.0.1"]
LOOPBACK_BINDS = ("127.0.0.1", "localhost", "::1")


def host_allowed(host, bind):
    """DNS-rebinding guard: on a loopback bind, answer only requests addressed to a loopback name. A page whose
    own hostname resolves to 127.0.0.1 would otherwise be same-origin with the agent and bypass CORS."""
    if bind not in LOOPBACK_BINDS:
        return True
    return bool(re.match(r"^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$", (host or "").strip(), re.I))


def origin_allowed(origin, allowed, any_origin):
    if not origin:
        return False
    if any_origin:
        return True
    for a in allowed:
        if origin == a or (a in ("http://localhost", "http://127.0.0.1") and re.match(re.escape(a) + r"(:\d+)?$", origin)):
            return True
    return False


def make_handler(directory, allowed, any_origin, bind="127.0.0.1", live=None):
    """Read-only HTTP API. `live` is a LiveSource (or anything with .get()); /api/live answers 404 without one."""
    from http.server import BaseHTTPRequestHandler

    class Handler(BaseHTTPRequestHandler):
        server_version = "aina-hw/" + VERSION

        def cors(self):
            origin = self.headers.get("Origin")
            if origin_allowed(origin, allowed, any_origin):
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
                self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type")
                self.send_header("Access-Control-Allow-Private-Network", "true")

        def send_json(self, code, obj):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def host_ok(self):
            if host_allowed(self.headers.get("Host"), bind):
                return True
            self.send_json(403, {"error": "unexpected Host header"})
            return False

        def do_OPTIONS(self):
            if not self.host_ok():
                return
            self.send_response(204)
            self.cors()
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self):
            if not self.host_ok():
                return
            path = self.path.split("?", 1)[0]
            if path == "/api/live":
                # Counters only; nothing in the request reaches a command (ports come from lab.env).
                if live is None:
                    self.send_json(404, {"error": "live counters are not enabled on this agent"})
                else:
                    self.send_json(200, live.get())
                return
            report_file = os.path.join(directory, "aina-report.json")
            report = None
            if os.path.isfile(report_file):
                try:
                    with open(report_file, encoding="utf-8") as f:
                        report = json.load(f)
                except (OSError, ValueError):
                    report = None
            if not isinstance(report, dict):
                report = None
            if path == "/api/status":
                checks = latest_checks(directory)
                self.send_json(200, {"schema": AGENT_SCHEMA, "toolkit": VERSION, "host": socket.gethostname(),
                                     "read_only": True, "report": bool(report),
                                     "report_generated": report and report.get("generated"),
                                     "lab": report and report.get("lab"), "checks": len(checks),
                                     "live": live is not None, "live_remote": bool(getattr(live, "remote", False))})
            elif path == "/api/report":
                if report:
                    self.send_json(200, report)
                else:
                    self.send_json(404, {"error": "no report yet: run aina-hw collect-all"})
            elif path == "/api/checks":
                self.send_json(200, latest_checks(directory))
            else:
                self.send_json(404, {"error": "not found", "endpoints": ["/api/status", "/api/report", "/api/checks", "/api/live"]})

        def log_message(self, fmt, *args):
            sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    return Handler


def cmd_serve(a):
    import socket
    from http.server import ThreadingHTTPServer

    class Server(ThreadingHTTPServer):
        address_family = socket.AF_INET6 if ":" in a.bind else socket.AF_INET

    directory = results_dir()
    allowed = DEFAULT_ORIGINS + (a.allow_origin or [])
    live = LiveSource(load_env(env_path(a.env)) or {}, remote=a.live_remote, interval=a.live_interval)
    httpd = Server((a.bind, a.port), make_handler(directory, allowed, a.allow_any_origin, a.bind, live))
    print("aina-hw agent (read-only) on http://%s:%d serving %s" % (a.bind, a.port, directory))
    print("Allowed origins: %s" % ("any" if a.allow_any_origin else ", ".join(allowed)))
    ports = ", ".join("%s/%s" % (d, p) for d, p, _ in live.local_ports) or "none found"
    print("Live counters at /api/live: host A %s%s" % (ports, "; remote hosts over one SSH session each, every %gs" % a.live_interval
                                                       if live.remotes else " (add --live-remote to include host B/C over SSH)"))
    if a.bind not in LOOPBACK_BINDS:
        print("WARNING: listening beyond localhost exposes your lab inventory to the network.")
    print("From your laptop: ssh -L %d:127.0.0.1:%d <this host>, then Connect in the academy. Ctrl-C to stop." % (a.port, a.port))
    sys.stdout.flush()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


def cmd_env(a):
    path = env_path(a.env)
    env = load_env(path)
    if env is None:
        print("No lab.env at %s" % path, file=sys.stderr)
        return 2
    print("# %s" % path)
    for k in sorted(env):
        print("%s=%s" % (k, env[k]))
    missing = [k for k in ("HOST_A", "HOST_B", "A_IP", "B_IP", "A_RDMA_DEV", "B_RDMA_DEV", "A_NETDEV", "B_NETDEV") if not env.get(k)]
    if missing:
        print("missing: " + ", ".join(missing), file=sys.stderr)
        return 1
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(prog="aina-hw", description="AI Networking Academy real-hardware toolkit")
    ap.add_argument("--version", action="version", version="aina-hw " + VERSION)
    sub = ap.add_subparsers(dest="cmd")

    p = sub.add_parser("collect", help="inventory this host (read-only)")
    p.add_argument("--out", help="report file (default results/aina-report.json)")
    p.add_argument("--stdout", action="store_true", help="print host facts as JSON instead of writing a report")
    p.add_argument("--role", help="role label (A, B or C)")
    p.add_argument("--netdev", action="append", help="also inventory this netdev")
    p.add_argument("--env", help="lab.env path")
    p.add_argument("--redact", action="store_true", help="hide hostnames, GUIDs and MACs")
    p.set_defaults(fn=cmd_collect)

    p = sub.add_parser("collect-all", help="inventory every host in lab.env over SSH")
    p.add_argument("--env", help="lab.env path")
    p.add_argument("--out", help="report file (default results/aina-report.json)")
    p.add_argument("--sudo", action="store_true", help="collect with sudo -n on remote hosts")
    p.add_argument("--redact", action="store_true", help="hide hostnames, GUIDs and MACs")
    p.set_defaults(fn=cmd_collect_all)

    p = sub.add_parser("summary", help="print a report")
    p.add_argument("report", nargs="?")
    p.set_defaults(fn=cmd_summary)

    p = sub.add_parser("check", help="run a lab's check.sh and save the result")
    p.add_argument("--task", type=int, help="run only the checks of this task (resume a lab)")
    p.add_argument("lab")
    p.add_argument("args", nargs=argparse.REMAINDER)
    p.set_defaults(fn=cmd_check)

    p = sub.add_parser("serve", help="read-only local agent for the academy's Connect page")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--bind", default="127.0.0.1")
    p.add_argument("--allow-origin", action="append", help="extra allowed browser origin, e.g. https://example.org")
    p.add_argument("--allow-any-origin", action="store_true", help="allow every origin (not recommended)")
    p.add_argument("--env", help="lab.env path (lab ports for /api/live)")
    p.add_argument("--live-remote", action="store_true", help="include host B/C in /api/live (one SSH session per host while the Live view is open)")
    p.add_argument("--live-interval", type=float, default=2.0, help="seconds between remote live samples (default 2)")
    p.set_defaults(fn=cmd_serve)

    p = sub.add_parser("live", help="watch the lab port counters as rates (read-only)")
    p.add_argument("--env", help="lab.env path")
    p.add_argument("--role", help="role whose lab port to read (default A)")
    p.add_argument("--dev", help="RDMA device (instead of lab.env)")
    p.add_argument("--port", type=int, default=1, help="RDMA port (with --dev)")
    p.add_argument("--netdev", help="netdev of that port (with --dev)")
    p.add_argument("--prio", type=int, choices=range(8), metavar="0-7", help="lossless priority (default ROCE_PRIO or 3)")
    p.add_argument("--interval", type=float, default=1.0)
    p.add_argument("--duration", type=float, default=0, help="stop after this many seconds (0 = until Ctrl-C)")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--once", action="store_true", help="print one JSON snapshot")
    g.add_argument("--stream", action="store_true", help="print one JSON snapshot per line (used over SSH by serve)")
    p.set_defaults(fn=cmd_live)

    p = sub.add_parser("env", help="show and validate lab.env")
    p.add_argument("--env", help="lab.env path")
    p.set_defaults(fn=cmd_env)

    a = ap.parse_args(argv)
    if not getattr(a, "fn", None):
        ap.print_help()
        return 2
    return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
