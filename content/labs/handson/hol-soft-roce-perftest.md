---
id: hol-soft-roce-perftest
title: "Soft-RoCE: your first RDMA connection without RDMA hardware"
kind: handson
level: 2
estimated_minutes: 60
environment: linux-vm
lessons: [rdma-on-linux, perftest-benchmarking]
files: labs/hol-soft-roce-perftest
verified: true
tier: 0
fabric: any
requires: [linux-vm]
summary: "Soft-RoCE turns any NIC into an RDMA device: GID tables, RC ping-pong and perftest bandwidth and latency."
---

> [!NOTE]
> Verified end to end (every task, `check.sh` and `cleanup.sh`) on 2026-10-23 with Ubuntu 24.04 user space (privileged `ubuntu:24.04` containers on the host network) on two
> ESXi VMs running Ubuntu 26.04.1 with the generic kernel 7.0.0-38 and the distribution's RDMA stack;
> Soft-RoCE on a 1500-byte VMXNET3 interface. See `labs/README.md` for versions.

> [!NOTE]
> This lab has been syntax-checked (`bash -n` on every script) but has not yet been executed end
> to end on a real VM. If a command behaves differently on your system, please report it.
> It does not run under WSL2 as tested (kernel 6.6.87.2-microsoft-standard-WSL2, built without
> `rdma_rxe`). Use a regular VM with Ubuntu's generic kernel.

## Goal

Turn an ordinary Ethernet interface into an RDMA device with **Soft-RoCE** (the `rdma_rxe` kernel
driver, which implements RoCEv2 in software), then use the same tools you would use on a GPU
server with ConnectX or other RDMA NICs: `rdma`, `ibv_devices`, `ibv_devinfo`, `ibv_rc_pingpong`
and the `perftest` suite (`ib_write_bw`, `ib_send_lat`, ...).

By the end you can:

- Create and inspect an RDMA device, its port state, MTU and GID table.
- Explain what a GID index is and pick the right one for RoCEv2 over IPv4.
- Run an RC ping-pong and perftest bandwidth/latency tests and read their output.
- Explain why Soft-RoCE numbers say nothing about real RDMA NIC performance.

### Which topology does this lab use, honestly?

The tested-by-design approach here is **single host, single rxe device, client and server on the
same device**. `rxe` detects that the destination is its own device and loops the packets back
internally, so this is reliable on one VM. The trade-off: those packets never reach the wire, so
you cannot capture them with `tcpdump` (that is what the `hol-rocev2-wireshark` lab does, with
two VMs).

Two variants that you may read about elsewhere, and why this lab does not rely on them:

- **Two rxe devices in one network namespace** (for example on the two ends of a veth pair): both
  IP addresses are local, so the kernel routes the traffic through `lo` instead of the veth, and
  `rxe` cannot match it to a device. Do not expect it to work.
- **rxe inside separate network namespaces**: historically `rxe` created its UDP port 4791 socket
  only in the initial network namespace. Newer kernels have been adding namespace support; check
  your kernel's changelog before relying on it.

The robust way to get real RoCEv2 on the wire without RDMA NICs is **two VMs** on the same virtual
network, each with its own rxe device (see "Going further").

## Setup

- Ubuntu 24.04 VM, 2+ vCPU, an interface with an IPv4 address (the default NAT interface is fine).
- Packages:

  ```bash
  sudo apt-get update
  sudo apt-get install -y iproute2 rdma-core ibverbs-utils ibverbs-providers perftest rdmacm-utils
  # rdma_rxe ships in the "extra" modules package on Ubuntu generic kernels:
  sudo apt-get install -y linux-modules-extra-$(uname -r)
  ```

  `labs/setup-ubuntu.sh` installs all of this. Cloud-provider kernels (`-aws`, `-azure`, `-gcp`
  ...) may package modules differently or omit `rdma_rxe`; if `modprobe rdma_rxe` fails, switch to
  the generic kernel or use a local VM. On newer Ubuntu kernels `rdma_rxe` is part of the main
  modules package and the `linux-modules-extra` line just reports that no such package exists
  (Ubuntu 26.04, kernel 7.0); `modprobe rdma_rxe` is what counts.
