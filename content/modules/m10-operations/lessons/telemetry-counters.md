---
id: telemetry-counters
title: "Counters that matter: NIC, RDMA, InfiniBand, switch and GPU"
module: m10-operations
level: 4
estimated_minutes: 60
objectives:
  - Name the NIC, RDMA, InfiniBand, switch and GPU counters that reveal loss, pause, congestion and link health in an AI fabric.
  - Read ethtool -S, RDMA hw_counters and perfquery output and turn raw values into rates and ratios.
  - Distinguish counters that indicate a healthy lossless fabric doing its job from counters that indicate a fault.
  - Map a symptom to the counter that proves or disproves it, and to the next command to run.
prerequisites: [rdma-on-linux, ib-tools-diagnostics, pfc-priority-flow-control, ecn-and-dcqcn]
quiz: quiz-telemetry-counters
widgets: [pfc-ecn-sim]
labs: []
tags: [telemetry, counters, ethtool, perfquery, dcgm, wjh, operations]
further_reading:
  - title: rdma-statistic(8) man page (iproute2)
    url: https://man7.org/linux/man-pages/man8/rdma-statistic.8.html
  - title: Linux kernel documentation - mlx5 counters (Documentation/networking/device_drivers/ethernet/mellanox/mlx5)
    url: https://docs.kernel.org/networking/device_drivers/ethernet/mellanox/mlx5/counters.html
  - title: NVIDIA DCGM User Guide - Field identifiers and diagnostics
    url: https://docs.nvidia.com/datacenter/dcgm/latest/user-guide/index.html
  - title: InfiniBand Architecture Specification (IBTA) - Performance Management
    url: https://www.infinibandta.org/ibta-specification/
---

## Why this matters

An AI training job does not fail loudly when the network is unhealthy. It slows down. A 2,048-GPU job whose all-reduce has dropped from 380 GB/s to 290 GB/s bus bandwidth still finishes its step, still writes checkpoints, and still looks "green" on a ping-based dashboard. What it is actually doing is burning roughly a quarter of a very expensive cluster on waiting. The only way to see that waste, and to locate it, is through counters: the hardware registers that every NIC, HCA, switch ASIC and GPU keep for packets, bytes, pauses, drops, retransmissions and errors.

The difficulty is not getting counters. A ConnectX NIC exposes hundreds of them, a Spectrum or Quantum switch thousands, and a GPU hundreds more through DCGM. The difficulty is knowing which twenty matter, what "normal" looks like for each, and which ones are only meaningful as a rate or a ratio. This lesson is the curated list an experienced AI fabric SRE carries in their head, organised by layer, with the reasoning that turns a number into a diagnosis.

## Concepts

### Counters are cumulative; you must differentiate

Almost every hardware counter is a monotonically increasing integer since the last driver load, port reset or counter clear. A value of `rx_prio3_pause: 18,442,019` tells you nothing on its own: it may be three years of perfectly normal operation. What matters is:

- **Delta over an interval** (per second, per minute, per training step).
- **Ratio to a denominator**: discards per million packets received, pause time as a fraction of wall-clock time, CNPs per gigabyte transferred.
- **Comparison across peers**: in a rail-optimized fabric, all 8 NICs of a node and all nodes in a rail should look nearly identical. The outlier is the finding.

> [!TIP]
> When triaging by hand, take two snapshots 10 seconds apart and diff them. Fleet-wide, let Prometheus do it with `rate()` or `increase()`, and alert on the rate, never on the absolute value.

### Four questions every counter answers

Group counters by the question they answer, not by the tool that prints them:

| Question | Ethernet / RoCE host | InfiniBand host / switch | Switch (Ethernet) | GPU |
|---|---|---|---|---|
| Is the link physically healthy? | symbol / FEC / CRC counters, `link_down_events_phy` | `SymbolErrorCounter`, `LinkErrorRecoveryCounter`, `LinkDownedCounter`, `PortRcvErrors` | interface errors, FEC corrected/uncorrected, flaps | PCIe replay counters, XID errors |
| Is anything being dropped? | `rx_discards_phy`, `rx_out_of_buffer` | `PortXmitDiscards`, `PortRcvErrors` | per-queue drops, WJH drop reasons | n/a |
| Is the lossless machinery working hard? | `rx/tx_prioN_pause`, pause duration, CNP counters | `PortXmitWait` (credit starvation) | PFC rx/tx per priority, ECN-marked packets, buffer occupancy | n/a |
| Is the transport recovering from loss? | `out_of_sequence`, `packet_seq_err`, `local_ack_timeout_err` | same RDMA counters on the HCA | n/a | NCCL-level timing, throughput fields |

