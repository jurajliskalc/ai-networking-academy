---
id: hw-13-ibdiagnet-triage
title: "Fabric triage with ibdiagnet: LID routing, extended speeds and three faults to diagnose"
kind: handson
level: 3
estimated_minutes: 90
environment: hardware
tier: 1
fabric: ib
requires: [infiniband, two-rdma-hosts, root, ssh-mesh]
changes_config: true
lessons: [ib-tools-diagnostics, ib-speeds-cables, subnet-manager-routing, ib-architecture]
files: labs/hw-13-ibdiagnet-triage
verified: true
summary: "Run ibdiagnet and read its reports, follow a LID route and a path record, then diagnose a link that trained at FDR instead of EDR, a disabled port and a fabric with no subnet manager."
---

> [!NOTE]
> Verified end to end (every task, all three faults, the check and the restore step) on 2026-10-23
> on two ConnectX-5 VPI cards with port 2 in InfiniBand mode, cabled back to back (EDR DAC, no switch;
> ESXi VMs with PCI passthrough; Ubuntu 26.04.1, kernel 7.0.0-38, NVIDIA DOCA-OFED 3.4 with its OpenSM
> 5.27.1); see `labs/README.md`. Switch-related reports stayed empty (no switch).

## Goal

`ibdiagnet` is the first command an InfiniBand operator runs when "the fabric is slow" or "a node
cannot connect": one sweep checks discovery, LIDs, links, the SM, counters, speeds, widths,
partitions and firmware, and writes a set of report files. In this lab you run it on a healthy
fabric between host A (`{{HOST_A}}`) and host B (`{{HOST_B}}`), learn the addressing tools next to
it, and then diagnose three faults that a script injects on host B's InfiniBand port.

By the end you can:

- Run `ibdiagnet` on the right port, read its summary and find the detail in its report files.
- Follow a LID route with `ibtracert` and decode a path record from the SA.
- Read link speed correctly, including the **extended speed** fields where EDR lives.
- Recognize a degraded link, a disabled port and a missing SM from `ibstat`, `iblinkinfo` and
  `ibdiagnet`, and fix each.

> [!NOTE]
> Output blocks labelled as a real capture come from the verification run (two ConnectX-5 ports in
> InfiniBand mode back to back, EDR, DOCA-OFED 3.4 with ibutils2 `IBDIAGNET 2.26.0`; host A LID 1,
> host B LID 2). Other output is illustrative. Back to back there are no switches, so
> switch checks (forwarding tables, routing reports, switch counters) stay empty here; on a switched
> fabric the same reports list every switch port.

## Before you start