- **Not on a host with NVIDIA's OFED/DOCA stack:** it replaces the kernel's RDMA core modules but ships
  no Soft-RoCE, so `modprobe rdma_rxe` fails with `Invalid argument` (`dmesg`: `rdma_rxe: disagrees
  about version of symbol ...`), and its user space has no rxe provider either. Use a VM with the
  distribution's stack.
- Lab files: `labs/hol-soft-roce-perftest/` (`setup.sh`, `find_gid.sh`, `cleanup.sh`, `check.sh`).

You will need **two terminals** on the VM for the client/server tests. Run all commands from the
lab directory: `cd labs/hol-soft-roce-perftest`.

## Tasks

### Task 1: Create the Soft-RoCE device

```bash
IF=$(ip -o -4 route show to default | awk '{print $5; exit}')
echo "Using netdev $IF"
sudo modprobe rdma_rxe
sudo rdma link add rxe0 type rxe netdev $IF
rdma link show
```

Illustrative output:

```
link rxe0/1 state ACTIVE physical_state LINK_UP netdev enp0s3
```

(Or run `sudo ./setup.sh`, which does the same and prints the GID table.)

**Why:** `rdma` is the iproute2 tool for the RDMA subsystem, the counterpart of `ip`. `rxe0/1`
means device `rxe0`, port 1. On a real server you would see one device per RDMA NIC port, for
example `mlx5_0/1` (or `rocep59s0f0/1` with distribution rdma-core), already present because the
hardware driver created it; `rdma link add ...
type rxe` is only for software RDMA.

### Task 2: Inspect the device like a real NIC

```bash
ibv_devices
ibv_devinfo -d rxe0
ibv_devinfo -d rxe0 -v | less
```

Illustrative excerpt of `ibv_devinfo -d rxe0`:

```
hca_id:	rxe0
	transport:			InfiniBand (0)
	fw_ver:				0.0.0
	node_guid:			...
	phys_port_cnt:			1
		port:	1
			state:			PORT_ACTIVE (4)
			max_mtu:		4096 (5)
			active_mtu:		1024 (3)
			sm_lid:			0
			port_lid:		0
			link_layer:		Ethernet
```

**What to observe and why:**

- `transport: InfiniBand` with `link_layer: Ethernet` is how every RoCE device looks: the verbs
  and transport are InfiniBand's, carried over Ethernet/IP/UDP.
- `active_mtu` is the **RDMA path MTU**, chosen from the IB MTU values (256, 512, 1024, 2048,
  4096) that fit inside the netdev MTU with room for headers. With a 1500-byte netdev MTU you get
  1024. Try it: set the netdev MTU to 9000 on a lab interface and the active MTU should rise to
  4096 (do not change the MTU of your VM's only interface if your hypervisor network does not
  support it).
- `port_lid: 0` and `sm_lid: 0`: Ethernet has no subnet manager or LIDs. RoCE addresses peers by
  **GID** (an IPv6-format address) instead.

### Task 3: Understand the GID table

```bash
./find_gid.sh rxe0
ls /sys/class/infiniband/rxe0/ports/1/gids/ | head
cat /sys/class/infiniband/rxe0/ports/1/gid_attrs/types/0
```

Illustrative output of `find_gid.sh`:

```
index 0   fe80:0000:0000:0000:0a00:27ff:fe12:3456  type=RoCE v2  netdev=enp0s3
index 1   0000:0000:0000:0000:0000:ffff:0a00:020f  type=RoCE v2  netdev=enp0s3
IPv4-mapped GID index: 1
```

