---
id: ib-tools-diagnostics
title: "InfiniBand tools and diagnostics: from ibstat to ibdiagnet"
module: m05-infiniband
level: 3
estimated_minutes: 55
objectives:
  - Choose the right infiniband-diags tool for host, link, path, fabric and Subnet Manager questions.
  - Discover and verify topology with ibnetdiscover, ibhosts, ibswitches and iblinkinfo, and trace a path with ibtracert.
  - Read InfiniBand port counters with perfquery and ibqueryerrors, and map each important counter to its likely cause.
  - Localise the faulty link using the PortRcvErrors versus PortRcvRemotePhysicalErrors pattern.
  - Run a structured, bottom-up troubleshooting workflow that ends in a fabric-wide ibdiagnet check.
prerequisites: [subnet-manager-routing, ib-flow-control-vls, perftest-benchmarking]
quiz: quiz-ib-tools-diagnostics
widgets: [ib-tools-map]
labs: []
tags: [infiniband, diagnostics, infiniband-diags, perfquery, ibdiagnet, iblinkinfo, counters, troubleshooting]
further_reading:
  - title: "infiniband-diags tools and man pages (rdma-core)"
    url: https://github.com/linux-rdma/rdma-core/tree/master/infiniband-diags
  - title: InfiniBand Trade Association - InfiniBand Architecture Specification (PortCounters attribute)
    url: https://www.infinibandta.org/ibta-specification/
  - title: NVIDIA networking documentation (ibdiagnet, UFM and MFT user manuals)
    url: https://docs.nvidia.com/networking/
  - title: "OpenSM (logs and configuration reference, GitHub)"
    url: https://github.com/linux-rdma/opensm
---

## Why this matters

When a 2,000-GPU job slows down by 20 %, there are tens of thousands of InfiniBand ports that could be responsible. Guessing — reseating random cables, rebooting switches — wastes hours of a very expensive cluster. InfiniBand has a major advantage over most networks here: every device has a built-in management and performance agent, so from *any* host on the fabric you can discover the whole topology, read every port's counters and trace any path, without logging into a single switch.

This lesson turns the tools you met in earlier lessons into a systematic workflow. The goal is to go from "something is slow" to "port 33 on leaf07 has a failing cable" with evidence, and to know which counters mean "broken", which mean "congested", and which mean "misconfigured".

## Concepts

### The toolbox by question

| Question | Tools | Package |
|---|---|---|
| Is my HCA port up, what speed, what LID? | `ibstat`, `ibstatus`, `ibv_devinfo` | infiniband-diags, rdma-core |
| Which SM is master? | `sminfo` | infiniband-diags |
| What does the fabric look like? | `ibnetdiscover`, `ibhosts`, `ibswitches` | infiniband-diags |
| Are all links at the right speed and width? | `iblinkinfo` | infiniband-diags |
| Can I reach a port at the IB level? | `ibping` (with a server started by `ibping -S`) | infiniband-diags |
| Which path does traffic take? | `ibtracert`, `ibroute`, `dump_fts` | infiniband-diags |
| What are the counters on a port? | `perfquery` | infiniband-diags |
| Which ports in the fabric have errors? | `ibqueryerrors` | infiniband-diags |
| Raw SM attributes (PortInfo, NodeInfo, SL2VL...) | `smpquery` | infiniband-diags |
| Query or change a port's state, speed, width | `ibportstate` | infiniband-diags |
| SA records (path records, nodes, multicast) | `saquery` | infiniband-diags |
| Fabric-wide health check and report | `ibdiagnet` | NVIDIA (ibutils2, shipped with the NVIDIA OFED/DOCA stack and UFM) |
| PHY detail: BER, FEC, module info | `mlxlink`, `mlxcables` | NVIDIA MFT |
| Central monitoring, telemetry, alerts | NVIDIA UFM | NVIDIA |

