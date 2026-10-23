---
id: hw-06-switch-lossless-incast
title: "Lossless switch fabric under incast: PFC, ECN and CNPs on real gear"
kind: handson
level: 4
estimated_minutes: 180
environment: hardware
tier: 2
fabric: roce
requires: [three-rdma-hosts, lossless-switch, root, ssh-mesh]
changes_config: true
lessons: [incast-and-congestion-hotspots, pfc-priority-flow-control, ecn-and-dcqcn, buffers-headroom-ets, rocev2-configuration-end-to-end, pfc-storms-deadlocks, telemetry-counters, lossless-misconfigurations]
files: labs/hw-06-switch-lossless-incast
verified: false
summary: "Configure your switch for lossless RoCE, fire a two-to-one RDMA incast, and read PFC pauses, ECN marks and CNPs on the switch and the NICs. Then take ECN and PFC away and watch what each one was doing."
---

## Goal

Two senders, one receiver, one switch: the smallest network that produces **real congestion**.
Hosts **A** (`{{HOST_A}}`) and **C** (`{{HOST_C}}`) both write as fast as they can into host **B**
(`{{HOST_B}}`, `{{B_IP}}`). The switch port towards B (`{{B_SWITCH_PORT}}` on `{{SWITCH}}`) has
to carry twice its line rate, its queue fills, and the fabric has to decide what to do:

- **ECN:** the switch marks packets in the RoCE queue, B (the notification point) returns CNPs, and
  the NICs of A and C (reaction points) slow down. This is DCQCN, the steering.
- **PFC:** if the queue still grows past its threshold, the switch pauses priority
  {{ROCE_PRIO}} on the ports facing A and C. This is the emergency brake that keeps RoCE lossless.
- **Neither:** packets are dropped, and B's sequence-error counters tell you so.

By the end you can:

- Configure a switch's lossless RoCE class and match it to the hosts.
- Generate a measurable incast and read its evidence on switch and NIC counters.
- Explain, with your own numbers, what ECN and PFC each contribute.
- Roll the switch back to its previous configuration.

> [!NOTE]
> Command output here is **illustrative**. Switch commands and counter layouts differ between NOS
> releases, and RDMA counter names differ between NIC drivers (the examples use NVIDIA ConnectX
> names). Where this lab says "check your release's documentation", it means it.

## Before you start