The column that surprises newcomers is the third. In a lossless RoCE fabric, **some** PFC pauses and **some** CNPs are expected: they are the congestion control system doing its job. Zero is not the goal. A sudden step change, a single outlier port, or pauses that propagate upstream across several hops are the warning signs.

### Healthy-busy versus broken

A useful mental model for the lossless counters:

| Pattern | Interpretation |
|---|---|
| ECN marks and CNPs rising with traffic, few PFC pauses, no drops | Healthy: DCQCN is handling congestion end-to-end before PFC needs to act. |
| PFC pauses rising, CNPs near zero | ECN marking is disabled, mis-thresholded, or CNPs are not getting through (wrong priority, filtered). PFC is doing all the work. |
| Pauses received on a host NIC with no matching congestion at its own leaf | Pause propagating from deeper in the fabric (head-of-line blocking or a slow receiver elsewhere). |
| `tx_prioN_pause` from a host NIC | The host itself cannot drain its receive buffer fast enough (PCIe, host memory, receive WQE starvation). |
| Drops on the RoCE priority | The "lossless" class is not lossless: PFC disabled, wrong priority mapped, or headroom too small. |
| `out_of_sequence` / `packet_seq_err` rising | Packets lost somewhere (or reordered); the RC transport is retransmitting. |

> [!ANALOGY]
> Think of SNMP interface counters on a WAN router: `ifInErrors` creeping up on one circuit is the first hint of a bad line card or fibre long before customers complain. AI fabric counters play the same role, but the tolerances are far tighter. A WAN link with 0.01 % loss is "fine"; a RoCE fabric with 0.01 % loss on the RDMA class can halve collective throughput because go-back-N retransmission of large messages is expensive. The analogy also breaks on pause counters: there is no enterprise equivalent of "back-pressure that is good in moderation".

## How it works

### Host NIC counters (mlx5 / ConnectX, Ethernet mode)

`ethtool -S <netdev>` on a ConnectX port prints driver, vport and physical port (`_phy`) counters. The `_phy` suffix means "counted by the physical port hardware", which is the closest to the wire and includes traffic the kernel never sees, such as RoCE. Counter sets differ between ConnectX generations and driver releases, so always confirm names against the mlx5 counters documentation for your version. The ones that matter most:

| Counter (mlx5, verify for your version) | Meaning | Healthy expectation |
|---|---|---|
| `rx_prio3_pause` / `tx_prio3_pause` | PFC pause frames received / sent on priority 3 (substitute your RoCE priority) | Low, steady rate under load; no outlier ports |
| `rx_prio3_pause_duration` / `tx_prio3_pause_duration` | Time spent paused (units are documented per driver; treat as relative) | Small fraction of interval |
| `rx_prio3_bytes` / `rx_prio3_packets` | Traffic received on that priority | Should carry essentially all RoCE traffic; if it is on prio 0 instead, mapping is wrong |
| `rx_discards_phy` | Packets dropped by the port because of lack of buffer at the physical level | Zero on a lossless priority |
| `rx_out_of_buffer` | Packets dropped because no receive descriptor (WQE) was available on the host side (kernel netdev queues) | Zero or near zero |
| `rx_crc_errors_phy`, `rx_symbol_err_phy` | Physical-layer corruption | Zero after FEC on a healthy link |
| `rx_corrected_bits_phy` | Bits corrected by FEC | Non-zero is normal on PAM4 links; trend matters |
| `link_down_events_phy` | Number of times the link went down | Constant |
| `tx_pause_storm_warning_events` / `tx_pause_storm_error_events` | Device detected it was sending pause continuously (PFC storm prevention) | Zero |

`rx_out_of_buffer` and `rx_discards_phy` are often confused. The first is a host-side receive-queue starvation drop (software did not post buffers fast enough); the second is the physical port running out of its internal buffer. Neither should ever count on the RDMA priority in a correctly configured lossless setup.

### RDMA hardware counters (per port)

RDMA traffic bypasses the kernel network stack, so most transport-level events appear in a separate counter tree: `/sys/class/infiniband/<dev>/ports/<port>/hw_counters/`. The same values are reachable with `rdma statistic show` (iproute2). Names below are those used by recent mlx5 drivers; the set varies by firmware and kernel, so check the mlx5 RDMA counters documentation before building alerts on any one name.

