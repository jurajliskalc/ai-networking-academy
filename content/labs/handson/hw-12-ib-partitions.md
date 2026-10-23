---
id: hw-12-ib-partitions
title: "P_Key partitions: full and limited members, IPoIB child interfaces and traffic that never arrives"
kind: handson
level: 3
estimated_minutes: 90
environment: hardware
tier: 1
fabric: ib
requires: [infiniband, two-rdma-hosts, root, ssh-mesh]
changes_config: true
lessons: [ib-architecture, subnet-manager-routing, ib-tools-diagnostics]
files: labs/hw-12-ib-partitions
verified: true
summary: "Define three partitions in OpenSM, read them in each port's P_Key table, run IPoIB and RDMA on them, and watch limited-to-limited traffic get dropped and counted as a P_Key violation."
---

> [!NOTE]
> Verified end to end (every task, the check and the restore step) on 2026-10-23 on two ConnectX-5 VPI cards with port 2 in InfiniBand mode, cabled back to back (EDR DAC, no switch;
> ESXi VMs with PCI passthrough; Ubuntu 26.04.1, kernel 7.0.0-38, NVIDIA DOCA-OFED 3.4 with its OpenSM
> 5.27.1); see `labs/README.md`. Switch partition enforcement was not part of
> that run (no switch).

## Goal

InfiniBand isolates tenants, storage and management traffic with **partitions**, the closest thing
it has to VLANs. The subnet manager decides which ports belong to which partition and writes a
**P_Key** (partition key) table into every port; the hardware drops any packet whose P_Key the
receiving port does not hold. In this lab you build three partitions between host A (`{{HOST_A}}`)
and host B (`{{HOST_B}}`) and test them with IPoIB and RDMA.

By the end you can:

- Write an OpenSM partition configuration with full and limited members.
- Read P_Key tables in sysfs and with `smpquery pkeys`, and tell full from limited membership.
- Put IPoIB child interfaces on partitions and predict which pairs can talk.
- Run perftest on a partition and find the dropped packets in the `PkeyViolations` counter.

> [!NOTE]
> Output blocks labelled as a real capture come from the verification run (two ConnectX-5 ports in
> InfiniBand mode back to back, DOCA-OFED 3.4, OpenSM 5.27.1; host A LID 1, host B LID 2). GUIDs,
> LIDs, table indexes and counter values differ on your fabric.

## Before you start

