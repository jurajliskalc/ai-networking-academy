---
id: hw-10-ib-sm-failover
title: "Subnet manager failover: priorities, master and standby, and timing a takeover"
kind: handson
level: 3
estimated_minutes: 75
environment: hardware
tier: 1
fabric: ib
requires: [infiniband, two-rdma-hosts, root, ssh-mesh]
changes_config: true
lessons: [subnet-manager-routing, ib-architecture, ib-tools-diagnostics]
files: labs/hw-10-ib-sm-failover
verified: true
summary: "Run two OpenSMs with different priorities, identify master and standby with sminfo, kill the master and time the takeover, then see why the old master does not take its job back."
---

> [!NOTE]
> Verified end to end (every task, the check and the restore step) on 2026-10-23 on two ConnectX-5 VPI cards with port 2 in InfiniBand mode, cabled back to back (EDR DAC, no switch;
> ESXi VMs with PCI passthrough; Ubuntu 26.04.1, kernel 7.0.0-38, NVIDIA DOCA-OFED 3.4 with its OpenSM
> 5.27.1); see `labs/README.md`. With a switch-embedded SM or UFM the
> roles, priorities and timers are configured there instead.

## Goal

A production InfiniBand fabric never depends on one subnet manager. It runs two or more (on
switches, on UFM servers or on hosts), and exactly one of them is **master** while the others wait
in **standby**, watching it. In this lab you build that pair on host A (`{{HOST_A}}`) and host B
(`{{HOST_B}}`), kill the master, and measure what the fabric sees.

By the end you can:

- Start OpenSM with a priority and find master and standby with `sminfo`.
- Explain how a standby notices that the master is gone, and why that takes tens of seconds with
  OpenSM's defaults.
- Measure a takeover and show that ports stay `ACTIVE` while only the **SM LID** changes.
- Predict what a returning SM does, from its priority and OpenSM's `master_sm_priority`.

> [!NOTE]
> Output blocks labelled as a real capture come from the verification run: two ConnectX-5 ports in
> InfiniBand mode back to back (EDR), DOCA-OFED 3.4 with its OpenSM 5.27.1, host A at LID 1 and
> host B at LID 2. GUIDs, LIDs, activity counts and the exact takeover time on your fabric will differ.

## Before you start

- **Finish [hw-09](#/hw/labs/hw-09-infiniband-bringup) first**: both InfiniBand ports trained,
  OpenSM and `infiniband-diags` installed on **both** hosts (`labs/hw-toolkit/setup-rdma-host.sh
  --opensm` on each), and a profile with `FABRIC=ib` and your InfiniBand devices.
- **No other subnet manager.** If hw-09's OpenSM still runs, stop it (`sudo ./stop-sm.sh` in the
  hw-09 directory). On a managed switch fabric with an embedded SM or UFM, do this lab only on an
  isolated test fabric: a third SM with a high priority can take mastership from production.
- **Changes:** this lab starts one OpenSM per host with `lab-sm.sh`, which records the process it
  started and stops only that one. Nothing else on the hosts changes. Its log goes to
  `/var/log/opensm-aina.log`.
- `sminfo` and the SM need root. The check runs `sminfo` with `sudo -n`, so run `sudo -v` first.

## Tasks

### Task 1: Start the master and the standby

On **host A**, start OpenSM with priority 14:

```bash
cd {{AINA_DIR}}/labs/hw-10-ib-sm-failover
sudo ./lab-sm.sh start --role A --priority 14
```

On **host B**, start a second one with priority 13:

```bash
cd {{AINA_DIR}}/labs/hw-10-ib-sm-failover
sudo ./lab-sm.sh start --role B --priority 13
```

`lab-sm.sh` binds OpenSM to the lab port's GUID (`opensm -B -g <port GUID> -p <priority>`), so it
never picks another port of the host. Sample output on host B:

```text real=doca
+ opensm -B -g 0x1c34da0300002229 -p 13 -f /var/log/opensm-aina.log -J /var/lib/aina/state/ib-lab-sm/opensm.pid
sminfo: sm lid 1 sm guid 0x248a0703000011ef, activity count 58 priority 14 state 3 SMINFO_MASTER
OpenSM started on mlx5_1 port 1 (priority 13). Log: /var/log/opensm-aina.log
```

**Read it:** host B's own `sminfo` (with no LID, it asks the SM that its port knows, the
`SM lid`) already reports host A's SM as master. B's OpenSM started, discovered a master with a
higher priority and went into standby without touching the fabric.

