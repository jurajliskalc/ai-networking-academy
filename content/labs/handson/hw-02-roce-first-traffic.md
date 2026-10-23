---
id: hw-02-roce-first-traffic
title: "First RoCEv2 traffic between two real hosts: GIDs, ping-pong, perftest and NUMA"
kind: handson
level: 2
estimated_minutes: 90
environment: hardware
tier: 1
fabric: roce
requires: [two-rdma-hosts, root, ssh-mesh]
changes_config: false
lessons: [rdma-on-linux, perftest-benchmarking, rocev2-encapsulation, pcie-numa-topology, rdma-connection-failures]
files: labs/hw-02-roce-first-traffic
verified: true
summary: "Bring up RDMA between two hosts with real NICs: pick the right GID, run RC ping-pong and rping, then measure bandwidth and latency the way fabric engineers do."
---

> [!NOTE]
> Verified end to end (every task, the check and the restore step) on 2026-10-23 on two ConnectX-5
> hosts cabled back to back (100GbE DAC; ESXi VMs with PCI passthrough; Ubuntu 26.04.1, kernel
> 7.0.0-38, NVIDIA DOCA-OFED 3.4); see `labs/README.md` for the exact versions. Your device names,
> numbers and some output lines will differ with other NICs, firmware or the distribution's inbox stack.

## Goal

Move real RoCEv2 traffic between **host A** (`{{HOST_A}}`, `{{A_IP}}`) and **host B** (`{{HOST_B}}`,
`{{B_IP}}`), then measure it honestly. This is the first thing anyone does with a new pair of RDMA
NICs, and it is where most bring-up problems first show up: wrong GID index, MTU mismatch, a firewall
blocking the connection exchange, or a NIC sitting on the wrong NUMA node.

By the end you can:

- Prove IP reachability and jumbo-frame MTU end to end before blaming RDMA.
- Find the RoCE v2 GID index for an IPv4 address on each host, and explain why it matters.
- Run an RC ping-pong with explicit GIDs and an `rping` that resolves them through RDMA CM.
- Measure RDMA WRITE bandwidth and latency with perftest, and compare them with the port rate.
- Show the effect of path MTU, queue pairs and NUMA placement on the numbers.

> [!NOTE]
> Blocks labelled **Real capture** were copied from the reference hosts (ConnectX-5, firmware 16.29,
> Ubuntu 26.04, host A `10.10.10.1`, host B `10.10.10.2`) with the stack named in the label; use the
> stack switch to see the inbox or DOCA version. Other output is **illustrative**. Your device names,
> firmware, GID indexes and numbers will differ; that is the point of doing it on your own gear.

## Before you start

