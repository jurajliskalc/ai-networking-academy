# Fabric Simulator

The Fabric Simulator is a deterministic, in-browser model of a small rail-optimized RoCEv2 GPU cluster.
It exists so that learners can practise **reading real tool output and reasoning from evidence** without
owning a GPU cluster. Code: `frontend/src/sim/` (`fabric.ts` model, `shell.ts` commands, `lab.ts` grading).

> It is a teaching model, not an emulator. It reproduces *which* counters move, *which* tests fail and
> *roughly how much* bandwidth is lost for each fault class. Absolute numbers, counter magnitudes and
> exact output formats of real products differ by hardware generation, firmware and software version.

## The cluster

| Item | Model |
|---|---|
| Nodes | `node01`-`node04`, 8 H100-class GPUs each (32 ranks) |
| NICs | 8 per node, `mlx5_0`-`mlx5_7`, 400G RoCEv2, PCIe Gen5 x16, one per GPU (`PIX` in `nvidia-smi topo -m`) |
| Netdevs | `enp24s0np0`, `enp41s0np0`, `enp82s0np0`, `enp99s0np0`, `enp154s0np0`, `enp170s0np0`, `enp204s0np0`, `enp220s0np0` |
| Rail leaves | `leaf01`-`leaf08`; rail *r* (`mlx5_r`) of node *n* lands on `leaf0(r+1)` port `swp<n>` |
| Spines | `spine01`, `spine02`; every leaf has `swp31` → spine01 and `swp32` → spine02 |
| Addressing | routed /31 per host link: host `10.<rail>.<node>.1`, leaf `10.<rail>.<node>.0` |
| QoS | RoCE on DSCP 26 → priority 3 (lossless, PFC + ECN), CNP on DSCP 48 → priority 6. `NCCL_IB_TC=106` |
| NCCL | `/etc/nccl.conf` on every node: `NCCL_SOCKET_IFNAME=eno1`, `NCCL_IB_HCA=mlx5`, `NCCL_IB_GID_INDEX=3`, `NCCL_IB_TC=106` |

The DSCP/priority choices follow a common NVIDIA convention; they are not a standard. Leaf ECN marking
for traffic classes 0 and 3 uses the NVUE `default-global` congestion-control thresholds (150000 B /
1500000 B). The PFC watchdog is enabled on every switch port (100 ms polling, robustness 3, the NVUE
defaults); Cumulus Linux leaves it off by default, enabling it is common practice.

## InfiniBand variant

A lab whose first `faults` entry is `{ type: ib_fabric }` runs on the same topology converted to
InfiniBand: the HCAs run IB link layer at 4X NDR (400 Gb/s), the netdevs are IPoIB (`ibp24s0` ...
`ibp220s0`), the leaves and spines are Quantum-2 switches (node description `MF0;<name>:MQM9700/U1`,
ports numbered 1-32: `swpN` in the model is port N) and the whole fabric is one subnet. OpenSM runs as
the `opensm` service on node01 and uses node01 `mlx5_0` as its port.