| Counter | Meaning | Interpretation |
|---|---|---|
| `np_ecn_marked_roce_packets` | RoCE packets received with ECN CE set (this node as Notification Point) | Congestion seen on the path towards this receiver |
| `np_cnp_sent` | CNPs this node sent back to senders | Should track `np_ecn_marked_roce_packets` (CNP generation is rate-limited) |
| `rp_cnp_handled` | CNPs received and acted on by this node as Reaction Point | Senders are being told to slow down; DCQCN active |
| `rp_cnp_ignored` | CNPs received but ignored | Non-zero suggests congestion control disabled or misconfigured on this priority |
| `out_of_sequence` | Packets received out of expected PSN order | Loss or reordering upstream |
| `packet_seq_err` | NAKs for sequence errors received | Remote side detected missing packets from us |
| `local_ack_timeout_err` | Local ACK timeouts (retransmission due to no ACK) | Silent loss, or a remote node not responding |
| `implied_nak_seq_err` | Read-response sequence gaps | Loss on RDMA READ paths |
| `duplicate_request` | Retransmitted requests received | The sender retransmitted something we already got |
| `rnr_nak_retry_err` | Receiver-not-ready retries exhausted | Application not posting receives fast enough |
| `out_of_buffer` | Drops due to lack of receive WQEs on RDMA QPs | Application/library receive starvation |

> [!NOTE]
> A CNP-to-ECN-mark ratio well below 1 is normal because the NIC rate-limits CNP generation per flow. Compare ratios across nodes, not to an ideal of 1.0.

### InfiniBand port counters

InfiniBand defines its counters in the IBTA PortCounters and PortCountersExtended attributes, which the Subnet Manager or any management host can read remotely with `perfquery` (infiniband-diags). Because IB is credit-based, there are no pauses and no ECN marks in the Ethernet sense; congestion shows up as **wait**.

| Counter | Meaning | Note |
|---|---|---|
| `PortXmitWait` | Ticks during which the port had data to send but no credits | The IB congestion indicator; compare across ports |
| `PortXmitData` / `PortRcvData` | Data in units of 4 octets (32-bit words) | Multiply by 4 for bytes |
| `SymbolErrorCounter` | Minor physical-layer symbol errors | Small counts after a link-up can be normal; steady increase is not |
| `LinkErrorRecoveryCounter` | Successful link retraining events | Any increment during operation deserves a look |
| `LinkDownedCounter` | Link failed to recover and went down | Increments correlate with job failures |
| `PortRcvErrors` | Received packets with errors (CRC, malformed) | Check the cable / neighbour |
| `PortRcvRemotePhysicalErrors` | Packets marked bad by an upstream link (EBP) | Error originated one hop earlier |
| `PortXmitDiscards` | Packets discarded on transmit (timeouts, port down) | Often head-of-line or routing issues |
| `ExcessiveBufferOverrunErrors`, `LocalLinkIntegrityErrors` | Buffer overrun / link integrity threshold exceeded | Usually physical or misconfigured VL buffers |

The legacy (non-extended) counters are narrow (for example `SymbolErrorCounter` is 16 bits and some are 8 bits) and saturate instead of wrapping, so a counter "stuck at maximum" means "a lot, at some point". Use extended counters (`perfquery -x`) for data counters, and clear error counters after remediation so new increments are visible.

### Switch counters

On the switch side the vocabulary changes slightly but the questions are the same. Per port and per priority or traffic class you want:

- **PFC frames received and transmitted per priority.** A switch port transmitting many pauses towards a host means the switch's ingress buffer for that port is filling: the downstream (egress) side is congested.
- **ECN-marked packets per egress queue.** The healthy congestion signal.
- **Buffer occupancy / watermarks per queue and per pool.** Peak occupancy since last read is more useful than an instantaneous sample.
- **Drops per queue, with reason.** On NVIDIA Spectrum switches, **What Just Happened (WJH)** reports dropped packets together with a reason (for example buffer drop, ACL drop, routing drop, link down) and packet headers, which turns "something dropped" into "this flow was dropped by this ACL". Availability and the CLI to query it depend on the NOS and release (Cumulus Linux/NVUE, SONiC, NetQ integration); check your NOS documentation.
- **Link errors and FEC statistics** as on the host.

### GPU-side counters with DCGM

A collective is only as fast as its slowest participant, and sometimes that participant is a GPU, not a link. NVIDIA DCGM (Data Center GPU Manager) exposes per-GPU fields that you correlate with network counters. Commonly used fields (confirm identifiers in the DCGM field reference for your version):