- **Done first:** [Host-side lossless QoS](#/hw/labs/hw-03-host-qos-pfc-ecn), applied on **all
  three** hosts (run its `apply-qos.sh` on host C too). The hosts must stamp DSCP {{ROCE_DSCP}} and
  map it to priority {{ROCE_PRIO}}, or the switch configuration below has nothing to act on.
- **Hardware:** three RDMA hosts on one switch, all ports at the same speed. (If B's port were
  faster than the senders' ports, there would be no congestion to observe.)
- **Profile:** `HOST_COUNT=3`, `SWITCH_OS` and the three switch ports set on the
  [Connect page](#/hw/connect).
- **Switch access** with permission to change QoS, and its documentation for your NOS release.
- **Changes:** switch QoS and buffer configuration. Applying QoS buffer changes can briefly
  disrupt traffic on **every** port of the switch. Use a lab switch, or a maintenance window.

> [!WARNING]
> Never run this on a switch that also carries production traffic. A misconfigured lossless class
> can spread pauses to other ports (head-of-line blocking) and, in a larger fabric, deadlock.

## Tasks

### Task 1: Back up the switch configuration

**Cumulus Linux (NVUE):**

```bash
nv config history | head            # note the current applied revision
nv config show -o commands > ~/pre-hw06-commands.txt
```

**SONiC:**

```bash
sudo cp /etc/sonic/config_db.json ~/config_db.pre-hw06.json
show runningconfiguration all > ~/running.pre-hw06.json
```

**Other NOS:** save the running configuration to a file you can restore, using your NOS's normal
backup procedure.

**Why first:** QoS on a switch is a dense web of maps, buffer pools and thresholds. Undoing it from
memory is how labs end up with a switch nobody trusts.

### Task 2: Configure the lossless RoCE class

**Cumulus Linux** has a built-in RoCE profile that sets trust, PFC, ECN and buffers in one step:

```bash
nv set interface {{A_SWITCH_PORT}} link mtu 9216
nv set interface {{B_SWITCH_PORT}} link mtu 9216
nv set interface {{C_SWITCH_PORT}} link mtu 9216
nv set qos roce
nv set qos roce mode lossless
nv config diff        # read it before applying
nv config apply
nv show qos roce
```

Read `nv show qos roce` carefully: it tells you which priority is lossless, which DSCP values map to
it and to the CNP priority, and the ECN thresholds. The defaults are release-specific; your hosts
must match them (priority {{ROCE_PRIO}}, DSCP {{ROCE_DSCP}}, CNPs at DSCP {{CNP_DSCP}} in your
profile). If they disagree, change the hosts (re-run `apply-qos.sh` with an updated profile) rather
than fighting the switch's defaults.

**SONiC:** on many platforms the default QoS templates already make priorities 3 and 4 lossless, map
DSCP to them and enable ECN on those queues. Verify rather than assume:

```bash
show runningconfiguration all | grep -A12 PORT_QOS_MAP     # pfc_enable per port, dscp_to_tc_map
show pfcwd config
```

If PFC is not enabled on your ports, the fix is in the port's `PORT_QOS_MAP` entry and the buffer
profiles for your HwSKU; follow your platform vendor's SONiC QoS guide (`sudo config qos reload`
regenerates QoS and buffers from the templates and overwrites manual edits). Check that the MTU of
the three ports is 9216 (`show interfaces status`).

**Other NOS:** configure the same contract. The checklist:

| Item | Value for this lab |
|---|---|
| Classification | trust DSCP on the host-facing ports |
| DSCP map | {{ROCE_DSCP}} to the lossless traffic class, {{CNP_DSCP}} to a high-priority class |
| PFC | enabled on priority {{ROCE_PRIO}} only, on the ports facing A, B and C |
| ECN | WRED/ECN marking enabled on the RoCE queue, thresholds below the PFC threshold |
| Buffers | lossless headroom for the cable length and speed of each port |
| Scheduling | ETS share for the RoCE class; CNP class strict or high priority |
| PFC watchdog | enabled, so a stuck receiver cannot pause the switch forever |
| MTU | 9216 on the three ports |

The [end-to-end RoCE configuration](#/lesson/rocev2-configuration-end-to-end) and
[buffers, headroom and ETS](#/lesson/buffers-headroom-ets) lessons explain each line.

### Task 3: Baseline: one sender, no congestion

Run a single A to B test first, with your traffic class:

```bash
ib_write_bw -d {{B_RDMA_DEV}} -x {{GID_INDEX}} -q 4 -D 10 -F --report_gbits --tclass={{TCLASS}}               # host B
ib_write_bw -d {{A_RDMA_DEV}} -x {{GID_INDEX}} -q 4 -D 10 -F --report_gbits --tclass={{TCLASS}} {{B_IP}}      # host A
```

and read the switch counters for the three ports:

```bash
nv show interface {{B_SWITCH_PORT}} qos roce counters        # Cumulus
show pfc counters                                            # SONiC
show queue counters                                          # SONiC: which queue carried the bytes
```

**Expect:** near line rate, no ECN marks, and no PFC frames from the switch towards A. One sender
into one equally fast receiver does not congest the switch. Host B's NIC may still send a few
pauses of its own towards the switch (`tx_prio{{ROCE_PRIO}}_pause` on B), as it did back to back in
the host QoS lab: that is the receiving NIC's buffer, not fabric congestion. Write the counter
values down: they are your "before".

### Task 4: Fire the incast

From host A:

```bash
cd {{AINA_DIR}}/labs/hw-06-switch-lossless-incast
./incast.sh 15
```

The script starts two `ib_write_bw` servers on B (TCP ports 18610 and 18611), then A and C send at
the same time with 4 QPs each and `--tclass={{TCLASS}}`, and it prints how the counters moved.
Illustrative output:

```
counter (host:name)                delta
A:rp_cnp_handled                   48211
A:rx_prio3_pause                   1290
B:np_cnp_sent                      97730
B:np_ecn_marked_roce_packets       1854204
B:out_of_sequence                  0
B:packet_seq_err                   0
B:tx_prio3_pause                   0
C:rp_cnp_handled                   49519
C:rx_prio3_pause                   1307
A -> B bandwidth (Gb/s)            47.9
C -> B bandwidth (Gb/s)            47.6
```

**Read it:**

- The two senders share B's link roughly evenly, and the sum stays a little below one line rate.
- `np_ecn_marked_roce_packets` on B: packets that arrived with the CE mark the switch set.
- `np_cnp_sent` on B and `rp_cnp_handled` on A and C: the CNPs and the senders reacting to them.
- `rx_prio{{ROCE_PRIO}}_pause` on A and C: PFC frames the **switch** sent to the senders. A healthy
  DCQCN setup keeps these low because ECN acts first; zero is possible with generous buffers.
- `out_of_sequence` and `packet_seq_err` on B stay at zero: nothing was dropped.

On the switch, during a run, the port towards B shows ECN marks and the ports towards A and C show
transmitted PFC frames (`nv show interface {{A_SWITCH_PORT}} qos roce counters`, or
`show pfc counters` on SONiC). The pauses go **upstream** towards the senders, never towards B.

### Task 5: Take ECN away: PFC does all the work

On host **B** only, disable the notification point for priority {{ROCE_PRIO}}, if your driver
exposes the switch (see Task 5 of the host QoS lab: these sysfs files exist only with NVIDIA's
MLNX_OFED / DOCA-Host stack, not with the inbox mlx5 driver):

```bash
cat /sys/class/net/{{B_NETDEV}}/ecn/roce_np/enable/{{ROCE_PRIO}}               # note the value (1)
echo 0 | sudo tee /sys/class/net/{{B_NETDEV}}/ecn/roce_np/enable/{{ROCE_PRIO}}
```

Run `./incast.sh 15` again. Then put it back:

```bash
echo 1 | sudo tee /sys/class/net/{{B_NETDEV}}/ecn/roce_np/enable/{{ROCE_PRIO}}
```

**Observe:** B still sees marked packets but sends no CNPs, so the senders never slow down. The
switch queue sits at its PFC threshold and the pause counters on A and C climb by orders of
magnitude. Bandwidth may look similar on this tiny network, but every pause also stops any other
traffic that shares priority {{ROCE_PRIO}} on those links. In a larger fabric, that is how
congestion spreads to innocent flows. If the per-priority ECN files do not exist on your stack,
read the expected result in the [ECN and DCQCN](#/lesson/ecn-and-dcqcn) lesson instead; do not
change ECN thresholds on the switch to imitate it unless you know your NOS's syntax.

### Task 6: Take PFC away: the fabric stops being lossless

On Cumulus, switch the RoCE profile to lossy mode (ECN only, no PFC):

```bash
nv set qos roce mode lossy
nv config apply
nv show qos roce
```

On SONiC or another NOS, disable PFC for priority {{ROCE_PRIO}} on the three ports with the
command your release documents (on SONiC, the port's `pfc_enable` list in `PORT_QOS_MAP`).
Then run `./incast.sh 15` and, to make it harsher, a version with more QPs by hand.

**Observe:** with DCQCN still active, losses may be rare: ECN alone controls a two-to-one incast
fairly well. If B's `out_of_sequence` or `packet_seq_err` counters move, every one of those is a
dropped packet that forced a retransmission (go-back-N on many RoCE NICs; newer generations can
retransmit selectively), and the bandwidth numbers usually show
it. That is the difference PFC buys: not speed, but the guarantee that the transport never needs
its slow recovery path. Restore lossless mode before you continue:

```bash
nv set qos roce mode lossless
nv config apply
```

### Task 7: Look at buffers and the watchdog

```bash
show priority-group watermark headroom      # SONiC: peak headroom use per priority group
show priority-group watermark shared
show pfcwd stats                            # storms detected must be zero
```

On Cumulus, `nv show qos roce` and your release's buffer commands show the equivalent. Headroom is
the buffer that absorbs the data still in flight after the switch sends a pause (cable length,
speed, MTU and response time). If its peak use approaches its size, lossless drops are close. Any
PFC watchdog storm is an incident to explain, not a counter to clear.

## Verify

From host A:

```bash
cd {{AINA_DIR}}/labs
./hw-toolkit/aina-hw check hw-06-switch-lossless-incast
```

The check requires a three-host profile and SSH to B and C, confirms all three RDMA ports are
ACTIVE, and runs a 10-second incast. It passes when both senders complete, congestion control is
visibly active (B marked packets or sent CNPs, or the senders received PFC pauses on priority
{{ROCE_PRIO}}) and host B counted **no** sequence errors. Aggregate bandwidth is reported for
information. Import the result on the [Connect page](#/hw/connect).

## Restore

**Switch, Cumulus Linux:** remove the lab's QoS and MTU settings, review, apply:

```bash
nv unset qos roce
nv unset interface {{A_SWITCH_PORT}} link mtu
nv unset interface {{B_SWITCH_PORT}} link mtu
nv unset interface {{C_SWITCH_PORT}} link mtu
nv config diff
nv config apply
nv config save
```

Compare with `~/pre-hw06-commands.txt`. If your switch had QoS settings before the lab, re-apply
those lines instead; `nv config history` shows earlier revisions and your release's NVUE guide
describes how to return to one.

**Switch, SONiC:** load the backup and save it (check `config reload --help` on your release; a
reload restarts services and interrupts traffic):

```bash
sudo config reload ~/config_db.pre-hw06.json -y
sudo config save -y
```

**Other NOS:** restore the configuration you saved in Task 1.

**Hosts:** if you disabled ECN in Task 5, make sure it is back to its noted value. To remove the
host QoS configuration as well, run `sudo ./restore-qos.sh` in `labs/hw-03-host-qos-pfc-ecn` on
each host.

## What you learned

- Incast is the normal traffic shape of collectives; two senders and one receiver are enough to
  study it.
- ECN plus CNPs (DCQCN) slows senders before queues fill; PFC is the backstop that keeps the queue
  from dropping.
- Pauses travel upstream towards the senders; marks and CNPs show up at the receiver.
- Without ECN, PFC carries the whole load and spreads congestion; without PFC, drops force
  retransmissions through the slow recovery path.
- Receiver sequence-error counters are the ground truth for "was it lossless".
- Back up, diff and roll back switch QoS like any other change.

## Going further

- Raise the QP count on both senders (`-q 16`) and compare the pause counts.
- Add a TCP flow (`iperf3`) from C to B on the default priority during the incast, and check that it
  does not get paused: that is ETS and per-priority PFC doing their job.
- Read [PFC storms and deadlocks](#/lesson/pfc-storms-deadlocks) and work out which topology change
  in your lab could create a deadlock loop, and why a single switch cannot.