- **[hw-11](#/hw/labs/hw-11-ipoib) works**: IPoIB comes up on both hosts with `ipoib.sh`, and the
  hw-10 directory provides `lab-sm.sh`. No other OpenSM may run on host A.
- **A test fabric.** Partitions change what every port in the subnet may talk to. On a shared fabric
  managed by a switch SM or UFM, partitions are configured there, by its administrators; do not
  start an SM of your own.
- **Addresses:** the child interfaces use `10.81.1.0/24`, `10.81.2.0/24` and `10.81.3.0/24` (host A
  `.1`, host B `.2`). If those collide with your networks, set `PKEY_NET` in
  `labs/hw-12-ib-partitions/partitions.env` on both hosts.
- **Changes:** the SM runs with a generated partition file; `pkey-children.sh` creates three IPoIB
  child interfaces per host. The Restore section removes them and has the SM rewrite the default
  P_Key tables.

## Tasks

### Task 1: Write the partitions

On host A, generate the lab's partition file. It needs both port GUIDs and reads B's over SSH:

```bash
cd {{AINA_DIR}}/labs/hw-12-ib-partitions
./gen-partitions.sh > /tmp/aina-partitions.conf
cat /tmp/aina-partitions.conf
```

Sample output:

```text real=doca
# hw-12-ib-partitions, generated 2026-10-23T19:16Z. Host A port GUID 0x248a0703000011ef, host B 0x1c34da0300002229.
# Default partition: every port a full member, IPoIB broadcast group with a 4096-byte MTU (mtu=5).
Default=0x7fff, ipoib, mtu=5 : ALL=full ;
storage=0x8001, ipoib, mtu=5 : 0x248a0703000011ef=full, 0x1c34da0300002229=full ;
compute=0x8002, ipoib, mtu=5 : 0x248a0703000011ef=full, 0x1c34da0300002229=limited ;
isolated=0x8003, ipoib, mtu=5 : 0x248a0703000011ef=limited, 0x1c34da0300002229=limited ;
```

**Read it:** each line is `name=P_Key, flags : members ;`.

- `0x8001` and friends: a P_Key is 16 bits. The low 15 bits name the partition, the top bit is the
  **membership**: set (`0x8001`) = **full** member, clear (`0x0001`) = **limited** member.
  `0x7fff`/`0xffff` is the default partition.
- **Full** members may talk to everyone in the partition. **Limited** members may talk only to full
  members, never to each other: the classic use is a storage or management server (full) that all
  clients (limited) can reach while the clients cannot reach one another.
- `storage` has both hosts full, `compute` has B limited, `isolated` has both limited: a partition in
  which nobody can talk.
- `ipoib, mtu=5` asks the SM to create the IPoIB broadcast group with a 4096-byte MTU (hw-11).
- OpenSM's `partitions.conf` man section (`man opensm`, PARTITION CONFIGURATION) documents the
  syntax, including `ALL`, `SELF` and `defmember=`.

### Task 2: Start the SM and read the P_Key tables

On host A:

```bash
cd {{AINA_DIR}}/labs/hw-10-ib-sm-failover
sudo ./lab-sm.sh start --role A --partitions /tmp/aina-partitions.conf
grep -H . /sys/class/infiniband/{{A_RDMA_DEV}}/ports/{{RDMA_PORT}}/pkeys/[0-4]
ssh {{HOST_B}} "grep -H . /sys/class/infiniband/{{B_RDMA_DEV}}/ports/{{RDMA_PORT}}/pkeys/[0-4]"
sudo smpquery -C {{A_RDMA_DEV}} -P {{RDMA_PORT}} pkeys <LID of host B>
```

Sample output:

```text real=doca
/sys/class/infiniband/mlx5_1/ports/1/pkeys/0:0xffff
/sys/class/infiniband/mlx5_1/ports/1/pkeys/1:0x8001
/sys/class/infiniband/mlx5_1/ports/1/pkeys/2:0x8002
/sys/class/infiniband/mlx5_1/ports/1/pkeys/3:0x0003
/sys/class/infiniband/mlx5_1/ports/1/pkeys/4:0x0000
/sys/class/infiniband/mlx5_1/ports/1/pkeys/0:0xffff
/sys/class/infiniband/mlx5_1/ports/1/pkeys/1:0x8001
/sys/class/infiniband/mlx5_1/ports/1/pkeys/2:0x0002
/sys/class/infiniband/mlx5_1/ports/1/pkeys/3:0x0003
/sys/class/infiniband/mlx5_1/ports/1/pkeys/4:0x0000
   0: 0xffff 0x8001 0x0002 0x0003 0x0000 0x0000 0x0000 0x0000
   8: 0x0000 0x0000 0x0000 0x0000 0x0000 0x0000 0x0000 0x0000
...
 120: 0x0000 0x0000 0x0000 0x0000 0x0000 0x0000 0x0000 0x0000
128 pkeys capacity for this port
```

**Read it:**

- Host A's table holds `0xffff 0x8001 0x8002 0x0003`: full member of the default partition,
  storage and compute, limited member of isolated. Host B's holds `0x0002` for compute: limited.
- `smpquery pkeys` reads the same table over the fabric with a management datagram, from any host:
  that is how you audit a remote port without logging in. The table has 128 entries on this
  adapter.
- The **index** of a P_Key in the table matters to applications: a queue pair is bound to a P_Key
  *index*, not to a value (perftest's `--pkey_index` in Task 4). Indexes can differ between hosts.

### Task 3: IPoIB on the partitions

Bring up the parent IPoIB interface (hw-11) and the child interfaces on **both** hosts. On host A:

```bash
cd {{AINA_DIR}}/labs/hw-11-ipoib
sudo ./ipoib.sh up --role A
cd {{AINA_DIR}}/labs/hw-12-ib-partitions
sudo ./pkey-children.sh up --role A
```

On host B the same with `--role B`. A child interface is `ip link add link <parent> name
<parent>.<pkey> type ipoib pkey <pkey>`; the script also adds the addresses. Then on host A:

```bash
ip -d link show {{A_NETDEV}}.8003 | grep -o 'ipoib pkey [^ ]* mode [^ ]*'
for n in 1 2 3; do ping -c 3 -W 1 -q 10.81.$n.2 | tail -2 | head -1; done
ip neigh show dev {{A_NETDEV}}.8003
sudo ip link add link {{A_NETDEV}} name {{A_NETDEV}}.8004 type ipoib pkey 0x8004
sudo ip link set {{A_NETDEV}}.8004 up; sleep 3; ip -br link show {{A_NETDEV}}.8004
sudo ip link del {{A_NETDEV}}.8004
```

Sample output:

```text real=doca
ipoib pkey 0x8003 mode datagram
3 packets transmitted, 3 received, 0% packet loss, time 2004ms
3 packets transmitted, 3 received, 0% packet loss, time 2042ms
3 packets transmitted, 0 received, 100% packet loss, time 2042ms
10.81.3.2 INCOMPLETE
ibs64f1.8004@ibs64f1 DOWN           00:00:22:85:fe:80:00:00:00:00:00:00:24:8a:07:03:00:00:11:ef <NO-CARRIER,BROADCAST,MULTICAST,UP>
```

**Read it:**

- `10.81.1.2` (storage, full and full) and `10.81.2.2` (compute, full A and limited B) answer;
  `10.81.3.2` (isolated, both limited) does not, and the neighbour entry stays `INCOMPLETE` (later
  `FAILED`): ARP itself never got through. Nothing on either host is misconfigured; the hardware drops the packets.
- The child on `0x8003` is created with the full-member value, but host A only holds `0x0003`
  (limited); the driver still brings it up on that entry, and the port takes part as a limited
  member.
- `0x8004` is in nobody's table: the child interface stays `NO-CARRIER`. That is the first thing to
  check when a new IPoIB partition interface does not come up: does the SM put this port in the
  partition?

Run the check now (Verify section).

### Task 4: RDMA on a partition, and the counter that proves the drops

perftest selects the partition by P_Key index (`--pkey_index`). Take the index of `0x8002`/`0x0002`
(compute) and `0x0003` (isolated) from each host's table in Task 2 (both were at 2 and 3 here).
Server on host B, client on host A, compute first:

```bash
ib_write_bw -d {{B_RDMA_DEV}} -i {{RDMA_PORT}} --pkey_index=2 -F --report_gbits -n 2000 -p 18614              # host B
ib_write_bw -d {{A_RDMA_DEV}} -i {{RDMA_PORT}} --pkey_index=2 -F --report_gbits -n 2000 -p 18614 {{HOST_B}}   # host A
```

Then isolated, and read B's `PkeyViolations` before and after (from host A, by B's LID):

```bash
sudo smpquery -C {{A_RDMA_DEV}} -P {{RDMA_PORT}} portinfo <LID of host B> | grep PkeyViolations
ib_write_bw -d {{B_RDMA_DEV}} -i {{RDMA_PORT}} --pkey_index=3 -F --report_gbits -n 2000 -p 18614              # host B
ib_write_bw -d {{A_RDMA_DEV}} -i {{RDMA_PORT}} --pkey_index=3 -F --report_gbits -n 2000 -p 18614 {{HOST_B}}   # host A
sudo smpquery -C {{A_RDMA_DEV}} -P {{RDMA_PORT}} portinfo <LID of host B> | grep PkeyViolations
```

Stop the host B server with Ctrl-C if it is still waiting. Sample output:

```text
compute (index 2):
 #bytes     #iterations    BW peak[Gb/sec]    BW average[Gb/sec]   MsgRate[Mpps]
 65536      2000             93.24              93.15  		     0.177673
isolated (index 3):
PkeyViolations:..................49152
 Completion with error at client
 Failed status-transport retry counter exceeded (12): wr_id 0 syndrom 0x81
 Failed to complete run_iter_bw function successfully
PkeyViolations:..................65535
```

**Read it:**

- On compute the test runs at full speed: one full member is enough.
- On isolated the connection setup succeeds (it goes over TCP to `{{HOST_B}}`), but every RDMA
  packet is dropped at B's port. The sender's queue pair retries until it gives up:
  `transport retry counter exceeded (12)`, the same error a dead link or a wrong LID produces.
- B's **`PkeyViolations`** (a PortInfo field, not a `perfquery` counter) rose: that is the evidence
  that separates "partition" from "link" or "routing". It is a 16-bit counter that stops at 65535:
  here earlier test runs had already left it at 49152, and this run saturated it. A non-zero value
  can be old, so compare before and after. `perfquery` shows no receive
  errors at the same time; check PortInfo when an RDMA connection times out on an otherwise healthy
  fabric.

> [!VERIFIED]
> **Limited-to-limited RDMA failed as a transport retry timeout, and only PortInfo showed why.** On
> ConnectX-5 (firmware 16.29/16.34, DOCA-OFED 3.4), `ib_write_bw --pkey_index` on a partition where
> both ports were limited members failed with `Failed status-transport retry counter exceeded (12)`,
> `perfquery` showed no error counter change, and the receiver's `PkeyViolations` (in
> `smpquery portinfo`) rose until it saturated at 65535.

