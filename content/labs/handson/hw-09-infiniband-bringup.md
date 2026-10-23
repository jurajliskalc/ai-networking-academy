---
id: hw-09-infiniband-bringup
title: "InfiniBand bring-up: subnet manager, LIDs, fabric discovery and counters"
kind: handson
level: 3
estimated_minutes: 90
environment: hardware
tier: 1
fabric: ib
requires: [infiniband, two-rdma-hosts, root, ssh-mesh]
changes_config: true
lessons: [ib-architecture, subnet-manager-routing, ib-tools-diagnostics, ib-speeds-cables]
files: labs/hw-09-infiniband-bringup
verified: true
summary: "Watch an InfiniBand fabric come alive: ports stuck in INIT until a subnet manager assigns LIDs, then discovery, counters, ibping and RDMA bandwidth addressed by LID instead of IP."
---

> [!NOTE]
> Verified end to end (every task, the check and the restore step) on 2026-10-23 on two ConnectX-5
> VPI cards with port 2 in InfiniBand mode, cabled back to back (EDR DAC, no switch; ESXi VMs with PCI
> passthrough; Ubuntu 26.04.1, kernel 7.0.0-38, NVIDIA DOCA-OFED 3.4 with its OpenSM); see
> `labs/README.md`. Output with a switch (switch LIDs, `ibswitches`, routing) was not part of that run.

## Goal

Bring up a small InfiniBand fabric between host A (`{{HOST_A}}`) and host B (`{{HOST_B}}`), back to
back or through an InfiniBand switch, and see each step that a large fabric goes through at
power-on: links train, ports wait in `INIT`, a **subnet manager** (SM) sweeps the fabric and assigns
addresses, ports turn `ACTIVE`, and only then does RDMA traffic flow.

InfiniBand differs from Ethernet in exactly this point: it is a centrally managed fabric. No SM, no
fabric. Seeing that with your own eyes, and learning the diagnostic tools that go with it, is the
foundation for operating InfiniBand clusters of any size.

By the end you can:

- Explain the `INIT` versus `ACTIVE` port states and what the SM does in between.
- Run OpenSM, identify the master SM and read its state with `sminfo`.
- Discover the fabric with `ibnetdiscover`, `iblinkinfo`, `ibhosts` and `ibswitches`.
- Read and interpret port counters with `perfquery`, and test reachability with `ibping`.
- Run perftest over InfiniBand and explain why it needs no GID index.

> [!NOTE]
> Output blocks labelled as a real capture come from the verification run (DOCA-OFED 3.4; `mlx5_1` is
> the InfiniBand port, `mlx5_0` the RoCE port 1 of the same card; OpenSM on host A, LID 1; host B
> LID 2). Other output is **illustrative**. GUIDs, LIDs, rates, device names and versions on your
> fabric will differ.

## Before you start

- **Hardware:** two hosts with InfiniBand HCAs (or VPI adapters such as ConnectX set to InfiniBand
  mode), cabled back to back or through an InfiniBand switch.
  - **Managed switches** usually run an embedded SM (or the fabric is managed by NVIDIA UFM). In that
    case an SM already exists: do not start a second one unless you want to experiment with SM
    priorities, and skip to Task 3 after reading Task 2.
  - **Back to back or unmanaged switch:** you need an SM on one of the hosts. This lab runs OpenSM on
    host A.