* **Port state** is computed, not stored. The SM sweeps the subnet from its own port over links that are
  physically up; every port it reaches is `Active` with a LID (switches 1-10 in the order leaf01-leaf08,
  spine01, spine02; HCA `mlx5_r` of node *n* gets `11 + 8(n-1) + r`, so the SM's own port is LID 11).
  Without a running SM every trained port stays `Initialize`/`INIT` with LID 0 and SM LID 0.
* **NCCL**: the IB plugin skips ports that are not ACTIVE (as NCCL's `net_ib` does); when no port is
  usable it logs `NET/IB : No device found.` and falls back to sockets. `NCCL_IB_GID_INDEX` and
  `NCCL_IB_TC` are removed from `/etc/nccl.conf` in this variant.
* **No PFC/ECN/trust** checks apply: InfiniBand is lossless through credit-based link-level flow control.
* **Counters**: every HCA port and switch port has PMA PortCounters (`IB_PC_FIELDS` in `fabric.ts`).
  Traffic adds data/packet counts (data in 4-byte words) and PortXmitWait under load; a link with a high
  BER adds SymbolErrorCounter, LinkErrorRecoveryCounter and PortRcvErrors on both ends. The 32-bit
  PortCounters saturate as on real hardware (`perfquery` shows `4294967295` for data after one job; use
  `perfquery -x` for the 64-bit extended counters).
* RoCE-only tools (`ethtool`, `mlnx_qos`, `mlxlink`, `show_gids`, `ping`) print a note, and `ssh` to a
  switch explains that IB switches are queried in-band. On the RoCE cluster the infiniband-diags tools
  print a note instead.

## How performance is computed

* **Point-to-point** (`ib_write_bw`, one RC QP, unloaded fabric): 391.8 Gb/s × the worst *non-load*
  factor on the path: high BER (×0.55), PCIe below line rate (PCIe GB/s × 0.9 / 400), RoCE path MTU
  below 4096 (×0.93 at 2048, ×0.82 at ≤1024). Lossless misconfigurations do **not** show here, because a
  single flow never congests the fabric. That is a deliberate teaching point.
* **Collective** (`all_reduce_perf`, 32 ranks): 46.5 GB/s of bus bandwidth per used rail, times the
  number of rails NCCL may use, times the worst factor on any (node, rail), including load-only factors:
  RoCE QoS off on the leaf (×0.3), NIC trusting PCP (×0.35), PFC not on priority 3 (×0.35), wrong
  `NCCL_IB_TC` (×0.35), ECN disabled on the leaf's RoCE traffic class (×0.55: PFC is the only brake),
  a stuck receiver on the rail (×0.15 with the leaf's PFC watchdog containing it, ×0.04 without), a link
  trained at fewer lanes (lanes / 4, also point-to-point). `NCCL_CROSS_NIC=1` makes inter-node hops
  change rail through the spines (×0.46, ×0.24 if any leaf uplink is down). The slowest rail paces the
  ring, as in reality.
* **Fatal conditions** fail the job with a realistic NCCL WARN: a dead link or a path MTU smaller than the
  RoCE packet (retry exceeded, `status=12`), a non-routable GID index (`ibv_modify_qp` timeout), a bad
  `NCCL_SOCKET_IFNAME` (bootstrap failure). `NCCL_IB_DISABLE=1`, or an `NCCL_IB_HCA` that matches no device, falls back to sockets over the 25GbE management NIC (~2.6 GB/s), as real NCCL does.
* **Counters** advance deterministically every time a test runs, according to the active faults: drops,
  `out_of_sequence`, `packet_seq_err`, pause frames, ECN marks and CNPs, symbol and CRC errors, PFC
  watchdog deadlocks, spine traffic for cross-rail rings, and the InfiniBand PMA counters.
* **Pause direction** matters and is modelled: without ECN the *leaf* pauses the senders (TX PFC pause on
  the leaf, `rx_prio3_pause` on the NICs); a stuck receiver makes the *NIC* pause the leaf (`tx_prio3_pause`
  on the NIC, RX PFC pause on the leaf), which is what trips the leaf's watchdog.

## Commands

GPU nodes: `ssh`, `ip`, `ibdev2netdev`, `ibv_devices`, `ibv_devinfo`, `show_gids`, `rdma link|statistic`,
`ethtool [-S|-m|-a]`, `mlnx_qos`, `lspci [-vv -s]`, `nvidia-smi topo -m`, `dmesg`, `mlxlink [-c]`, `ping`,
`ib_write_bw`, `all_reduce_perf` (directly or via `mpirun`), `cat`, `sed -i 's/…/…/'`, `sed -i '/…/d'`,
`echo … >> /etc/nccl.conf`, with pipes to `grep`, `head`, `tail`, `wc -l`, `sort`. With
`NCCL_DEBUG=INFO`, `all_reduce_perf` also prints where the first rings enter and leave node01
(`[receive]`/`[send] via NET/IB/<n>/GDRDMA`; a rail-aligned send from a GPU that is not next to NIC *n*
goes through PXN and is logged `NET/IB/<n>(<proxy rank>)`, as in NCCL's `net.cc`), which is how crossed rails
show up. The line format follows NCCL 2.1x; newer releases append `(PCI)`/`/flush=` details.

InfiniBand variant (GPU nodes): `ibstat [-l|-p] [<ca> [<port>]]`, `ibstatus [<ca>[:<port>]]`,
`iblinkinfo [--switches-only|--cas-only|-d]`, `perfquery [-x] [-r] [-C <ca>] [<lid> [<port>]]`, `sminfo`,
`ibqueryerrors [-s <Counter,...>] [-c]`, `systemctl status|start|stop|restart|enable [--now]|disable|
is-active|is-enabled opensm`, plus `ibv_devinfo`, `ibdev2netdev`, `rdma link|statistic`, `ib_write_bw`,
`all_reduce_perf`, `lspci`, `nvidia-smi topo -m`. `ibdiagnet` (NVIDIA proprietary) and `ibnetdiscover` are
not modelled.

Output formats follow the rdma-core sources: `ibstat` (`infiniband-diags/ibstat.c`: State
`Initializing`/`Active`, Rate, Base lid, SM lid, Capability mask), `ibstatus` (the sysfs-reading
script: `2: INIT`, `4: ACTIVE`, `400 Gb/sec (4X NDR)`), `iblinkinfo` (`iblinkinfo.c` `print_port`: the
`( 4X        106.25 Gbps Active/  LinkUp)` link string and the `Could be 4X` width message from
`get_max_msg`), `perfquery` (libibmad `mad_dump_perfcounters` field order and dot padding, saturating
widths), `sminfo` (`sm lid … state 3 SMINFO_MASTER`, and `sminfo: iberror: failed: query`), and
`ibqueryerrors` (`Errors for …`, `[Counter == n]`, `## Summary` lines, and `## Thresholds: ` with nothing
after it, as with the packaged `error_thresholds` file whose entries are all commented out, so any non-zero
counter, PortXmitWait included, is reported). perftest's
`Port number 1 state is Init` / `Couldn't set the link layer` comes from `perftest_parameters.c`.
Simplifications: unused switch ports are not listed by `iblinkinfo`; `ibqueryerrors` ignores
`--threshold-file` (thresholds are always 0) and does not check unused switch ports, and it summarises PMA query failures instead of printing each
`ibwarn` line; when no SM runs, `sminfo` and `perfquery` fail with a single `iberror` line (the exact
`ibwarn` lines before it vary by version); `systemctl` unit text, capability masks and CapMask values
are illustrative.

Switches (Cumulus Linux NVUE subset): `nv show interface [<swp> [counters]]`, `nv show qos roce`,
`nv show interface <swp> qos roce counters` (a subset of the rows: pause packets, ECN-marked packets,
CNP packets, RoCE packets, buffer discards), `nv show qos congestion-control default-global
[traffic-class <tc>]`, `nv show qos pfc-watchdog`, `nv show interface <swp> qos pfc-watchdog` (state and
the per-traffic-class `OK`/`DEADLOCK` table with `deadlock-count`),
`nv set|unset interface <swp> link mtu|state`, `nv set|unset qos roce [mode lossless|lossy]`,
`nv set qos congestion-control default-global traffic-class <tc> ecn enable|disable`,
`nv set|unset interface <swp> qos pfc-watchdog [state enabled|disabled]`,
`nv action clear interface <swp> qos pfc-watchdog deadlock-count`, `nv config diff`, `nv config apply`.
Changes are staged until applied, as in NVUE. The command paths follow the Cumulus Linux 5.16 user guide
(Quality of Service, RoCE); output shapes are modelled on its examples and may differ from any given
release. How `nv set qos roce` and the `default-global` congestion-control profile interact on a real
switch is simplified here: the model keeps one ECN switch per traffic class.

Lab actions for physical work: `replace-cable <switch> <port>` (a new cable/transceiver: clears BER and
restores full width; IB port numbers work too, e.g. `replace-cable leaf03 3`), `reseat-nic <node> <dev>`
(drain, power-cycle and reseat: restores PCIe width/speed and clears a stuck receive path).

## Writing a simulator lab

`content/labs/sim/<id>.yaml`:

```yaml
id: sim-42-example
title: "Short, specific title"
level: 3                     # 1-4
estimated_minutes: 30
lessons: [pfc-priority-flow-control]   # lessons this lab practises
summary: One sentence for the lab list.
start: node01
ticket: |                    # Markdown: the incident as a user would report it
  **INC-0000 · Sev3 · ...**
faults:                      # applied to a healthy cluster, in order
  - { type: host_pfc, node: node03, rail: 5, prios: [4] }
hints: [ "...", "..." ]      # revealed one at a time; counted
diagnosis:                   # one correct option, every option explained
  prompt: What is the root cause?
  options: [ { id: a, text: ..., correct: true, explanation: ... }, ... ]
checks:                      # graded against the live simulator state
  - { description: "...", check: host_pfc_only, args: { node: node03, rail: 5, prio: 3 } }
  - { description: "...", check: allreduce_min_busbw, args: { value: 360 } }
solution: |                  # Markdown, shown after grading
  ...
fix:                         # "host: command" lines; the test suite replays them
  - "node03: mlnx_qos -i enp170s0np0 --pfc 0,0,0,1,0,0,0,0"
```

Fault types: `switch_port_mtu`, `switch_port_admin_down`, `cable_unplugged`, `bad_cable` (`ber`),
`switch_roce` (`mode: lossless|lossy|off`), `host_mtu`, `host_pfc` (`prios`), `host_trust`,
`nic_admin_down`, `pcie_downtrain` (`width`, `speed`), `nccl_conf` (`set: {KEY: value|null}`),
`switch_ecn` (`switch`, `tc`, `enabled: false`: ECN marking off on that traffic class),
`nic_rx_stall` (`node`, `rail`: the NIC stops draining and pauses its leaf port non-stop; the state
starts with the watchdog already tripped), `pfcwd` (`switch`, `port`, `enabled`),
`link_degraded` (`switch`, `port`, `lanes`, optional `ber`: the link trained at fewer lanes),
and for the InfiniBand variant `ib_fabric` (must be the first entry), `sm_down` (`enabled`: whether the
opensm unit stays enabled) and `ib_counters` (`switch`+`port` or `node`+`rail`, `counters: {Name: n}`:
pre-existing counter history, useful for red herrings).
`node: all` applies a host fault to every node.

Checks: `allreduce_min_busbw`, `ib_write_bw_min`, `port_mtu_min`, `port_up`, `link_clean`, `host_mtu`,
`host_pfc_only`, `host_trust`, `nic_up`, `pcie_ok`, `switch_roce`, `no_pending`, `nccl_conf`,
`nccl_conf_absent`, `nccl_conf_not` (`key`, `value`: the key is absent or has another value),
`nccl_hca_all`, `switch_ecn_on` (`switch`, `tc`), `pfcwd_on` (`switch`, `port`), `nic_not_stalled`
(`node`, `rail`), `link_width` (`switch`, `port`, `value`), `sm_running`, `sm_enabled`, `ib_ports_active`
(`node`, optional `rail`).

`frontend/tests/sim-labs.test.ts` requires every lab to fail its checks before the fix and pass all of
them after replaying `fix`. A lab that does not pass this test cannot be merged.
`frontend/tests/sim-scenarios.test.ts` pins down the evidence the newer tickets rely on (sim-14 onward)
and the healthy InfiniBand baseline; add a block there when a new lab depends on a specific symptom.
