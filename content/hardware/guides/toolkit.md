---
id: toolkit
title: "The aina-hw toolkit"
order: 6
summary: Install, inventory, check and connect. A reference for the scripts in labs/hw-toolkit and the agent the academy talks to.
---

## What is in `labs/hw-toolkit`

| File | What it does | Changes the system? |
|---|---|---|
| `setup-rdma-host.sh` | Installs RDMA user space and diagnostic tools (apt or dnf), then audits drivers, RDMA devices, the locked-memory limit, CPU governor, IOMMU flags and the GPU stack | Installs packages; optional `--set-memlock` writes one limits file |
| `aina-hw` (`aina_hw.py`) | Inventories hosts, runs lab checks and records results, serves both to the academy | No: it only reads |
| `lib.sh` | Helpers every hardware `check.sh` sources: profile loading, PASS/FAIL output, SSH to the other hosts, GID lookup, counters, perftest servers | No |
| `lab.env.example` | A commented example profile | n/a |
| `tests/` | Unit tests that run the collector against fake sysfs trees | n/a |

`aina-hw` needs only **Python 3.8 or newer** and the standard library, so it runs on any current
distribution without installing anything, and it can stream itself to remote hosts over SSH: the
other hosts need Python 3 but no copy of the toolkit.

Optionally put it on your `PATH` on host A:

```bash
sudo ln -s {{AINA_DIR}}/labs/hw-toolkit/aina-hw /usr/local/bin/aina-hw
```

## The profile: `lab.env`

