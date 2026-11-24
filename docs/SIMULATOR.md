# Fabric Simulator

The Fabric Simulator is a deterministic, in-browser model of a small rail-optimized RoCEv2 GPU cluster.
It exists so that learners can practise **reading real tool output and reasoning from evidence** without
owning a GPU cluster. Code: `frontend/src/sim/` (`fabric.ts` model, `shell.ts` commands, `lab.ts` grading).

> It is a teaching model, not an emulator. It reproduces *which* counters move, *which* tests fail and
> *roughly how much* bandwidth is lost for each fault class. Absolute numbers, counter magnitudes and
> exact output formats of real products differ by hardware generation, firmware and software version.

## What the model is, and is not

| | |
|---|---|
| **Modelled** | The topology and its configuration state (MTU, PFC, trust, switch QoS, GIDs, PCIe, NCCL settings, link state); which counters each fault class moves and in which direction; which tests fail and with what message; per-flow ECMP hashing for cross-rail traffic; subnet manager election and port state in the InfiniBand variant |
| **Approximated** | Performance: a nominal bus bandwidth per healthy rail multiplied by a fixed factor per fault class ([How performance is computed](#how-performance-is-computed)). Counter magnitudes. Switch CLI output, which follows vendor documentation and has not been compared with a switch |
| **Deterministic** | The same commands on the same lab always print the same output, and counters advance by fixed amounts each time a test runs. That is what lets the test suite replay and grade every lab |
| **Pinned to real hardware** | The format of host-tool output (line order, field names, units), compared with captures from ConnectX-5 hosts by the [golden-format tests](#golden-format-tests-simulator-vs-real-captures). The values are the model's |
| **Not a performance model** | No packets, queues or buffers are simulated. Do not read the absolute numbers as predictions for real hardware, and do not use the simulator to size or tune a fabric |

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
| NCCL | `/etc/nccl.conf` on every node: `NCCL_SOCKET_IFNAME=eno1`, `NCCL_IB_HCA=mlx5`, `NCCL_IB_GID_INDEX=3`, `NCCL_IB_TC=106`, `NCCL_IB_QPS_PER_CONNECTION=4` |

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
The free-play page (`#/simulator`) has a Fabric switch for RoCE or InfiniBand (`?fabric=ib` in a shared
link). Its InfiniBand fabric runs a second OpenSM on node02 (priority 13, standby to node01's priority 14)
so that failover can be explored: `systemctl stop opensm` on node01, `sminfo`, `sleep 60`, `sminfo`.

* **Port state.** The master SM sweeps the subnet from its own port over links that are physically up;
  every port it reaches is `Active` with a LID (switches 1-10 in the order leaf01-leaf08, spine01, spine02;
  HCA `mlx5_r` of node *n* gets `11 + 8(n-1) + r`, so node01 `mlx5_0` is LID 11 and node02 `mlx5_0` LID 19).
  In a rail-optimized fabric a leaf is reachable only through the spines (HCAs do not forward subnet
  management packets), so a leaf whose uplinks are all down cannot be configured. A configured port stays
  `Active`, with its LID and the SM LID of the last master, when the SM goes away (running traffic is
  unaffected, as verified on hardware); only a port whose link retrains (a reboot, `replace-cable`,
  `reseat-nic`, the `ib_port_reset` fault) drops back to `Initialize`/`INIT` with LID 65535 (0xFFFF,
  unassigned; as on real ConnectX hardware) and SM LID 0 until a master SM sweeps it again. `sm_down`
  stands for an SM that is down *and* a fabric that has been power-cycled since, so nothing is configured.
* **Several SMs.** `ib_sm` adds or changes OpenSM instances (node, priority, running/stopped/failed,
  enabled). The master is the running SM with the highest priority, then the lowest port GUID (IBA
  election rules); every other running SM is a standby, and `sminfo <lid>` reports it as
  `state 2 SMINFO_STANDBY` (infiniband-diags numbers the states 0 NOTACT, 1 DISCOVER, 2 STANDBY, 3 MASTER).
  When the master stops while a standby runs, no master answers for `SM_TAKEOVER_S` = 50 simulated seconds
  (measured: 53 s on two ConnectX-5 ports with DOCA OpenSM defaults; OpenSM's polling_timeout and
  polling_retry_number set it, check opensm.conf for your version), then the standby becomes master and the ports' SM LID changes to its LID. Simulated time: every
  command adds 1 s, `all_reduce_perf` 20 s, `sleep N` N seconds. Simplifications: a starting SM, and a
  returning higher-priority SM, take the master role at once (OpenSM has options that control handover);
  LIDs never change between masters (OpenSM normally keeps existing LIDs).
* **NCCL**: the IB plugin skips ports that are not ACTIVE (as NCCL's `net_ib` does); when no port is
  usable it logs `NET/IB : No device found.` and falls back to sockets. `NCCL_IB_GID_INDEX`,
  `NCCL_IB_TC` and `NCCL_IB_QPS_PER_CONNECTION` are removed from `/etc/nccl.conf` in this variant.
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
  change rail through the spines (see ECMP below; about ×0.41 with the default 4 QPs per connection,
  ×0.24 with one QP, at most ×0.485). The slowest rail paces the
  ring, as in reality.
* **Fatal conditions** fail the job with a realistic NCCL WARN: a dead link or a path MTU smaller than the
  RoCE packet (retry exceeded, `status=12`), a non-routable GID index (`ibv_modify_qp` timeout), a bad
  `NCCL_SOCKET_IFNAME` (bootstrap failure). `NCCL_IB_DISABLE=1`, or an `NCCL_IB_HCA` that matches no device, falls back to sockets over the 25GbE management NIC (~2.6 GB/s), as real NCCL does.
* **ECMP on the leaf uplinks** (cross-rail traffic only; rail-aligned traffic never leaves its leaf). With
  `NCCL_CROSS_NIC=1` each of the 2 channels per rail makes 4 inter-node hops from NIC *m* of one node to NIC
  *m+1* of the next, so each leaf sends 8 connections to one other leaf. Every connection opens
  `NCCL_IB_QPS_PER_CONNECTION` QPs (NCCL's default is 1), and every QP is one flow with a fixed UDP source
  port, derived from the two QP numbers like the Linux `rdma_flow_label_to_udp_sport()` helper (real NICs and
  firmware differ in the details). The source leaf hashes each flow's 5-tuple onto one usable uplink (static
  ECMP; one seed on every leaf). Each NIC sends 2 x QPs flows at line rate, and a link shared by *m* flows
  gives each 1/*m* of it, so the factor is 0.97 × min(2 x QPs / *m*) over every flow's leaf uplink and spine
  egress port. With one QP per connection some leaves end up 6/2 or 8/0; with 4 the worst link carries 19 of
  32 flows. `ecmp_balanced` grades the worst link's fair share / actual flows. The InfiniBand variant spreads
  flows evenly (the SM's routing balances destinations), so no hashing losses there. If no uplink path is left
  the collective fails with the retry-exceeded WARN.
* **Counters** advance deterministically every time a test runs, according to the active faults: drops,
  `out_of_sequence`, `packet_seq_err`, pause frames, ECN marks and CNPs, symbol and CRC errors, PFC
  watchdog deadlocks, spine traffic for cross-rail rings, and the InfiniBand PMA counters.
* **Pause direction** matters and is modelled: without ECN the *leaf* pauses the senders (TX PFC pause on
  the leaf, `rx_prio3_pause` on the NICs); a stuck receiver makes the *NIC* pause the leaf (`tx_prio3_pause`
  on the NIC, RX PFC pause on the leaf), which is what trips the leaf's watchdog.

## Commands

GPU nodes: `ssh`, `ip`, `ibdev2netdev`, `ibv_devices`, `ibv_devinfo`, `show_gids`, `rdma link|statistic`,
`ethtool [-S|-m|-a]`, `ethtool -A <if> rx on|off tx on|off` (global pause on clears PFC on every priority and
enabling PFC turns global pause off, as verified on mlx5), `mlnx_qos [--trust] [--pfc] [--tsa … --tcbw …]` (ETS
bandwidths must add up to 100 over the `ets` classes), `lspci [-vv -s]`, `nvidia-smi topo -m`, `dmesg`, `mlxlink [-c]`,
`ping [-c] [-s] [-M do] [-I <if>|<addr>]`, `ib_write_bw [-q N] [-D s] [-m <mtu>]`, `all_reduce_perf` (directly or via `mpirun`), `cat`, `sed -i 's/…/…/'`, `sed -i '/…/d'`,
`echo … >> /etc/nccl.conf`, with pipes to `grep`, `head`, `tail`, `wc -l`, `sort`. With
`NCCL_DEBUG=INFO`, `all_reduce_perf` also prints where the first rings enter and leave node01
(`[receive]`/`[send] via NET/IB/<n>/GDRDMA`; a rail-aligned send from a GPU that is not next to NIC *n*
goes through PXN and is logged `NET/IB/<n>(<proxy rank>)`, as in NCCL's `net.cc`), which is how crossed rails
show up. The line format follows NCCL 2.1x; newer releases append `(PCI)`/`/flush=` details.

InfiniBand variant (GPU nodes): `ibstat [-l|-p] [<ca> [<port>]]`, `ibstatus [<ca>[:<port>]]`,
`iblinkinfo [-C <ca>] [--switches-only|--cas-only|-d]` (`-C` starts the directed-route walk from that HCA),
`perfquery [-x] [-r] [-C <ca>] [<lid> [<port>]]`, `sminfo [-C <ca>] [<sm_lid>]`, `sleep <seconds>`,
`ibqueryerrors [-s <Counter,...>] [-c]`, `systemctl status|start|stop|restart|enable [--now]|disable|
is-active|is-enabled opensm` (on every node that has an SM instance), plus `ibv_devinfo`, `ibdev2netdev`, `rdma link|statistic`, `ib_write_bw`,
`all_reduce_perf`, `lspci`, `nvidia-smi topo -m`. `ibdiagnet` (NVIDIA proprietary) and `ibnetdiscover` are
not modelled.

Output formats follow the rdma-core sources: `ibstat` (`infiniband-diags/ibstat.c`: State
`Initializing`/`Active`, Rate, Base lid, SM lid, Capability mask), `ibstatus` (the sysfs-reading
script: `2: INIT`, `4: ACTIVE`, `400 Gb/sec (4X NDR)`), `iblinkinfo` (`iblinkinfo.c` `print_port`: the
`( 4X        106.25 Gbps Active/  LinkUp)` link string and the `Could be 4X` width message from
`get_max_msg`), `perfquery` (libibmad `mad_dump_perfcounters` field order and dot padding, saturating
widths), `sminfo` (`sm lid … priority P state 3 SMINFO_MASTER` or `state 2 SMINFO_STANDBY`, and
`sminfo: iberror: failed: query`; an SM LID that no running SM answers fails with `dport (Lid N)`), and
`ibqueryerrors` (`Errors for …`, `[Counter == n]`, `## Summary` lines, and `## Thresholds: ` with nothing
after it, as with the packaged `error_thresholds` file whose entries are all commented out, so any non-zero
counter, PortXmitWait included, is reported). perftest's
`Port number 1 state is Init` / `Couldn't set the link layer` comes from `perftest_parameters.c`.
Simplifications: unused switch ports are not listed by `iblinkinfo`; `ibqueryerrors` ignores
`--threshold-file` (thresholds are always 0) and does not check unused switch ports, and it summarises PMA query failures instead of printing each
`ibwarn` line; when no SM runs, `sminfo` and `perfquery` fail with a single `iberror` line (the exact
`ibwarn` lines before it vary by version); `systemctl` unit text, capability masks and CapMask values
are illustrative. `sminfo` to a LID where no SM runs is modelled as a timeout (the reply of a real port
may differ by firmware), and an unconfigured switch shows LID 0 in `iblinkinfo`.

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
restores full width on both ends of the link, which retrains; IB port numbers work too, e.g. `replace-cable leaf03 3`), `reseat-nic <node> <dev>`
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
`switch_down` (`switch`: powered off; every link on it is down and SSH gets `No route to host`),
and for the InfiniBand variant `ib_fabric` (must be the first entry), `sm_down` (`enabled`: whether the
opensm units stay enabled; also clears every port's configuration, as after a power cycle), `ib_sm`
(`node`, optional `rail` (0), `priority`, `state: running|stopped|failed`, `enabled`: adds or changes an
OpenSM instance), `ib_port_reset` (`switch`, or `node`+`rail`: those links retrained, e.g. a reboot; their
ports wait in INIT for an SM) and `ib_counters` (`switch`+`port` or `node`+`rail`, `counters: {Name: n}`:
pre-existing counter history, useful for red herrings).
`node: all` applies a host fault to every node.

Checks: `allreduce_min_busbw`, `ib_write_bw_min`, `port_mtu_min`, `port_up`, `link_clean`, `host_mtu`,
`host_pfc_only`, `host_trust`, `nic_up`, `pcie_ok`, `switch_roce`, `no_pending`, `nccl_conf`,
`nccl_conf_absent`, `nccl_conf_not` (`key`, `value`: the key is absent or has another value),
`nccl_conf_min` (`key`, `value`, optional `default`: numeric value at least `value`), `ecmp_balanced`
(`value`: cross-rail flows spread so that the worst link's fair share / flows is at least `value`; 1 when
nothing crosses the spines),
`nccl_hca_all`, `switch_ecn_on` (`switch`, `tc`), `pfcwd_on` (`switch`, `port`), `nic_not_stalled`
(`node`, `rail`), `link_width` (`switch`, `port`, `value`), `sm_running` (any SM runs),
`sm_enabled` (optional `node`; without it every SM instance), `sm_count` (`value`: running SMs),
`sm_master` (`node`), `ib_switch_reachable` (`switch`: the master SM's sweep reaches it), `ib_ports_active`
(`node`, optional `rail`).

## Golden-format tests (simulator vs real captures)

`frontend/tests/sim-golden.test.ts` runs a simulator command next to the real output of the same tool and requires
both to have the same *line skeleton*. The captures are in `frontend/tests/fixtures/real/<stack>/<cmd>.txt` (two
ConnectX-5 hosts, DOCA-OFED and inbox stacks, RoCE and InfiniBand with and without an SM; provenance in the README
there). Hand-written regex pins for a few details remain in `frontend/tests/sim-real-format.test.ts`.

* **Masking** (`mask()`): dates, GIDs (colon-hex groups and perftest's 16 decimal bytes), `0x` hex and bare GUIDs,
  IPv4 addresses, RDMA device names (`mlx5_N`, `rocep…`), netdev names (`en…npN`, `ib[ps]…`), host names, board IDs
  (`MT_…`), CA types (`MTxxxx`) and every remaining number become placeholders. Tabs and single spaces are kept, runs
  of two or more spaces become two, and padding between a value and a tab is dropped (its width depends on the value).
  Field names, their order, separators, headers, footers, blank lines and trailing spaces are compared exactly.
* **Modes**: `exact` (default) compares line by line; `subset` (counter lists such as `rdma statistic`) requires every
  simulated line to appear in the capture in the same order, because the simulator models fewer counters;
  `collapse` folds a block repeated per device or GID to one copy, so 2 real devices compare with 8 simulated ones;
  `pick` selects the comparable part of the simulated output (the first CA blocks of `iblinkinfo`, one `rdma link`
  line); `setup` runs commands first (for example `mlnx_qos --trust pcp` and `ethtool -A … rx on tx on` to recreate
  the factory state of the "default" captures).
* **Intentional differences** go in the case's `allow` list as `{ re, to, why }`: `re` is replaced by `to` in both
  masked outputs. Keep the list short and specific: today it covers 400G vs 100G names (`Speed`, `(Ext.)` speed
  labels in `mlxlink`, `NDR` vs `EDR` in `ibstatus`), the back-to-back peer in `iblinkinfo` (a leaf switch in the
  simulator) and the unmodelled `(3.000)` suffix of `ibqueryerrors`. A test fails if an entry matches nothing, if a
  fixture is not used by any case, or if a fixture contains a serial number. Not compared at all, because the
  simulator does not model them: the perftest server side, umad tools on a host whose first device is RoCE
  (`Failed to open '(null)' port '0'`), `mlxlink -m`, and `ib_write_bw -D` iteration counts (real runs counted fewer
  iterations than duration × message rate).
* **Adding a capture**: save the raw output (stdout and stderr) as `### cmd: <command>`, `### ----`, the output,
  `### rc=<exit status>`; remove serial numbers (or leave such commands out); add a `CASES` entry with the
  equivalent simulator command; run `npx vitest run tests/sim-golden.test.ts`. A mismatch prints the first differing
  masked line of both sides: fix the simulator, or add an `allow` entry with its reason if the difference is
  intended. Then note the verified format in `docs/HARDWARE_VERIFICATION.md`.

`frontend/tests/sim-labs.test.ts` requires every lab to fail its checks before the fix and pass all of
them after replaying `fix`. A lab that does not pass this test cannot be merged.
`frontend/tests/sim-scenarios.test.ts` pins down the evidence the newer tickets rely on (sim-14 onward),
the healthy InfiniBand baseline, the ECMP model and the SM election and failover model; add a block there when a new lab depends on a specific symptom.