- **VPI adapters in Ethernet mode:** if `link_layer` shows `Ethernet`, the port must be switched to
  InfiniBand first. With NVIDIA's MFT installed:

  ```bash
  sudo mst start && sudo mst status -v   # the PCI column gives the device, e.g. 03:00.0
  sudo mlxconfig -d <pci-address> query | grep LINK_TYPE
  sudo mlxconfig -d <pci-address> set LINK_TYPE_P1=1     # 1 = InfiniBand, 2 = Ethernet
  sudo mlxconfig -d <pci-address> -e q LINK_TYPE_P1      # Default, Current and Next Boot values
  ```

  > [!WARNING]
  > This writes the adapter's non-volatile configuration. It is **persistent**, takes effect only
  > after a firmware reset or reboot, and changes what every other lab sees. Only VPI adapters
  > support it; confirm the parameter name and values with `mlxconfig ... query` and your firmware
  > release notes. Switch back with `LINK_TYPE_P1=2` when you return to the RoCE labs.
  > In a **virtual machine** with the NIC passed through, neither a guest reboot nor a VM power
  > cycle applies it (`-e q` keeps showing Current `ETH(2)`, Next Boot `IB(1)`), and `mlxfwreset`
  > answers `-E- The tool is not supported on virtual machines.`: reboot the physical host. On a
  > dual-port VPI card you can switch one port only (`LINK_TYPE_P2`) and keep the other on Ethernet.

  Recent MFT addresses the adapter by PCI address or RDMA name (`mlxconfig -d 03:00.0 q`); `mst start`
  ending with `Unloading MST PCI module (unused)` is normal. On a host with **Secure Boot** (kernel
  lockdown), MFT cannot reach the adapter's configuration:
  `mlxconfig -d mlx5_0 q` or `-d <pci-address> q` prints `-E- Failed to open the device`, and even
  the `/dev/fwctl/fwctl0` path of recent kernels and MFT refuses NV configuration
  (`HW access is disabled`). Disable Secure Boot for the change (or use a signed MFT kernel module),
  then turn it back on.
