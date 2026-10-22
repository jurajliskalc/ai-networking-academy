---
id: hw-03-host-qos-pfc-ecn
title: "Host-side lossless QoS: DSCP trust, PFC on one priority and ECN on real NICs"
kind: handson
level: 3
estimated_minutes: 120
environment: hardware
tier: 1
fabric: roce
requires: [two-rdma-hosts, root, ssh-mesh]
changes_config: true
lessons: [qos-trust-and-mapping, pfc-priority-flow-control, ecn-and-dcqcn, rocev2-configuration-end-to-end, lossless-misconfigurations]
files: labs/hw-03-host-qos-pfc-ecn
verified: false
summary: "Configure the host half of a lossless RoCE fabric on both NICs, prove that RoCE traffic lands in the lossless priority with counters, and restore the original state afterwards."
---

## Goal

A lossless RoCE fabric is a contract between every NIC and every switch: **which packets are RoCE,
which priority they travel in, which priority may be paused, and which priority gets ECN marks.**
In this lab you configure and verify the host half of that contract on **host A** (`{{HOST_A}}`,
`{{A_NETDEV}}`) and **host B** (`{{HOST_B}}`, `{{B_NETDEV}}`):

| Setting | Your profile | Why |
|---|---|---|
| Trust mode | DSCP | Routed RoCEv2 links usually carry no VLAN tag, so there is no PCP to trust. |
| RoCE DSCP | {{ROCE_DSCP}} | The DSCP your RoCE packets carry and the switches classify on. |
| Lossless priority | {{ROCE_PRIO}} | The only priority with PFC enabled. |
| Traffic class byte | {{TCLASS}} | DSCP {{ROCE_DSCP}} shifted left by two, plus ECT(0), for perftest and NCCL. |
| CNP DSCP | {{CNP_DSCP}} | Congestion notifications should travel in their own, high priority. |

By the end you can:

- Read a NIC's QoS state (trust, PFC per priority, DSCP-to-priority map) with `mlnx_qos` or `dcb`.
- Configure it reproducibly with a script that saves the original state first.
- Prove with per-priority counters that RoCE traffic really uses the lossless priority.
- Explain what ECN and DCQCN do on the host, and what you can and cannot see of them.
- Restore the original configuration exactly.

> [!NOTE]
> Command output in this lab is **illustrative**. Output layouts of `mlnx_qos` and `dcb` differ
> between releases, and counter names differ between drivers. The examples are from NVIDIA
> ConnectX (mlx5) NICs, the most common RoCE NICs in lab gear.

## Before you start