- **Hardware:** two hosts with RDMA NICs in Ethernet mode, cabled back to back or through any
  switch. No QoS is needed for this lab: with one flow and no congestion, RoCEv2 works on a plain
  link. (Lossless configuration is the next labs' job.)
- **Profile:** fill in hosts, data IPs, netdevs and RDMA devices on the
  [Connect page](#/hw/connect). The commands below are already personalised with your values.
- **Software:** `labs/hw-toolkit/setup-rdma-host.sh` on both hosts (rdma-core, perftest,
  `rdmacm-utils`, `ethtool`, `numactl`).
- **SSH:** key-based SSH from host A to host B, for the check script.
- **Firewall:** `ibv_rc_pingpong` and perftest (without `-R`) exchange connection details over TCP
  before any RDMA traffic flows: 18515 (their default), 18600 and 18601 (the check script). Open
  them on the data network or stop the firewall for the lab. RoCE data itself is UDP 4791 and is
  handled by the NIC, outside the host firewall. `rping` and other RDMA CM tools do not use TCP:
  their port number (7174 for `rping`) lives in the RDMA CM port space and the connection messages
  travel as RoCE packets too.
- **Changes:** nothing persistent. Task 1 may set the MTU at runtime; it reverts at reboot unless
  you also put it in your network configuration.

Open two terminals: one on host A, one on host B.

## Tasks

### Task 1: Prove the IP path and the MTU first

On **both** hosts, look at the data interface:

```bash
ip -br addr show dev {{A_NETDEV}}        # on host B: {{B_NETDEV}}
ip link show dev {{A_NETDEV}} | grep -o 'mtu [0-9]*'
```

If the MTU is not `{{MTU}}` yet, set it at runtime on both hosts (and on the switch ports, if
there is a switch: they need at least this MTU plus headers, 9216 is common):

```bash
sudo ip link set dev {{A_NETDEV}} mtu {{MTU}}      # host B: {{B_NETDEV}}
```

The largest value the NIC accepts is the `maxmtu` in `ip -d link show` (9978 on ConnectX-5, for
example); above it `ip` answers `Error: mtu greater than device maximum.`

From host A, send a ping that **must not be fragmented** and exactly fills the MTU (IPv4 header 20
bytes + ICMP header 8 bytes = 28):

```bash
ping -M do -s $(({{MTU}} - 28)) -c 3 {{B_IP}}
```

Output with a 9000-byte MTU (the replies are 8972 bytes of payload plus the 8-byte ICMP header):

```text real=inbox
PING 10.10.10.2 (10.10.10.2) 8972(9000) bytes of data.
8980 bytes from 10.10.10.2: icmp_seq=1 ttl=64 time=0.275 ms
8980 bytes from 10.10.10.2: icmp_seq=2 ttl=64 time=0.229 ms
8980 bytes from 10.10.10.2: icmp_seq=3 ttl=64 time=0.270 ms

--- 10.10.10.2 ping statistics ---
3 packets transmitted, 3 received, 0% packet loss, time 2034ms
rtt min/avg/max/mdev = 0.229/0.258/0.275/0.020 ms
```

If the **local** netdev MTU is smaller than the packet, `ping` refuses to send it and says
`ping: sendmsg: Message too long` (the statistics then show `+1 errors`). One byte too many on the
same hosts:

```text real=inbox
$ ping -M do -s 8973 -c 1 10.10.10.2
PING 10.10.10.2 (10.10.10.2) 8973(9001) bytes of data.
ping: sendmsg: Message too long

--- 10.10.10.2 ping statistics ---
1 packets transmitted, 0 received, +1 errors, 100% packet loss, time 0ms
```

**Why:** RDMA tools fail with timeouts that look like RDMA problems when the real problem is an IP
path that drops large frames. A small ping succeeding proves very little; a full-size,
don't-fragment ping proves the whole path carries jumbo frames.

> [!WARNING]
> If small pings work and this one gets no replies at all (`100% packet loss`, no error message),
> something further along the path has a smaller MTU. That
> is the classic jumbo-frame black hole: fix it before going further.

### Task 2: Inspect the RDMA port and find the right GID

On each host:

```bash
rdma link show
ibv_devinfo -d {{A_RDMA_DEV}} -i {{RDMA_PORT}}     # host B: {{B_RDMA_DEV}}
```

Output of `ibv_devinfo -d <dev> -i 1` on host A:

```text stack=inbox real
hca_id:	rocep3s0f0
	transport:			InfiniBand (0)
	fw_ver:				16.29.1016
	node_guid:			248a:0703:0000:11ee
	...
	vendor_part_id:			4119
	...
		port:	1
			state:			PORT_ACTIVE (4)
			max_mtu:		4096 (5)
			active_mtu:		4096 (5)
			sm_lid:			0
			port_lid:		0
			port_lmc:		0x00
			link_layer:		Ethernet
```

```text stack=doca real
libibverbs: Warning: couldn't load driver 'libionic-rdmav59.so': libionic-rdmav59.so: cannot open shared object file: No such file or directory
hca_id:	mlx5_0
	transport:			InfiniBand (0)
	fw_ver:				16.29.1016
	node_guid:			248a:0703:0000:11ee
	...
	vendor_part_id:			4119
	...
		port:	1
			state:			PORT_ACTIVE (4)
			max_mtu:		4096 (5)
			active_mtu:		4096 (5)
			sm_lid:			0
			port_lid:		0
			port_lmc:		0x00
			link_layer:		Ethernet
```

The device name is `mlx5_0` with NVIDIA's OFED/DOCA stack; distribution rdma-core names it after
the PCI address (here `rocep3s0f0`, PCI `0000:03:00.0`). The `libionic` warning comes from DOCA's
rdma-core and is harmless. Use whatever `rdma link show` prints on your host.
`transport: InfiniBand (0)` is normal on RoCE too: it names the verbs transport, not the link.

**Check:** `state PORT_ACTIVE`, `link_layer Ethernet`, and `active_mtu 4096`. The active MTU is the
largest InfiniBand MTU (256 to 4096) that fits in the netdev MTU with the RoCE headers; with a
1500-byte netdev MTU it drops to 1024, which costs bandwidth and message rate.

Now list the GID table of the port. Every IP address on the netdev gets entries, one per RoCE version
the device supports:

```bash
D=/sys/class/infiniband/{{A_RDMA_DEV}}/ports/{{RDMA_PORT}}
for i in $(ls $D/gids | sort -n); do
  t=$(cat $D/gid_attrs/types/$i 2>/dev/null) || continue
  printf '%-3s %-40s %-12s %s\n' "$i" "$(cat $D/gids/$i)" "$t" "$(cat $D/gid_attrs/ndevs/$i 2>/dev/null)"
done
```

Illustrative output:

```
0   fe80:0000:0000:0000:ba3f:d2ff:feaa:bb01  IB/RoCE v1   ens1f0np0
1   fe80:0000:0000:0000:ba3f:d2ff:feaa:bb01  RoCE v2      ens1f0np0
2   0000:0000:0000:0000:0000:ffff:c0a8:320b  IB/RoCE v1   ens1f0np0
3   0000:0000:0000:0000:0000:ffff:c0a8:320b  RoCE v2      ens1f0np0
```

> [!NOTE]
> **With one IPv4 address on the netdev, GID index 3 was the RoCE v2 IPv4 entry on both stacks.**
> On the ConnectX-5 reference hosts (inbox rdma-core 61 and DOCA-OFED 3.4) the table read: 0 = fe80
> link-local RoCE v1, 1 = the same address as RoCE v2, 2 = IPv4-mapped RoCE v1, 3 = IPv4-mapped RoCE v2
> (`show_gids` with DOCA: `n_gids_found=8` for the two ports). That is why `-x 3` and
> `NCCL_IB_GID_INDEX=3` are so common, and also why they break: an extra IPv6 address or a VLAN
> interface adds entries and can move the one you want.

The entry you want is **RoCE v2** with the IPv4-mapped address `::ffff:` + your IP in hex
(`c0a8:320b` is 192.168.50.11). Write down the index on each host. Your profile says
`GID_INDEX={{GID_INDEX}}`; if your hosts disagree with it, update the profile. If you have NVIDIA's
OFED/DOCA tools installed, `show_gids` prints the same table (it is not part of upstream rdma-core,
which is why this lab reads sysfs).

**Why:** with explicit-GID tools (`ibv_*_pingpong`, perftest without `-R`, NCCL), the GID index
selects the source address **and** the RoCE version. Pick a RoCE v1 entry and your packets are not
routable IP at all; pick a link-local IPv6 entry and they go nowhere useful on an IPv4 fabric.

### Task 3: An RC ping-pong across the wire

Host B (server), with **B's** GID index:

```bash
ibv_rc_pingpong -d {{B_RDMA_DEV}} -i {{RDMA_PORT}} -g {{GID_INDEX}}
```

Host A (client), with **A's** GID index and B's IP address:

```bash
ibv_rc_pingpong -d {{A_RDMA_DEV}} -i {{RDMA_PORT}} -g {{GID_INDEX}} {{B_IP}}
```

Client output on host A:

```text stack=inbox real
  local address:  LID 0x0000, QPN 0x000048, PSN 0x7bb49d, GID ::ffff:10.10.10.1
  remote address: LID 0x0000, QPN 0x000183, PSN 0xa6939e, GID ::ffff:10.10.10.2
8192000 bytes in 0.01 seconds = 11330.57 Mbit/sec
1000 iters in 0.01 seconds = 5.78 usec/iter
```

```text stack=doca real
libibverbs: Warning: couldn't load driver 'libionic-rdmav59.so': libionic-rdmav59.so: cannot open shared object file: No such file or directory
  local address:  LID 0x0000, QPN 0x000047, PSN 0xb3948c, GID ::ffff:10.10.10.1
  remote address: LID 0x0000, QPN 0x000086, PSN 0x519117, GID ::ffff:10.10.10.2
8192000 bytes in 0.01 seconds = 11663.29 Mbit/sec
1000 iters in 0.01 seconds = 5.62 usec/iter
```

If the two sides use GID entries of different types (for example `-g 0` against `-g 3`), the client
fails with `client read/write: No space left on device`, which says nothing about GIDs; see the
[RDMA connection failures lesson](#/lesson/rdma-connection-failures).

**What happened:** the two sides exchanged QPN, PSN and GID over TCP port 18515, moved their RC
queue pairs through INIT, RTR and RTS, then bounced 1000 messages with SEND/RECV. The usec/iter
figure is a round trip for a 4 KiB message including software overhead in the example program, not
a latency benchmark: Task 6 measures latency properly.

If it hangs or times out, check in this order: firewall (TCP 18515), GID index on **each** side,
MTU (Task 1), and that both ports are ACTIVE.

### Task 4: Let RDMA CM resolve the address: `rping`

`rping` uses the **RDMA connection manager**, which resolves the destination IP to a GID and path
itself, the way most storage and many applications connect.

```bash
rping -s -a {{B_IP}} -v -C 5          # host B: server, bound to its data IP
rping -c -a {{B_IP}} -v -C 5          # host A: client
```

Client output on host A (the `DISCONNECT EVENT` line came first in this capture: the order of lines
from the tool's output streams is not guaranteed):

```text stack=inbox real
client DISCONNECT EVENT...
ping data: rdma-ping-0: ABCDEFGHIJKLMNOPQRSTUVWXYZ[\]^_`abcdefghijklmnopqr
ping data: rdma-ping-1: BCDEFGHIJKLMNOPQRSTUVWXYZ[\]^_`abcdefghijklmnopqrs
...
ping data: rdma-ping-4: EFGHIJKLMNOPQRSTUVWXYZ[\]^_`abcdefghijklmnopqrstuv
```

```text stack=doca real
libibverbs: Warning: couldn't load driver 'libionic-rdmav59.so': libionic-rdmav59.so: cannot open shared object file: No such file or directory
client DISCONNECT EVENT...
ping data: rdma-ping-0: ABCDEFGHIJKLMNOPQRSTUVWXYZ[\]^_`abcdefghijklmnopqr
ping data: rdma-ping-1: BCDEFGHIJKLMNOPQRSTUVWXYZ[\]^_`abcdefghijklmnopqrs
...
ping data: rdma-ping-4: EFGHIJKLMNOPQRSTUVWXYZ[\]^_`abcdefghijklmnopqrstuv
```

`rping` is in the `rdmacm-utils` package, which distributions do not install by default (the setup
script does). With NVIDIA's DOCA-Host stack, RDMA CM tools may also print a harmless
`libibverbs: Warning: couldn't load driver 'libionic-rdmav59.so': ...` line first.

**Compare with Task 3:** no `-g` here. RDMA CM picked the GID from the route to `{{B_IP}}`, and it
uses the default RoCE version configured for the device (RoCE v2 on current stacks). NVIDIA's
stack has a `cma_roce_mode` script to show or change it; on any stack the same setting lives in
the rdma_cm configfs (`sudo mkdir /sys/kernel/config/rdma_cm/{{A_RDMA_DEV}}`, then read
`ports/{{RDMA_PORT}}/default_roce_mode` in that directory). When `rping` works but `ibv_rc_pingpong` does not,
suspect the GID index you typed.

### Task 5: Bandwidth with perftest

Start the server on host B, then the client on host A:

```bash
ib_write_bw -d {{B_RDMA_DEV}} -i {{RDMA_PORT}} -x {{GID_INDEX}} -F --report_gbits                  # host B
ib_write_bw -d {{A_RDMA_DEV}} -i {{RDMA_PORT}} -x {{GID_INDEX}} -F --report_gbits {{B_IP}}         # host A
```

Client output on host A (100 GbE back to back). The header lists the device, QP and MTU settings,
then one `local address` / `remote address` pair with GIDs per QP; a few header lines differ between
the distro perftest and DOCA's:

```text stack=inbox real
---------------------------------------------------------------------------------------
                    RDMA_Write BW Test
 Dual-port       : OFF		Device         : rocep3s0f0
 Number of qps   : 1		Transport type : IB
 Connection type : RC		Using SRQ      : OFF
 PCIe relax order: ON		Lock-free      : OFF
 ibv_wr* API     : ON		Using DDP      : OFF
 TX depth        : 128
 CQ Moderation   : 1
 Mtu             : 4096[B]
 Link type       : Ethernet
 GID index       : 3
 Max inline data : 0[B]
 rdma_cm QPs	 : OFF
 Data ex. method : Ethernet
---------------------------------------------------------------------------------------
 local address: LID 0000 QPN 0x004b PSN 0xd59040 RKey 0x184d00 VAddr 0x0071e7d1051000
 GID: 00:00:00:00:00:00:00:00:00:00:255:255:10:10:10:01
 remote address: LID 0000 QPN 0x0186 PSN 0xb9398 RKey 0x004300 VAddr 0x00784a42c47000
 GID: 00:00:00:00:00:00:00:00:00:00:255:255:10:10:10:02
---------------------------------------------------------------------------------------
 #bytes     #iterations    BW peak[Gb/sec]    BW average[Gb/sec]   MsgRate[Mpps]
 65536      5000             94.73              94.72  		     0.180663
---------------------------------------------------------------------------------------
```

```text stack=doca real
---------------------------------------------------------------------------------------
                    RDMA_Write BW Test
 Dual-port       : OFF		Device         : mlx5_0
 Number of qps   : 1		Transport type : IB
 Connection type : RC		Using SRQ      : OFF
 PCIe relax order: ON		Lock-free      : OFF
 ibv_wr* API     : ON		Using Enhanced Reorder      : OFF
 TX depth        : 128
 CQ Moderation   : 1
 CQE Poll Batch  : Dynamic
 Mtu             : 4096[B]
 Link type       : Ethernet
 GID index       : 3
 Max inline data : 0[B]
 rdma_cm QPs	 : OFF
 Data ex. method : Ethernet
 NUMA node       : 0
---------------------------------------------------------------------------------------
 local address: LID 0000 QPN 0x004b PSN 0x47e235 RKey 0x201dbc VAddr 0x00792fd34ab000
 GID: 00:00:00:00:00:00:00:00:00:00:255:255:10:10:10:01
 remote address: LID 0000 QPN 0x008a PSN 0xcaa37b RKey 0x0353bc VAddr 0x00790ff303a000
 GID: 00:00:00:00:00:00:00:00:00:00:255:255:10:10:10:02
---------------------------------------------------------------------------------------
 #bytes     #iterations    BW peak[Gb/sec]    BW average[Gb/sec]   MsgRate[Mpps]
 65536      5000             95.73              95.73  		     0.182590
---------------------------------------------------------------------------------------
```

`Transport type : IB` names the verbs transport, as in `ibv_devinfo`; `Link type : Ethernet` is the
RoCE port.

Compare with the port rate:

```bash
cat /sys/class/infiniband/{{A_RDMA_DEV}}/ports/{{RDMA_PORT}}/rate
```

**Read it:** the reported number is RDMA payload. Even a perfect run stays a few percent below the
link rate: every 4096-byte packet also carries Ethernet, IPv4, UDP and BTH headers, ICRC, FCS,
preamble and inter-frame gap (roughly 80 bytes, so about 98% efficiency at a 4096 path MTU, less at
1024). If you are far below that, it is not the protocol: look at PCIe (Task 6 and the Inventory
lab), CPU/NUMA placement, or a single QP being unable to fill a very fast link.

Now run the variations, each time restarting the server with the same extra options.

> [!NOTE]
> `-a` registers buffers up to 8 MiB, which together with the queues is more than the default
> memlock limit (often 8192 KiB) allows: the run then stops with `Couldn't allocate MR` and ` Couldn't create IB resources`. Set
> memlock to unlimited first (`labs/hw-toolkit/setup-rdma-host.sh --set-memlock`, then log in again)
> and check with `ulimit -l` on both hosts.

```bash
# 4 queue pairs: what fast links (200G and up) often need to reach line rate
ib_write_bw -d {{A_RDMA_DEV}} -x {{GID_INDEX}} -q 4 -F --report_gbits {{B_IP}}
# all message sizes from 2 bytes to 8 MiB: watch where bandwidth flattens
ib_write_bw -d {{A_RDMA_DEV}} -x {{GID_INDEX}} -a -F --report_gbits {{B_IP}}
# bidirectional: both directions at once
ib_write_bw -d {{A_RDMA_DEV}} -x {{GID_INDEX}} -b -F --report_gbits {{B_IP}}
```

Also try `ib_read_bw` and `ib_send_bw`. READ needs a round trip per request and is bounded by the
number of outstanding reads the NIC allows; SEND needs the receiver to keep posting buffers.

### Task 6: Latency, and why NUMA placement matters

Find each NIC's NUMA node and pin the test to it:

```bash
cat /sys/class/infiniband/{{A_RDMA_DEV}}/device/numa_node      # -1 means single node / not reported
N=$(cat /sys/class/infiniband/{{A_RDMA_DEV}}/device/numa_node); [ "$N" -lt 0 ] && N=0   # host B: {{B_RDMA_DEV}}
```

```bash
numactl --cpunodebind=$N --membind=$N ib_write_lat -d {{B_RDMA_DEV}} -x {{GID_INDEX}} -a -F               # host B (use B's node)
numactl --cpunodebind=$N --membind=$N ib_write_lat -d {{A_RDMA_DEV}} -x {{GID_INDEX}} -a -F {{B_IP}}      # host A
```

Excerpt from host A (inbox perftest, back to back, run without `numactl`):

```text real=inbox
 #bytes #iterations    t_min[usec]    t_max[usec]  t_typical[usec]    t_avg[usec]    t_stdev[usec]   99% percentile[usec]   99.9% percentile[usec]
 2       1000          1.07           3.40         1.10     	       1.11        	0.08   		1.24    		3.40
 ...
 4096    1000          2.47           4.56         2.58     	       2.60        	0.07   		2.85    		4.56
 ...
```

**Read it:** report `t_typical` (the median) and the 99th/99.9th percentiles, not `t_min`. On a
dual-socket host, repeat the client run pinned to the **other** NUMA node: the extra hop across
the CPU interconnect usually shows up as higher and noisier latency. That is the same effect that
makes a GPU and NIC on different sockets a bandwidth problem in Tier 3.

### Task 7: Path MTU versus message size

perftest can request a smaller path MTU with `-m`. Compare 1024 with 4096 at two message sizes:

```bash
for m in 1024 4096; do for s in 4096 1048576; do
  echo "== path MTU $m, message $s"
  ib_write_bw -d {{A_RDMA_DEV}} -x {{GID_INDEX}} -m $m -s $s -F --report_gbits {{B_IP}} | tail -2
done; done
# host B: run the matching server four times (same -m and -s), or loop it the same way without the IP
```

**Observe:** at large messages the difference is the header overhead per packet (four times as many
packets at 1024). At high message rates the NIC's per-packet work matters too. This is why "MTU 1500
on one host" quietly costs performance even when everything works. On one 100G ConnectX-5 pair,
1 MiB and 64 KiB messages ran about 6% faster at path MTU 4096 (96 against 90.5 Gb/s at 64 KiB),
while at 4 KiB messages both settings landed within run-to-run noise of each other (82-88 Gb/s): the
message rate, not the header overhead, limits small messages. Repeat each run a few times before
drawing conclusions from a difference of a few percent.

### Task 8: Watch the counters while traffic runs

Start a long run (`-D 30` on both sides) and, in a third terminal on host B, watch the counters
with the commands below. With `-D` perftest prints ` WARNING: BW peak won't be measured in this run.`
and reports `BW peak` as `0.00`; read `BW average`.

```bash
rdma statistic show link {{B_RDMA_DEV}}/{{RDMA_PORT}}
grep -H . /sys/class/infiniband/{{B_RDMA_DEV}}/ports/{{RDMA_PORT}}/hw_counters/{out_of_sequence,packet_seq_err,local_ack_timeout_err} 2>/dev/null
ethtool -S {{B_NETDEV}} | grep -E 'vport_rdma_unicast|discard|pause' | head -20
```

```text stack=inbox real
$ rdma statistic show link rocep3s0f0/1
link rocep3s0f0/1
    rx_write_requests 0
    rx_read_requests 0
    ...
    out_of_sequence 0
    duplicate_request 0
    rnr_nak_retry_err 0
    packet_seq_err 0
    implied_nak_seq_err 0
    local_ack_timeout_err 0
    ...
    np_ecn_marked_roce_packets 0
    np_cnp_sent 0
    rx_icrc_encapsulated 0
```

```text stack=doca real
$ rdma statistic show link mlx5_0/1
link mlx5_0/1
    rx_write_requests 0
    rx_read_requests 0
    ...
    out_of_sequence 0
    duplicate_request 0
    rnr_nak_retry_err 0
    packet_seq_err 0
    implied_nak_seq_err 0
    local_ack_timeout_err 0
    ...
    np_ecn_marked_roce_packets 0
    np_cnp_sent 0
    rx_icrc_encapsulated 0
```

(Snapshots from host A; on the receiving side of a write test `rx_write_requests` rises.) Recent
iproute2 prints one counter per line under `link <dev>/<port>` (older versions put them all on one
line). The `ethtool -S` filter on host A, after some RDMA traffic (both stacks print the same names):

```text real=inbox
     rx_vport_rdma_unicast_packets: 5835
     rx_vport_rdma_unicast_bytes: 361770
     tx_vport_rdma_unicast_packets: 80000
     tx_vport_rdma_unicast_bytes: 332400000
     rx_pause_ctrl_phy: 0
     tx_pause_ctrl_phy: 0
     rx_discards_phy: 0
     tx_discards_phy: 0
     rx_prio0_discards: 0
     ...
     rx_global_pause: 0
     rx_global_pause_duration: 0
     tx_global_pause: 0
     tx_global_pause_duration: 0
``` In `ethtool -S`, RDMA traffic shows up in the `*_vport_rdma_unicast_*` counters, not in
the ordinary netdev packet counters; per-priority pause counters (`rx_prio3_pause` ...) appear only
for priorities with PFC enabled, so here (global pause on, PFC off) you see the `*_global_pause*`
ones instead.

**What to look for:** byte and packet counters rising with the test, and the **error** counters
staying flat. `out_of_sequence` and `packet_seq_err` count gaps in packet sequence numbers seen by
the receiver: on a back-to-back cable without congestion they should not move. When they do on a
real fabric, packets were dropped somewhere, which is exactly what lossless configuration (next
labs) prevents. Counter names are driver-specific; these exist on NVIDIA ConnectX (mlx5) NICs.

## Verify

On host A:

```bash
cd {{AINA_DIR}}/labs
./hw-toolkit/aina-hw check hw-02-roce-first-traffic
```

The check confirms the tools and SSH, both ports ACTIVE on Ethernet, matching MTUs, a
don't-fragment jumbo ping, a RoCE v2 IPv4 GID on each host, an active MTU of 4096 (warning only),
a 100-iteration RC ping-pong and a 5-second, 4-QP `ib_write_bw` from A to B. It compares the
bandwidth with the port rate (a warning below 60%, a sanity floor rather than a benchmark target;
set `AINA_MIN_BW_PCT` to change it) and checks that B's sequence-error counters did not move
(a warning if they did).

`aina-hw check` saves a result file; import it on the [Connect page](#/hw/connect) or let the local
agent pick it up, and this lab is marked as verified on your hardware.

## Restore

Nothing to undo unless you changed the MTU in Task 1 and want the old value back:

```bash
sudo ip link set dev {{A_NETDEV}} mtu 1500        # host B: {{B_NETDEV}}; use your previous value
```

## What you learned

- Prove the IP path with a full-size, don't-fragment ping before debugging RDMA.
- RoCE peers are addressed by GID; the RoCE v2 IPv4 entry is the one routed fabrics need, and its
  index can differ per host.
- `ibv_rc_pingpong` and perftest use explicit GIDs; RDMA CM tools such as `rping` resolve them from
  the IP route.
- perftest bandwidth is payload: expect a few percent below link rate at a 4096 path MTU, and use
  several QPs on fast links.
- Latency is reported as median and tail; NUMA placement changes both.
- Sequence-error counters at the receiver are your first evidence of packet loss.

## Going further

- Repeat Task 5 with `-R` (RDMA CM connection setup in perftest) and confirm you no longer need `-x`.
- Capture the connection-setup TCP exchange with `sudo tcpdump -i {{A_NETDEV}} tcp port 18515`, then
  try to capture RoCE data with `sudo tcpdump -i {{A_NETDEV}} udp port 4791`: you will see nothing,
  because the NIC handles RoCE in hardware and the packets never pass the netdev. On mlx5 NICs,
  libpcap's **RDMA sniffer** does see them: `sudo tcpdump -D` lists the RDMA device (for example
  `mlx5_0 (RDMA sniffer)`), and `sudo tcpdump -i {{A_RDMA_DEV}} -w /tmp/roce.pcap` (the RDMA device,
  not the netdev) records the RoCEv2 packets; filter when reading (`tcpdump -r /tmp/roce.pcap 'udp
  port 4791'`). On Ubuntu the tcpdump AppArmor profile blocks this (`No such device exists`) unless
  you put it in complain mode; NVIDIA's stack also ships `ibdump`.
- Run the [simulator's GID-index incident](#/labs/sim-08-gid-index) and compare it with what you saw.
