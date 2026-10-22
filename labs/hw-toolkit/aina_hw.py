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
    aina-hw check        LAB_ID [ARGS ...]
    aina-hw serve        [--port 8765] [--bind 127.0.0.1] [--allow-origin URL ...]
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

VERSION = "1.0.0"
REPORT_SCHEMA = "aina.hw.report/1"
HOST_SCHEMA = "aina.hw.host/1"
CHECK_SCHEMA = "aina.hw.check/1"
AGENT_SCHEMA = "aina.hw.agent/1"

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
    """Lines 'PASS: ...', 'FAIL: ...', 'WARN: ...', 'SKIP: ...' -> list of results."""
    out = []
    for line in (text or "").splitlines():
        m = re.match(r"\s*(PASS|FAIL|WARN|SKIP):\s?(.*)$", line)
        if m:
            out.append({"status": m.group(1), "text": m.group(2).strip()})
    return out


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


def collect_netdev(name, notes):
    base = "/sys/class/net/" + name
    if not os.path.isdir(sys_path(base)):
        notes.append("netdev %s does not exist" % name)
        return None
    speed = to_int(read(base + "/speed"))
    nd = {
        "name": name,
        "mtu": to_int(read(base + "/mtu")),
        "operstate": read(base + "/operstate"),
        "speed_mbps": speed if speed and speed > 0 else None,
        "mac": read(base + "/address"),
        "ipv4": [],
        "pause": parse_ethtool_pause(run(["ethtool", "-a", name])),
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
    return host in names


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
            if nd.get("mtu"):
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
    env = dict(os.environ)
    env.setdefault("AINA_ENV", env_path(None))
    started = now()
    t0 = _dt.datetime.now()
    lines = []
    p = subprocess.Popen(["bash", script] + a.args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         universal_newlines=True, env=env, cwd=os.path.dirname(script))
    for line in p.stdout:
        sys.stdout.write(line)
        sys.stdout.flush()
        lines.append(line)
    code = p.wait()
    results = parse_check_output("".join(lines))
    counts = {s: sum(1 for r in results if r["status"] == s) for s in ("PASS", "FAIL", "WARN", "SKIP")}
    labenv = load_env(env["AINA_ENV"]) or {}
    record = {
        "schema": CHECK_SCHEMA, "toolkit": VERSION, "lab": a.lab, "host": socket.gethostname(),
        "lab_name": labenv.get("LAB_NAME"), "fabric": labenv.get("FABRIC"),
        "started": started, "finished": now(), "duration_s": round((_dt.datetime.now() - t0).total_seconds(), 1),
        "exit_code": code, "passed": code == 0 and counts["FAIL"] == 0 and counts["PASS"] > 0,
        "counts": counts, "results": results,
    }
    stamp = started.replace(":", "").replace("+0000", "Z")[:17]
    out = os.path.join(results_dir(), "check-%s-%s.json" % (a.lab, stamp))
    write_json(out, record)
    print("\nResult: %s  (%d pass, %d fail, %d warn, %d skip)  saved to %s" % (
        "PASSED" if record["passed"] else "NOT PASSED", counts["PASS"], counts["FAIL"], counts["WARN"], counts["SKIP"], out))
    return 0 if record["passed"] else 1


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
        if rec["lab"] not in latest or rec["finished"] >= latest[rec["lab"]]["finished"]:
            latest[rec["lab"]] = rec
    return [latest[k] for k in sorted(latest)]


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


def make_handler(directory, allowed, any_origin, bind="127.0.0.1"):
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
                                     "lab": report and report.get("lab"), "checks": len(checks)})
            elif path == "/api/report":
                if report:
                    self.send_json(200, report)
                else:
                    self.send_json(404, {"error": "no report yet: run aina-hw collect-all"})
            elif path == "/api/checks":
                self.send_json(200, latest_checks(directory))
            else:
                self.send_json(404, {"error": "not found", "endpoints": ["/api/status", "/api/report", "/api/checks"]})

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
    httpd = Server((a.bind, a.port), make_handler(directory, allowed, a.allow_any_origin, a.bind))
    print("aina-hw agent (read-only) on http://%s:%d serving %s" % (a.bind, a.port, directory))
    print("Allowed origins: %s" % ("any" if a.allow_any_origin else ", ".join(allowed)))
    if a.bind not in LOOPBACK_BINDS:
        print("WARNING: listening beyond localhost exposes your lab inventory to the network.")
    print("From your laptop: ssh -L %d:127.0.0.1:%d <this host>, then Connect in the academy. Ctrl-C to stop." % (a.port, a.port))
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
    p.add_argument("lab")
    p.add_argument("args", nargs=argparse.REMAINDER)
    p.set_defaults(fn=cmd_check)

    p = sub.add_parser("serve", help="read-only local agent for the academy's Connect page")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--bind", default="127.0.0.1")
    p.add_argument("--allow-origin", action="append", help="extra allowed browser origin, e.g. https://example.org")
    p.add_argument("--allow-any-origin", action="store_true", help="allow every origin (not recommended)")
    p.set_defaults(fn=cmd_serve)

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
