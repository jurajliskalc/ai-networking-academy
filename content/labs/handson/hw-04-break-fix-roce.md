---
id: hw-04-break-fix-roce
title: "Break/fix on your own gear: diagnose an injected RoCE fault layer by layer"
kind: handson
level: 3
estimated_minutes: 90
environment: hardware
tier: 1
fabric: roce
requires: [two-rdma-hosts, root, ssh-mesh]
changes_config: true
lessons: [troubleshooting-methodology, rdma-connection-failures, lossless-misconfigurations, mtu-jumbo-frames, qos-trust-and-mapping]
files: labs/hw-04-break-fix-roce
verified: true
summary: "A script on host B injects one hidden, reversible fault. Work the incident from host A with real tools, commit a diagnosis, fix it and prove the fabric is healthy again."
---

> [!NOTE]
> Verified end to end (every task, the check and the restore step) on 2026-10-23 on two ConnectX-5
> hosts cabled back to back (100GbE DAC; ESXi VMs with PCI passthrough; Ubuntu 26.04.1, kernel
> 7.0.0-38, NVIDIA DOCA-OFED 3.4); see `labs/README.md` for the exact versions. Your device names,
> numbers and some output lines will differ with other NICs, firmware or the distribution's inbox stack.
> All five faults were injected, diagnosed and restored; one random fault was diagnosed from the
> lab's own commands alone.

## Goal

The simulator labs train you on a modelled fabric. This one uses yours. A script on **host B**
(`{{HOST_B}}`) quietly breaks one thing on its RDMA interface `{{B_NETDEV}}`; you get a ticket,
investigate from **host A** (`{{HOST_A}}`) with the same tools you would use at 3 a.m. on a
production cluster, name the root cause, fix it and prove the result.

By the end you can:

- Work an RDMA incident bottom-up: link, IP and MTU, RDMA port and GID, QoS, counters.
- Tell faults that break connectivity from faults that only show up as wrong classification.
- Separate evidence from assumption: each conclusion backed by a command output.
- Close the incident with a verification, not with "it seems fine now".