Most of these tools send MADs from the local HCA (they need access to `/dev/infiniband/umad*`, usually root). They address remote ports by **LID** by default; many accept a GUID with `-G` or a directed route with `-D` for ports that have no LID yet. Check each tool's man page for the exact options in your version.

> [!VERIFIED]
> **Without `-C`/`-P` the umad tools open the first RDMA device, which on a mixed RoCE + InfiniBand host is the wrong one.** On a ConnectX-5 (fw 16.29, DOCA-OFED 3.4) with port 1 as RoCE (`mlx5_0`) and port 2 as InfiniBand (`mlx5_1`), a bare `sudo sminfo` or `sudo perfquery` printed `ibwarn: [pid] mad_rpc_open_port2: client_register for mgmt 1 failed` and `iberror: failed: Failed to open '(null)' port '0'` (exit 255); bare `iblinkinfo` printed `Failed to open (null) port 0`. Naming the IB port fixed every tool: `sminfo -C mlx5_1 -P 1`, `perfquery -C mlx5_1 -P 1`, and `ibdiagnet -i mlx5_1 -p 1` for ibdiagnet. `ibstat -l` lists every CA name, the RoCE ones included, so use it to find the right one.

Pick a symptom or a tool in the map below to see what the tool reads, how far into the subnet it reaches and through which management interface; then turn the Subnet Manager off to see which tools still answer.

```widget
ib-tools-map
```

### Counters: errors, congestion, and traffic

