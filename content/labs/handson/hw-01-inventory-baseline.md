---
id: hw-01-inventory-baseline
title: "Inventory and baseline your RDMA hosts like a fabric engineer"
kind: handson
level: 2
estimated_minutes: 75
environment: hardware
tier: 1
fabric: any
requires: [two-rdma-hosts, ssh-mesh]
changes_config: false
lessons: [rdma-on-linux, pcie-numa-topology, reading-server-topology, nics-dpus-supernics]
files: labs/hw-01-inventory-baseline
verified: true
summary: "Record exactly what you have before you test anything: NIC model and firmware, PCIe link, NUMA placement, RDMA-to-netdev mapping, GIDs and software versions, then run the academy's fabric health review."
---

> [!NOTE]
> Verified end to end (every task, the check and the restore step) on 2026-10-23 on two ConnectX-5
> hosts cabled back to back (100GbE DAC; ESXi VMs with PCI passthrough; Ubuntu 26.04.1, kernel
> 7.0.0-38, NVIDIA DOCA-OFED 3.4); see `labs/README.md` for the exact versions. Your device names,
> numbers and some output lines will differ with other NICs, firmware or the distribution's inbox stack.

## Goal

Build a written, reproducible **baseline** of host A (`{{HOST_A}}`) and host B (`{{HOST_B}}`):
what NICs they have, which firmware those NICs run, how they are attached to the CPU, which RDMA
device belongs to which network interface, and which software stack drives them. Then collect the
same facts automatically with `aina-hw collect-all` and run the academy's fabric health review on
the [Connect page](#/hw/connect).

This is the first step of every serious fabric bring-up and every incident. "It worked yesterday"
is only useful if you know what yesterday looked like. A surprising share of real performance
problems are inventory problems: a NIC negotiated at half its PCIe width, two hosts on different
firmware, a card in a slot wired to the far CPU socket, or a memlock limit that breaks large
registrations.

By the end you can:

- Identify each RDMA device, its firmware and its netdev, with upstream tools and (where installed)
  vendor helpers.
- Read a PCIe link's capability against its negotiated state and say whether it can carry the NIC's
  port speed.
- Find the NUMA node of a NIC and explain why it matters.
- Produce a JSON inventory of both hosts and interpret the health review's findings.

> [!NOTE]
> Blocks labelled **Real capture** were copied from the reference hosts (ConnectX-5, firmware 16.29,
> Ubuntu 26.04) with the stack named in the label; use the stack switch to see the inbox or DOCA
> version. Other output is **illustrative**. Model names, firmware versions, PCI addresses and GIDs on
> your hosts will differ.

## Before you start

- **Hardware:** two hosts with RDMA NICs (RoCE or InfiniBand), cabled directly or through a switch.
  Links do not have to be up for most tasks, but Task 2 and the check expect ACTIVE ports.
- **Profile:** fill in host names, netdevs and RDMA devices on the [Connect page](#/hw/connect)
  and save the generated `lab.env` as `{{AINA_DIR}}/labs/hw-toolkit/lab.env` on every host (host A runs
  the checks; the QoS and break/fix scripts read it on host B). The commands below are personalised
  with your values.
- **Software:** run `labs/hw-toolkit/setup-rdma-host.sh` on both hosts (it installs rdma-core,
  `pciutils`, `ethtool`, `numactl`, `python3` and friends).
- **SSH:** key-based SSH from host A to host B (`ssh-copy-id {{SSH_USER}}@{{HOST_B}}`).
- **Changes:** none. Everything here reads sysfs, procfs and "show" commands. Some `lspci` fields
  need root, so a few commands use `sudo`.

Keep a text file open (or a ticket, or a wiki page) and paste what you find: that file is the
deliverable of this lab, alongside the JSON report.

## Tasks

### Task 1: List the RDMA devices and map them to netdevs

On each host:

```bash
ibv_devices
rdma dev show
rdma link show
```

Output of `ibv_devices` and `rdma link show` on the reference host A, both ports up (with DOCA, the
NVIDIA helper `ibdev2netdev -v` is shown as well):

```text stack=inbox real
$ ibv_devices
    device          	   node GUID
    ------          	----------------
    rocep3s0f0      	248a0703000011ee
    rocep3s0f1      	248a0703000011ef
$ rdma link show
link rocep3s0f0/1 state ACTIVE physical_state LINK_UP netdev ens64f0np0
link rocep3s0f1/1 state ACTIVE physical_state LINK_UP netdev ens64f1np1
```

```text stack=doca real
$ ibv_devices
libibverbs: Warning: couldn't load driver 'libionic-rdmav59.so': libionic-rdmav59.so: cannot open shared object file: No such file or directory
    device          	   node GUID
    ------          	----------------
    mlx5_0          	248a0703000011ee
    mlx5_1          	248a0703000011ef
$ rdma link show
link mlx5_0/1 state ACTIVE physical_state LINK_UP netdev ens64f0np0
link mlx5_1/1 state ACTIVE physical_state LINK_UP netdev ens64f1np1
$ ibdev2netdev -v
cat: /sys/class/infiniband/mlx5_0/device/vpd: Permission denied
0000:03:00.0 mlx5_0 (MT4119 -            )                 fw 16.29.1016 port 1 (ACTIVE) ==> ens64f0np0 (Up)
cat: /sys/class/infiniband/mlx5_1/device/vpd: Permission denied
0000:03:00.1 mlx5_1 (MT4119 -            )                 fw 16.29.1016 port 1 (ACTIVE) ==> ens64f1np1 (Up)
```

A port whose netdev is down reads `state DOWN physical_state DISABLED`. (The `libionic` warning
comes from DOCA's rdma-core and is harmless.)

**Device names depend on the driver stack.** Distribution rdma-core (Ubuntu, RHEL inbox) renames
RDMA devices after their PCI address (`rocep<bus>s<slot>f<function>`, so `rocep3s0f0` is PCI
`0000:03:00.0` and `rocep59s0f0` would be `0000:3b:00.0`); NVIDIA's OFED / DOCA-Host stack keeps the kernel names `mlx5_0`, `mlx5_1`. The
netdev names are the same on both. Always take the name from `rdma link` or `ibv_devices` on the
host itself, never from a document (including this one).

**Why:** RDMA tools talk to **devices** (`rocep59s0f0` or `mlx5_0`), IP tools talk to **netdevs** (`ens1f0np0`).
Every command in later labs needs the right pair, and on a dual-port card or a server with eight
NICs it is easy to grab the wrong one. `rdma link show` is the upstream (iproute2) way to see the
mapping. If NVIDIA's OFED or DOCA-Host stack is installed you may also have `ibdev2netdev -v`,
which prints the same mapping plus the PCI address and firmware (as non-root it also prints
`Permission denied` lines for the VPD file, which are harmless); it is not part of upstream
rdma-core, so do not rely on it in scripts that must run everywhere.

On an InfiniBand port `rdma link` prints no `netdev` field at all, even when an IPoIB interface
exists; it shows `subnet_prefix`, `lid`, `sm_lid` and `lmc` instead. `ibdev2netdev` still lists the
IPoIB interface (for example `mlx5_1 port 1 ==> ibs64f1 (Down)`). That is normal: InfiniBand does
not need an IP interface to carry RDMA.

Confirm the profile: host A should use `{{A_RDMA_DEV}}` / `{{A_NETDEV}}`, host B `{{B_RDMA_DEV}}` /
`{{B_NETDEV}}`. Fix the profile now if they differ.

### Task 2: Port state, link layer and rate

```bash
D=/sys/class/infiniband/{{A_RDMA_DEV}}/ports/{{RDMA_PORT}}
grep -H . $D/state $D/phys_state $D/link_layer $D/rate
```

The same files read one by one on the reference host A (inbox stack; with DOCA only the device
name in the path changes):

```text real=inbox
$ cat /sys/class/infiniband/rocep3s0f0/ports/1/state /sys/class/infiniband/rocep3s0f0/ports/1/phys_state
4: ACTIVE
5: LinkUp
$ cat /sys/class/infiniband/rocep3s0f0/ports/1/link_layer
Ethernet
$ cat /sys/class/infiniband/rocep3s0f0/ports/1/rate
100 Gb/sec (4X EDR)
```

**Read it:**

- `phys_state LinkUp` means the electrical/optical link trained. `state ACTIVE` means the port is
  usable for RDMA. On Ethernet they normally go together. On InfiniBand a port can be `LinkUp` but
  stay in `INIT` until a subnet manager configures it (the InfiniBand lab shows this).
- `link_layer` tells you RoCE (`Ethernet`) or native `InfiniBand`.
- `rate` is the data rate the RDMA stack reports. On Ethernet ports the parenthesised IB-style
  label (`4X EDR`) is just the closest InfiniBand equivalent, not a statement that you have an EDR
  link; the number is what matters.

> [!NOTE]
> **A 100GbE RoCE port reported its rate as `100 Gb/sec (4X EDR)`.**
> On ConnectX-5 (fw 16.29) in Ethernet mode, with both the inbox stack and DOCA-OFED 3.4, sysfs `rate`
> and `ibstatus` (`rate: 100 Gb/sec (4X EDR)`) used the InfiniBand label even though `link_layer` was
> `Ethernet` and `ethtool` showed `Speed: 100000Mb/s`. Read the number and `link_layer`, not the label.

Repeat on host B. Both ends of a link should report the same rate; if they do not, a cable, optic,
or autonegotiation problem is likely (the Link health lab digs into it).

### Task 3: NIC model and firmware

```bash
ethtool -i {{A_NETDEV}}
cat /sys/class/infiniband/{{A_RDMA_DEV}}/fw_ver
cat /sys/class/infiniband/{{A_RDMA_DEV}}/hca_type /sys/class/infiniband/{{A_RDMA_DEV}}/board_id 2>/dev/null
```

Output of `ethtool -i` on the reference host A (only `version` differs between the stacks):

```text stack=inbox real
driver: mlx5_core
version: 7.0.0-38-generic
firmware-version: 16.29.1016 (MT_0000000008)
expansion-rom-version:
bus-info: 0000:03:00.0
supports-statistics: yes
...
```

```text stack=doca real
driver: mlx5_core
version: 26.04-0.8.5
firmware-version: 16.29.1016 (MT_0000000008)
expansion-rom-version:
bus-info: 0000:03:00.0
supports-statistics: yes
...
```

The sysfs files on the same host read `16.29.1016` (`fw_ver`), `MT4119` (`hca_type`, ConnectX-5) and
`MT_0000000008` (`board_id`).

**Read it:** `driver` is the kernel driver; `version` is the kernel version for the inbox
driver and the driver package version (for example `26.04-0.8.5`) with NVIDIA's DOCA-Host stack. `firmware-version` is the NIC firmware, and on NVIDIA NICs the text in parentheses is the
**PSID**, which identifies the board variant (and so which firmware images are valid for it).
`hca_type` (for example `MT4129`) is the device ID, and `board_id` repeats the PSID. Not every
vendor's driver exposes `hca_type` and `board_id`; that is why the command tolerates errors.

**Why it matters:** two hosts with the same NIC model on different firmware are a classic source of
"one node is slower" or "only this pair fails" incidents, because firmware changes congestion
control defaults, link training and bug fixes. Record both versions. If NVIDIA's firmware tools
(MFT) are installed, `sudo mlxfwmanager --query` lists every adapter with its PSID and firmware in one
go. Recent MFT reaches the NIC directly by PCI address (`sudo mst start` may end with `Unloading MST
PCI module (unused)`, which is normal). On a host with Secure Boot and kernel lockdown that access is
blocked: `mlxfwmanager` reports `-E- No devices found or specified, mst might be stopped, ...`, and
sysfs plus `ethtool -i` are your inventory.

### Task 4: The PCIe link: capability versus reality

Take the PCI address from `bus-info` above (or from `readlink /sys/class/infiniband/{{A_RDMA_DEV}}/device`):

```bash
PCI=$(basename "$(readlink -f /sys/class/infiniband/{{A_RDMA_DEV}}/device)"); echo $PCI
sudo lspci -vv -s $PCI | grep -E 'LnkCap:|LnkSta:'
grep -H . /sys/bus/pci/devices/$PCI/{max_link_speed,max_link_width,current_link_speed,current_link_width}
```

Illustrative output:

```
		LnkCap:	Port #0, Speed 16GT/s, Width x16, ASPM not supported
		LnkSta:	Speed 16GT/s, Width x16
/sys/bus/pci/devices/0000:3b:00.0/max_link_speed:16.0 GT/s PCIe
/sys/bus/pci/devices/0000:3b:00.0/max_link_width:16
/sys/bus/pci/devices/0000:3b:00.0/current_link_speed:16.0 GT/s PCIe
/sys/bus/pci/devices/0000:3b:00.0/current_link_width:16
```

**Read it:** `LnkCap` is what the device can do; `LnkSta` is what it actually negotiated with the
slot. When the negotiated speed or width is lower, recent `lspci` versions append `(downgraded)` to
the `LnkSta` field. A NIC downgraded to x8, or to a lower generation, has had half (or less) of its
host bandwidth taken away and nothing else will tell you: RDMA still works, just slower. Typical
causes are a slot that is mechanically x16 but electrically x8, a riser, a BIOS bifurcation
setting, or a marginal connection.

In a virtual machine with the NIC passed through (for example on ESXi), `lspci` and the sysfs link
files describe the hypervisor's virtual PCIe port (values such as `Speed 5GT/s, Width x32`), not the
physical slot. Check the PCIe link on the hypervisor or bare metal instead; the check's PCIe result
means nothing inside such a VM.

#### The arithmetic: can this slot carry this NIC?

PCIe generations 3, 4 and 5 run at 8, 16 and 32 GT/s per lane with 128b/130b encoding, so each lane
carries roughly 7.9, 15.8 and 31.5 Gb/s per direction before protocol overhead:

| Link | Raw per direction (approx.) | Enough for |
|---|---|---|
| Gen3 x8 | ~63 Gb/s | 40-50 GbE, not 100 GbE |
| Gen3 x16 | ~126 Gb/s | one 100 Gb/s port |
| Gen4 x16 | ~252 Gb/s | one 200 Gb/s port |
| Gen5 x16 | ~504 Gb/s | one 400 Gb/s port |

Transaction-layer overhead (headers, flow-control credits, completions) costs a further slice,
commonly quoted around 10-20% depending on payload size and platform, so treat the table as an upper
bound and an order of magnitude. Two consequences: a dual-port card can usually not run both ports
at full rate at once if the slot only just covers one, and a 200 Gb/s NIC in a Gen3 slot will never
reach line rate however well the fabric is tuned.

### Task 5: NUMA placement

```bash
cat /sys/class/infiniband/{{A_RDMA_DEV}}/device/numa_node
lscpu | grep -i 'numa'
numactl --hardware | head -5
```

**Read it:** the first command prints the NUMA node the NIC's PCIe root port belongs to (`-1` means
the platform reports none, common on single-socket systems). Memory and CPU on that node reach the
NIC directly; anything on another socket crosses the CPU interconnect. That is why perftest results
change when you pin with `numactl` (First traffic lab, Task 6), and why GPU servers pair each GPU
with a NIC under the same PCIe switch. Record the node for each host; later labs use it.

### Task 6: GIDs (RoCE) or LIDs (InfiniBand)

For RoCE, list the GID table with types and netdevs:

```bash
D=/sys/class/infiniband/{{A_RDMA_DEV}}/ports/{{RDMA_PORT}}
for i in $(ls $D/gids | sort -n); do
  t=$(cat $D/gid_attrs/types/$i 2>/dev/null) || continue
  printf '%-3s %-40s %s\n' "$i" "$(cat $D/gids/$i)" "$t"
done
```

Illustrative output for a port with one IPv4 address (unused indexes are skipped):

```
0   fe80:0000:0000:0000:268a:07ff:fe00:11ee  IB/RoCE v1
1   fe80:0000:0000:0000:268a:07ff:fe00:11ee  RoCE v2
2   0000:0000:0000:0000:0000:ffff:0a0a:0a01  IB/RoCE v1
3   0000:0000:0000:0000:0000:ffff:0a0a:0a01  RoCE v2
```

`gid_attrs/ndevs/<index>` names the netdev each entry belongs to. NVIDIA's stack also ships a
`show_gids` script that prints the same table; it is not part of upstream rdma-core.

Note the index of the **RoCE v2** entry that carries your data IP (`{{A_IP}}` appears as
`::ffff:` plus the address in hex). Your profile uses `GID_INDEX={{GID_INDEX}}`; correct it if your
hosts disagree.

For InfiniBand, record the port LID and the SM LID instead:

```bash
cat $D/lid $D/sm_lid
```

On an InfiniBand port without a subnet manager the LID reads `0xffff` (65535, unassigned), not 0;
see the InfiniBand lab. On RoCE ports both files read `0x0`, because RoCE does not use LIDs.

### Task 7: Software stack, limits and CPU policy

```bash
uname -r
(dpkg-query -W rdma-core perftest 2>/dev/null || rpm -q rdma-core perftest)
command -v ofed_info >/dev/null && ofed_info -s
ulimit -l
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor 2>/dev/null
```

**Why each line matters:**

- **Kernel and rdma-core**: inbox drivers come with the kernel; the user-space providers come with
  rdma-core. Mismatched versions across hosts make comparisons harder.
- **OFED / DOCA-Host**: if `ofed_info` exists, NVIDIA's driver stack replaced the inbox one
  (`ofed_info -s` prints a one-line version string, for example `OFED-internal-26.04-0.8.6:`). Do not
  mix it with the distribution's rdma-core packages on the same host.
- **memlock** (`ulimit -l`): RDMA pins ("registers") memory. A small limit makes large perftest or
  NCCL runs fail with memory-registration errors (perftest: `Couldn't allocate MR`). `unlimited` is
  the usual lab setting; `labs/hw-toolkit/setup-rdma-host.sh --set-memlock` sets it (log in again).
- **CPU governor**: power-saving governors make latency noisy, and perftest warns about CPU
  frequency. `performance` is the usual benchmarking choice; on some platforms the governor is
  controlled by firmware and the file does not exist (it is also missing inside most VMs).

### Task 8: Collect everything automatically and run the health review

Now let the toolkit do the same inventory on both hosts. On host A:

```bash
cd {{AINA_DIR}}/labs
./hw-toolkit/aina-hw env                 # shows the profile it will use
./hw-toolkit/aina-hw collect-all         # SSHes to host B and streams the collector there
./hw-toolkit/aina-hw summary             # prints the saved report again
```

`collect-all` writes `hw-toolkit/results/aina-report.json`. It is read-only: it reads sysfs and
procfs and runs show-type commands (`ethtool -i`, `ethtool -S`, `ip -j addr`, `mlnx_qos` or `dcb`
if present, `nvidia-smi` if present). Add `--redact` to hide hostnames, GUIDs and MAC addresses if
you plan to share the file, and `--sudo` if some reads need root on your hosts (it uses
non-interactive `sudo -n`).

Open the [Connect page](#/hw/connect) and import the report (or start `./hw-toolkit/aina-hw serve`
and connect through an SSH tunnel, as the page explains). The review checks, among other things,
port states, PCIe downgrades, MTU consistency, firmware drift, GID availability and QoS consistency
across hosts, and explains each finding with a fix and a lesson to read.

**Compare** the review with your notes from Tasks 1-7. Anything the tool flagged that you missed, or
the other way round, is worth understanding before moving on.

## Verify

On host A:

```bash
cd {{AINA_DIR}}/labs
./hw-toolkit/aina-hw check hw-01-inventory-baseline
```

The check confirms the tools and SSH, that both RDMA ports are ACTIVE, that each NIC's PCIe link
runs at its maximum speed and width (warning only), that NICs of the same model run the same
firmware (warning only), that memlock is unlimited (warning only), and that a report produced by
`aina-hw collect-all` exists and is less than seven days old.

## Restore

Nothing to restore: this lab changes no settings. Keep `results/aina-report.json` as your baseline;
rerun `collect-all` after any change (firmware update, new cable, BIOS setting) and compare.

## What you learned

- RDMA devices and netdevs are different names for the same port; `rdma link show` maps them on
  any distribution.
- Firmware version and PSID belong in every inventory; drift between hosts is a common root cause.
- `LnkSta` versus `LnkCap` (or the sysfs current/max link files) reveals PCIe downgrades that no
  other tool will report.
- PCIe Gen3/4/5 x16 roughly match one 100/200/400 Gb/s port: check the slot before blaming the
  fabric.
- NUMA placement, memlock and the CPU governor shape every later measurement.
- A saved JSON baseline turns "something changed" into a diff.

## Going further

- Run `nvidia-smi topo -m` on GPU hosts and find which GPU shares a PCIe switch with the NIC (the
  GPUDirect lab builds on it).
- On a host with NVIDIA's MFT installed, compare `mlxfwmanager --query` with what you recorded and
  check whether newer firmware is available for your PSID (read the release notes before updating).
- Make `aina-hw collect-all` part of your change routine: collect before and after every change and
  keep the reports next to your change notes.