> [!NOTE]
> Blocks labelled **Real capture** were copied from the reference hosts (ConnectX-5, firmware 16.29,
> Ubuntu 26.04) with the stack named in the label; other output here is **illustrative**. Error texts
> of the RDMA tools vary between rdma-core and perftest releases; the patterns are what matters. With
> NVIDIA's DOCA-Host stack, verbs tools may also print a harmless `libibverbs: Warning: couldn't load
> driver 'libionic-rdmav59.so': ...` line.

## Before you start

- **Done first:** [First RoCEv2 traffic](#/hw/labs/hw-02-roce-first-traffic). Ideally also
  [Host-side lossless QoS](#/hw/labs/hw-03-host-qos-pfc-ecn) with its configuration still applied:
  two of the five faults are QoS faults and are only injected if the lossless configuration is
  active (otherwise there would be nothing to break). `pfc-off` works with `mlnx_qos` or `dcb`;
  `trust-pcp` uses `mlnx_qos --trust pcp` on NVIDIA's stack; with the distribution's inbox stack
  (`dcb apptrust` is not supported on mlx5) it removes the port's DSCP app entries, which switches
  mlx5 back to PCP trust, and the restore adds them again.
- **A healthy baseline:** `./hw-toolkit/aina-hw check hw-02-roce-first-traffic` passes on host A.
- **Host names on the management network:** `HOST_B` in your profile must be a management name or
  address, not host B's data IP. The `ip-missing` and `port-down` faults take the data interface away,
  and the checks still have to reach host B over SSH.
  Do not start an incident on a fabric that is already broken.
- **Root** on host B (the injector) and **SSH** from A to B (the check).
- **Profile on host B:** `inject.sh` reads `{{AINA_DIR}}/labs/hw-toolkit/lab.env` on host B to find
  `{{B_NETDEV}}` and `{{B_IP}}`, so copy the same `lab.env` there.
- **Management access to B that does not use `{{B_NETDEV}}`.** Two faults take the data interface
  or its address away. The injector refuses them when `{{B_NETDEV}}` carries the default route or
  an SSH session, but it cannot know about every console path: make sure you can still reach B.
- **Changes:** one fault at a time, on host B's data interface only, at runtime. The pre-fault
  state is saved under `/var/lib/aina/state/hw-04-break-fix-roce/`; `inject.sh --restore` undoes
  it, and a reboot clears every one of these faults too.

## Tasks

### Task 1: Start the incident

On **host B**:

```bash
cd {{AINA_DIR}}/labs/hw-04-break-fix-roce
sudo ./inject.sh --list
sudo ./inject.sh --random
```

Illustrative `--list` output:

```
FAULT          HERE         WHAT
mtu-mismatch   yes          set the data netdev MTU to 1500
pfc-off        yes          disable PFC on the lossless priority
trust-pcp      yes          switch the NIC from DSCP trust to PCP trust
ip-missing     yes          remove the data IPv4 address
port-down      no           administratively shut the data netdev (ens1f0np0 carries the default route or an SSH session)
```

`--random` picks one applicable fault and does not tell you which. Now log out of host B's shell
mentally: from here on you are the on-call engineer on host A, and host B is "a node the scheduler
reported".

> [!TIP]
> Instructors can run `sudo ./inject.sh --fault <id>` before handing over the hosts. The learner
> still has to find it.

### Task 2: Read the ticket

> **INC-2207, severity 3.** Training job on `{{HOST_A}}` and `{{HOST_B}}` fails or runs slower
> than last week. Nothing was "changed" according to the change log. `ping {{B_IP}}` from the job
> launcher works or does not, depending on who you ask. Please investigate and restore service.

Before typing anything, write down two things: what "healthy" looks like on this pair (you know it
from the earlier labs: ports ACTIVE, MTU {{MTU}}, a RoCE v2 GID, RC ping-pong and full bandwidth,
RoCE traffic in priority {{ROCE_PRIO}}), and in which order you will check the layers. The
[troubleshooting methodology](#/lesson/troubleshooting-methodology) lesson argues for bottom-up
when the symptom is vague, because each layer depends on the one below.

### Task 3: Layer 1 and 2: is the link up, end to end?

From host A, you may log in to B to **read** state (that is what an engineer does), but do not
change anything yet:

```bash
ip -br link show dev {{A_NETDEV}}
ssh {{HOST_B}} ip -br link show dev {{B_NETDEV}}
rdma link show
ssh {{HOST_B}} rdma link show
```

**What to look for:** `UP` on both netdevs and `state ACTIVE physical_state LINK_UP` on both RDMA
ports. On RoCE NICs the RDMA port state follows the Ethernet link, so an administratively down
netdev shows up as a DOWN RDMA port as well. Note who says what: if A's port is ACTIVE and B's is
not, the cable is probably fine (A would see the loss of signal too on a back-to-back link), and
the cause is local to B.

### Task 4: Layer 3: addresses and the MTU

```bash
ssh {{HOST_B}} ip -br addr show dev {{B_NETDEV}}
ping -c 3 {{B_IP}}
ping -M do -s $(({{MTU}} - 28)) -c 3 {{B_IP}}
ssh {{HOST_B}} cat /sys/class/net/{{B_NETDEV}}/mtu
```

**Reading the combinations:**

| Small ping | Full-size DF ping | Likely meaning |
|---|---|---|
| fails | fails | no IP path: address, link or neighbour problem |
| works | fails | an MTU smaller than {{MTU}} somewhere on the path |
| works | works | the IP layer is fine; look higher |

A full-size don't-fragment ping that fails while small pings succeed is the jumbo-frame black hole
from [MTU and jumbo frames](#/lesson/mtu-jumbo-frames). Note which **host** has the smaller MTU:
the receiver drops frames larger than its MTU, so the failure appears in one direction first.

### Task 5: The RDMA layer: port, active MTU and GIDs

```bash
ssh {{HOST_B}} ibv_devinfo -d {{B_RDMA_DEV}} -i {{RDMA_PORT}} | grep -E 'state|active_mtu|link_layer'
ssh {{HOST_B}} 'D=/sys/class/infiniband/{{B_RDMA_DEV}}/ports/{{RDMA_PORT}}; for i in $(ls $D/gids | sort -n); do t=$(cat $D/gid_attrs/types/$i 2>/dev/null) || continue; echo "$i $(cat $D/gids/$i) $t"; done'
```

**What to look for:**

- `active_mtu` lower than 4096 means the netdev MTU on that host is below about 4200.
- The RoCE v2 entry with `::ffff:` and B's IPv4 address must exist. GIDs are generated from the
  addresses on the netdev: remove the address and the GID disappears with it, and every tool that
  uses that GID index fails or picks the wrong source.

Then try the connection the way the job would:

```bash
ibv_rc_pingpong -d {{A_RDMA_DEV}} -g {{GID_INDEX}} {{B_IP}}      # after starting the server on B with B's GID index
```

Illustrative failures and what they usually point to:

```
client read/write: No space left on device   # server and client disagree (for example -g 0 on one side, 3 on the other)
Couldn't read/write remote address
Failed to modify QP to RTR          # bad remote GID / address information, often a GID index problem
Couldn't connect to 192.168.50.12:18515      # no TCP path to the server (address, link, firewall)
IB device 'mlx5_0' wasn't found     # ibv_devinfo: wrong device name (compare with rdma link show)
```

perftest reports a missing server as `Couldn't connect to 192.168.50.12:18515` followed by
`Unable to open file descriptor for socket connection`, and a wrong device as `IB device mlx5_0 not
found` / ` Unable to find the Infiniband/RoCE device`.