- PCIe and NVLink throughput (`DCGM_FI_PROF_PCIE_TX_BYTES`, `DCGM_FI_PROF_PCIE_RX_BYTES`, `DCGM_FI_PROF_NVLINK_TX_BYTES`, `DCGM_FI_PROF_NVLINK_RX_BYTES`).
- Clock event / throttle reasons (thermal or power slowdown), SM clock and temperature.
- XID errors (`DCGM_FI_DEV_XID_ERRORS`), ECC errors, PCIe replay counter.

`dcgm-exporter` publishes these to Prometheus, which is how most clusters put GPU and network data on the same Grafana panel.

## In practice

### Snapshotting and diffing NIC counters

Take two snapshots and diff only the counters that changed:

```bash
DEV=eth2   # netdev of the RoCE port; map with: rdma link show / ibdev2netdev
ethtool -S $DEV > /tmp/c1; sleep 10; ethtool -S $DEV > /tmp/c2
paste /tmp/c1 /tmp/c2 | awk '$2 != $4 {printf "%-40s %15d\n", $1, $4-$2}'
```

Illustrative output during an all-reduce on a RoCE port with priority 3 as the lossless class:

```text
rx_prio3_bytes:                         243516270592   # ~24 GB/s received on prio 3 = ~195 Gb/s, matches the expected rate
tx_prio3_bytes:                         244011935744
rx_prio3_pause:                                 1832   # pauses received from the leaf: modest, check vs peers
rx_prio3_pause_duration:                        5120   # relative; compare with other NICs in the same rail
tx_prio3_pause:                                    0   # this host is never the bottleneck: good
rx_discards_phy:                                   0   # good
rx_corrected_bits_phy:                           412   # FEC is working; normal on PAM4 links
```

Interpretation: the NIC receives some pauses from its leaf (congestion somewhere downstream), sends none, drops nothing. On its own this is healthy-busy. The next step is to compare with the other NICs in the same rail; if this NIC receives 20 times more pauses than its peers, follow the pause upstream.

### RDMA hw_counters

```bash
grep -H . /sys/class/infiniband/mlx5_0/ports/1/hw_counters/{np_cnp_sent,np_ecn_marked_roce_packets,rp_cnp_handled,out_of_sequence,packet_seq_err,local_ack_timeout_err} 2>/dev/null
# or, with iproute2:
rdma statistic show link mlx5_0/1
```

Illustrative output (deltas over 60 s on two nodes in the same job):

```text
                         node-a17   node-b04
np_ecn_marked_roce_packets  91,204     88,950   # both see similar congestion: fabric-level incast, expected
np_cnp_sent                 22,310     21,877
rp_cnp_handled              23,002     22,409   # DCQCN active on both
out_of_sequence                  0     14,822   # node-b04 is receiving with gaps: loss on its path
packet_seq_err                   0      3,117
local_ack_timeout_err            0        210   # retransmissions after timeouts: costly
```

`node-b04` is the finding. Congestion signals are the same on both nodes, so congestion control is not the difference; loss is. The next commands are its NIC's physical counters (`rx_discards_phy`, symbol and CRC errors), its leaf port counters, and WJH on that leaf if available.

### InfiniBand: perfquery

```bash
perfquery -x <lid> <port>    # extended (64-bit) counters
perfquery <lid> <port>       # error counters
ibqueryerrors                # sweep all ports for counters above thresholds
```

Illustrative output for one switch port:

```text
# Port counters: Lid 412 port 17
SymbolErrorCounter:..............1876     # rising every poll: physical problem
LinkErrorRecoveryCounter:........3        # link retrained 3 times
LinkDownedCounter:...............0
PortRcvErrors:...................244      # corrupted packets arriving
PortRcvRemotePhysicalErrors:.....0
PortXmitDiscards:................0
PortXmitWait:....................1029331  # wait ticks; compare with sibling ports
```

A rising `SymbolErrorCounter` with `PortRcvErrors` on one port, and clean neighbours, points at that cable, transceiver or the far-end port. Swap the transceiver or cable, clear counters, and verify they stay at zero under load.

### Decision table: symptom to counter to fix