- **[hw-09](#/hw/labs/hw-09-infiniband-bringup) works** and the hw-10 directory provides
  `lab-sm.sh`. No other OpenSM may run on host A.
- **`ibdiagnet`** comes with NVIDIA's stack (package `ibutils2` in DOCA-OFED/MLNX_OFED). It is not in
  the distribution archives. Options change between versions: check `ibdiagnet --help`.
- **Changes:** `fault.sh` on host B changes only B's InfiniBand port, with local `ibportstate`
  commands (direct route `0`, so they work even while the link is down): it enables fewer speeds,
  disables the port or retrains the link. It refuses to run on a port whose link layer is not
  InfiniBand, so a RoCE port of the same adapter is never touched. `sudo ./fault.sh --restore`
  undoes the fault. Expect IPoIB and RDMA traffic on the IB port to stop during the faults.

## Tasks

### Task 1: A healthy fabric through ibdiagnet's eyes

Start the SM on host A and run `ibdiagnet` on the InfiniBand port (`-i <device> -p <port>`; without
them it may open a RoCE port of the same host):

```bash
cd {{AINA_DIR}}/labs/hw-10-ib-sm-failover
sudo ./lab-sm.sh start --role A
cd /tmp
sudo ibdiagnet -i {{A_RDMA_DEV}} -p {{RDMA_PORT}} > /tmp/ibdiagnet-baseline.txt
grep -E '^-[EW]-' /tmp/ibdiagnet-baseline.txt
sed -n '/^Fabric Summary/,$p' /tmp/ibdiagnet-baseline.txt
```

Sample output (trimmed):

```text real=doca
-W- FW Check finished with warnings
-W- ESXI-1-UbuntuServer-1/mlx5_1 - Node with Devid:4119(0x1017),PSID:MT_0000000008 has FW version 16.29.1016 while the latest FW version for the same Devid/PSID on this fabric is 16.34.1002
-W- Post Reports SM Configuration Validations finished with warnings
-W- Field 'AdaptiveTimeoutSLMask' has 2 different values across the fabric [0; 65535]
Fabric Summary

Total Nodes             : 2
IB Switches             : 0
IB Channel Adapters     : 2
...
Total number of links   : 1
Links at 4x25           : 1

Master SM: Port=1 LID=1 GUID=0x248a0703000011ef devid=4119 Priority:0 Node_Type=CA Node_Description=ESXI-1-UbuntuServer-1 mlx5_1
Standby SM : No Standby SM
...
Summary
-I- Stage                               Warnings   Errors     Comment
-I- Discovery                           0          0
-I- Lids Check                          0          0
-I- Links Check                         0          0
-I- Subnet Manager                      0          0
-I- Port Counters                       0          0
-I- Nodes Information                   1          0
-I- Speed / Width checks                0          0
-I- Virtualization                      0          0
-I- Partition Keys                      0          0
-I- Temperature Sensing                 0          0
-I- Routers                             0          0
-I- Post Reports Generation             1          0

-I- You can find detailed errors/warnings in: /var/tmp/ibdiagnet2/ibdiagnet2.log
```

**Read it:**

- The **Summary** table is the verdict: one row per stage with its warnings and errors. Start there,
  then read `-E-` lines first, `-W-` second. **`ibdiagnet` exits with status 0 even when stages
  report errors**: scripts must parse the summary, not the exit code (the check of this lab does;
  verified with `IBDIAGNET 2.26.0`, where a run with a `Speed / Width checks` error still returned 0).
- The warnings here are expected on a lab pair: two firmware versions on the same adapter model
  (`Nodes Information`), and an SM-related field that differs between the two ports. On a production
  fabric, a firmware warning is a real finding: mixed firmware is a classic source of odd behaviour.
- `Fabric Summary` counts nodes and links and names the master SM; `Links at 4x25` means one link,
  4 lanes at 25 Gb/s class (EDR).

The detail is in the report files:

```bash
ls /var/tmp/ibdiagnet2/
grep -v '^#' /var/tmp/ibdiagnet2/ibdiagnet2.sm | grep .
grep -v '^#' /var/tmp/ibdiagnet2/ibdiagnet2.iblinkinfo | grep .
grep -A16 'Port=1 Lid=0x0001' /var/tmp/ibdiagnet2/ibdiagnet2.pm
```

Sample output (trimmed):

```text real=doca
ibdiagnet2.db_csv
ibdiagnet2.debug
ibdiagnet2.iblinkinfo
ibdiagnet2.ibnetdiscover
ibdiagnet2.log
ibdiagnet2.lst
ibdiagnet2.net_dump
ibdiagnet2.nodes_info
ibdiagnet2.pkey
ibdiagnet2.pm
ibdiagnet2.rnc2
ibdiagnet2.sm
ibdiagnet2.vports
ibdiagnet2.vports_pkey
ibdiagnet fabric SM report
  SM - master
    Port=1 lid=0x0001 guid=0x248a0703000011ef dev=4119 priority:0
CA: ESXI-2-UbuntuServer-1 mlx5_1:
      0x1c34da0300002229      2              B94D0F1/1/1[  ] ==( 4X      25.78125 Gbps Active/  LinkUp)==>       1                        1[  ] "ESXI-1-UbuntuServer-1 mlx5_1" ( )
CA: ESXI-1-UbuntuServer-1 mlx5_1:
      0x248a0703000011ef      1                        1[  ] ==( 4X      25.78125 Gbps Active/  LinkUp)==>       2              B94D0F1/1/1[  ] "ESXI-2-UbuntuServer-1 mlx5_1" ( )
Port=1 Lid=0x0001 GUID=0x248a0703000011ef Device=4119 Port Name=ESXI-1-UbuntuServer-1/mlx5_1/P1
-------------------------------------------------------
link_down_counter=0x00000005
link_error_recovery_counter=0x00000000
symbol_error_counter=0x00000000
port_rcv_remote_physical_errors=0x00000000
port_rcv_errors=0x00000000
port_xmit_discard=0x0000000b
...
port_xmit_data=0xffffffff
port_rcv_data=0xffffffff
```

`ibdiagnet2.log` repeats every `-E-`/`-W-` line, `ibdiagnet2.db_csv` holds everything in CSV sections
(node, port and counter tables) for scripts, `ibdiagnet2.pkey` lists partitions and members (try it
after [hw-12](#/hw/labs/hw-12-ib-partitions)), and `ibdiagnet2.pm` the counters. ibdiagnet samples
counters twice (one second apart by default) and reports errors that **grew** between samples:
`port_xmit_discard=0x0000000b` and `link_down_counter=0x00000005` (from earlier link resets on this
pair) are history, not a current problem. The 32-bit data counters read `0xffffffff`: saturated,
as in hw-09; use the extended counters (`perfquery -x`) for data volumes.

### Task 2: LIDs, routes and path records

```bash
sudo ibtracert -C {{A_RDMA_DEV}} -P {{RDMA_PORT}} <LID of host A> <LID of host B>
sudo saquery -C {{A_RDMA_DEV}} -P {{RDMA_PORT}} --src-to-dst <LID of host A>:<LID of host B>
sudo smpquery -C {{A_RDMA_DEV}} -P {{RDMA_PORT}} portinfo <LID of host B> | grep -E 'LinkSpeed|LinkWidth|MTU'
```

Sample output:

```text real=doca
From ca {0x248a0703000011ef} portnum 1 lid 1-1 "ESXI-1-UbuntuServer-1 mlx5_1"
[1] -> ca port {0x1c34da0300002229}[1] lid 2-2 "ESXI-2-UbuntuServer-1 mlx5_1"
To ca {0x1c34da0300002229} portnum 1 lid 2-2 "ESXI-2-UbuntuServer-1 mlx5_1"
PathRecord dump:
		service_id..............0x0000000000000000
		dgid....................fe80::1c34:da03:0:2229
		sgid....................fe80::248a:703:0:11ef
		dlid....................2
		slid....................1
		hop_flow_raw............0x0
		tclass..................0x0
		num_path_revers.........0x80
		pkey....................0xFFFF
		qos_class...............0x0
		sl......................0x0
		mtu.....................0x85
		rate....................0x90
		pkt_life................0x92
		preference..............0x0
		resv2...................0x000000000000
LinkWidthEnabled:................1X or 4X
LinkWidthSupported:..............1X or 4X
LinkWidthActive:.................4X
LinkSpeedSupported:..............2.5 Gbps or 5.0 Gbps or 10.0 Gbps
LinkSpeedActive:.................10.0 Gbps
LinkSpeedEnabled:................2.5 Gbps or 5.0 Gbps or 10.0 Gbps
NeighborMTU:.....................4096
LinkSpeedExtActive:..............25.78125 Gbps
LinkSpeedExtSupported:...........14.0625 Gbps or 25.78125 Gbps
LinkSpeedExtEnabled:.............14.0625 Gbps or 25.78125 Gbps
LinkSpeedExtActive2:.............No Extended Speed 2
LinkSpeedExtSupported2:..........0
LinkSpeedExtEnabled2:............0
```

**Read it:**

- `ibtracert` follows the forwarding tables hop by hop from one LID to another. Back to back it is a
  single hop; through switches it prints every switch and port, which is how you find the path a
  flow takes (and the link to blame) on a fat tree.
- A **path record** is what an application gets from the SA before it connects (IPoIB, rdma_cm,
  MPI, NCCL): the LIDs, the P_Key, the SL, and `mtu 0x85` / `rate 0x90`. The top two bits are a
  selector (`2` = exactly), the rest the IBTA code: MTU code 5 = 4096 bytes, rate code 16 =
  100 Gb/s. A rate or MTU lower than expected in a path record explains a slow job even when every
  host looks fine.
- **Speed lives in two places.** `LinkSpeedActive: 10.0 Gbps` is the original field, which stops at
  QDR. EDR is in `LinkSpeedExtActive: 25.78125 Gbps` (and newer generations in the
  `...Ext...2` fields). Reading only the first field makes every modern link look like QDR.

`ibdiagnet` can also compare links against what you expect them to be:

```bash
sudo ibdiagnet -i {{A_RDMA_DEV}} -p {{RDMA_PORT}} --ls 25 --lw 4x | grep -E '^-E-|Speed / Width checks  '
sudo ibdiagnet -i {{A_RDMA_DEV}} -p {{RDMA_PORT}} --ls 50 --lw 4x | grep -E '^-E-|Speed / Width checks  '
```

Sample output:

```text
-I- Speed / Width checks                0          0
(--ls 50:)
-E- Links Speed Check finished with errors
-E- Link: ESXI-1-UbuntuServer-1/mlx5_1/P1<-->ESXI-2-UbuntuServer-1/mlx5_1/B94D0F1/1/1 - Unexpected actual link speed 25
-I- Speed / Width checks                0          1
```

With `--ls 50` (what you would expect on HDR), the EDR link is flagged: a simple way to audit a
whole fabric against its design.

### Task 3: Fault 1, "the job got slower"

On **host B**, inject the first fault:

```bash
cd {{AINA_DIR}}/labs/hw-13-ibdiagnet-triage
sudo ./fault.sh slow-link
```

Wait about 20 seconds for the link to come back, then investigate from **host A**:

```bash
ibstat {{A_RDMA_DEV}} {{RDMA_PORT}} | grep -E 'State|Rate'
sudo iblinkinfo -C {{A_RDMA_DEV}} -P {{RDMA_PORT}}
sudo ibdiagnet -i {{A_RDMA_DEV}} -p {{RDMA_PORT}} | grep -E '^-E-|Links at'
sudo smpquery -C {{A_RDMA_DEV}} -P {{RDMA_PORT}} portinfo <LID of host B> | grep -E 'LinkSpeedExt(Active|Enabled|Supported):'
```

And measure (server on host B, client on host A):

```bash
ib_write_bw -d {{B_RDMA_DEV}} -i {{RDMA_PORT}} -F --report_gbits -p 18615                   # host B
ib_write_bw -d {{A_RDMA_DEV}} -i {{RDMA_PORT}} -F --report_gbits -p 18615 {{HOST_B}}        # host A
```

Sample output:

```text real=doca
State: Active
Rate: 56
CA: ESXI-2-UbuntuServer-1 mlx5_1:
      0x1c34da0300002229      2    1[  ] ==( 4X       14.0625 Gbps Active/  LinkUp)==>       1    1[  ] "ESXI-1-UbuntuServer-1 mlx5_1" ( Could be 25.78125 Gbps)
CA: ESXI-1-UbuntuServer-1 mlx5_1:
      0x248a0703000011ef      1    1[  ] ==( 4X       14.0625 Gbps Active/  LinkUp)==>       2    1[  ] "ESXI-2-UbuntuServer-1 mlx5_1" ( Could be 25.78125 Gbps)
-E- Links Speed Check finished with errors
-E- Link: ESXI-1-UbuntuServer-1/mlx5_1/P1<-->ESXI-2-UbuntuServer-1/mlx5_1/B94D0F1/1/1 - Unexpected actual link speed 14 (enable_speed1="2.5 or 5 or 10 or 14 or 25 or FDR10", enable_speed2="2.5 or 5 or 10 or 14 or 25 or FDR10" therefore final speed should be 25)
Links at 4x14           : 1
LinkSpeedExtActive:..............14.0625 Gbps
LinkSpeedExtSupported:...........14.0625 Gbps or 25.78125 Gbps
LinkSpeedExtEnabled:.............14.0625 Gbps or 25.78125 Gbps
 #bytes     #iterations    BW peak[Gb/sec]    BW average[Gb/sec]   MsgRate[Mpps]
 65536      5000             52.19              52.18  		     0.099519
```

**Read it:** the port is `ACTIVE`, nothing is "down", and only the rate changed: `Rate: 56`, FDR,
4 x 14.0625 Gb/s, and RDMA bandwidth dropped from about 95 to 52 Gb/s. `iblinkinfo` says it directly
(`Could be 25.78125 Gbps`) and `ibdiagnet` explains it: both ends **enable** 14 and 25 Gb/s, so the
link should have trained at 25. The fault script enabled only FDR on B and retrained the link; the
SM then restored B's enabled speeds on its next sweep (OpenSM's `force_link_speed_ext` default),
but a link only renegotiates when it retrains. On real fabrics the same picture comes from a
marginal cable or optic, or a port that came up while its peer was being reconfigured.

> [!VERIFIED]
> **A link retrained at FDR stayed at FDR after the SM restored its enabled speeds.** On ConnectX-5
> EDR ports back to back (DOCA-OFED 3.4, OpenSM 5.27.1), enabling only 14.0625 Gb/s on one end and
> resetting the link gave `Rate: 56` and 52 Gb/s in `ib_write_bw`; OpenSM set `LinkSpeedExtEnabled`
> back to `14.0625 Gbps or 25.78125 Gbps` on its next sweep, but `LinkSpeedExtActive` stayed at
> 14.0625 Gbps until the next link reset. `iblinkinfo` printed `( Could be 25.78125 Gbps)`.

**Fix:** retrain the link, which here also undoes the fault:

```bash
sudo ./fault.sh --restore          # host B
```

On a real fabric the equivalent is a port reset (`ibportstate <lid> <port> reset` from a host, or
the switch's port commands); if the link comes back slow again, suspect the cable.

### Task 4: Fault 2, "node B is gone"

On **host B**:

```bash
sudo ./fault.sh port-disable
```

From **host A**:

```bash
ibstat {{A_RDMA_DEV}} {{RDMA_PORT}} | grep -E 'State|Physical'
sudo ibdiagnet -i {{A_RDMA_DEV}} -p {{RDMA_PORT}} | grep -E '^-E-|Discovering|Total Nodes'
ssh {{HOST_B}} "ibstat {{B_RDMA_DEV}} {{RDMA_PORT}} | grep -E 'State|Physical'"
```

Sample output:

```text real=doca
State: Down
Physical state: Polling
-E- Failed to initialize - Failed to set port of ibis object, err=Ibis could't find viable ports in the system
-I- Discovering ... 0 Nodes (0 Switches & 0 CAs) discovered.
-E- Fabric Discover failed, err=IBDiag initialize wasn't done
-E- Fabric Discover failed, MAD err=Ibis could't find viable ports in the system
Total Nodes             : 0
-E- A fatal error occurred, exiting...
State: Down
Physical state: Disabled
```

**Read it:** host A's port is `Down` / `Polling`: it is trying to train, but nobody answers.
`ibdiagnet` from A cannot even open its own port (`couldn't find viable ports`, sic) and exits with a
fatal error: with the local link down there is no fabric to discover. Host B shows the cause: physical state
**`Disabled`**, a port administratively switched off (by an SM, a switch command or `ibportstate`).
`Polling` on one end and `Disabled` on the other is the signature of a disabled peer; `Polling` on
both ends points at the cable or the optics.

**Fix:**

```bash
sudo ./fault.sh --restore          # host B
```

### Task 5: Fault 3, "nothing comes back after maintenance"

This time the SM fails first and a link retrains while it is down. On **host A**:

```bash
cd {{AINA_DIR}}/labs/hw-10-ib-sm-failover
sudo ./lab-sm.sh stop
```

On **host B**:

```bash
cd {{AINA_DIR}}/labs/hw-13-ibdiagnet-triage
sudo ./fault.sh link-reset
```

Wait 30 seconds, then from **host A**:

```bash
ibstat {{A_RDMA_DEV}} {{RDMA_PORT}} | grep -E 'State|lid'
sudo iblinkinfo -C {{A_RDMA_DEV}} -P {{RDMA_PORT}}
sudo ibdiagnet -i {{A_RDMA_DEV}} -p {{RDMA_PORT}} | grep -E '^-E-|Master SM'
ssh {{HOST_B}} "ibstat {{B_RDMA_DEV}} {{RDMA_PORT}} | grep -E 'State|lid'"
```

Sample output:

```text real=doca
State: Initializing
Base lid: 1
SM lid: 1
CA: ESXI-2-UbuntuServer-1 mlx5_1:
      0x1c34da0300002229      2    1[  ] ==( 4X      25.78125 Gbps Initialize/  LinkUp)==>       1    1[  ] "ESXI-1-UbuntuServer-1 mlx5_1" ( )
CA: ESXI-1-UbuntuServer-1 mlx5_1:
      0x248a0703000011ef      1    1[  ] ==( 4X      25.78125 Gbps Initialize/  LinkUp)==>       2    1[  ] "ESXI-2-UbuntuServer-1 mlx5_1" ( )
-E- Links Check finished with errors
-E- Link: ESXI-1-UbuntuServer-1/mlx5_1/P1<-->ESXI-2-UbuntuServer-1/mlx5_1/B94D0F1/1/1 - Link logical state is INI
-E- Subnet Manager Check finished with errors
-E- Not found master subnet manager in fabric
Master SM  : No Master SM
State: Down
Base lid: 2
SM lid: 1
```

**Read it:** the link trained (`LinkUp`) but the logical state is `INIT` (`Initialize` in
`iblinkinfo`, `INI` in `ibdiagnet`), and `ibdiagnet` finds no master SM. The ports keep their old
LIDs, but without an SM nothing activates them. This is hw-09 Task 1 again, now in the form you
meet it in production: after a power event or maintenance window, "links up, everything INIT"
means the SM is down or cannot reach that part of the fabric.

> [!NOTE]
> Host B's own `ibstat` reported `State: Down` for its port during this run, while `iblinkinfo`
> and `ibdiagnet` (which ask the port over the fabric) showed it in `Initialize`. The driver's view
> of its own port can lag behind the hardware's; when they disagree, believe the MAD-based tools.

**Fix:** start the SM again on host A:

```bash
sudo ./lab-sm.sh start --role A
sleep 5
ibstat {{A_RDMA_DEV}} {{RDMA_PORT}} | grep State
```

## Verify

With the SM running on host A and every fault restored, on host A:

```bash
cd {{AINA_DIR}}/labs
sudo -v
./hw-toolkit/aina-hw check hw-13-ibdiagnet-triage
```

The check confirms both ports are `ACTIVE`, runs `ibdiagnet` into a temporary directory and fails
on any stage with errors (it parses the summary, since the exit status is always 0), requires a
master SM in the fabric summary, and fails if `iblinkinfo` reports a link below its capability
(`Could be ...`).

## Restore

On **host B**:

```bash
cd {{AINA_DIR}}/labs/hw-13-ibdiagnet-triage
sudo ./fault.sh --restore
sudo ./fault.sh --status
```

On **host A**:

```bash
cd {{AINA_DIR}}/labs/hw-10-ib-sm-failover
sudo ./lab-sm.sh stop
rm -f /tmp/ibdiagnet-baseline.txt
```

`/var/tmp/ibdiagnet2/` keeps the last report; delete it if you like. Without an SM the ports stay
`ACTIVE` until a link resets.

## What you learned

- `ibdiagnet -i <dev> -p <port>` sweeps the whole fabric; read the Summary table first, then `-E-`
  and `-W-` lines, then the report files. Its exit status does not reflect errors.
- `ibtracert` shows the LID route, `saquery --src-to-dst` the path record an application receives
  (MTU and rate as IBTA codes), `smpquery portinfo` the raw port state including extended speeds.
- A degraded link stays `ACTIVE` at a lower rate: `iblinkinfo`'s `Could be` and ibdiagnet's speed
  check catch it, and only a retrain fixes it.
- `Polling` against `Disabled` means a disabled peer; `LinkUp` plus `INIT` means no SM.

## Going further

- Run `ibdiagnet` with `--pc` to reset counters, generate traffic with `ib_write_bw`, and run it
  again: which counters does it report now?
- On a switched fabric, add `-r` for routing checks and read `ibdiagnet2.lst` and the forwarding
  table reports; `ibtracert` between two hosts on different leaves shows the spine they cross.
- Read the [diagnostics lesson](#/lesson/ib-tools-diagnostics) and map every tool used here to the
  layer it tests.