**Why:** the kernel builds one GID per IP address on the netdev (per RoCE version the device
supports; rxe supports only RoCE v2). An IPv4 address `a.b.c.d` appears as the IPv4-mapped IPv6
address `::ffff:a.b.c.d`. When you run any RDMA tool over IPv4 you must pass the index of that
entry (`-g` for the `ibv_*_pingpong` examples, `-x` for perftest). Choosing a wrong index (for
example a link-local IPv6 GID when the peer only has IPv4 reachability, or a RoCE v1 GID on a
routed fabric) is one of the most common causes of "RDMA connection times out" on real clusters.
Real NIC vendors also ship helper scripts to print this table; their names vary, but the sysfs
paths above are generic.

Save the index for the next tasks:

```bash
GID=$(./find_gid.sh -q rxe0); echo $GID
```

### Task 4: An RC ping-pong (send/receive)

Terminal 1 (server):

```bash
GID=$(./find_gid.sh -q rxe0)
ibv_rc_pingpong -d rxe0 -g $GID
```

Terminal 2 (client, same host):

```bash
GID=$(./find_gid.sh -q rxe0)
ibv_rc_pingpong -d rxe0 -g $GID 127.0.0.1
```

Illustrative client output:

```
  local address:  LID 0x0000, QPN 0x000011, PSN 0x6c2f1e, GID ::ffff:10.0.2.15
  remote address: LID 0x0000, QPN 0x000012, PSN 0x2d5a77, GID ::ffff:10.0.2.15
8192000 bytes in 0.12 seconds = 546.13 Mbit/sec
1000 iters in 0.12 seconds = 120.00 usec/iter
```

**What happened:** both sides created a **Reliable Connection (RC) queue pair**, exchanged their
QP number, starting PSN and GID over an ordinary TCP socket (port 18515 by default; that is what
the IP address argument is for), moved their QPs through INIT, RTR and RTS, then bounced 1000
4096-byte messages with SEND/RECV verbs. The out-of-band TCP exchange is the "connection
establishment" step that `rdma_cm` or NCCL's bootstrap perform in real applications.

Experiment:

```bash
# Server and client both: smaller messages and more iterations
ibv_rc_pingpong -d rxe0 -g $GID -s 64 -n 10000              # server
ibv_rc_pingpong -d rxe0 -g $GID -s 64 -n 10000 127.0.0.1    # client
```

Small messages show per-message cost (usec/iter); large ones show throughput. Keep both views in
mind for perftest.

### Task 5: perftest bandwidth: `ib_write_bw`

RDMA WRITE puts data directly into the remote memory region: the remote CPU posts nothing per
message. Terminal 1:

```bash
ib_write_bw -d rxe0 -x $GID -F --report_gbits
```

Terminal 2:

```bash
ib_write_bw -d rxe0 -x $GID -F --report_gbits 127.0.0.1
```

Illustrative client result table:

```
 #bytes     #iterations    BW peak[Gb/sec]    BW average[Gb/sec]   MsgRate[Mpps]
 65536      5000             2.10               2.05   		     0.003910
```

**Read it:** `#bytes` is the message size (default 65536), `BW average` the number you report, and
`MsgRate` messages per second. `-F` suppresses the CPU-frequency warning that perftest prints when
the CPU governor is not at maximum frequency (on real hardware you should fix the governor rather
than hide the warning). The connection info printed above the table (QPN, PSN, RKey, VAddr, GID)
is what each side needed to write into the other's memory.

Now sweep message sizes:

```bash
ib_write_bw -d rxe0 -x $GID -F -a --report_gbits             # server
ib_write_bw -d rxe0 -x $GID -F -a --report_gbits 127.0.0.1   # client
```

**Observe:** bandwidth climbs with message size and flattens. Watch `top` in a third terminal
during a long run (`-D 20` for 20 seconds): the work shows up as kernel CPU time (softirq/kworker
threads), because rxe does in software what an RDMA NIC does in hardware. Soft-RoCE throughput is
limited by CPU and is typically far below line rate; never use it to benchmark a fabric.

