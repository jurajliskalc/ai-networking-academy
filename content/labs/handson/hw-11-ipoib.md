---
id: hw-11-ipoib
title: "IPoIB: IP over InfiniBand, its MTU, datagram mode and what it costs next to RDMA"
kind: handson
level: 3
estimated_minutes: 75
environment: hardware
tier: 1
fabric: ib
requires: [infiniband, two-rdma-hosts, root, ssh-mesh]
changes_config: true
lessons: [ib-architecture, subnet-manager-routing, ib-tools-diagnostics]
files: labs/hw-11-ipoib
verified: true
summary: "Bring up IPoIB between two hosts, find out why its MTU is 2044 or 4092 (the subnet manager decides), try connected mode, and compare TCP over IPoIB with RDMA on the same link."
---

> [!NOTE]
> Verified end to end (every task, the check and the restore step) on 2026-10-23 on two ConnectX-5 VPI cards with port 2 in InfiniBand mode, cabled back to back (EDR DAC, no switch;
> ESXi VMs with PCI passthrough; Ubuntu 26.04.1, kernel 7.0.0-38, NVIDIA DOCA-OFED 3.4 with its OpenSM
> 5.27.1); see `labs/README.md`. Connected mode was refused by that driver;
> the distribution's inbox IPoIB driver was not tested.

## Goal

Every InfiniBand cluster runs IP too: job launchers, SSH, storage clients, monitoring and the
bootstrap of RDMA programs need it, and on many clusters the only network the hosts share is the
InfiniBand fabric. **IPoIB** (IP over InfiniBand) puts an IP interface on an InfiniBand port. In this
lab you bring it up between host A (`{{HOST_A}}`, `{{A_IP}}`) and host B (`{{HOST_B}}`, `{{B_IP}}`)
and find out what it depends on.

By the end you can:

- Read an IPoIB interface: its 20-byte link-layer address, P_Key and mode.
- Explain why the IPoIB MTU is set by the subnet manager's broadcast group, and change it.
- Check whether connected mode is available on your driver, and what datagram mode limits.
- Compare TCP over IPoIB with RDMA on the same link, and say when that difference matters.

> [!NOTE]
> Output blocks labelled as a real capture come from the verification run (ConnectX-5 back to back
> at EDR 100 Gb/s, ESXi VMs with PCI passthrough, DOCA-OFED 3.4, OpenSM 5.27.1; IPoIB netdev
> `ibs64f1`, 10.10.30.1 and .2). Other output is illustrative. TCP throughput in particular depends
> on CPU, interrupt and NUMA placement more than on the link.

## Before you start