### Task 2: Master and standby with `sminfo`

`sminfo` takes the LID of a port that runs an SM as an argument. First find the LIDs, then ask both:

```bash
ibstat {{A_RDMA_DEV}} {{RDMA_PORT}} | grep -E 'Base lid|SM lid'                  # host A
ssh {{HOST_B}} ibstat {{B_RDMA_DEV}} {{RDMA_PORT}} | grep -E 'Base lid|SM lid'   # host B's port
sudo sminfo -C {{A_RDMA_DEV}} -P {{RDMA_PORT}}               # the master, at the port's SM lid
sudo sminfo -C {{A_RDMA_DEV}} -P {{RDMA_PORT}} <LID of host B>
```

Sample output:

```text real=doca
Base lid: 1
SM lid: 1
Base lid: 2
SM lid: 1
sminfo: sm lid 1 sm guid 0x248a0703000011ef, activity count 59 priority 14 state 3 SMINFO_MASTER
sminfo: sm lid 2 sm guid 0x1c34da0300002229, activity count 24 priority 13 state 2 SMINFO_STANDBY
```

**Read it:**

- `state 3 SMINFO_MASTER` and `state 2 SMINFO_STANDBY` are the SMInfo states (1 is DISCOVERING,
  0 NOTACTIVE). The **activity count** of the master grows with every sweep; the standby's grows as
  it polls. Run the commands twice to see it.