- **Done first:** [First RoCEv2 traffic](#/hw/labs/hw-02-roce-first-traffic). RDMA must already
  work between the two hosts; this lab changes how it is classified.
- **Hardware:** the same two hosts, back to back or through a switch. Back to back is fine: two
  NICs exchange PFC frames directly. If there is a switch in between, it must be configured to match
  (that is the [lossless switch lab](#/hw/labs/hw-06-switch-lossless-incast)); otherwise PFC from a
  host stops at the switch and its queues stay lossy.
- **Tools:** one of these on **both** hosts:
  - `mlnx_qos`, shipped with NVIDIA's MLNX_OFED / DOCA-Host packages (not with distribution
    rdma-core), or
  - `dcb` from iproute2 (included in the `iproute2` package on current Ubuntu and RHEL-family
    releases).

  The lab scripts pick `mlnx_qos` when it exists and fall back to `dcb`.
- **Root** on both hosts and **SSH** from A to B (for the check).
- **Profile on both hosts:** the save, apply and restore scripts run on each host and read
  `{{AINA_DIR}}/labs/hw-toolkit/lab.env` there (to find the netdev, priority and DSCP, and to tell
  which host they are on), so copy the same `lab.env` to host B.
- **Changes:** runtime NIC QoS on the RDMA netdev of each host. `apply-qos.sh` saves the original
  state to `/var/lib/aina/state/hw-03-host-qos-pfc-ecn/` before changing anything, and
  `restore-qos.sh` puts it back. A reboot also clears runtime QoS on most driver stacks.

> [!WARNING]
> Do not run this lab on hosts that carry other RDMA or storage traffic. Changing trust mode and
> PFC on a live NIC reclassifies everything on it, including NVMe-oF or storage traffic that may
> depend on a different priority.

## Tasks

### Task 1: Read the current state before changing anything

On each host, with the tool you have:

```bash
mlnx_qos -i {{A_NETDEV}}                     # host B: {{B_NETDEV}}
```

or

```bash
dcb pfc show dev {{A_NETDEV}}
dcb app show dev {{A_NETDEV}}
```

Illustrative `mlnx_qos` excerpt (factory defaults on many ConnectX releases):

```
DCBX mode: OS controlled
Priority trust state: pcp
...
PFC configuration:
        priority    0   1   2   3   4   5   6   7
        enabled     0   0   0   0   0   0   0   0
```

Illustrative `dcb` output:

```
pfc-cap 8 macsec-bypass off delay 0
prio-pfc 0:off 1:off 2:off 3:off 4:off 5:off 6:off 7:off
```

**Read it:** the **trust state** says what the NIC looks at to choose a priority for received
packets: the 3-bit PCP of a VLAN tag (`pcp`) or the 6-bit DSCP of the IP header (`dscp`). The PFC
line says which priorities may be paused. `DCBX mode: OS controlled` means the host software, not a
DCBX negotiation with the switch, owns these settings: what you configure is what applies.

Now save it, on **each** host:

```bash
cd {{AINA_DIR}}/labs/hw-03-host-qos-pfc-ecn
sudo ./save-qos.sh
ls /var/lib/aina/state/hw-03-host-qos-pfc-ecn/*/
```

**Why:** in a real fabric, the most expensive QoS mistakes are the ones you cannot undo because
nobody wrote down what was there before. The script detects which host it is on by matching the
data IPs in your lab profile, and refuses to overwrite an existing save.

### Task 2: Trust DSCP and map {{ROCE_DSCP}} to priority {{ROCE_PRIO}}

The apply script does this for you, but do it once by hand to see each step. With `mlnx_qos`:

```bash
sudo mlnx_qos -i {{A_NETDEV}} --trust dscp
sudo mlnx_qos -i {{A_NETDEV}} --dscp2prio set,{{ROCE_DSCP}},{{ROCE_PRIO}}
```

With `dcb`:

```bash
sudo dcb app replace dev {{A_NETDEV}} dscp-prio {{ROCE_DSCP}}:{{ROCE_PRIO}}
dcb app show dev {{A_NETDEV}} dscp-prio
```

**What to observe:** after `--trust dscp`, `mlnx_qos` prints a `dscp2prio mapping` table. On
ConnectX the default map takes the top three bits of the DSCP as the priority, so DSCP 26 (binary
011010) already lands in priority 3, and DSCP 48 (CNPs, binary 110000) in priority 6. That is why
"DSCP 26 / priority 3" became a common convention: it works with the defaults. The explicit
`set` makes the intent visible and survives a different default. (The `--dscp2prio` option exists
on current `mlnx_qos` releases; if yours rejects it, check `mlnx_qos --help` and rely on the default
map.)

With `dcb`, there is no separate "trust" command in every iproute2 release. On mlx5, the driver
switches the port to DSCP trust when the first DSCP APP entry is added and back to PCP when the last
one is removed; other drivers can behave differently, so check your NIC's documentation. Newer
iproute2 releases add `dcb apptrust`; see `man dcb-apptrust` if your system has it.

> [!TIP]
> DSCP {{ROCE_DSCP}} in decimal is what switches and `dcb` use. Tools that set the whole IP
> traffic-class byte (perftest `--tclass`, `NCCL_IB_TC`, `cma_roce_tos`) need DSCP × 4 + ECN bits:
> {{TCLASS}} here. Mixing the two up is a classic way to land RoCE in the wrong queue.

### Task 3: PFC on priority {{ROCE_PRIO}}, and only there

```bash
sudo mlnx_qos -i {{A_NETDEV}} --pfc 0,0,0,1,0,0,0,0          # one flag per priority 0..7; this example is priority 3
```

or

```bash
sudo dcb pfc set dev {{A_NETDEV}} prio-pfc all:off {{ROCE_PRIO}}:on
dcb pfc show dev {{A_NETDEV}} prio-pfc
```

**Why only one priority:** PFC makes a priority lossless by letting a receiver stop its neighbour,
and the price is head-of-line blocking and, in the worst case, pause storms and deadlocks. You want
that trade only for RoCE. TCP, management and storage that recovers losses by itself stay in lossy
priorities. Enabling PFC on a priority the switch does not honour gives you a NIC that pauses a link
that never pauses back, which is worse than useless because it hides the mismatch.

Now apply the complete configuration on **both** hosts with the script, which does Tasks 2 and 3
plus ECN (Task 5) and prints the result:

```bash
sudo ./apply-qos.sh --dry-run      # show the commands first
sudo ./apply-qos.sh
```

### Task 4: Prove RoCE traffic uses the lossless priority

Configuration that looks right proves nothing until traffic shows it. Watch the per-priority
counters while a test runs with your traffic class. Host B (server):

```bash
ib_write_bw -d {{B_RDMA_DEV}} -x {{GID_INDEX}} -q 4 -D 20 -F --report_gbits --tclass={{TCLASS}}
```

Host A (client):

```bash
ib_write_bw -d {{A_RDMA_DEV}} -x {{GID_INDEX}} -q 4 -D 20 -F --report_gbits --tclass={{TCLASS}} {{B_IP}}
```

While it runs, on host B:

```bash
watch -d -n1 "ethtool -S {{B_NETDEV}} | grep -E 'rx_prio[0-7]_(bytes|pause)|tx_prio[0-7]_pause'"
```

Illustrative excerpt:

```
     rx_prio0_bytes: 18234
     rx_prio3_bytes: 241953488712
     rx_prio3_pause: 0
     tx_prio3_pause: 0
```

**What to observe:** the bytes accumulate on `rx_prio{{ROCE_PRIO}}_bytes`, not on priority 0. Now
run the same test **without** `--tclass`: the packets carry DSCP 0, so they land in priority 0, the
lossy class, even though everything "works". That is the most common silent misconfiguration in RoCE
fabrics: the lossless queue is configured perfectly and nothing uses it.

The `--tclass` option exists on recent perftest releases (check `ib_write_bw --help`). For NCCL,
the equivalent is `NCCL_IB_TC={{TCLASS}}`. For RDMA CM applications, NVIDIA's OFED/DOCA packages
include a `cma_roce_tos` script that sets a default traffic class per device; options vary between
versions, so check its usage text.

> [!NOTE]
> Expect **zero pause frames** here. A receiver only sends PFC when its receive buffer for that
> priority fills, and a single sender into a host that drains at line rate rarely gets there. Seeing
> PFC and ECN fire needs congestion: two senders into one receiver, which is the switch lab.

### Task 5: ECN and DCQCN on the host

In RoCEv2 congestion control (DCQCN), a congested switch **marks** packets (ECN CE) instead of
dropping them; the receiving NIC, the **notification point** (NP), sees the marks and sends a
**CNP** back to the sender; the sending NIC, the **reaction point** (RP), slows that QP down. PFC is
the emergency brake; ECN is the steering. Both NICs take part, so both need it enabled.

Some NVIDIA driver stacks expose per-priority switches in sysfs. Check whether yours does:

```bash
ls /sys/class/net/{{A_NETDEV}}/ecn/ 2>/dev/null || echo "not exposed by this driver stack"
cat /sys/class/net/{{A_NETDEV}}/ecn/roce_np/enable/{{ROCE_PRIO}} /sys/class/net/{{A_NETDEV}}/ecn/roce_rp/enable/{{ROCE_PRIO}} 2>/dev/null
```

If the files exist, `apply-qos.sh` has set both to `1` for priority {{ROCE_PRIO}}. If they do not,
your stack controls DCQCN another way (on many recent stacks it is enabled by default); check the
driver documentation for your release rather than guessing at paths.

The evidence of DCQCN at work lives in the RDMA hardware counters:

```bash
grep -H . /sys/class/infiniband/{{A_RDMA_DEV}}/ports/{{RDMA_PORT}}/hw_counters/{np_ecn_marked_roce_packets,np_cnp_sent,rp_cnp_handled,rp_cnp_ignored} 2>/dev/null
```

`np_*` counters move on the receiver (marked packets seen, CNPs sent), `rp_*` on the sender (CNPs
received and acted on). On an uncongested back-to-back link they stay at zero, which is the correct
answer. Remember the names: they are the first thing to look at in the switch lab.

### Task 6: Break the contract on purpose

On **host B only**, enable PFC on a second priority (with `mlnx_qos`, give a second `1`; with
`dcb`, add `4:on`), then re-run the check (next section) and read the failure. Put it back with
`sudo ./apply-qos.sh` on host B.

Then try the opposite mismatch: on host B, trust PCP instead of DSCP (`sudo mlnx_qos -i {{B_NETDEV}} --trust pcp`; with
`dcb`, delete the APP entry with `dcb app del dev {{B_NETDEV}} dscp-prio {{ROCE_DSCP}}:{{ROCE_PRIO}}`),
run the Task 4 traffic again and find which priority counter B now uses.

**Why:** these are exactly the drifts that configuration audits catch in production: one host
reimaged without its QoS profile, one host with an extra lossless priority. Traffic keeps flowing,
and the problem only appears under congestion, as drops or pauses on the wrong class.

## Verify

On host A:

```bash
cd {{AINA_DIR}}/labs
./hw-toolkit/aina-hw check hw-03-host-qos-pfc-ecn
```

The check reads (never changes) the QoS state of both hosts: DSCP trust (when the tool can show it),
PFC enabled on exactly priority {{ROCE_PRIO}}, DSCP {{ROCE_DSCP}} mapped to priority
{{ROCE_PRIO}}, and the ECN switches when the driver exposes them. Then it runs a 5-second,
4-QP `ib_write_bw --tclass={{TCLASS}}` from A to B and requires host B's
`rx_prio{{ROCE_PRIO}}_bytes` counter to grow by at least 100 MB. Import the saved result on the
[Connect page](#/hw/connect).

## Restore

On **each** host, when you are done (or before the break/fix lab, which expects your configured
state):

```bash
cd {{AINA_DIR}}/labs/hw-03-host-qos-pfc-ecn
sudo ./restore-qos.sh
```

It restores the saved trust mode, the PFC-enabled priorities, the saved mapping for DSCP
{{ROCE_DSCP}} (or removes the entry the lab added, with `dcb`) and the ECN switches, then moves the
saved state aside. It does not touch DSCP entries other than {{ROCE_DSCP}}: if you changed others by
hand, the saved `mlnx_qos.txt` / `dcb-app.txt` in the `.restored.*` directory shows what they were.
With `mlnx_qos`, the DSCP table may only be printed (and so saved) while trust is DSCP: if the host
trusted PCP before the lab, the DSCP {{ROCE_DSCP}} mapping the lab set can stay behind. It has no
effect while trust is PCP again; compare with the saved `mlnx_qos.txt` if you later switch to DSCP.

If you want to keep the lossless configuration for the next labs, skip this step: the
[break/fix](#/hw/labs/hw-04-break-fix-roce) and [switch](#/hw/labs/hw-06-switch-lossless-incast)
labs build on it. A reboot clears it either way unless you make it persistent with your
distribution's or NIC vendor's mechanism.

## What you learned

- Trust mode decides how a NIC classifies received packets; routed RoCEv2 uses DSCP.
- The DSCP-to-priority map and the PFC-enabled priority must agree on every NIC and switch.
- perftest `--tclass` and `NCCL_IB_TC` take the whole traffic-class byte: DSCP × 4 plus ECN bits.
- Per-priority counters (`rx_prioN_bytes`) are the proof that traffic uses the lossless class.
- No pause frames and no CNPs on an uncongested link is the correct result, not a failure.
- Save state before changing it, script the change, and keep the restore path tested.

## Going further

- Compare `mlnx_qos -i {{A_NETDEV}}` with `dcb ets show dev {{A_NETDEV}}`: ETS decides bandwidth
  shares between traffic classes. Read the [buffers, headroom and ETS](#/lesson/buffers-headroom-ets)
  lesson and find where your NIC maps priority {{ROCE_PRIO}}.
- Repeat Task 4 with other `--tclass` values (for example DSCP 0, or a DSCP that maps to another
  priority) and predict which `rx_prioN_bytes` counter moves before you look. (`tcpdump` on the
  host usually cannot show RoCE packets, including RDMA CM's, because the NIC sends and receives
  them without the kernel's network stack; a switch port mirror can.)
- Write the configuration into your node provisioning (systemd unit, NetworkManager dispatcher, or
  your vendor's persistence mechanism) and reboot to prove it survives.