## Verify

With the SM running on the lab partitions and all child interfaces up (Tasks 2 and 3), on host A:

```bash
cd {{AINA_DIR}}/labs
./hw-toolkit/aina-hw check hw-12-ib-partitions
```

The check reads both ports' P_Key tables and confirms each lab partition is there with the right
membership (full or limited) on each host, then pings host B on each partition: storage and compute
must answer, isolated must not.

## Restore

On **both** hosts, remove the child interfaces and the parent address:

```bash
cd {{AINA_DIR}}/labs/hw-12-ib-partitions
sudo ./pkey-children.sh restore --role A      # on host B: --role B
cd {{AINA_DIR}}/labs/hw-11-ipoib
sudo ./ipoib.sh restore --role A              # on host B: --role B
```

On **host A**, let the SM rewrite the default P_Key tables, check them, and stop it:

```bash
cd {{AINA_DIR}}/labs/hw-10-ib-sm-failover
sudo ./lab-sm.sh stop
sudo ./lab-sm.sh start --role A
sleep 5
grep -H . /sys/class/infiniband/{{A_RDMA_DEV}}/ports/{{RDMA_PORT}}/pkeys/[0-3]
sudo smpquery -C {{A_RDMA_DEV}} -P {{RDMA_PORT}} pkeys <LID of host B> | head -1
sudo ./lab-sm.sh stop
rm -f /tmp/aina-partitions.conf
```

Only `0xffff` should remain at index 0. P_Key tables live in the adapters: stopping the SM does not
clear them, which is why the SM has to sweep once with the default configuration.

## What you learned

- Partitions are defined once, in the SM, and enforced in hardware by every port's P_Key table.
- The top bit of a P_Key is the membership: full members talk to everyone in the partition, limited
  members only to full members.
- IPoIB child interfaces (`type ipoib pkey ...`) put IP on a partition; no table entry means no
  carrier, limited-to-limited means silent drops.
- A partition drop looks like a dead path to RDMA (`retry counter exceeded`); the `PkeyViolations`
  PortInfo field tells the two apart.

## Going further

- Make host A a full and host B a limited member of the default partition (the man page's
  `Default=0x7fff : ALL=limited, SELF=full ;` pattern) and see what still works, including the SM.
- Run `sudo ibdiagnet -i {{A_RDMA_DEV}} -p {{RDMA_PORT}}` with the partitions active and read
  `ibdiagnet2.pkey` (more in [hw-13](#/hw/labs/hw-13-ibdiagnet-triage)).
- Find out how your RDMA applications choose a partition (a P_Key index option or environment
  variable, rdma_cm's IPoIB-interface mapping); the names differ per library and version, so take
  them from its documentation.