The **PortCounters** attribute (served by each port's PMA) is the foundation of InfiniBand diagnostics. The classic counters are small (many are 8 or 16 bits and saturate rather than wrap); **extended counters** (`perfquery -x`) provide 64-bit data and packet counters.

| Counter | Meaning | Usual cause |
|---|---|---|
| `SymbolErrorCounter` | Minor physical errors detected on the link | Signal integrity: dirty or damaged cable/optic, marginal module. On FEC links, interpret per vendor documentation (what counts as a symbol error after FEC is implementation-specific) |
| `LinkErrorRecoveryCounter` | Link went through error recovery (retrained) successfully | Marginal physical link |
| `LinkDownedCounter` | Link failed recovery and went down | Failing cable/optic, reseat, reboot of the peer |
| `PortRcvErrors` | Packets received with errors (bad CRC, malformed) on *this* link | Physical problem on the link into this port |
| `PortRcvRemotePhysicalErrors` | Packets received already marked bad by an upstream hop | The error occurred on an earlier link (cut-through forwarding) |
| `PortRcvSwitchRelayErrors` | Packets a switch could not forward | Routing problems: DLID not in the LFT, invalid VL mapping, packets to a non-existent destination |
| `PortXmitDiscards` | Outbound packets discarded | Port down, or packets that waited too long (head-of-queue lifetime) under severe congestion |
| `PortRcvConstraintErrors` / `PortXmitConstraintErrors` | Packets dropped by partition or filtering enforcement | P_Key mismatch, partition misconfiguration |
| `LocalLinkIntegrityErrors` | Local physical error threshold exceeded | Physical link quality |
| `ExcessiveBufferOverrunErrors` | Receive buffer overrun events | Should not happen with correct credit flow; suggests a flow-control or link problem |
| `VL15Dropped` | Management packets dropped | Management overload or resource exhaustion; usually low priority |
| `PortXmitWait` | Time spent with data to send but no credits | **Congestion** downstream, not an error |
| `PortXmitData` / `PortRcvData` | Data in units of 4 bytes (multiply by 4 for bytes) | Traffic volume |

Three categories to keep in your head:

- **Physical**: SymbolError, LinkErrorRecovery, LinkDowned, PortRcvErrors, LocalLinkIntegrity.
- **Configuration**: SwitchRelay, Constraint errors.
- **Congestion**: PortXmitWait, and in extreme cases PortXmitDiscards.

> [!ANALOGY]
> This is the InfiniBand equivalent of reading `show interface` counters on routers — CRC and input errors for physical problems, output drops for congestion — with one big difference: you can read every port in the fabric from one host over the fabric itself, without SNMP, SSH or switch credentials. The flip side is that if the fabric's management path is broken (for example the SM is down and ports have no LIDs), many tools need directed-route addressing to reach anything.

## How it works

### Localising a bad link: local versus remote physical errors

InfiniBand switches forward cut-through: a switch starts sending a packet before it has received all of it. If a packet is corrupted on link A and the error is detected only once the tail arrives, the switch has already started forwarding it on link B. It then marks the packet as bad (an "end bad packet" delimiter), and downstream ports count it as a **remote** physical error rather than a local one.

```mermaid
flowchart LR
    H1["node01 HCA"] -->|"link A: dirty optic"| L1["leaf03 port 7: PortRcvErrors (culprit link)"]
    L1 --> S1["spine02 port 3: RemotePhysicalErrors (victim)"]
    S1 --> L2["leaf09 port 40: RemotePhysicalErrors (victim)"]
    L2 --> H2["node77 HCA"]
```

Rule: **the faulty link is the one into the port where `PortRcvErrors` (and usually `SymbolErrorCounter`) increases**; ports further downstream that show only `PortRcvRemotePhysicalErrors` are victims, not culprits. Replace the cable or optic on link A, not the spine.

### Rates, not totals

Counters accumulate since they were last cleared, and some are small and saturate. A counter that reads 3 might be from a cable reseat last month. Good practice:

1. Record a baseline (or clear counters fabric-wide at a known time).
2. Run the workload or a stress test (perftest, nccl-tests).
3. Read again and look at the **delta per unit time** for each port.
4. Compare ports of the same role: one leaf port with symbol errors growing while its 63 neighbours stay at zero is your outlier.

`perfquery` can reset counters after reading them, and `ibdiagnet` and UFM can clear counters fabric-wide; coordinate with whoever owns monitoring, because clearing counters destroys history.

### ibdiagnet: the fabric-wide check

`ibdiagnet` (NVIDIA) discovers the fabric, checks for duplicate GUIDs and LIDs, validates links (speed, width, state), reads all port counters, checks routing consistency and can collect cable and PHY information. It writes a summary to the screen and detailed reports — log, CSV database of the fabric and counters, topology files — under an output directory (by default `/var/tmp/ibdiagnet2/` in recent versions). It supports options for counter clearing and threshold-based checks, cable information collection, BER tests and more; run `ibdiagnet --help` for the options in your version. Running it before and after a workload is a standard acceptance and post-maintenance step.

### The SM's view

The Subnet Manager log (for OpenSM, typically `/var/log/opensm.log`; for UFM, the UFM logs) records topology changes, heavy sweeps, routing-engine results and traps. When diagnostics show a link flapping, the SM log tells you *when* it started and how often; when routing looks wrong, it tells you which engine actually ran.

## In practice

### Step 1: the host

```text
$ ibstat mlx5_3 | grep -E "State|Physical|Rate|Base lid|SM lid"
		State: Active
		Physical state: LinkUp
		Rate: 400
		Base lid: 57
		SM lid: 1
```

*(Illustrative.)* Active, LinkUp, expected rate, a LID and an SM LID: the host's view is healthy. `ibstatus` gives a similar summary across all HCAs.

On real hardware (two ConnectX-5 ports in InfiniBand mode, EDR, back to back, OpenSM running) the same check reads like this. Note that `ibstat <ca> <port>` prints a flat, unindented block, unlike `ibstat <ca>`:

```text real=doca
$ ibstat mlx5_1 1
CA: 'mlx5_1'
Port 1:
State: Active
Physical state: LinkUp
Rate: 100
Base lid: 1
LMC: 0
SM lid: 1
Capability mask: 0x2651e84a
Port GUID: 0x248a0703000011ef
Link layer: InfiniBand
```

### Step 2: the link and its neighbour

```text
$ iblinkinfo | grep '"node09 HCA-4"'
          2    17[  ] ==( 4X        106.25 Gbps Active/  LinkUp)==>      57    1[  ] "node09 HCA-4" ( )
```

*(Illustrative.)* The leaf side (LID 2, port 17) agrees: 4X at NDR lane speed. Filtering on the node description is the simplest version-independent way to find one link; your iblinkinfo version may also offer options to select a switch or port directly.

Back to back on real hardware there is no switch, so `iblinkinfo` prints one `CA:` block per HCA, and EDR shows up as a lane speed of 25.78125 Gbps:

```text real=doca
$ sudo iblinkinfo -C mlx5_1 -P 1
CA: ESXI-2-UbuntuServer-1 mlx5_1:
      0x1c34da0300002229      2    1[  ] ==( 4X      25.78125 Gbps Active/  LinkUp)==>       1    1[  ] "ESXI-1-UbuntuServer-1 mlx5_1" ( )
CA: ESXI-1-UbuntuServer-1 mlx5_1:
      0x248a0703000011ef      1    1[  ] ==( 4X      25.78125 Gbps Active/  LinkUp)==>       2    1[  ] "ESXI-2-UbuntuServer-1 mlx5_1" ( )
```

> [!VERIFIED]
> **`smpquery portinfo` reports `LinkSpeedActive: 10.0 Gbps` on a healthy EDR link.** On the ConnectX-5 EDR pair above (DOCA-OFED 3.4, infiniband-diags 2604), `sudo smpquery -C mlx5_1 -P 1 portinfo 1 1` printed `LinkSpeedSupported: 2.5 Gbps or 5.0 Gbps or 10.0 Gbps` and `LinkSpeedActive: 10.0 Gbps`, while `iblinkinfo` showed `4X 25.78125 Gbps` and `ibstat` `Rate: 100`. The classic PortInfo speed fields stop at QDR's 10 Gbps per lane; FDR and EDR live in the extended-speed fields further down the output (the port advertises `IsExtendedSpeedsSupported` in its CapMask). Read those, or trust `iblinkinfo`/`ibstat`, before concluding that a link trained slowly.

### Step 3: counters on both ends

```text
$ perfquery 57 1
# Port counters: Lid 57 port 1 (CapMask: 0x5A00)
PortSelect:......................1
CounterSelect:...................0x0000
SymbolErrorCounter:..............0
LinkErrorRecoveryCounter:........0
LinkDownedCounter:...............0
PortRcvErrors:...................0
PortRcvRemotePhysicalErrors:.....0
PortRcvSwitchRelayErrors:........0
PortXmitDiscards:................0
PortXmitConstraintErrors:........0
PortRcvConstraintErrors:.........0
CounterSelect2:..................0x00
LocalLinkIntegrityErrors:........0
ExcessiveBufferOverrunErrors:....0
QP1Dropped:......................0
VL15Dropped:.....................0
PortXmitData:....................4294967295
PortRcvData:.....................4294967295
PortXmitPkts:....................4294967295
PortRcvPkts:.....................4294967295
PortXmitWait:....................1288227

$ perfquery 2 17
...
SymbolErrorCounter:..............1834
LinkErrorRecoveryCounter:........3
PortRcvErrors:...................211
...
```

*(Illustrative.)* Notice the 32-bit data counters on the host saturated at 4294967295 — use `perfquery -x` for 64-bit extended counters. On the switch side, port 17 (receiving from node09's HCA) shows symbol errors, link recoveries and receive errors: the transmit path from the HCA's optic to the switch is bad. Clean or replace the cable/optic on that link, then clear and re-measure.

The saturation is easy to hit on a real link. After a few bandwidth tests over the back-to-back EDR pair, the classic and the extended counters of the same port read:

```text real=doca
$ sudo perfquery -C mlx5_1 -P 1
# Port counters: Lid 1 port 1 (CapMask: 0x5A00)
...
PortXmitDiscards:................11
...
PortXmitData:....................4294967295
PortRcvData:.....................95779411
PortXmitPkts:....................193443485
PortRcvPkts:.....................13680303
PortXmitWait:....................65571
$ sudo perfquery -x -C mlx5_1 -P 1
# Port extended counters: Lid 1 port 1 (CapMask: 0x5A00 CapMask2: 0x0000000)
PortSelect:......................1
CounterSelect:...................0x0000
PortXmitData:....................199294892652
PortRcvData:.....................95779411
PortXmitPkts:....................193443485
PortRcvPkts:.....................13680303
...
```

> [!VERIFIED]
> **The 32-bit `PortXmitData` of plain `perfquery` saturated at 4294967295 after a few bandwidth tests on an EDR link; `perfquery -x` showed the real value.** On ConnectX-5 (fw 16.29, DOCA-OFED 3.4) the same port read `PortXmitData:....................4294967295` with `perfquery -C mlx5_1 -P 1` and `199294892652` with `perfquery -x -C mlx5_1 -P 1`. At 100 Gb/s, 2^32 units of 4 bytes are about 17 GB, so the classic counter is full in under two seconds of line-rate traffic. Always use `-x` (or UFM telemetry) for data and packet counters, and read the classic block only for the error counters.

### Step 4: the whole fabric

```text
$ ibqueryerrors
Errors for 0xfc6a1c0300e4f300 "leaf03"
   GUID 0xfc6a1c0300e4f300 port 7: [SymbolErrorCounter == 52113] [PortRcvErrors == 409]
Errors for 0xfc6a1c0300e50b00 "spine02"
   GUID 0xfc6a1c0300e50b00 port 3: [PortRcvRemotePhysicalErrors == 409]
```

*(Illustrative.)* `ibqueryerrors` scans the fabric and reports ports whose error counters exceed thresholds (and has options to adjust thresholds, include data counters or suppress specific counters; see its man page). Read it with the localisation rule: leaf03 port 7 is the culprit link, spine02 port 3 is a downstream victim. The report ends with a `## Summary:` of the nodes and ports checked, and the exit status is non-zero when ports exceed thresholds. It finds the ports through the SA: with no SM running it prints only a warning such as `ibwarn: [...] sa_get_handle: No SM/SA found on port :1` (with exit status 0 in the version we tested), which is not a clean bill of health.

On the real back-to-back pair, with an SM running, the full report looks like this (exit status 1; counters with a rate threshold also print the rate in brackets):

```text real=doca
$ sudo ibqueryerrors -C mlx5_1 -P 1
Errors for "ESXI-2-UbuntuServer-1 mlx5_1"
   GUID 0x1c34da0300002229 port 1: [PortRcvErrors == 3 (3.000)] [PortRcvSwitchRelayErrors == 3 (3.000)]
Errors for "ESXI-1-UbuntuServer-1 mlx5_1"
   GUID 0x248a0703000011ef port 1: [PortXmitDiscards == 11] [PortXmitWait == 65571]

## Summary: 2 nodes checked, 2 bad nodes found
##          2 ports checked, 2 ports have errors beyond threshold
## Thresholds:
## Suppressed:
```

A single snapshot like this cannot tell you whether those counts are old or still growing, which is exactly why you compare deltas rather than totals.

### Step 5: the path and the SM

```text
$ ibtracert 12 57          # which switches and ports are on the path
$ sminfo                   # is the master SM the expected one?
$ ibnetdiscover > fabric.topo
$ diff <(sort expected.topo) <(sort fabric.topo)   # compare with the cabling plan
```

`ibnetdiscover` output lists every switch and HCA and every cable between them, with GUIDs, node descriptions and link speed/width. Comparing it with an expected topology (generated from the cabling plan, after normalising formats) is the most reliable way to catch miscabling, which silently ruins ftree balance and rail alignment.

On the real back-to-back pair (no switch, OpenSM on the first host) the path is a single hop and the SM is the local port:

```text real=doca
$ sudo sminfo -C mlx5_1 -P 1
sminfo: sm lid 1 sm guid 0x248a0703000011ef, activity count 48 priority 0 state 3 SMINFO_MASTER
$ sudo ibtracert -C mlx5_1 -P 1 1 2
From ca {0x248a0703000011ef} portnum 1 lid 1-1 "ESXI-1-UbuntuServer-1 mlx5_1"
[1] -> ca port {0x1c34da0300002229}[1] lid 2-2 "ESXI-2-UbuntuServer-1 mlx5_1"
To ca {0x1c34da0300002229} portnum 1 lid 2-2 "ESXI-2-UbuntuServer-1 mlx5_1"
$ sudo ibaddr -C mlx5_1 -P 1
GID fe80::248a:703:0:11ef LID start 0x1 end 0x1
```

Without an SM, the LID-addressed tools fail (`sminfo: iberror: failed: query`, `ibtracert: iberror: failed: Failed to get route information`, `perfquery: iberror: failed: classportinfo query`), while the directed-route tools (`ibnetdiscover`, `ibhosts`, `iblinkinfo`) still map the fabric. One tool answers misleadingly:

> [!VERIFIED]
> **Before an SM runs, `ibaddr` answers with the peer's GID, not the local one.** On the back-to-back ConnectX-5 EDR pair (DOCA-OFED 3.4) with no subnet manager, `sudo ibaddr -C mlx5_1 -P 1` on the first host printed `GID fe80::1c34:da03:0:2229 LID start 0xffff end 0xffff`: the GUID of the far host's port. Its own port GUID is `0x248a0703000011ef`, and once OpenSM had run the same command printed `GID fe80::248a:703:0:11ef LID start 0x1 end 0x1`. The unassigned LID 0xffff is also the permissive LID, which a port accepts as "whoever is at the other end of this link", so the query is answered by the neighbour. Treat any LID 0xffff answer as "no SM yet" and read local identity from `ibstat` or sysfs instead.

### Step 6: ibping for reachability

```text
node77$ ibping -S
node01$ ibping 88
Pong from node77.(none) (Lid 88): time 0.012 ms
```

*(Illustrative.)* `ibping` checks MAD-level reachability between two ports using the IB path, independent of IP and of the application. If ibping works but RDMA fails, look at partitions, QP configuration or the application.

Back to back on real EDR hardware, with the responder (`sudo ibping -S -C mlx5_1 -P 1`) on the peer:

```text real=doca
$ sudo ibping -C mlx5_1 -P 1 -c 3 -L 2
Pong from ESXI-2-UbuntuServer-1.(none) (Lid 2): time 0.048 ms
Pong from ESXI-2-UbuntuServer-1.(none) (Lid 2): time 0.045 ms
Pong from ESXI-2-UbuntuServer-1.(none) (Lid 2): time 0.052 ms

--- ESXI-2-UbuntuServer-1.(none) (Lid 2) ibping statistics ---
3 packets transmitted, 3 received, 0% packet loss, time 3000 ms
rtt min/avg/max = 0.045/0.048/0.052 ms
```

Without an SM the peer's LID is still 0xffff and the client fails (exit status 255): `ibping: iberror: failed: can't resolve destination port 65535`.

### A troubleshooting checklist

| # | Check | Tool | Bad sign |
|---|---|---|---|
| 1 | Host port state, rate, LID | `ibstat` | Init, Down, wrong rate, no LID (`Base lid: 65535`) |
| 2 | Master SM present and expected | `sminfo` | No SM, unexpected GUID, state not master |
| 3 | Link speed and width on both ends | `iblinkinfo` | 2X/1X width, lower lane speed |
| 4 | Physical error counter rates | `perfquery`, `ibqueryerrors` | Growing SymbolError, PortRcvErrors, LinkDowned |
| 5 | Configuration errors | `perfquery` | SwitchRelay or Constraint errors |
| 6 | Congestion indicators | `perfquery` (PortXmitWait, extended data) | High wait growth on specific ports |
| 7 | Path and routing | `ibtracert`, `ibroute`, `dump_fts` | Unexpected path, unbalanced uplinks |
| 8 | Fabric-wide report | `ibdiagnet` | Errors, warnings, duplicate GUIDs/LIDs |
| 9 | History | SM logs, UFM | Flaps, heavy sweeps, master changes |

> [!TIP]
> Always identify ports by **switch node description + port number** or by GUID in tickets, never by LID alone. LIDs can change; "leaf03 port 7" means the same physical cable tomorrow.

## Common pitfalls

- **Replacing the victim, not the culprit.** Symptom: errors continue after replacing spine cables. Cause: replaced links that only showed `PortRcvRemotePhysicalErrors`. Fix: find the port with local `PortRcvErrors`/symbol errors.
- **Reading totals instead of rates.** Symptom: chasing old, static error counts. Cause: counters accumulate since the last clear. Fix: baseline, run load, compare deltas.
- **Trusting saturated 32-bit counters.** Symptom: `PortXmitData` stuck at 4294967295. Cause: classic counters saturate. Fix: use extended counters (`perfquery -x`) or UFM telemetry.
- **Treating PortXmitWait as a fault.** Symptom: healthy cables replaced on busy spine ports. Cause: PortXmitWait measures congestion. Fix: check physical counters first; investigate traffic patterns and routing for wait.
- **Clearing counters without coordination.** Symptom: monitoring loses history, alerts reset. Cause: a fabric-wide clear by one engineer. Fix: agree on when counters are cleared, or rely on rates computed by monitoring.
- **Ignoring the SM.** Symptom: intermittent fabric-wide hiccups that no single port explains. Cause: heavy sweeps from a flapping link or a master SM change. Fix: read the SM log and `sminfo` as part of every investigation.
- **Running diagnostics without permissions.** Symptom: tools fail with "can't open MAD port" style errors. Cause: no access to `/dev/infiniband/umad*`. Fix: run as root or with appropriate permissions on a host with an Active port.
- **Querying the wrong local device.** Symptom: `sminfo`, `perfquery` or `iblinkinfo` fail even as root, with `ibwarn: [...] mad_rpc_open_port2: client_register for mgmt 1 failed` and `Failed to open '(null)' port '0'`. Cause: without options the tools open the first RDMA device, and on this host that is a RoCE (Ethernet) port, for example a frontend NIC or the other port of a VPI card. Fix: name the InfiniBand device and port with `-C <ca> -P <port>` (`ibdiagnet` uses `-i <dev> -p <port>`); `ibstat -l` lists every CA, RoCE ones included.

## Key takeaways

- Every IB device has a management (SMA) and performance (PMA) agent, so one host can discover, query and trace the whole fabric.
- Work bottom-up: host (`ibstat`) → SM (`sminfo`) → link (`iblinkinfo`) → counters (`perfquery`, `ibqueryerrors`) → path (`ibtracert`) → fabric (`ibdiagnet`) → history (SM/UFM logs).
- Physical counters (SymbolError, LinkErrorRecovery, LinkDowned, PortRcvErrors) mean broken links; SwitchRelay and Constraint errors mean configuration; PortXmitWait means congestion.
- The culprit link is where `PortRcvErrors` rises; ports with only `PortRcvRemotePhysicalErrors` are downstream victims of cut-through forwarding.
- Use rates and extended (64-bit) counters, and identify ports by node description and port number or GUID, not LID.
- Compare `ibnetdiscover` output with the cabling plan to catch miscabling before it ruins routing balance.