- **Profile:** set `FABRIC` to `ib` on the [Connect page](#/hw/connect), with your RDMA devices. For
  InfiniBand the `*_NETDEV` fields are only used if you run IPoIB; host names (`HOST_A`,
  `HOST_B`) must resolve on the management network.
- **Software:** `labs/hw-toolkit/setup-rdma-host.sh --opensm` on host A (installs OpenSM and
  `infiniband-diags`), and `setup-rdma-host.sh` on host B. NVIDIA's OFED/DOCA stack ships its own
  versions of these tools; use those if installed.
- **Root:** OpenSM and some diagnostics need root.
- **Changes:** this lab starts a subnet manager on host A (Task 2). `start-sm.sh` records whether one
  was already running, and the Restore section stops it only if the lab started it.

## Tasks

### Task 1: Links up, fabric not ready

Before any SM runs (if your fabric has one, just observe the `ACTIVE` result), on both hosts:

```bash
ibstat {{A_RDMA_DEV}} {{RDMA_PORT}}          # host B: {{B_RDMA_DEV}}
```

Output without an SM (EDR, back to back):

```text real=doca
$ ibstat mlx5_1 1
CA: 'mlx5_1'
Port 1:
State: Initializing
Physical state: LinkUp
Rate: 100
Base lid: 65535
LMC: 0
SM lid: 0
Capability mask: 0x2651e848
Port GUID: 0x248a0703000011ef
Link layer: InfiniBand
```

(With a device and port given, `ibstat` prints this flat list; plain `ibstat` prints every CA with
indented `Port N:` blocks. The device is `mlx5_0` with NVIDIA's stack and named after the PCI
address, like `ibp59s0f0`, with distribution rdma-core: take it from `ibstat -l` or `rdma link`.)

Also: `ibstatus` (a compact summary script) and the raw sysfs view:

```bash
grep -H . /sys/class/infiniband/{{A_RDMA_DEV}}/ports/{{RDMA_PORT}}/{state,phys_state,lid,sm_lid,link_layer}
```

```text real=doca
$ grep -H . /sys/class/infiniband/mlx5_1/ports/1/{state,phys_state,rate,link_layer,lid,sm_lid,lid_mask_count,sm_sl,cap_mask}
/sys/class/infiniband/mlx5_1/ports/1/state:2: INIT
/sys/class/infiniband/mlx5_1/ports/1/phys_state:5: LinkUp
/sys/class/infiniband/mlx5_1/ports/1/rate:100 Gb/sec (4X EDR)
/sys/class/infiniband/mlx5_1/ports/1/link_layer:InfiniBand
/sys/class/infiniband/mlx5_1/ports/1/lid:0xffff
/sys/class/infiniband/mlx5_1/ports/1/sm_lid:0x0
...
```

If the far host is down or rebooting, the port does not even reach `LinkUp`: in the verification run
`rdma link` then showed `state DOWN physical_state POLLING` (the port keeps looking for a link
partner).

**Read it:** `Physical state: LinkUp` means the cable trained: electrically, the link is fine.
`State: Initializing` (`2: INIT` in sysfs) means the port is waiting for the SM. The LID is
unassigned (`ibstat` shows `Base lid: 65535`, sysfs and `ibstatus` `0xffff`; that value is also the
"permissive" LID, which is why `ibaddr` can answer with the peer's GID before an SM runs) and
`SM lid` is 0: nobody manages this subnet. RDMA traffic is impossible in this state. On a real
cluster, "links up but everything INIT" after a power event almost always means the SM is down or
cannot reach that part of the fabric.

### Task 2: Start a subnet manager

On host A, from the lab directory:

```bash
cd {{AINA_DIR}}/labs/hw-09-infiniband-bringup
sudo ./start-sm.sh
```

The script refuses to start OpenSM if `sminfo` already finds a master SM (pass `--force` to start a
second one anyway, for example to watch priorities), records what it did, and then starts OpenSM as
a system service if the package installed one, or as a background daemon with `opensm -B`
otherwise. Package and service names differ between distributions; on Debian and Ubuntu the packaged
service may need the port GUID set in its defaults file. If the service starts but ports stay in
`INIT`, stop it and run `sudo opensm -B` directly, which binds to a local port automatically
(`-g <port GUID>` chooses one explicitly; see `opensm --help` for your version).

Wait a few seconds, then on both hosts. The diagnostic tools (`sminfo`, `ibnetdiscover`, `perfquery`,
`ibping`, ...) open the **first** RDMA device unless told otherwise: on a host whose first device is a
RoCE port (here the other port of a VPI card) a bare `sudo sminfo` fails with `ibwarn: ...
client_register for mgmt 1 failed` / `Failed to open '(null)' port '0'`, so this lab always names the
InfiniBand device and port with `-C` and `-P`:

```bash
ibstat {{A_RDMA_DEV}} {{RDMA_PORT}}
sudo sminfo -C {{A_RDMA_DEV}} -P {{RDMA_PORT}}
```

Output on host A (which runs the SM, so its own port got LID 1):

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
$ sudo sminfo -C mlx5_1 -P 1
sminfo: sm lid 1 sm guid 0x248a0703000011ef, activity count 48 priority 0 state 3 SMINFO_MASTER
```

The capability mask changed from `0x2651e848` to `0x2651e84a`: the extra bit is IsSM, set on the
port the SM runs on. Host B shows its own LID (2 in this run) and the same `SM lid: 1`.

> [!VERIFIED]
> **DOCA-OFED names the OpenSM unit `opensmd.service`; there is no `opensm.service`.** On Ubuntu
> 26.04 with DOCA-OFED 3.4, `systemctl status opensm` printed `Unit opensm.service could not be
> found.`, while `systemctl status opensmd` showed `opensmd.service - OpenSM`, `Loaded: loaded
> (/usr/lib/systemd/system/opensmd.service; disabled; preset: enabled)`. Ubuntu's own `opensm`
> package is packaged differently, so check `systemctl list-unit-files | grep -i opensm` before
> scripting a start or stop. Starting the daemon by hand (`opensm -B`, with `-g <port GUID>` to
> bind it to the InfiniBand port) also worked in the verification run.

**What happened:** OpenSM discovered every node and port, assigned each port a **LID** (local
identifier, the 16-bit address used for forwarding inside a subnet), computed forwarding tables for
any switches, and moved the ports through ARMED to ACTIVE. `sminfo` shows the master SM's LID, its
priority and state; run it twice and the **activity count** should increase, proving the SM is
alive and sweeping. In production, two or more SMs run with different priorities, so a standby takes
over if the master fails.

### Task 3: Discover the fabric

```bash
sudo ibnetdiscover -C {{A_RDMA_DEV}} -P {{RDMA_PORT}} > /tmp/fabric-topology.txt; less /tmp/fabric-topology.txt
sudo ibhosts -C {{A_RDMA_DEV}} -P {{RDMA_PORT}}
sudo ibswitches -C {{A_RDMA_DEV}} -P {{RDMA_PORT}}
sudo iblinkinfo -C {{A_RDMA_DEV}} -P {{RDMA_PORT}}
```

Output on host A, back to back:

```text real=doca
$ sudo ibhosts -C mlx5_1 -P 1
Ca	: 0x1c34da0300002229 ports 1 "ESXI-2-UbuntuServer-1 mlx5_1"
Ca	: 0x248a0703000011ef ports 1 "ESXI-1-UbuntuServer-1 mlx5_1"
$ sudo ibswitches -C mlx5_1 -P 1
$ sudo iblinkinfo -C mlx5_1 -P 1
CA: ESXI-2-UbuntuServer-1 mlx5_1:
      0x1c34da0300002229      2    1[  ] ==( 4X      25.78125 Gbps Active/  LinkUp)==>       1    1[  ] "ESXI-1-UbuntuServer-1 mlx5_1" ( )
CA: ESXI-1-UbuntuServer-1 mlx5_1:
      0x248a0703000011ef      1    1[  ] ==( 4X      25.78125 Gbps Active/  LinkUp)==>       2    1[  ] "ESXI-2-UbuntuServer-1 mlx5_1" ( )
```

The node description is `<hostname> <device>`. `ibswitches` prints nothing without a switch, and
EDR appears in `iblinkinfo` as 4 lanes of 25.78125 Gbps. These tools discover by directed route, so
they already answer before the SM runs (`iblinkinfo` then shows `Initialize/  LinkUp` and LID 65535
on both ends).

**Read it:** `ibnetdiscover` walks the fabric with management datagrams and prints every node, port
and link: it is the InfiniBand equivalent of drawing your topology from LLDP, except that it works
from any host without access to the switches. `ibhosts` and `ibswitches` are filtered views.
`iblinkinfo` prints every switch port with its width, speed, state and the device on the other end:
the fastest way to find a link that trained at a lower width (for example `1X` instead of `4X`) or
speed. Back to back, you will see no switches and a single link.

### Task 4: Port counters with `perfquery`

On host A, read the local port, then the remote port by its LID (from `ibstat` on host B):

```bash
sudo perfquery -C {{A_RDMA_DEV}} -P {{RDMA_PORT}}
sudo perfquery -C {{A_RDMA_DEV}} -P {{RDMA_PORT}} -x <LID of host B> 1
```

Excerpt from host A's local port, after the verification run's bandwidth tests:

```text real=doca
$ sudo perfquery -C mlx5_1 -P 1
# Port counters: Lid 1 port 1 (CapMask: 0x5A00)
PortSelect:......................1
CounterSelect:...................0x0000
SymbolErrorCounter:..............0
LinkErrorRecoveryCounter:........0
LinkDownedCounter:...............0
PortRcvErrors:...................0
PortRcvRemotePhysicalErrors:.....0
PortRcvSwitchRelayErrors:........0
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
...
```

`PortXmitData` of the classic block is stuck at 4294967295 (2^32 - 1: the 32-bit counter
saturated), while `-x` shows the real 64-bit value for the same port.

**Read it:**

- Error counters (`SymbolErrorCounter`, `LinkErrorRecoveryCounter`, `LinkDownedCounter`,
  `PortRcvErrors`) should stay at or near zero and, above all, not grow. The
  [Link health lab](#/hw/labs/hw-05-link-health-optics) explains what a rising one means.
- `PortXmitDiscards` counts packets the port had to drop on transmit (for example because of
  congestion or a down path). `PortXmitWait` (on ports that support it) counts time spent waiting for
  credits: InfiniBand's equivalent of being paused.
- `-x` reads the **extended 64-bit** counters. Data counters are in units of **4 bytes**: multiply
  by 4 for bytes, read twice and divide the delta by the interval for throughput.
- `perfquery -r <lid> 1` reads and then **resets** the counters. On a lab fabric that is fine; on a
  shared one it erases evidence that monitoring or colleagues rely on, so prefer recording deltas.

Fabric-wide, `ibqueryerrors` scans every port and prints only those whose error counters exceed
thresholds (its options vary across `infiniband-diags` versions; see `ibqueryerrors --help`).
In the verification run it flagged both ports (for example `[PortXmitDiscards == 11] [PortXmitWait
== 65571]` on host A) and exited with status 1; without an SM it prints only `sa_get_handle: No
SM/SA found on port :1`.

### Task 5: Reachability without IP: `ibping`

On host B start a responder; on host A ping B's LID:

```bash
sudo ibping -C {{B_RDMA_DEV}} -P {{RDMA_PORT}} -S          # host B (Ctrl-C when done)
sudo ibping -C {{A_RDMA_DEV}} -P {{RDMA_PORT}} -c 5 <LID of host B>        # host A
```

Client output on host A (this capture used `-c 3`, and `-L`, which marks the address as a LID; see
`ibping --help`):

```text real=doca
$ sudo ibping -C mlx5_1 -P 1 -c 3 -L 2
Pong from ESXI-2-UbuntuServer-1.(none) (Lid 2): time 0.048 ms
Pong from ESXI-2-UbuntuServer-1.(none) (Lid 2): time 0.045 ms
Pong from ESXI-2-UbuntuServer-1.(none) (Lid 2): time 0.052 ms

--- ESXI-2-UbuntuServer-1.(none) (Lid 2) ibping statistics ---
3 packets transmitted, 3 received, 0% packet loss, time 3000 ms
rtt min/avg/max = 0.045/0.048/0.052 ms
```

Before an SM runs, host B's LID is 0xffff and the client fails with `ibping: iberror: failed:
can't resolve destination port 65535`.

**Why:** `ibping` uses InfiniBand management datagrams, so it tests the InfiniBand path itself,
independent of IPoIB or any IP configuration. When an application fails, `ibping` working tells you
the fabric layer is fine and the problem is higher up.

### Task 6: RDMA bandwidth over InfiniBand

Server on host B, client on host A:

```bash
ib_write_bw -d {{B_RDMA_DEV}} -i {{RDMA_PORT}} -F --report_gbits                 # host B
ib_write_bw -d {{A_RDMA_DEV}} -i {{RDMA_PORT}} -F --report_gbits {{HOST_B}}      # host A
```

Client output on host A (trimmed):

```text real=doca
$ ib_write_bw -d mlx5_1 -i 1 -F --report_gbits 192.0.2.12
---------------------------------------------------------------------------------------
                    RDMA_Write BW Test
 Dual-port       : OFF		Device         : mlx5_1
 Number of qps   : 1		Transport type : IB
 Connection type : RC		Using SRQ      : OFF
...
 Mtu             : 4096[B]
 Link type       : IB
 Max inline data : 0[B]
 rdma_cm QPs	 : OFF
 Data ex. method : Ethernet
...
---------------------------------------------------------------------------------------
 local address: LID 0x01 QPN 0x014c PSN 0x9b74b6 RKey 0x03df00 VAddr 0x007edbd6e34000
 remote address: LID 0x02 QPN 0x014a PSN 0x7b3292 RKey 0x23bf00 VAddr 0x00771145b11000
---------------------------------------------------------------------------------------
 #bytes     #iterations    BW peak[Gb/sec]    BW average[Gb/sec]   MsgRate[Mpps]
 65536      5000             94.79              94.79  		     0.180790
---------------------------------------------------------------------------------------
```

`Link type : IB`, no `GID index` line, and address lines that carry a LID but no `GID:` field.
`Data ex. method : Ethernet` is the TCP handshake described below. On a port still in `INIT` (no
SM) perftest stops with ` Port number 1 state is Init` / ` Couldn't set the link layer`.

**Two things to notice:**

1. **No `-x` GID index.** InfiniBand forwards by LID; the queue pairs exchange LIDs and QP numbers,
   and the GID (and its index) only matter when traffic leaves the subnet through a router. Compare
   with every RoCE lab, where choosing the GID was the most error-prone step.
2. **The address on the command line is only for the handshake.** perftest exchanges its connection
   details over a TCP socket before the RDMA traffic starts, so the client needs an IP path to the
   server: here the management network (`{{HOST_B}}`), or IPoIB if you configured it. The RDMA
   traffic itself flows over InfiniBand. Open TCP 18515 (or the port you pass with `-p`) between
   the hosts.

Compare the bandwidth with the port rate (`ibstat` `Rate:`) and repeat with `-q 4`. As with RoCE,
expect a few percent below link rate from headers and encoding, and check PCIe (Inventory lab) if
you are far below it. While it runs, watch `sudo perfquery -x` data counters rise.

### Task 7 (optional): `ibdiagnet`

If NVIDIA's OFED/DOCA stack or the `ibdiagnet` package is installed:

```bash
sudo ibdiagnet -i {{A_RDMA_DEV}} -p {{RDMA_PORT}}
```

It runs a full fabric check (discovery, duplicate GUID and LID checks, link speed and width checks,
counters, and more) and writes reports to a log directory it prints at the end (often under
`/var/tmp/ibdiagnet2/`). Start with the summary, then the per-check files. Options change between
versions; use `ibdiagnet --help` on your installation rather than flags from older guides.

### Task 8: Lose the SM, keep the fabric

With traffic running (`ib_write_bw ... -D 60` on both sides), stop the SM:

```bash
sudo ./stop-sm.sh            # host A, lab directory
```

**Observe:** the running test continues and ports stay `ACTIVE` (in the verification run the 60 s
test finished at 97.44 Gb/s with the SM stopped part-way; `sminfo` then failed with `iberror:
failed: query`). The SM configures the fabric; it
does not forward data. Without it, though, nothing **changes** safely: a link that flaps or a host
that reboots will come back in `INIT` and stay there. Start it again with `sudo ./start-sm.sh` for
the check.

## Verify

Make sure the SM is running (Task 2), then on host A:

```bash
cd {{AINA_DIR}}/labs
sudo -v          # cache your sudo credentials: the check runs sminfo with sudo -n
./hw-toolkit/aina-hw check hw-09-infiniband-bringup
```

The check confirms the InfiniBand tools and SSH, that both ports are `ACTIVE` with link layer
InfiniBand and a valid LID, that both hosts see the same non-zero SM LID, that `sminfo` finds a master
SM, and runs a 5-second `ib_write_bw` from A to B over InfiniBand (handshake via `HOST_B`).

## Restore

Stop OpenSM if this lab started it (the script does nothing if an SM was already running before):

```bash
cd {{AINA_DIR}}/labs/hw-09-infiniband-bringup
sudo ./stop-sm.sh
```

Without an SM, a back-to-back fabric falls back to `INIT` the next time a link resets. If your lab
depends on InfiniBand permanently, run OpenSM as an enabled system service instead. If you changed a
VPI adapter's `LINK_TYPE`, set it back before returning to the RoCE labs (and reset or reboot).

## What you learned

- InfiniBand ports train physically (`LinkUp`) but stay in `INIT` until a subnet manager assigns
  LIDs and activates them.
- `sminfo` identifies the master SM; a rising activity count shows it is alive.
- `ibnetdiscover`, `iblinkinfo`, `ibhosts` and `ibswitches` map the fabric from any host.
- `perfquery` reads per-port error and data counters (data in 4-byte units with `-x`); record deltas
  instead of resetting.
- `ibping` tests the InfiniBand layer without IP.
- perftest over InfiniBand needs no GID index; its TCP handshake still needs an IP path.

## Going further

- Start a second OpenSM on host B with a higher priority (`opensm --help` shows the priority option on
  your version) and watch with `sminfo` which one becomes master, then stop the master and time the
  takeover (about 53 s in our two-host run; see the
  [subnet manager lesson](#/lesson/subnet-manager-routing)).
- Read the [subnet manager and routing lesson](#/lesson/subnet-manager-routing) and look up which
  routing engine your OpenSM uses in its configuration file.
- Run `./hw-toolkit/aina-hw collect-all` and import the report on the [Connect page](#/hw/connect):
  the health review checks SM presence and LIDs on InfiniBand fabrics.