Also try `ib_read_bw` and `ib_send_bw` with the same arguments and compare. READ needs a request
and a response for each message, and SEND needs the receiver to have posted receive buffers.

### Task 6: perftest latency: `ib_send_lat`

```bash
ib_send_lat -d rxe0 -x $GID -F -a             # server
ib_send_lat -d rxe0 -x $GID -F -a 127.0.0.1   # client
```

Illustrative excerpt:

```
 #bytes #iterations    t_min[usec]    t_max[usec]  t_typical[usec]    t_avg[usec]    t_stdev[usec]   99% percentile[usec]   99.9% percentile[usec]
 2       1000          8.12           65.30        9.05     	       9.40        	1.20   		14.10   		50.22  
```

**Read it:** `t_typical` (the median) and the high percentiles matter more than `t_min`. For AI
collectives, tail latency of small messages drives the cost of many synchronization steps. Here the
numbers are software-loopback latencies in a VM: tens of microseconds is plausible, whereas RDMA
NICs on a good fabric are typically in the low single-digit microseconds; the exact value depends
heavily on generation, fabric and settings.

### Task 7: Watch QPs and counters while a test runs

Start a long test (`ib_write_bw ... -D 30` on both sides), then in a third terminal:

```bash
rdma resource show qp
rdma resource show cq
grep -H . /sys/class/infiniband/rxe0/ports/1/hw_counters/* 2>/dev/null | head -30
```

**Observe:** `rdma resource show qp` lists each QP with its local and remote QP numbers, type
(`RC`), state (`RTS` while running) and the owning process (`comm ib_write_bw`). The rxe
`hw_counters` directory exposes software counters such as packets sent and received and error or
retry events; the counter set is driver-specific (real NICs expose different, much larger sets).
`rdma statistic` can also show counters on recent iproute2 versions; see `man rdma-statistic`.

## Verify

```bash
cd labs/hol-soft-roce-perftest
sudo ./check.sh
```

`check.sh` confirms the tools are installed, `rdma_rxe` is loaded, `rxe0` is ACTIVE with an
Ethernet link layer and an IPv4 GID, then runs a 100-iteration `ibv_rc_pingpong` and a short
`ib_write_bw` in loopback (on TCP ports 18600/18601 so they do not collide with your own tests).

## Clean up

```bash
sudo ./cleanup.sh        # rdma link delete rxe0; modprobe -r rdma_rxe
```

## What you learned

- An RDMA device has ports with a state, an active RDMA MTU and a GID table; RoCE uses GIDs, not
  LIDs, to address peers.
- For RoCEv2 over IPv4 you must select the IPv4-mapped GID index (`-g`/`-x`).
- RC queue pairs need an out-of-band exchange of QPN, PSN and GID before data can flow.
- perftest reports bandwidth, message rate and latency percentiles; message size changes the story.
- Soft-RoCE is a functional teaching and testing tool, not a performance reference.

## Going further on real hardware

- **Two VMs instead of loopback:** create two VMs on the same virtual network, run `setup.sh` on
  each (with the netdev facing the other VM), and run the server on VM A and the client on VM B
  with VM A's IP address. Allow UDP 4791 and TCP 18515 between them. Now the packets cross a real
  (virtual) wire, which the next lab uses for packet captures.
- On a server with RDMA NICs, run the same commands against the hardware device (`-d mlx5_0` with
  NVIDIA's driver stack, a PCI-based name such as `rocep59s0f0` with distribution rdma-core: take it
  from `rdma link`), with the GID index of the RoCEv2 IPv4 entry. Pin the test to the NIC's NUMA
  node (for example with `numactl`) and compare results with your vendor's published expectations
  for that NIC generation and link speed.
- Use perftest options for multi-QP and bidirectional tests (`-q`, `-b`) and, if your build
  supports GPU memory (`--use_cuda` in CUDA-enabled builds), test GPUDirect RDMA. Check
  `ib_write_bw --help` on your build: available options differ between perftest versions.