Every value the labs use lives in one bash-syntax file, `labs/hw-toolkit/lab.env`. Generate it on
the [Connect page](#/hw/connect) (or copy `lab.env.example`) and put the same file on every host.
Scripts look for it at `$AINA_ENV` first, then at `labs/hw-toolkit/lab.env`.

```bash
./aina-hw env      # prints the values it loaded and lists anything required that is missing
```

The variable names are the placeholders in the lab text (tick **Show placeholders** above any
personalised page to see them unfilled). With your current profile, `A_RDMA_DEV` is
`{{A_RDMA_DEV}}` and `GID_INDEX` is `{{GID_INDEX}}`. `TCLASS` is derived: `ROCE_DSCP * 4 + 2`, the
DSCP shifted into the traffic-class byte with ECT(0) set (here `{{TCLASS}}`).

## Commands

### `aina-hw collect`

Inventories the host it runs on and writes `results/aina-report.json`. Options: `--role A|B|C`,
`--netdev IF` (also inventory an interface that has no RDMA device), `--redact`, `--out FILE`, and
`--stdout` (print one host's facts as JSON; this is what `collect-all` runs remotely).

### `aina-hw collect-all`

Reads `lab.env` and inventories hosts A and B (and C when `HOST_COUNT=3`): host A in-process, the
others over SSH, running the same collector by piping it into `python3 -` on the remote host. Use
`--sudo` to collect with `sudo -n` on the remote hosts (some QoS reads need root), and `--redact`
before sharing a report. The result is one report with every host, and a short terminal summary:

```
== node-a  role A  Ubuntu 24.04.1 LTS  kernel 6.8.0-45-generic
   rdma-core 50.0-2build2  perftest 24.01.0  ofed -  nvidia -
   rocep59s0f0 fw 28.42.1000    pci 0000:3b:00.0  PCIe 16.0 GT/s x16 (max 16.0 x16)  numa 0
     port 1  ACTIVE  Ethernet 100 Gb/sec (2X HDR)    mtu 4096  netdev ens1f0np0
...
ERROR fabric: MTU differs between hosts: 1500=node-b (B):ens1f0np0; 9000=node-a (A):ens1f0np0
```

(Illustrative.) The full, explained review runs on the [Connect page](#/hw/connect).

### `aina-hw summary [REPORT]`

Prints the summary of an existing report again.

### `aina-hw check LAB_ID [ARGS...]`

Runs `labs/LAB_ID/check.sh`, streams its output, and saves
`results/check-LAB_ID-<timestamp>.json` with every `PASS:`, `FAIL:`, `WARN:` and `SKIP:` line, the
counts, the exit code, the host and the timings. "Nothing failed" is not enough to verify a lab, so a
run is graded on three separate axes:

| Axis | Meaning |
|---|---|
| Functional | at least one PASS, no FAIL, and the script exited with 0 |
| Complete | every **required measurement** of the lab was made, and no task the check covers was left unrun |
| Performance | every measurement with a target reached it (`ok`), one missed it (`low`), or the lab has no targets |

Each check declares its required measurements up front (`REQUIRE: 5 bw RDMA write bandwidth ...`) and
reports them as they are made (`MET: bw`, and `PERF: bw ok` or `PERF: bw low` for a target). The verdict is
then one of:

- **PASSED**: functional, complete and on target. Only this marks the lab verified.
- **FAILED**: a check failed.
- **INCONCLUSIVE**: nothing failed, but a required measurement was not made (a SKIP: perftest built
  without CUDA, iperf3 missing, a counter the driver does not expose) or a covered task did not run. The
  terminal and the lab page name what is missing.
- **BELOW_TARGET**: everything ran and passed, but a measurement missed its target (for example
  hw-02's bandwidth below `AINA_MIN_BW_PCT`, default 60% of the port rate).

The academy recomputes all of this from the lines when it imports a result, so editing `"passed": true`
or `"verdict"` into a file does not count.

It works for the Tier 0 labs too (`sudo ./aina-hw check hol-soft-roce-perftest`): their check
scripts print the same line format.

**Per-task results.** The hardware lab checks group their lines by the lab's tasks: a `TASK: 3 ...`
line starts the checks for Task 3, and the lines before the first one are the "Before you start"
prerequisites. The result file then carries a `tasks` list (PASS, FAIL, WARN, SKIP per task, or
NOTRUN when the run stopped at the prerequisites), the terminal prints one line per task, and the
lab page shows which tasks are done and where to resume. To recheck only the task you just fixed:

```bash
./hw-toolkit/aina-hw check hw-03-host-qos-pfc-ecn --task 3
```

The prerequisites always run. A single-task result (`"only_task": 3`) is graded on that task's required
measurements and the prerequisites' only. It updates that task on the lab page but never marks the whole
lab verified: run the full check for that.

### `aina-hw live`

Prints the lab port's counters as rates once a second in the terminal (RDMA Gb/s from
`tx/rx_vport_rdma_unicast_bytes`, PFC or global pause frames per second, CNPs sent and handled,
out-of-sequence packets). `--once` prints one JSON snapshot instead. Read-only: it reads sysfs and
`ethtool -S`.

### `aina-hw serve`

A **read-only** HTTP agent for the Connect page. It serves four GET endpoints and nothing else:

| Endpoint | Returns |
|---|---|
| `GET /api/status` | toolkit version, host name, whether a report exists, number of check results, whether live counters are on |
| `GET /api/report` | the latest `results/aina-report.json` |
| `GET /api/checks` | the newest check result per lab (and newer single-task results) |
| `GET /api/live` | a timestamped snapshot of the lab ports' counters (see [Live](#/hw/live)) |

It never runs commands on request: reports and results only change when you run `collect-all` or
`check` in a terminal. `/api/live` reads the lab port named in `lab.env` (sysfs and `ethtool -S`;
nothing in the request reaches a command), at most twice a second however many tabs poll it. With
`--live-remote` it also reads host B (and C) through **one** long-lived SSH session per host while the
Live view is open (sampled every 2 seconds, `--live-interval` to change), and closes the session a
minute after the last request.

## Connecting the academy

The browser that shows the academy usually runs on your laptop, while the agent runs on host A. Keep
the agent on the loopback interface (the default `--bind 127.0.0.1`) and forward it over SSH:

```bash
# on host A
cd {{AINA_DIR}}/labs/hw-toolkit && ./aina-hw serve
# on your laptop
ssh -L 8765:127.0.0.1:8765 {{SSH_USER}}@{{HOST_A}}
```

Then press **Connect** on the [Connect page](#/hw/connect) with `http://127.0.0.1:8765`. With
auto-refresh on, a `check` you run on host A shows up within about 15 seconds.

**Security model.** The agent binds to 127.0.0.1, serves read-only data, and only answers
cross-origin requests from an allow-list: the published academy site and `http://localhost` /
`http://127.0.0.1` on any port (the local launcher). If you host the academy elsewhere, add your
origin with `--allow-origin https://your.host`. `--allow-any-origin` exists for experiments but
lets any web page you visit while the agent runs read your lab inventory.

**Browser notes.** Browsers treat a public HTTPS page reaching a loopback address specially. Recent
Chromium-based browsers may ask for permission to access devices on your local network; allow it
for the academy. The agent also answers the Private Network Access preflight that some Chromium
versions send. Safari may block the request entirely. If the Connect button cannot reach the agent,
use **file import** instead: copy `results/*.json` from host A (`scp`) and drop them on the page.
It does exactly the same thing.

## What the inventory contains

| Area | Sources | Used for |
|---|---|---|
| Host | `/etc/os-release`, `/proc/cpuinfo`, `/proc/meminfo`, `/proc/cmdline` (IOMMU and PCIe flags only), NUMA nodes, CPU governor, `ulimit -l` | Platform consistency, memlock, governor |
| Software | `dpkg-query`/`rpm` for rdma-core and perftest, `ofed_info -s`, the NVIDIA kernel module version, which diagnostic tools exist | Driver-stack consistency, missing tools |
| Kernel modules | `/sys/module/*` for the RDMA, NIC and GPU modules | Provider driver, `nvidia_peermem` |
| RDMA devices | `/sys/class/infiniband/*`: firmware, board ID, PCI address, NUMA node, PCIe current and maximum link, ports (state, rate, link layer, LIDs), GID table with types and netdevs, port and `hw_counters`; `ibv_devinfo` for the active MTU; `rdma -j link` for the netdev mapping | Most of the review |
| Netdevs | `/sys/class/net/*`, `ip -j addr`, `ethtool -i`, `-a`, and `-S` (only pause, per-priority, discard, error, buffer, FEC and congestion counters), `mlnx_qos` or `dcb` for trust, PFC and DSCP mapping, the per-priority RoCE ECN switches where the driver exposes them (NVIDIA's stack only) | MTU, IPs, QoS consistency, PHY errors |
| Neighbours | `lldpcli -f json show neighbors` (if lldpd runs) | Cabling against the profile's port map |
| GPUs | `nvidia-smi --query-gpu=...`, `nvidia-smi topo -m` | Tier 3 readiness, GPU and NIC affinity |

Anything a host does not have is simply absent, with a note explaining why (for example "could not
read QoS: some reads need root").

**Redaction.** `--redact` replaces host names with a hash and drops node GUIDs, MAC addresses and
the MAC- or GUID-derived part of GIDs. IP addresses on the data network, interface names and LLDP
neighbour (switch) names stay, because the review needs them; check results keep the real hostname.
Read the JSON before you share it; it is plain text.

## Writing check scripts with `lib.sh`

Every hardware lab's `check.sh` starts the same way:

```bash
#!/usr/bin/env bash
set -uo pipefail
. "$(dirname "$0")/../hw-toolkit/lib.sh"
aina_load_env
need_cmd ib_write_bw || aina_finish
check_ssh B || aina_finish
# ... tests that call pass / fail / warn / skip ...
aina_finish
```

| Helper | Purpose |
|---|---|
| `aina_load_env` | Source `lab.env`, fill defaults, compute `TCLASS` |
| `pass`, `fail`, `warn`, `skip`, `info` | Print a result line (`fail` and `warn` are counted) |
| `aina_finish` | Print the summary and exit 1 if anything failed |
| `need_cmd`, `need_root`, `check_ssh` | Preconditions as PASS/FAIL lines |
| `host_of`, `ip_of`, `netdev_of`, `rdma_of` | Role lookups: `ip_of B` prints {{B_IP}} |
| `on_host ROLE cmd...`, `on_host_sh ROLE 'snippet'` | Run locally on A, over SSH on B and C |
| `port_attr ROLE ATTR`, `hw_counter ROLE NAME`, `counter ROLE NETDEV NAME` | Read sysfs port attributes, RDMA hw counters, ethtool counters |
| `roce_gid ROLE` | The RoCE v2 GID index that carries the role's data IP (falls back to `GID_INDEX`) |
| `start_server ROLE LOG cmd...`, `stop_server`, `kill_server` | Background server side of perftest-style tests |
| `bw_average FILE` | The BW average column of a perftest result |
| `aina_state_dir LAB` | Where labs that change settings save the original state (`/var/lib/aina/state/LAB`) |

Rules the existing labs follow: checks are read-only unless the lab declares `changes_config`,
servers are wrapped in `timeout`, test handshakes use their own TCP ports (186xx) so they never
collide with the learner's own runs, and every failure message says what to look at next.

## Testing the toolkit

```bash
cd {{AINA_DIR}}
python3 -m unittest discover -s labs/hw-toolkit/tests -v
```

The tests build fake sysfs trees for two hosts, run the real collector against them with canned
command output, and check every parser. The academy's **demo report** on the Connect page is
generated from the same fake hosts (`tests/make_demo_report.py`), so the demo always matches what
the collector actually produces.