| Symptom | Likely cause | Evidence command | Fix |
|---|---|---|---|
| Collective bandwidth low on one node only | Loss on that node's path | RDMA `out_of_sequence`, `packet_seq_err` on that node; `rx_discards_phy` | Find the dropping hop (switch drops / WJH); fix PFC or the link |
| `tx_prioN_pause` high from a host | Host cannot drain receive traffic | `ethtool -S` tx pause, PCIe link status (`lspci -vv`), `rx_out_of_buffer` | Fix PCIe downtraining, NUMA placement, or receiver starvation |
| PFC pauses rising, CNPs zero | ECN not marking or CNPs blocked | Switch ECN-marked counter, `np_cnp_sent`, `rp_cnp_handled` | Enable ECN on the RoCE queue; carry CNPs on their configured priority |
| Drops counted on the RoCE priority | PFC not enabled for that priority / trust mismatch | `rx_prioN_pause` both directions zero, drops non-zero; switch PFC config | Align PFC priority and DSCP/PCP trust end-to-end |
| IB job slow, one port high `PortXmitWait` | Congested or slow downstream link | `perfquery` on that port and its egress neighbours | Rebalance routing, find the slow receiver or degraded link |
| Rising `SymbolErrorCounter`, `PortRcvErrors` | Bad cable, optic or port | `perfquery`, `mlxlink` BER | Reseat/replace optic or cable; check BER after |
| Throughput dips with GPU clock drops | Thermal or power throttling | DCGM clock event reasons, temperature | Fix cooling/power capping; drain node |

```widget
pfc-ecn-sim
```

Use the simulator to watch how the same congestion event looks in counters: with ECN thresholds below the PFC XOFF threshold, marks (and CNPs) rise first and pauses stay rare; push the ECN threshold above XOFF and the pause counter takes over.

> [!INTERVIEW]
> "Your dashboard shows PFC pause frames on every leaf. Is the fabric broken?" A strong answer: not necessarily. Pauses are expected in moderation under incast. I would look at the rate and the distribution: are pauses concentrated on a few ports, are they propagating to spines, and are ECN marks and CNPs rising with them? If CNPs are near zero while pauses rise, ECN is not working and PFC is doing congestion control by itself, which risks head-of-line blocking and spreading. I would also check for drops on the lossless priority and transport counters like `out_of_sequence`, because those show real harm to jobs.

## Common pitfalls

- **Alerting on absolute values.** Symptom: an alert fires on every node forever. Cause: cumulative counter compared to a threshold. Fix: alert on `rate()` or `increase()` over a window, and on deviation from peers.
- **Reading pause counters on the wrong priority.** Symptom: "no pauses anywhere" while drops occur. Cause: RoCE traffic is classified onto a different priority than the one being checked (or than PFC is enabled on). Fix: confirm which `rx_prioN_bytes` actually carries the RoCE traffic before reasoning about pauses.
- **Confusing `rx_out_of_buffer` with fabric drops.** Symptom: chasing switches for drops that occur inside the host. Cause: `rx_out_of_buffer` counts host receive-queue starvation. Fix: look at host CPU, interrupt affinity and receive queue sizing for netdev traffic; for RDMA look at `out_of_buffer` in hw_counters and the application's receive posting.
- **Ignoring saturated IB counters.** Symptom: `SymbolErrorCounter` reads 65535 and never changes. Cause: legacy 16-bit counter saturated. Fix: clear counters (`perfquery -R` resets, or let your management tool reset) and re-measure the increment rate.
- **Expecting FEC-corrected counts to be zero.** Symptom: optics replaced unnecessarily. Cause: PAM4 links always correct some bits. Fix: alert on uncorrectable errors and on pre-FEC BER crossing the vendor threshold, not on corrected bits alone.
- **Looking at the network in isolation.** Symptom: hours spent on a "slow node" with clean network counters. Cause: GPU throttling or PCIe downtraining. Fix: put DCGM fields and NIC counters on the same dashboard keyed by host and GPU index.
- **Assuming counter names are universal.** Symptom: an alert silently matches nothing after a driver upgrade. Cause: counters renamed or added per release. Fix: test alert rules against each driver/firmware version in staging and alert on "metric absent".

## Key takeaways

- Counters are cumulative: always work with deltas, rates, ratios and peer comparisons.
- Group counters by question: link health, drops, lossless machinery effort, and transport recovery.
- Some PFC pauses and CNPs are healthy; drops or sequence errors on the lossless class never are.
- RDMA transport events live in `/sys/class/infiniband/<dev>/ports/<p>/hw_counters` (or `rdma statistic`), not in the kernel netdev counters; names vary by version, so check the mlx5 documentation.
- On InfiniBand, `PortXmitWait` is the congestion signal and symbol / receive errors are the physical signal; use `perfquery -x` and clear counters after fixes.
- Switch-side PFC, ECN, buffer watermarks and drop reasons (WJH on Spectrum) locate the hop; DCGM fields rule GPU problems in or out.