### Task 6: The QoS layer: same contract on both hosts?

If everything so far is clean, the fault is in classification. Compare the hosts side by side:

```bash stack=inbox
# iproute2 (the inbox stack has no mlnx_qos):
dcb pfc show dev {{A_NETDEV}} prio-pfc
ssh {{HOST_B}} dcb pfc show dev {{B_NETDEV}} prio-pfc
dcb app show dev {{A_NETDEV}} dscp-prio
ssh {{HOST_B}} dcb app show dev {{B_NETDEV}} dscp-prio
ethtool -a {{A_NETDEV}}; ssh {{HOST_B}} ethtool -a {{B_NETDEV}}
```

```bash stack=doca
mlnx_qos -i {{A_NETDEV}} | grep -iE 'trust|enabled'
ssh {{HOST_B}} mlnx_qos -i {{B_NETDEV}} | grep -iE 'trust|enabled'
# dcb works with NVIDIA's stack too
ethtool -a {{A_NETDEV}}; ssh {{HOST_B}} ethtool -a {{B_NETDEV}}
```

On a correctly configured host (host A of the reference pair):

```text stack=inbox real
$ dcb pfc show dev ens64f0np0 prio-pfc
prio-pfc 0:off 1:off 2:off 3:on 4:off 5:off 6:off 7:off
$ dcb app show dev ens64f0np0 dscp-prio
dscp-prio AF31:3
$ ethtool -a ens64f0np0
Pause parameters for ens64f0np0:
Autonegotiate:	off
RX:		off
TX:		off
```

```text stack=doca real
$ mlnx_qos -i ens64f0np0 | grep -iE 'trust|enabled'
Priority trust state: dscp
	enabled     0   0   0   1   0   0   0   0
$ ethtool -a ens64f0np0
Pause parameters for ens64f0np0:
Autonegotiate:	off
RX:		off
TX:		off
```

`dcb app show` prints DSCP 26 by its name (`dscp-prio AF31:3`). `ethtool -a` belongs in the
comparison too: on mlx5, global pause (`RX: on`, `TX: on`) and PFC exclude each other, and an
`ethtool -A ... rx on tx on` silently turns PFC off on every priority.

Then run traffic with your traffic class and watch **which priority** host B counts it in:

```bash
# host B: ib_write_bw -d {{B_RDMA_DEV}} -x {{GID_INDEX}} -D 15 -F --report_gbits --tclass={{TCLASS}}
ib_write_bw -d {{A_RDMA_DEV}} -x {{GID_INDEX}} -D 15 -F --report_gbits --tclass={{TCLASS}} {{B_IP}}
ssh {{HOST_B}} "ethtool -S {{B_NETDEV}} | grep -E 'rx_prio[0-7]_bytes'"
```