- **[hw-09](#/hw/labs/hw-09-infiniband-bringup) works** (ports trained, OpenSM installed) and the
  lab files of [hw-10](#/hw/labs/hw-10-ib-sm-failover) are present: this lab starts its SM with
  hw-10's `lab-sm.sh`. No other OpenSM may run on host A (stop hw-09's with `sudo ./stop-sm.sh`).
- **Profile:** `FABRIC=ib`; `A_NETDEV`/`B_NETDEV` are the IPoIB interfaces of the InfiniBand ports
  (`ip -br link | grep ^ib`; NVIDIA's `ibdev2netdev` prints the mapping), `A_IP`/`B_IP` and
  `PREFIX_LEN` a subnet that is **not** used anywhere else on the hosts, `MTU=4092`.
- **Packages:** `iperf3` on both hosts (`sudo apt-get install iperf3`; answer "no" to starting it as
  a daemon) and perftest from hw-09.
- **Changes:** `ipoib.sh` adds the profile address to the IPoIB interface and sets it up; its
  `restore` removes exactly that and restores the saved up/down state. The SM runs only while the
  lab needs it. `ipoib.sh` refuses to touch an interface that is not IPoIB or carries the default
  route.

## Tasks

### Task 1: An IPoIB interface up close

On host A:

```bash
ip -d link show {{A_NETDEV}}
cat /sys/class/net/{{A_NETDEV}}/mode
```

Sample output:

```text real=doca
5: ibs64f1: <BROADCAST,MULTICAST> mtu 2044 qdisc mq state DOWN mode DEFAULT group default qlen 1000
    link/infiniband 00:00:11:47:fe:80:00:00:00:00:00:00:24:8a:07:03:00:00:11:ef brd 00:ff:ff:ff:ff:12:40:1b:ff:ff:00:00:00:00:00:00:ff:ff:ff:ff promiscuity 0 allmulti 0 minmtu 68 maxmtu 65520
    ipoib pkey 0xffff mode datagram umcast 0000 addrgenmode eui64 numtxqueues 504 numrxqueues 63 gso_max_size 65536 gso_max_segs 65535 tso_max_size 65536 tso_max_segs 65535 gro_max_size 65536 gso_ipv4_max_size 65536 gro_ipv4_max_size 65536 parentbus pci parentdev 0000:03:00.1
    altname ibp3s0f1
datagram
```

**Read it:**

- `link/infiniband` is a **20-byte** hardware address: 4 bytes of flags and the IPoIB queue pair
  number (`00:00:11:47`), then the port's 16-byte GID (`fe80:...:248a:0703:0000:11ef`, the subnet
  prefix plus the port GUID). An IPoIB "MAC" is really "which QP on which port".
- `brd 00:ff:ff:ff:ff:12:40:1b:ff:ff:...` is the IPv4 broadcast **multicast group**, whose MGID
  embeds the P_Key (`ff:ff`). IPoIB has no broadcast medium: ARP and broadcasts go to a multicast
  group the subnet manager creates.
- `ipoib pkey 0xffff mode datagram`: the interface belongs to the default partition (hw-12 adds
  others) and sends unreliable datagrams (UD).
- `maxmtu 65520` is the connected-mode ceiling; what you actually get depends on the mode and on the
  SM (Task 3).

### Task 2: Bring it up with a subnet manager's defaults

On **host A** start an SM without any configuration file, then bring up IPoIB:

```bash
cd {{AINA_DIR}}/labs/hw-10-ib-sm-failover
sudo ./lab-sm.sh start --role A
cd {{AINA_DIR}}/labs/hw-11-ipoib
sudo ./ipoib.sh up --role A
```

On **host B**:

```bash
cd {{AINA_DIR}}/labs/hw-11-ipoib
sudo ./ipoib.sh up --role B
```

Then on host A:

```bash
ping -c 3 {{B_IP}}
ip neigh show dev {{A_NETDEV}}
cat /sys/class/net/{{A_NETDEV}}/mtu
sudo saquery -C {{A_RDMA_DEV}} -P {{RDMA_PORT}} -g | grep -B2 -A4 'ff12:401b:ffff::ffff:ffff'
```

Sample output:

```text real=doca
64 bytes from 10.10.30.2: icmp_seq=1 ttl=64 time=2.23 ms
64 bytes from 10.10.30.2: icmp_seq=2 ttl=64 time=0.361 ms
64 bytes from 10.10.30.2: icmp_seq=3 ttl=64 time=0.352 ms
...
10.10.30.2 lladdr 00:00:0d:31:fe:80:00:00:00:00:00:00:1c:34:da:03:00:00:22:29 REACHABLE
2044
		SL......................0x0
MCMemberRecord group dump:
		MGID....................ff12:401b:ffff::ffff:ffff
		Mlid....................0xC000
		Mtu.....................0x84
		pkey....................0xFFFF
		Rate....................0x82
```

**Read it:**

- The neighbour entry is B's 20-byte address: ARP over IPoIB resolved B's QPN and GID. Behind the
  scenes, the first packet to a new neighbour also needed a **path record** from the SM (B's LID,
  rate, MTU): IPoIB depends on the SM for every new destination.
- The MTU is **2044**, not the 4092 you may expect. `saquery -g` lists the multicast groups the SM
  created; the IPv4 broadcast group `ff12:401b:ffff::ffff:ffff` has `Mtu 0x84`. The low six bits
  are the IB MTU code, `4` = 2048 bytes (the top two bits, `2`, are the selector "exactly"). IPoIB
  in datagram mode sends each IP packet in one UD message, so the IP MTU is the group's MTU minus
  the 4-byte IPoIB header: 2048 - 4 = 2044. OpenSM creates that group with MTU code 4 unless its
  partition configuration says otherwise.

> [!VERIFIED]
> **OpenSM's default IPoIB broadcast group gave an IPoIB MTU of 2044, not 4092.** With DOCA-OFED
> 3.4's OpenSM and no partition file, `saquery -g` showed the group `ff12:401b:ffff::ffff:ffff`
> with `Mtu 0x84` (2048 bytes) and both `ibs64f1` interfaces came up at MTU 2044; with
> `Default=0x7fff, ipoib, mtu=5 : ALL=full ;` they changed to 4092 after the SM restart, without
> touching the hosts. Check the SM's partition configuration before the hosts when IPoIB runs at 2044.

### Task 3: A 4 KiB broadcast group, and the MTU follows

Restart the SM on host A with a partition file that changes only the default partition's IPoIB
group (`partitions-mtu4k.conf`: `Default=0x7fff, ipoib, mtu=5 : ALL=full ;`, where 5 = 4096):

```bash
cd {{AINA_DIR}}/labs/hw-10-ib-sm-failover
sudo ./lab-sm.sh stop
sudo ./lab-sm.sh start --role A --partitions ../hw-11-ipoib/partitions-mtu4k.conf
sleep 10
cat /sys/class/net/{{A_NETDEV}}/mtu
ssh {{HOST_B}} cat /sys/class/net/{{B_NETDEV}}/mtu
ping -c 3 -M do -s 4064 {{B_IP}}
ping -c 2 -M do -s 4065 {{B_IP}}
sudo ip link set {{A_NETDEV}} mtu 9000
```

Sample output:

```text real=doca
4092
4092
PING 10.10.30.2 (10.10.30.2) 4064(4092) bytes of data.
4072 bytes from 10.10.30.2: icmp_seq=1 ttl=64 time=1.12 ms
...
3 packets transmitted, 3 received, 0% packet loss, time 2027ms
PING 10.10.30.2 (10.10.30.2) 4065(4093) bytes of data.
ping: sendmsg: Message too long
ping: sendmsg: Message too long
...
2 packets transmitted, 0 received, +2 errors, 100% packet loss, time 1020ms
RTNETLINK answers: Invalid argument
```

**Read it:** after the SM restarted, both interfaces rejoined the broadcast group (a new SM asks
the ports' clients to re-register) and the driver raised the MTU to **4092** by itself. `-s 4064` plus 28
bytes of IP and ICMP headers is exactly 4092 and passes with DF set; one byte more fails locally
(`ping: sendmsg: Message too long`). 9000 is refused: in datagram mode one IP packet must fit one IB message.
When you see 2044 on a cluster that should run 4092, look at the SM's partition configuration
before looking at the hosts. Run the check now (Verify section).

### Task 4: Connected mode?

IPoIB's other mode, **connected mode**, runs over RC queue pairs and allows an MTU of up to 65520.
Try it on host A:

```bash
cat /sys/class/net/{{A_NETDEV}}/mode
echo connected | sudo tee /sys/class/net/{{A_NETDEV}}/mode
sudo dmesg | grep -i 'connected mode' | tail -1
```

Sample output:

```text real=doca
datagram
connected
/sys/class/net/ibs64f1/mode: Invalid argument (os error 22)
[10397.676091] ibs64f1: Connected Mode not supported from MLNX_OFED 23.07 and above
```

**Read it:** on this driver the write fails with `Invalid argument`, and the kernel log says why:
NVIDIA's stack dropped connected mode (`Connected Mode not supported from MLNX_OFED 23.07 and
above`); ConnectX-4 and later run IPoIB in an offloaded datagram mode ("enhanced IPoIB") instead.
The upstream kernel IPoIB driver still documents connected mode; whether it works with your adapter
and kernel is something to test, not assume (this lab did not test the inbox driver). For
throughput, enhanced datagram mode relies on offloads (TSO/GSO show `gso_max_size 65536` in
Task 1) rather than on a large MTU.

### Task 5: TCP over IPoIB versus RDMA on the same link

Measure TCP throughput, one stream and four. On **host B**:

```bash
iperf3 -s -p 18611
```

On **host A**:

```bash
iperf3 -c {{B_IP}} -p 18611 -t 5 -f g
iperf3 -c {{B_IP}} -p 18611 -t 5 -P 4 -f g
```

Stop the server on B with Ctrl-C. Then RDMA on the same port, server on B, client on A (the
handshake goes over IPoIB this time):

```bash
ib_write_bw -d {{B_RDMA_DEV}} -i {{RDMA_PORT}} -F --report_gbits -p 18612                    # host B
ib_write_bw -d {{A_RDMA_DEV}} -i {{RDMA_PORT}} -F --report_gbits -p 18612 {{B_IP}}          # host A
```

And latency: `ping` over IPoIB against an RDMA write round trip:

```bash
ping -c 20 -q {{B_IP}}                                                                          # host A
ib_write_lat -d {{B_RDMA_DEV}} -i {{RDMA_PORT}} -F -p 18613                                   # host B
ib_write_lat -d {{A_RDMA_DEV}} -i {{RDMA_PORT}} -F -p 18613 {{B_IP}}                         # host A
```

Sample results from the verification run:

```text
iperf3, 1 stream:   [  5]   0.00-5.00   sec  21.8 GBytes  37.4 Gbits/sec                  receiver
iperf3, 4 streams:  [SUM]   0.00-5.01   sec  54.7 GBytes  93.8 Gbits/sec                  receiver
ib_write_bw:         65536      5000             94.58              94.57  		     0.180379
ping:               rtt min/avg/max/mdev = 0.191/0.288/0.403/0.064 ms
ib_write_lat:        2       1000          0.92           8.71         0.95     	       0.99        	0.19   		1.06    		8.71
```

**Read it:**

- One TCP stream is limited by one CPU core (copies, checksums, interrupts), well below the link
  (25-37 Gb/s in different runs here); several streams spread over cores and get close to the line
  rate (79-95 Gb/s). `ib_write_bw` gets there with
  **one** queue pair and almost no CPU: the NIC moves the data.
- The latency gap is large: `ping` (one packet per second, so it also measures idle CPUs waking
  up) took about 0.2-0.3 ms per round trip; `ib_write_lat` reports half a round trip, under 1 us.
  Even a tight TCP ping-pong over IPoIB took about 15 us in [hw-14](#/hw/labs/hw-14-mpi-ucx-rdma). This is why RDMA programs use IPoIB only for their bootstrap (NCCL's
  `NCCL_SOCKET_IFNAME` interface, perftest's handshake, MPI's launcher) and never for their data.
- IPoIB is still the right tool for what it is used for: SSH, storage protocols that are not
  RDMA-aware, monitoring, and the first contact between ranks.

## Verify

With both interfaces up and the SM running with `partitions-mtu4k.conf` (Task 3), on host A:

```bash
cd {{AINA_DIR}}/labs
./hw-toolkit/aina-hw check hw-11-ipoib
```

The check confirms both InfiniBand ports are `ACTIVE`, the profile's interfaces are IPoIB, up, with
their addresses and the same MTU (4092 passes, 2044 warns and points at Task 3), that `ping` works
with full-size packets and DF set, and runs a 5-second, 4-stream `iperf3` over IPoIB (TCP 18611).

## Restore

On **both** hosts:

```bash
cd {{AINA_DIR}}/labs/hw-11-ipoib
sudo ./ipoib.sh restore --role A      # on host B: --role B
```

On **host A**, stop the SM:

```bash
cd {{AINA_DIR}}/labs/hw-10-ib-sm-failover
sudo ./lab-sm.sh stop
```

`ipoib.sh restore` removes the address it added and sets the interface down again if it was down
before. If the connected-mode write in Task 4 succeeded on your driver, set it back with
`echo datagram | sudo tee /sys/class/net/{{A_NETDEV}}/mode` before restoring.

## What you learned

- An IPoIB address is a QPN plus a GID; broadcast and ARP use a multicast group the SM creates.
- The IPoIB MTU in datagram mode is the broadcast group's MTU minus 4 bytes: 2044 with OpenSM's
  default group, 4092 with `mtu=5` in the partition configuration. The SM decides, not `ip link`.
- NVIDIA's current stack runs IPoIB only in (offloaded) datagram mode; connected mode is refused.
- TCP over IPoIB needs several streams and CPU to approach the link rate, and its round trips cost
  tens to hundreds of microseconds; RDMA reaches the rate with one QP at about a microsecond. Use IPoIB
  for control and bootstrap traffic, RDMA for data.

## Going further

- Capture IPoIB traffic with `tcpdump -i {{A_NETDEV}}` during a `ping` and compare the frame layout
  with Ethernet.
- Pin `iperf3` to cores of the NIC's NUMA node (`-A`, or `numactl`) and see how much one stream
  gains.
- Continue with [hw-12](#/hw/labs/hw-12-ib-partitions): IPoIB child interfaces on other partitions.
