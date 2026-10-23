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
verified: false
summary: "Watch an InfiniBand fabric come alive: ports stuck in INIT until a subnet manager assigns LIDs, then discovery, counters, ibping and RDMA bandwidth addressed by LID instead of IP."
---

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
> Command output in this lab is **illustrative**. GUIDs, LIDs, rates and versions on your fabric
> will differ.

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
  sudo mst start && sudo mst status
  sudo mlxconfig -d /dev/mst/<your device> query | grep LINK_TYPE
  sudo mlxconfig -d /dev/mst/<your device> set LINK_TYPE_P1=1     # 1 = InfiniBand, 2 = Ethernet
  ```

  > [!WARNING]
  > This writes the adapter's non-volatile configuration. It is **persistent**, takes effect only
  > after a firmware reset or reboot, and changes what every other lab sees. Only VPI adapters
  > support it; confirm the parameter name and values with `mlxconfig ... query` and your firmware
  > release notes. Switch back with `LINK_TYPE_P1=2` when you return to the RoCE labs.

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

Illustrative output without an SM:

```
CA: 'mlx5_0'
Port 1:
State: Initializing
Physical state: LinkUp
Rate: 200
Base lid: 65535
LMC: 0
SM lid: 0
Capability mask: 0x...
Port GUID: 0x...
Link layer: InfiniBand
```

(With a device and port given, `ibstat` prints this flat list; plain `ibstat` prints every CA with
indented `Port N:` blocks. The device is `mlx5_0` with NVIDIA's stack and named after the PCI
address, like `ibp59s0f0`, with distribution rdma-core: take it from `ibstat -l` or `rdma link`.)

Also: `ibstatus` (a compact summary script) and the raw sysfs view:

```bash
grep -H . /sys/class/infiniband/{{A_RDMA_DEV}}/ports/{{RDMA_PORT}}/{state,phys_state,lid,sm_lid,link_layer}
```

**Read it:** `Physical state: LinkUp` means the cable trained: electrically, the link is fine.
`State: Initializing` (`2: INIT` in sysfs) means the port is waiting for the SM. The LID is
unassigned (shown as 0 or the "permissive" `65535`/`0xffff`, depending on tool and driver) and
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

Wait a few seconds, then on both hosts:

```bash
ibstat {{A_RDMA_DEV}} {{RDMA_PORT}}
sudo sminfo
```

Illustrative output:

```
State: Active
Physical state: LinkUp
...
Base lid: 2
LMC: 0
SM lid: 1
...
sminfo: sm lid 1 sm guid 0x..., activity count 1290 priority 0 state 3 SMINFO_MASTER
```

**What happened:** OpenSM discovered every node and port, assigned each port a **LID** (local
identifier, the 16-bit address used for forwarding inside a subnet), computed forwarding tables for
any switches, and moved the ports through ARMED to ACTIVE. `sminfo` shows the master SM's LID, its
priority and state; run it twice and the **activity count** should increase, proving the SM is
alive and sweeping. In production, two or more SMs run with different priorities, so a standby takes
over if the master fails.

### Task 3: Discover the fabric

```bash
sudo ibnetdiscover > /tmp/fabric-topology.txt; less /tmp/fabric-topology.txt
sudo ibhosts
sudo ibswitches
sudo iblinkinfo
```

Illustrative `ibhosts` output:

```
Ca      : 0x... ports 1 "node-a mlx5_0"
Ca      : 0x... ports 1 "node-b mlx5_0"
```

**Read it:** `ibnetdiscover` walks the fabric with management datagrams and prints every node, port
and link: it is the InfiniBand equivalent of drawing your topology from LLDP, except that it works
from any host without access to the switches. `ibhosts` and `ibswitches` are filtered views.
`iblinkinfo` prints every switch port with its width, speed, state and the device on the other end:
the fastest way to find a link that trained at a lower width (for example `1X` instead of `4X`) or
speed. Back to back, you will see no switches and a single link.

### Task 4: Port counters with `perfquery`

On host A, read the local port, then the remote port by its LID (from `ibstat` on host B):

```bash
sudo perfquery
sudo perfquery -x <LID of host B> 1
```

Illustrative excerpt:

```
# Port counters: Lid 2 port 1 (CapMask: 0x...)
PortSelect:......................1
SymbolErrorCounter:..............0
LinkErrorRecoveryCounter:........0
LinkDownedCounter:...............0
PortRcvErrors:...................0
PortXmitDiscards:................0
...
PortXmitData:....................123456
PortRcvData:.....................123400
```

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

### Task 5: Reachability without IP: `ibping`

On host B start a responder; on host A ping B's LID:

```bash
sudo ibping -S                          # host B (Ctrl-C when done)
sudo ibping -c 5 <LID of host B>        # host A
```

**Why:** `ibping` uses InfiniBand management datagrams, so it tests the InfiniBand path itself,
independent of IPoIB or any IP configuration. When an application fails, `ibping` working tells you
the fabric layer is fine and the problem is higher up.

### Task 6: RDMA bandwidth over InfiniBand

Server on host B, client on host A:

```bash
ib_write_bw -d {{B_RDMA_DEV}} -i {{RDMA_PORT}} -F --report_gbits                 # host B
ib_write_bw -d {{A_RDMA_DEV}} -i {{RDMA_PORT}} -F --report_gbits {{HOST_B}}      # host A
```

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
sudo ibdiagnet
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

**Observe:** the running test continues and ports stay `ACTIVE`. The SM configures the fabric; it
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
  takeover.
- Read the [subnet manager and routing lesson](#/lesson/subnet-manager-routing) and look up which
  routing engine your OpenSM uses in its configuration file.
- Run `./hw-toolkit/aina-hw collect-all` and import the report on the [Connect page](#/hw/connect):
  the health review checks SM presence and LIDs on InfiniBand fabrics.