**Why this layer is the hard one:** QoS faults do not break connectivity. With one sender and no
congestion, a host without PFC, or a host classifying RoCE into priority 0, moves traffic at full
speed. The damage appears only when the fabric is congested: drops instead of pauses, retransmits,
collapsing all-reduce bandwidth. That is why the only reliable detection is a **configuration
comparison** and **per-priority counters**, never "the test passed".

### Task 7: Commit your diagnosis

On host B, record your answer (it does not reveal the fault if you are wrong):

```bash
sudo ./inject.sh --answer <fault-id>
```

Write one line of evidence for your answer, as you would in the ticket, for example:
"`{{B_NETDEV}}` MTU 1500 vs {{MTU}} on A; DF ping of {{MTU}} bytes fails, small pings work;
`active_mtu` 1024 on B."

### Task 8: Fix it and close the incident

Fix the cause by hand with the command you would use in production (for example `ip link set`,
`ip addr add`, `mlnx_qos`, or `dcb`), using what you know the healthy state should be. Then let the
injector put back the exact saved state and mark the incident closed:

```bash
sudo ./inject.sh --restore
sudo ./inject.sh --status
```

Run it again with `--random` as often as you like: each run is a new incident.

## Verify

On host A:

```bash
cd {{AINA_DIR}}/labs
./hw-toolkit/aina-hw check hw-04-break-fix-roce
```

The check fails until a correct diagnosis is recorded and the fault is restored. Then it confirms
that host B is healthy again: port ACTIVE, netdev up, MTU equal to host A's, `{{B_IP}}` configured,
a RoCE v2 IPv4 GID, a full-size don't-fragment ping and a working RC ping-pong, plus matching trust
modes when `mlnx_qos` is available. Import the result on the [Connect page](#/hw/connect).

## Restore

`sudo ./inject.sh --restore` on host B restores whatever was injected (MTU, address, link state,
trust mode or PFC map) from the state saved just before the fault. It is safe to run at any time.
If something goes wrong with the state files, every fault is a runtime change: rebooting host B
returns it to its configured state.

The debrief, for after you have committed a diagnosis:

| Fault | What you see | Decisive evidence |
|---|---|---|
| `mtu-mismatch` | Small pings work, full-size DF ping fails; RDMA may work at small sizes and fail or stall at large ones (`ibv_rc_pingpong` uses a 1024-byte path MTU by default, so it can still pass) | `cat /sys/class/net/{{B_NETDEV}}/mtu` is 1500; `active_mtu` 1024 on B |
| `ip-missing` | Ping fails; `ibv_rc_pingpong` cannot connect; the RoCE v2 IPv4 GID is gone | `ip -br addr` on B shows no `{{B_IP}}`; GID table has only link-local entries |
| `port-down` | Everything fails; RDMA port `DOWN` / `DISABLED` on B, while A's port can still show `ACTIVE` (mlx5 keeps the PHY of an admin-down port up, so the cable stays lit) | `ip -br link` shows `DOWN` on B with admin state down (`ip link show` lacks `UP` in the flags) |
| `pfc-off` | Traffic works at full speed; nothing visible without congestion | `mlnx_qos` / `dcb pfc show` differ between A and B |
| `trust-pcp` | Traffic works; host B counts RoCE in `rx_prio0_bytes` instead of priority {{ROCE_PRIO}} | `mlnx_qos` trust state `pcp` on B; inbox stack: `dcb -N app show dev <if>` prints no `dscp-prio` entries on B |

## What you learned

- Bottom-up is fastest when symptoms are vague: link, IP and MTU, RDMA port and GID, QoS.
- Compare both ends: most RoCE faults are a disagreement between two devices, not a broken one.
- GIDs come from IP addresses; no address, no RoCE v2 GID, no connection.
- QoS faults keep traffic flowing and only bite under congestion; detect them with config
  comparisons and per-priority counters.
- Close incidents with a verification that would have failed before the fix.

## Going further

- Ask a colleague to inject with `--fault` and time yourself. Then try to find the fault with only
  one tool family (only counters, or only configuration reads).
- Repeat the investigation with `./hw-toolkit/aina-hw collect-all` and the health review on the
  [Connect page](#/hw/connect): which faults does the review flag by itself, and which need traffic?
- Compare with the simulator incidents [MTU black hole](#/labs/sim-01-mtu-blackhole) and
  [trust PCP](#/labs/sim-12-trust-pcp).