- The priority (0-15) decides who is master; on a tie, the SM with the lower port GUID wins.
- Every port's `SM lid` points at the master: that is where ports send traps and where clients
  (IPoIB, rdma_cm, perftest's `-R`, MPI) send their SA queries for path records.

Then run the check (Verify section) while both SMs run.

### Task 3: Kill the master and time the takeover

On **host B**, start the watcher. It prints one line per second with B's port state, its `SM lid`
and what `sminfo` answers, and stops when a new master answers:

```bash
cd {{AINA_DIR}}/labs/hw-10-ib-sm-failover
sudo ./watch-sm.sh --role B --timeout 150
```

On **host A**, in a second session, kill the master SM:

```bash
cd {{AINA_DIR}}/labs/hw-10-ib-sm-failover
sudo ./lab-sm.sh stop
```

Sample watcher output (trimmed):

```text real=doca
watching mlx5_1 port 1: SM LID 1 at start; kill the master SM now (Ctrl-C to stop)
  0 s  ACTIVE     sm_lid 1   sminfo: sm lid 1 sm guid 0x248a0703000011ef, activity count 67 priority 14 state 3 SMINFO_MASTER
...
  6 s  ACTIVE     sm_lid 1   sminfo: sm lid 1 sm guid 0x248a0703000011ef, activity count 73 priority 14 state 3 SMINFO_MASTER
  8 s  ACTIVE     sm_lid 1   sminfo: iberror: failed: query
  9 s  ACTIVE     sm_lid 1   sminfo: iberror: failed: query
...
 58 s  ACTIVE     sm_lid 1   sminfo: iberror: failed: query
 59 s  ACTIVE     sm_lid 2   sminfo: sm lid 2 sm guid 0x1c34da0300002229, activity count 73 priority 14 state 3 SMINFO_MASTER
takeover: a new master SM (LID 2) answered 51 s after the first failed sminfo (at 8 s)
```

**Read it:**

- The port stays `ACTIVE` all along: losing the SM does not stop the data path (hw-09 Task 8).
  What fails for those seconds is everything that needs the SM: `sminfo`, and in a real cluster
  path-record queries, multicast joins, new LIDs for a rebooted node, rerouting around a failed link.
- The takeover took **about a minute**: 51, 54 and 58 seconds in three runs here, counted from
  the first failed `sminfo`. OpenSM's standby polls the master every
  `sminfo_polling_timeout` (10 000 ms by default) and declares it dead after `polling_retry_number`
  (4) failed polls; then it sweeps the fabric as the new master. Host B's log shows the five failed
  polls ten seconds apart, then the state change ten seconds after the last one:

  ```bash
  sudo grep -E 'ERR 3111|Entering (DISCOVERING|MASTER) state' /var/log/opensm-aina.log | tail -9    # host B
  ```

  ```text real=doca
  Oct 23 19:06:15 927796 [ED7F96C0] 0x01 -> log_rcv_cb_error: ERR 3111: Received MAD with error status = 0xC, additional status 0x0,
  Oct 23 19:06:25 927979 [ED7F96C0] 0x01 -> log_rcv_cb_error: ERR 3111: Received MAD with error status = 0xC, additional status 0x0,
  Oct 23 19:06:35 928898 [ED7F96C0] 0x01 -> log_rcv_cb_error: ERR 3111: Received MAD with error status = 0xC, additional status 0x0,
  Oct 23 19:06:45 929267 [ED7F96C0] 0x01 -> log_rcv_cb_error: ERR 3111: Received MAD with error status = 0xC, additional status 0x0,
  Oct 23 19:06:55 930191 [ED7F96C0] 0x01 -> log_rcv_cb_error: ERR 3111: Received MAD with error status = 0xC, additional status 0x0,
  Entering DISCOVERING state
  Oct 23 19:07:05 930178 [6EBFF6C0] 0x80 -> Entering DISCOVERING state
  Entering MASTER state
  Oct 23 19:07:05 939525 [EFFFE6C0] 0x80 -> Entering MASTER state
  ```

  (`error status = 0xC`: the HCA at the old master's port still answers, but with "this
  method/attribute combination is not supported", because no SM runs behind it.)
- Afterwards the port's `SM lid` is B's own LID. The new master reports **priority 14**, not the 13
  it was started with: OpenSM raises its priority to `master_sm_priority` (14 by default) when it
  becomes master. That matters in Task 4.

> [!VERIFIED]
> **With OpenSM's defaults, a standby needed 51-58 seconds to take over from a killed master.** On
> DOCA-OFED 3.4's OpenSM 5.27.1 (two ConnectX-5 EDR ports back to back), three runs measured 51, 54
> and 58 s from the first failed `sminfo`; the standby logged five `ERR 3111` SMInfo errors ten
> seconds apart before `Entering MASTER state`, and reported `priority 14` (`master_sm_priority`)
> instead of its configured 13. With `sminfo_polling_timeout 1000` and `polling_retry_number 2` the
> takeover took 3-4 s. Ports stayed `ACTIVE` throughout.

### Task 4: The old master comes back

On **host A**, start OpenSM again with the same priority 14:

```bash
sudo ./lab-sm.sh start --role A --priority 14
sleep 20
sudo sminfo -C {{A_RDMA_DEV}} -P {{RDMA_PORT}}
sudo sminfo -C {{A_RDMA_DEV}} -P {{RDMA_PORT}} <LID of host A>
```

Sample output:

```text real=doca
+ opensm -B -g 0x248a0703000011ef -p 14 -f /var/log/opensm-aina.log -J /var/lib/aina/state/ib-lab-sm/opensm.pid
sminfo: sm lid 2 sm guid 0x1c34da0300002229, activity count 121 priority 14 state 3 SMINFO_MASTER
OpenSM started on mlx5_1 port 1 (priority 14). Log: /var/log/opensm-aina.log
sminfo: sm lid 2 sm guid 0x1c34da0300002229, activity count 140 priority 14 state 3 SMINFO_MASTER
sminfo: sm lid 1 sm guid 0x248a0703000011ef, activity count 28 priority 14 state 2 SMINFO_STANDBY
```

**Read it:** host A is now the **standby**. Both SMs have priority 14 (B because it became master),
and B wins the tie with its lower port GUID. This is deliberate: a recovered SM does not grab the
fabric back, because every handover means a fresh sweep, and a flapping SM would otherwise
reconfigure the fabric on every flap. Real fabrics pin the roles with explicit priorities.

Now make host A preempt. Restart it with priority 15, higher than any master can reach by promotion:

```bash
sudo ./lab-sm.sh stop
sudo ./lab-sm.sh start --role A --priority 15
sudo sminfo -C {{A_RDMA_DEV}} -P {{RDMA_PORT}}
sudo sminfo -C {{A_RDMA_DEV}} -P {{RDMA_PORT}} <LID of host B>
```

Sample output:

```text real=doca
+ kill 52512    # the OpenSM started by lab-sm.sh
+ opensm -B -g 0x248a0703000011ef -p 15 -f /var/log/opensm-aina.log -J /var/lib/aina/state/ib-lab-sm/opensm.pid
sminfo: sm lid 1 sm guid 0x248a0703000011ef, activity count 64 priority 15 state 3 SMINFO_MASTER
OpenSM started on mlx5_1 port 1 (priority 15). Log: /var/log/opensm-aina.log
sminfo: sm lid 1 sm guid 0x248a0703000011ef, activity count 74 priority 15 state 3 SMINFO_MASTER
sminfo: sm lid 2 sm guid 0x1c34da0300002229, activity count 162 priority 13 state 2 SMINFO_STANDBY
```

**Read it:** A took over within about a second: on discovering a standby-eligible SM with a
higher priority, the master hands over (the SMInfo HANDOVER handshake), and B dropped back to
standby with its configured priority 13. A planned handover is fast; it is the **detection** of
a dead master that takes time.

### Task 5: Faster failure detection

Stop both SMs (host A, then host B):

```bash
sudo ./lab-sm.sh stop
```

Then start them again with `--fast`, which writes a two-line OpenSM config file
(`sminfo_polling_timeout 1000`, `polling_retry_number 2`) and passes it with `-F`. On **host A**:

```bash
sudo ./lab-sm.sh start --role A --priority 14 --fast
```

On **host B**:

```bash
sudo ./lab-sm.sh start --role B --priority 13 --fast
sudo ./watch-sm.sh --role B --timeout 60
```

On **host A**, while the watcher runs: `sudo ./lab-sm.sh stop`. Sample watcher output:

```text real=doca
  5 s  ACTIVE     sm_lid 1   sminfo: sm lid 1 sm guid 0x248a0703000011ef, activity count 78 priority 14 state 3 SMINFO_MASTER
  7 s  ACTIVE     sm_lid 1   sminfo: iberror: failed: query
  8 s  ACTIVE     sm_lid 1   sminfo: iberror: failed: query
  9 s  ACTIVE     sm_lid 1   sminfo: iberror: failed: query
 10 s  ACTIVE     sm_lid 2   sminfo: sm lid 2 sm guid 0x1c34da0300002229, activity count 70 priority 14 state 3 SMINFO_MASTER
takeover: a new master SM (LID 2) answered 3 s after the first failed sminfo (at 7 s)
```

**Read it:** the takeover now takes a few seconds. The parameters are the standby's (B's), since
the standby does the polling. Shorter is not automatically better: on a large fabric a busy or
briefly unreachable master would be declared dead, and two SMs fighting over mastership is worse
than a slow takeover. Vendors' and UFM's defaults are a trade-off; change them only with a reason
and the vendor's guidance. OpenSM's full option list is in `opensm --create-config <file>`, which
writes every option with its default and a comment.

## Verify

With the pair from Task 1 running (or after Task 4 or 5, as long as both hosts run an SM), on
host A:

```bash
cd {{AINA_DIR}}/labs
sudo -v
./hw-toolkit/aina-hw check hw-10-ib-sm-failover
```

The check confirms that both hosts run OpenSM, both ports are `ACTIVE` and point at the same SM LID,
that `sminfo` finds exactly one master and one standby, that the master's priority is not lower
than the standby's, and that the ports' SM LID is the master's.

## Restore

On **both** hosts:

```bash
cd {{AINA_DIR}}/labs/hw-10-ib-sm-failover
sudo ./lab-sm.sh stop
sudo ./lab-sm.sh status
```

`lab-sm.sh stop` kills only the OpenSM it started (from its pid file) and removes the `--fast`
config file. The ports stay `ACTIVE` without an SM until a link resets; start hw-09's
`start-sm.sh` again if you continue with other InfiniBand labs.

## What you learned

- One SM is master, the others are standby; `sminfo -C <ca> -P <port> <lid>` shows each SM's state,
  priority and activity count, and every port's `SM lid` points at the master.
- A standby detects a dead master by polling: with OpenSM's defaults (10 s, 4 retries) the takeover
  took 50-60 s, during which data kept flowing but nothing could be reconfigured.
- A master hands over quickly to an SM with a higher priority; a returning SM with an equal priority
  stays standby, because OpenSM raises a new master to `master_sm_priority` (14).
- Detection speed is a tunable trade-off (`sminfo_polling_timeout`, `polling_retry_number`), not a
  free win.

## Going further

- Start a third SM with priority 0 (on a fabric with another host) and watch which standby takes
  over when the master dies.
- Read [the subnet manager lesson](#/lesson/subnet-manager-routing) on what a heavy sweep does, then
  find the `HEAVY SWEEP` lines in `/var/log/opensm-aina.log` around a takeover.
- On a switch-managed fabric, compare with the switch's or UFM's high-availability settings (their
  names and defaults are vendor-specific; check the documentation of your release).
