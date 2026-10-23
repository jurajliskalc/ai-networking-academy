# Hardware verification reference

What host tools really print and do, verified on real hardware on 2026-10-23. Content (lessons, labs, command
reference, quizzes, exams) and the Fabric Simulator's host-tool output must match the formats and behaviours
recorded here; values in sample output stay illustrative. Anything not listed here is unverified: hedge it or
verify it before stating it as fact. Parser fixtures from this run are in `labs/hw-toolkit/tests/captures/` and
`frontend/tests/fixtures/`; the simulator's format tests are `frontend/tests/sim-golden.test.ts` (simulator output vs
the real captures in `frontend/tests/fixtures/real/`, see docs/SIMULATOR.md) and `frontend/tests/sim-real-format.test.ts`.

Hosts: 2x Dell R640, ESXi VMs, ConnectX-5 MCX556A-ECAT (VPI, EDR IB / 100GbE) via PCI passthrough, ports
cabled back to back with 1 m DAC (MCP1600-E00AE30). Ubuntu 26.04.1 LTS, kernel 7.0.0-38-generic, Secure Boot ON
(kernel lockdown = integrity). Firmware 16.29.1016 (A), 16.34.1002 (B).

Two driver stacks were tested on the same hardware:
- **INBOX**: kernel mlx5_core + Ubuntu rdma-core 61.0, perftest 25.01.0, iproute2 6.19 (`dcb`, `rdma`), ethtool 6.19.
- **DOCA**: NVIDIA DOCA-OFED 3.4.0 (`ofed_info -s` = `OFED-internal-26.04-0.8.6:`), rdma-core 2604.0.7,
  perftest 26.04.16 (`--version`: 6.29), mlnx-tools 2604.0.13, MFT 4.36/4.37. Kernel modules from Canonical's
  signed `linux-modules-doca-ofed-3.4-generic` (load under Secure Boot; no DKMS).

Raw captures (exact output, one file per command) were taken with a capture script on host A; they contain
adapter and cable serial numbers and are not in the repository as a whole. A curated subset without serial numbers
is in `frontend/tests/fixtures/real/`.

## Verified facts

### Naming
- RDMA device names depend on the stack: INBOX (rdma-core udev rule) = `rocep3s0f0`/`rocep3s0f1` (name built
  from the PCI address); DOCA = `mlx5_0`/`mlx5_1`. Netdev names (`ens64f0np0`) are the same on both.
  Content that says "`mlx5_0`" should say it is the NVIDIA-stack/typical name and that distro rdma-core names
  devices like `rocep<bus>s<slot>f<fn>`; tell readers to take the name from `rdma link` / `ibv_devices`.
- `ibv_devinfo -d <missing>` prints `IB device 'mlx5_0' wasn't found` (exit 255).
- `ib_write_bw -d <missing>` prints `IB device mlx5_0 not found` then ` Unable to find the Infiniband/RoCE device`.

### Tools that exist only with the NVIDIA stack (DOCA/MLNX_OFED)
`mlnx_qos`, `show_gids`, `ibdev2netdev`, `cma_roce_tos`, `cma_roce_mode`, `ofed_info` (mlnx-tools /
mlnx-ofed-kernel-utils). Not in Ubuntu's archive. INBOX equivalents:
- `mlnx_qos` -> `dcb` (iproute2): `dcb pfc`, `dcb app`, `dcb ets`, `dcb buffer`. `dcb apptrust` is NOT supported by
  mlx5 here (prints `Attribute not found: Success`, exit 1). On mlx5, adding a DSCP app entry
  (`dcb app replace dev X dscp-prio 26:3`) switches the port to DSCP trust (verified: tclass 106 traffic counted in
  prio 3).
- `show_gids` -> read `/sys/class/infiniband/<dev>/ports/1/gids/N`, `gid_attrs/types/N`, `gid_attrs/ndevs/N`.
- `ibdev2netdev` -> `rdma link show` (shows `netdev`).
- `cma_roce_tos` / `cma_roce_mode` -> rdma_cm configfs: `mkdir /sys/kernel/config/rdma_cm/<dev>` then
  `ports/1/default_roce_tos` and `default_roce_mode`. `cma_roce_tos -t 106` writes exactly this file (verified: the
  configfs file reads 106 afterwards). Default ToS 0, default mode `RoCE v2`. Writing it directly also works
  (verified): `echo 106 | sudo tee /sys/kernel/config/rdma_cm/mlx5_0/ports/1/default_roce_tos`, after which
  `cma_roce_tos -d mlx5_0` prints 106; `rmdir /sys/kernel/config/rdma_cm/mlx5_0` removes the configfs entry.
  `dcb app add dev X dscp-prio 26:3` works (rc 0, and rc 0 again for a duplicate add); `dcb app del` removes it.

### ECN / DCQCN knobs
- `/sys/class/net/<if>/ecn/roce_np|roce_rp/...` exists ONLY with the NVIDIA stack (DOCA). INBOX: the directory does
  not exist (`No such file or directory`).
- DOCA defaults: `roce_np/enable/N` and `roce_rp/enable/N` = 1 for all priorities 0-7; `roce_np/cnp_dscp` = 48;
  `roce_np/cnp_802p_prio` = 6; `min_time_between_cnps` = 4; `roce_rp/*` exposes `rpg_ai_rate` (5), `rpg_hai_rate` (50),
  `rpg_gd` (11), `rpg_min_dec_fac` (50), `rpg_threshold` (1), `rpg_time_reset` (300), `rpg_byte_reset` (32767),
  `initial_alpha_value` (1023), `dce_tcp_g` (1019), `dce_tcp_rtt` (1), `rate_reduce_monitor_period` (4),
  `clamp_tgt_rate` (0), `clamp_tgt_rate_after_time_inc` (1), `rate_to_set_on_first_cnp` (0), `rpg_max_rate` (0),
  `rpg_min_rate` (1).
- INBOX exposes DCQCN parameters in debugfs `/sys/kernel/debug/mlx5/<pci>/cc_params/` (np_cnp_dscp, np_cnp_prio,
  rp_ai_rate, ...). With Secure Boot, kernel lockdown blocks debugfs reads even for root
  (`Operation not permitted`; dmesg: `Lockdown: grep: debugfs access is restricted`).
- RoCE CC counters (both stacks) are in `rdma statistic show link <dev>/1` and
  `/sys/class/infiniband/<dev>/ports/1/hw_counters/`: `np_cnp_sent`, `np_ecn_marked_roce_packets`, `rp_cnp_handled`,
  `rp_cnp_ignored`, plus `roce_adp_retrans`, `roce_slow_restart*`, `out_of_sequence`, `packet_seq_err`,
  `local_ack_timeout_err`, `req_transport_retries_exceeded`, `rx_icrc_encapsulated`, ... Back to back with no
  switch, `np_ecn_marked_roce_packets` stays 0 (nothing marks ECN) and so do the CNP counters while
  nothing is dropped. But CNPs WITHOUT ECN marks were seen: with untagged traffic in lossy priority 0 and
  global pause off (PFC on priority 3), B's `np_cnp_sent` rose +17 with `out_of_sequence` +30 in a 10 s run,
  `np_ecn_marked_roce_packets` +0, and A's `rp_cnp_handled` counted them; runs without drops sent no CNPs.

### PFC and global pause (mlx5, both stacks)
- Default: global 802.3x pause ON (`ethtool -a`: RX on, TX on), PFC off on all priorities, trust pcp.
- Enabling PFC on any priority turns global pause OFF automatically (`ethtool -a` -> RX off, TX off).
- `ethtool -A <if> rx on tx on` while PFC is enabled silently clears PFC on all priorities (rc 0, no warning).
  Verified with both `dcb pfc` and `mlnx_qos`.
- PFC counters appear in `ethtool -S` only for priorities with PFC enabled: `rx_prio3_pause`,
  `rx_prio3_pause_duration`, `tx_prio3_pause`, `tx_prio3_pause_duration`, `rx_prio3_pause_transition`.
  `rx_global_pause`, `tx_global_pause`, `*_global_pause_duration`, `rx_global_pause_transition` appear only while
  global 802.3x pause is on (the default); once PFC is enabled they DISAPPEAR and the `prioN_pause*` counters appear
  instead. Always present: `tx_pause_storm_warning_events`,
  `tx_pause_storm_error_events`, `rx_pause_ctrl_phy`, `tx_pause_ctrl_phy`.
- Even back to back at 100G the receiver sends PFC pauses under ib_write_bw load (rx_prio3_pause 696 after 10 s).
- `dcb buffer show` after PFC on prio 3: `prio-buffer 0:0 1:0 2:0 3:1 ...`, `buffer-size 0:130944b 1:130944b ...`,
  `total-size 262016b`.

### Real output formats (exact; values illustrative)
- `dcb app show dev X` prints well-known DSCP values by NAME: `dscp-prio AF31:3` for 26. `dcb -N app show` prints
  `dscp-prio 26:3`. Empty table prints nothing.
- `dcb pfc show dev X` -> `pfc-cap 8 macsec-bypass off delay 7` / `prio-pfc 0:off 1:off 2:off 3:on 4:off 5:off 6:off 7:off`.
- `dcb ets show dev X` -> lines `willing off ets-cap 8 cbs off`, `tc-bw 0:0 ...`, `pg-bw ...`,
  `tc-tsa 0:vendor ...`, `prio-tc 0:1 1:0 2:2 3:3 4:4 5:5 6:6 7:7`, `reco-tc-bw`, `reco-tc-tsa 0:strict ...`, `reco-prio-tc`.
  NOTE default prio-tc mapping on mlx5: priority 0 -> TC1 and priority 1 -> TC0.
- `dcb ets set dev X tc-tsa all:ets 6:strict tc-bw 0:10 1:5 2:5 3:60 4:5 5:5 6:0 7:10` (run on the DOCA host)
  -> rc 0; `dcb ets show` then reads `tc-bw ... 6:100 ...` for the strict TC, and `mlnx_qos` shows the same ETS table.
  With DOCA the default read `tc-bw` 100 for every TC (the inbox capture above read 0). Restore with
  `tc-tsa all:vendor tc-bw all:0`; `tc-bw all:100` is rejected by dcb itself:
  `Bandwidth percentages in tc-bw sum to 800%, expected 0%` (rc 1).
- `mlnx_qos -i X` (DOCA, default):
  ```
  DCBX mode: OS controlled
  Priority trust state: pcp
  Receive buffer size (bytes): 262016,0,0,0,0,0,0,0,max_buffer_size=262016
  Cable len: 7
  PFC configuration:
  	priority    0   1   2   3   4   5   6   7
  	enabled     0   0   0   0   0   0   0   0
  	buffer      0   0   0   0   0   0   0   0
  tc: 0 ratelimit: unlimited, tsa: vendor
  	 priority:  1
  tc: 1 ratelimit: unlimited, tsa: vendor
  	 priority:  0
  tc: 2 ratelimit: unlimited, tsa: vendor
  	 priority:  2
  ... (tc 3..7 -> priority 3..7)
  ```
  With `--trust dscp` a `dscp2prio mapping:` block follows the trust line (`\tprio:0 dscp:07,06,05,04,03,02,01,00,`
  ... `\tprio:7 dscp:63,...,56,`); after `--dscp2prio set,26,3` prio 3 reads `dscp:26,31,30,29,28,27,25,24,`.
  With PFC on prio 3: `Receive buffer size (bytes): 130944,130944,0,0,0,0,0,0,max_buffer_size=262016`, enabled and
  buffer rows show `1` under priority 3. There is NO `default priority:` line. Setting options prints the full
  status afterwards. With ETS: `tc: 0 ratelimit: unlimited, tsa: ets, bw: 10%`, strict: `tsa: strict`.
  Errors: `--pfc 0,0,0,1` -> `pfc list must have 8 items`; `--trust foo` -> `Invalid trust state command. Refer to the help.`;
  ETS bandwidths not summing to 100 -> `Netlink error: Bad value. see dmesg.`
- `show_gids` (DOCA): header `DEV\tPORT\tINDEX\tGID\t\t\t\t\tIPv4  \t\tVER\tDEV`, rows like
  `mlx5_0\t1\t3\t0000:0000:0000:0000:0000:ffff:0a0a:0a01\t10.10.10.1  \tv2\tens64f0np0`, final `n_gids_found=8`.
  GID table on both stacks: index 0 = fe80 link-local RoCE v1, 1 = same RoCE v2, 2 = IPv4-mapped RoCE v1,
  3 = IPv4-mapped RoCE v2. So GID index 3 = RoCE v2 IPv4 holds (one IPv4 address, no extra IPv6).
- sysfs GID type strings: `IB/RoCE v1` and `RoCE v2`.
- `ibv_devinfo -v` GID lines (both stacks): `\t\t\tGID[  0]:\t\tfe80:0000:0000:0000:268a:07ff:fe00:11ee, RoCE v1`,
  `GID[  1]: fe80::268a:7ff:fe00:11ee, RoCE v2`, `GID[  2]: 0000:0000:0000:0000:0000:ffff:0a0a:0a01, RoCE v1`,
  `GID[  3]: ::ffff:10.10.10.1, RoCE v2` — v1 entries full hex, v2 entries compressed IPv6 notation.
- `ibdev2netdev` -> `mlx5_0 port 1 ==> ens64f0np0 (Up)`. `ibdev2netdev -v` as non-root prints
  `cat: /sys/class/infiniband/mlx5_0/device/vpd: Permission denied` lines, then
  `0000:03:00.0 mlx5_0 (MT4119 -            )                 fw 16.29.1016 port 1 (ACTIVE) ==> ens64f0np0 (Up)`.
- `ibv_devices`: `    device          \t   node GUID` / `    ------          \t----------------` /
  `    rocep3s0f0      \t248a0703000011ee` (device padded to 16, then a tab).
- `ibv_devinfo -d X`: `hca_id:\tX`, `transport:\t\t\tInfiniBand (0)` (also on RoCE), fw_ver, node_guid
  `248a:0703:0000:11ee`, vendor_id 0x02c9, vendor_part_id 4119 (CX-5), board_id MT_0000000008, port state
  `PORT_ACTIVE (4)`, `max_mtu: 4096 (5)`, `active_mtu: 4096 (5)`, `sm_lid: 0`, `port_lid: 0`, `link_layer: Ethernet`.
- `ibstat` on RoCE: `CA 'rocep3s0f0'`, `CA type: MT4119`, `Rate: 100`, `Base lid: 0`, `SM lid: 0`,
  `Capability mask: 0x00010000`, `Port GUID: 0x268a07fffe0011ee`, `Link layer: Ethernet`.
- `ibstatus` on RoCE: `rate:\t\t 100 Gb/sec (4X EDR)` (yes, EDR is printed even on Ethernet), `state:\t\t 4: ACTIVE`,
  `phys state:\t 5: LinkUp`, `link_layer:\t Ethernet`.
- `rdma link show` -> `link rocep3s0f0/1 state ACTIVE physical_state LINK_UP netdev ens64f0np0 ` (trailing space).
  Down port: `state DOWN physical_state DISABLED`.
- `rdma dev show` -> `0: rocep3s0f0: node_type ca protocol roce fw 16.29.1016 node_guid 248a:0703:0000:11ee sys_image_guid ...`.
- `rdma statistic show link X/1` (iproute2 6.19): first line `link X/1 `, then ONE COUNTER PER LINE indented 4 spaces
  (`    out_of_sequence 0 `). Older iproute2 printed them on one line; say formats differ by version.
- `rdma resource show` -> `0: rocep3s0f0: pd 3 cq 4 qp 1 cm_id 0 mr 0 ctx 0 srq 2`;
  `rdma resource show qp` -> `link rocep3s0f0/1 lqpn 1 type GSI state RTS sq-psn 0 comm [ib_core]`.
- `rdma system show` -> `netns shared privileged-qkey off monitor on copy-on-fork on`.
- `ethtool <if>` as non-root first prints `netlink error: Operation not permitted` (WoL query needs root), then the
  settings. On CX-5/DAC: `Supported ports: [ Backplane ]`, `Port: Direct Attach Copper`, `Speed: 100000Mb/s`,
  `Lanes: 4`, `Advertised FEC modes: RS`, `Link detected: yes`.
- `ethtool -m` needs root: non-root -> `netlink error: Operation not permitted`. On a DAC: no optical power / bias
  lines at all; `Module temperature : 0.00 degrees C / 32.00 degrees F` (temperature printed in C AND F),
  `Transmitter technology : 0xa0 (Copper cable, unequalized)`, `Length (Copper or Active cable) : 1m`.
- `ethtool --show-fec` -> `FEC parameters for X:` / `Supported/Configured FEC encodings: Auto` / `Active FEC encoding: RS`.
- `ethtool -a` -> `Pause parameters for X:` / `Autonegotiate:\toff` / `RX:\t\ton` / `TX:\t\ton`.
- `ethtool -i` -> `driver: mlx5_core`, `version: 7.0.0-38-generic` (INBOX: kernel version), `firmware-version:
  16.29.1016 (MT_0000000008)`, `bus-info: 0000:03:00.0`.
- `ethtool -S` has ~7000 counters (per-channel). Names that exist: `rx_vport_rdma_unicast_packets/bytes`,
  `tx_vport_rdma_unicast_packets/bytes`, `rx_discards_phy`, `tx_discards_phy`, `rx_prioN_discards`,
  `rx_crc_errors_phy`, `rx_symbol_err_phy`, `link_down_events_phy`, `rx_pcs_symbol_err_phy`, `rx_corrected_bits_phy`,
  `rx_out_of_buffer`, `rx_prioN_bytes`, `tx_prioN_bytes`, `rx_prioN_packets`, `rx_ecn_mark`, `rxN_ecn_mark`.
  RDMA traffic shows in `tx_vport_rdma_unicast_*` and in the `prio` byte counters, not in the netdev packet counters.
- `ip link set dev X mtu 9979` -> `Error: mtu greater than device maximum.` (max 9978 on CX-5).
- ping: DF oversize relative to the LOCAL MTU prints `ping: sendmsg: Message too long`, then statistics with
  `+1 errors`. (`ping: local error: message too long, mtu=N` is a different case: a learned path MTU.) `-I <addr>`
  header: `PING 10.10.10.2 (10.10.10.2) from 10.10.10.1 : 8972(9000) bytes of data.` 8972-byte payload replies
  print `8980 bytes from ...`. Unanswered target: no per-packet lines, `2 packets transmitted, 0 received, 100% packet loss`.
- `ibv_rc_pingpong`: `  local address:  LID 0x0000, QPN 0x000048, PSN 0x7bb49d, GID ::ffff:10.10.10.1` /
  `  remote address: LID 0x0000, ...` / `8192000 bytes in 0.01 seconds = 11330.57 Mbit/sec` /
  `1000 iters in 0.01 seconds = 5.78 usec/iter`. Mismatched GID (-g 0 vs 3): `client read/write: No space left on device` /
  `Couldn't read/write remote address`.
- perftest `ib_write_bw` (INBOX 25.01) header lines in order:
  ```
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
   local address: LID 0000 QPN 0x0047 PSN 0xfa74b8 RKey 0x184dec VAddr 0x007ad442d65000
   GID: 00:00:00:00:00:00:00:00:00:00:255:255:10:10:10:01
   remote address: LID 0000 QPN 0x0182 PSN 0x79c0ac RKey 0x0043ec VAddr 0x0078d288047000
   GID: 00:00:00:00:00:00:00:00:00:00:255:255:10:10:10:02
  ---------------------------------------------------------------------------------------
   #bytes     #iterations    BW peak[Gb/sec]    BW average[Gb/sec]   MsgRate[Mpps]
   65536      5000             95.59              95.57  		     0.182279
  ---------------------------------------------------------------------------------------
  ```
  DOCA perftest (6.29) differs: `ibv_wr* API     : ON		Using Enhanced Reorder      : OFF` replaces the DDP pair,
  adds ` CQE Poll Batch  : Dynamic` after `CQ Moderation` and ` NUMA node       : 0` after `GID index`.
  Server side prints the `* Waiting for client to connect... *` box first and has no `TX depth` line.
  With `-q N`: one local/remote address+GID pair per QP. With `-D`: first line
  ` WARNING: BW peak won't be measured in this run.` and BW peak prints `0.00`.
  Measured: 95.6 Gb/s (5000 iters, 64 KiB) on a 100G link; 96.9-98.0 Gb/s with -D.
- perftest failures: no server -> `Couldn't connect to 10.10.10.2:18515` / `Unable to open file descriptor for socket
  connection` / ` Unable to init the socket connection`. `-a` with default memlock (8192 KiB) -> `Couldn't allocate MR`
  / `failed to create mr` / `Failed to create MR` / ` Couldn't create IB resources` (fix: memlock unlimited;
  `setup-rdma-host.sh --set-memlock`). `--use_cuda` without CUDA build: check `ib_write_bw --help | grep -i cuda`
  (empty on distro perftest).
- `rping` needs `rdmacm-utils` (not installed by default). DOCA's rdma-core prints
  `libibverbs: Warning: couldn't load driver 'libionic-rdmav59.so': ...` from rdma_cm tools (harmless noise).
- `lspci` in a VM shows the virtual root port, e.g. `LnkSta: Speed 5GT/s, Width x32`; PCIe width/speed checks are
  meaningless inside ESXi VMs (VPD still shows `[V0] Vendor specific: PCIeGen3 x16`).
- No `cpufreq` (scaling_governor missing) inside the VM.
- `pkeys/0` = `0xffff`; `pkeys/1` does not exist on RoCE.
- `tcpdump -i <netdev>` does NOT see RoCE data traffic (offloaded). Verified: 0 packets for `udp port 4791`
  during ib_write_bw, both stacks.
- libpcap's **RDMA sniffer** DOES capture offloaded RoCE on mlx5: `tcpdump -D` lists `17.mlx5_0 (RDMA sniffer)`;
  `tcpdump -i mlx5_0 -w x.pcap` (capture on the RDMA DEVICE name, not the netdev) recorded the perftest TCP
  handshake, LLDP and the RoCEv2 packets (`10.10.10.1.55339 > 10.10.10.2.4791: UDP, length 3032` writes,
  `length 20` ACKs back). Caveats verified on Ubuntu 26.04: Ubuntu's AppArmor profile for tcpdump blocks it
  (`apparmor="DENIED" ... profile="tcpdump" name="/etc/libibverbs.d/"`; tcpdump then says
  `tcpdump: mlx5_0: No such device exists`), so it needs the profile in complain mode or an unconfined binary;
  a BPF filter on the sniffer was not verified (filter when reading: `tcpdump -r x.pcap 'udp port 4791'`);
  tcpdump drops privileges, so `-w` into a root-owned existing file fails with `Permission denied`.
  The rdma device name follows the stack (`rocep3s0f0` on INBOX). NVIDIA also ships `ibdump` (DOCA).
- Every libibverbs program under sudo/AppArmor or DOCA may print harmless warnings:
  `libibverbs: Warning: couldn't open config directory '/etc/libibverbs.d'.` (confined tcpdump) and, on DOCA,
  `libibverbs: Warning: couldn't load driver 'libionic-rdmav59.so': ...`.

### Soft-RoCE (rdma_rxe) and NVIDIA's stack
- With DOCA-OFED installed, Soft-RoCE is unusable on that host: DOCA replaces `ib_core`, `ib_uverbs` and friends
  (`/lib/modules/<kver>/ubuntu/dkms/doca-ofed-3.4/`) but ships no `rdma_rxe`, and the kernel's own module no longer
  loads: `modprobe rdma_rxe` -> `modprobe: ERROR: could not insert 'rdma_rxe': Invalid argument`, dmesg
  `rdma_rxe: disagrees about version of symbol ib_get_eth_speed` / `rdma_rxe: Unknown symbol ib_get_eth_speed (err -22)`.
  DOCA's `ibverbs-providers` (2604.0.7) also contains no rxe provider (`/etc/libibverbs.d/` lists `ionic.driver`
  and `mlx5.driver` only). Use a host or VM with the distribution's stack for the Soft-RoCE labs.
- With the distribution's stack, Soft-RoCE on a VMXNET3 interface (MTU 1500) works: `rxe0` exposes only RoCE v2 GIDs
  (index 0 link-local, index 1 IPv4-mapped), `fw_ver 0.0.0`, `vendor_id 0xffffff`, `active_mtu 1024 (3)`; 4.6-5.3 Gb/s
  `ib_write_bw` and about 5.8 us typical `ib_send_lat` on host A; a 4 KiB SEND is split into First/Middle/Middle/Last
  (opcodes 0,1,1,2) with AckReq on the last; a 3000-byte WRITE is 6/7/8 with the RETH on 6, ACKed by 17; a 2048-byte
  READ is request 12 answered by 13 and 15 (no opcode 17: the responses carry the AETH); rdma_cm shows
  `CM: ConnectRequest` / `ConnectReply` / `ReadyToUse` on QP 1 (`LID: 65535` as the first packet's source in tshark).
- Ubuntu 26.04's AppArmor profile for `tshark` (`/etc/apparmor.d/tshark`, via `abstractions/user-tmp`) only reads
  files in `/tmp` that the user OWNS. `sudo tcpdump -w /tmp/x.pcap` writes the file as user `tcpdump` (privilege drop),
  so `tshark -r /tmp/x.pcap` fails with `tshark: You don't have permission to read the file "/tmp/x.pcap".` (dmesg:
  `apparmor="DENIED" operation="open" ... profile="tshark"`), for root too. Verified fixes: `sudo tcpdump -Z $USER -w ...`
  (file owned by the reader) or `tshark -r - < /tmp/x.pcap`. The host profile also applied inside a privileged container.
- On Ubuntu 26.04 (kernel 7.0) `rdma_rxe` is in the main modules package; `linux-modules-extra-<kver>` does not
  exist for that kernel in the 24.04 archive.

### Secure Boot / kernel lockdown (Ubuntu with Secure Boot on)
- debugfs blocked (see cc_params above).
- MFT `mst start` prints `Loading MST PCI module - Success`, `Loading MST PCI configuration module -
  Success`, `Create devices`, then `Unloading MST PCI module (unused) - Success` (rc 0) and creates no
  /dev/mst devices. This happens WITH AND WITHOUT Secure Boot (MFT 4.37 reaches the device directly;
  `mst status -v` shows `NA` in the MST column), so it is not a lockdown symptom. With Secure Boot OFF
  (verified): `mlxlink`, `mlxconfig q` (`Device type: ConnectX5`, `LINK_TYPE_P1 ETH(2)`) and `flint q`
  (`FW Version: 16.29.1016`, `PSID: MT_0000000008`) work with `-d 03:00.0` or `-d mlx5_0`; `mstconfig -d 03:00.0
  q` works; `mlxfwmanager --query` lists `Part Number: MCX556A-ECA_Ax`; debugfs `cc_params/rp_ai_rate` reads 5;
  over `/dev/fwctl/fwctl0` mlxconfig and flint still fail the same way as with Secure Boot on. With Secure
  Boot ON: `mstconfig -d 03:00.0 q` (mstflint) fails with `FATAL - crspace read (0xf0014) failed: Bad file
  descriptor` / `-E- Failed to identify the device`; MFT `mlxconfig -d mlx5_0 q` and `-d 03:00.0 q` print
  `-E- Failed to open the device`; `mlxfwmanager --query` prints `-E- No devices found or specified, mst might be
  stopped, run 'mst start' to load MST modules`.
- perftest CUDA: distro perftest 25.01 has no CUDA (`--help | grep -i cuda` is empty; `--use_cuda=0`
  prints ` Parser function exited with Error` / ` Unsupported memory type`). DOCA perftest lists `--use_cuda`,
  `--cuda_mem_type`, `--use_cuda_bus_id`, `--use_cuda_dmabuf`, `--use_cuda_pcie_mapping`, `--use_data_direct`. Kernel 7.0 + MFT 4.37 offer the fwctl path: `mst status -v` lists `/dev/fwctl/fwctl0`;
  `mlxlink -d /dev/fwctl/fwctl0` WORKS; `mlxconfig -d /dev/fwctl/fwctl0 q` fails
  (`Cannot access NV register ... HW access is disabled`); `flint` fails. Changing LINK_TYPE (IB<->Eth) therefore
  needs Secure Boot off (or a signed MFT kernel module).
- `mlxlink -d mlx5_0` fails: `-E- Failed to open device: "mlx5_0", No such file or directory` (under lockdown).
- `mlxlink` real format (100GbE, values in 36th column, colors on a TTY):
  ```
  Operational Info
  ----------------
  State                              : Active
  Physical state                     : LinkUp
  Speed                              : 100GbE
  Width                              : 4x
  FEC                                : Standard RS-FEC - RS(528,514)
  Loopback Mode                      : No Loopback
  Auto Negotiation                   : ON
  ...
  Troubleshooting Info
  --------------------
  Status Opcode                      : 0
  Group Opcode                       : N/A
  Recommendation                     : No issue was observed
  ```
  Full `mlxlink`, `-c` and `-m` output (verified over fwctl). Sections in
  order: Operational Info, Port Info, Supported Info, Troubleshooting Info, Tool Information, then (with -c)
  `Physical Counters and BER Info` with lines in this order: `Time Since Last Clear [Min]`,
  `Effective Physical Errors`, `Raw Physical Errors Per Lane` (e.g. `0,0,0,0`), `Effective Physical BER`,
  `Raw Physical BER`, `Link Down Counter`, `Link Error Recovery Counter`. A clean link shows BER `15E-255`.
  With -m: `Module Info` (`Temperature [C]`, `Voltage [mV]`, `Bias Current [mA]`, `Rx Power Current [dBm]`,
  `Tx Power Current [dBm]` per lane, `Identifier`, `Compliance`, `Cable Technology`, `Vendor Part Number`,
  `Transfer Distance [m]`, ...). A passive DAC reports zeros for temperature/power.
- Changing the port type inside a VM (ESXi PCI passthrough, Secure Boot off): `mlxconfig -d 03:00.0 set
  LINK_TYPE_P2=1` succeeds (`-I- Please power cycle machine to load new configurations.` with fw 16.29,
  `... reboot machine ...` with fw 16.34); `mlxconfig -e q` then shows Default `IB(1)` (the factory default of
  this VPI card), Current `ETH(2)`, Next Boot `IB(1)`. Neither a guest reboot nor a full VM power-off/power-on
  loads it (Current stays `ETH(2)`), and `mlxfwreset -d 03:00.0 reset` refuses with `-E- The tool is not
  supported on virtual machines.` (its `query` lists level 3 "Driver restart and PCI reset" as supported).
  The physical host has to reset the adapter.
- `devlink dev info` -> `pci/0000:03:00.0:` / `  driver mlx5_core` / `  versions:` / `      fixed:` /
  `        fw.psid MT_0000000008` / `      running:` / `        fw.version 16.29.1016`.

### Further behaviour verified on the hardware
- debugfs under lockdown (DOCA too): `/sys/kernel/debug/mlx5/0000:03:00.0/cc_params/` lists `np_cnp_dscp`,
  `np_cnp_prio`, `np_cnp_prio_mode`, `np_min_time_between_cnps`, `rp_ai_rate`, ...; `cat rp_ai_rate` as root ->
  `cat: rp_ai_rate: Operation not permitted`; dmesg `Lockdown: cat: debugfs access is restricted; see man kernel_lockdown.7`.
- memlock 8192 KiB + `ib_write_bw -a`: `Couldn't allocate MR with error=12` (DOCA perftest; INBOX perftest prints
  `Couldn't allocate MR`), then `failed to create mr`, `Failed to create MR`, ` Couldn't create IB resources`.
- DSCP app entry removal: with `dcb app add ... 26:3` on both hosts, tclass-106 traffic counted in B's
  `rx_prio3_bytes` (+36.9 GB, prio0 +20 KB); after `dcb app del` B's trust read `pcp` and the same traffic went to
  `rx_prio0_bytes` (+37.0 GB, prio3 +0). `dcb app add` with several entries (`26:3 48:6`) and `dcb app del` with
  several work; `dcb app flush dev X` returned rc 0.
- Port states: `ip link set <if> down` on the LOCAL host -> `rdma link`: `state DOWN physical_state DISABLED`,
  sysfs phys_state `3: Disabled`. Taking the PEER's netdev down leaves the local port `ACTIVE` / `LINK_UP`
  (`ethtool`: Speed 100000Mb/s, Link detected: yes): mlx5 keeps the PHY of an admin-down port up. POLLING not observed.
- `ip -d link show` prints `minmtu 68` and `maxmtu 9978`; `ip link set mtu 9978` succeeds.
- `ib_write_bw -T 106` without `-R` -> ` TOS only valid for rdma_cm based QP and RawEth QP `. With `-R -T 106`:
  header ` rdma_cm QPs	 : ON` and ` Data ex. method : rdma_cm 	TOS    : 106`.
- MFT over fwctl: `mlxconfig -d /dev/fwctl/fwctl0 q` -> `-E- Cannot access NV register. Either FW does not support NV
  access register, or HW access is disabled. rc=(265)`; `flint -d /dev/fwctl/fwctl0 q` -> `-E- Cannot open Device:
  /dev/fwctl/fwctl0. Operation not supported. MFE_BAD_PARAMS`; `flint -d mlx5_0 q` -> `-E- Cannot open Device: mlx5_0. `;
  `mlxconfig -d mlx5_0 q` -> `-E- Failed to open the device`.
- PFC frames are consumed by the NIC: during a run where `rx_prio3_pause` rose by 2178, `tcpdump -i <netdev>
  ether proto 0x8808` captured 0 packets (and the RDMA sniffer captured no 0x8808 frames either).
- RDMA sniffer re-captured: confined tcpdump lists no sniffer and says
  `tcpdump: mlx5_0: No such device exists`; unconfined lists `17.mlx5_0 (RDMA sniffer)` and recorded 10 RoCEv2
  `udp/4791` packets out of 52 (`UDP, length 3032`).
- `rdma statistic` order (mlx5): rx_write_requests, rx_read_requests, rx_atomic_requests, rx_dct_connect,
  out_of_buffer, out_of_sequence, duplicate_request, rnr_nak_retry_err, packet_seq_err, implied_nak_seq_err,
  local_ack_timeout_err, resp_local_length_error, resp_cqe_error, req_cqe_error, req_remote_invalid_request,
  req_remote_access_errors, resp_remote_access_errors, resp_cqe_flush_error, req_cqe_flush_error,
  req_transport_retries_exceeded, req_rnr_retries_exceeded, roce_adp_retrans, roce_adp_retrans_to,
  roce_slow_restart, roce_slow_restart_cnps, roce_slow_restart_trans, rp_cnp_ignored, rp_cnp_handled,
  np_ecn_marked_roce_packets, np_cnp_sent, rx_icrc_encapsulated.

### Toolkit (labs/hw-toolkit)
- `setup-rdma-host.sh` ran clean on both hosts (installs rdmacm-utils, lldpd, ...); flags memlock 8192 KiB;
  `--set-memlock` fixes it after re-login.
- `ethtool -m` needs sudo (closes the hw-05 open question in NEXT_STEPS).
- Live counters (`aina-hw serve --live-remote`, `GET /api/live`, toolkit 1.1, DOCA, default QoS: global pause on,
  PFC off): during a 15 s `ib_write_bw -q 4` A -> B, A's `tx_vport_rdma_unicast_bytes` rate read 81-83 Gb/s per 1 s
  sample (perftest reported 80.12 Gb/s average) and B's `rx_vport_rdma_unicast_bytes` 81-82 Gb/s; `rx_prio3_bytes`
  stayed 0 (untagged traffic, PCP trust). At ramp-up B sent 802.3x pauses (`tx_global_pause` ~1800/s over 2 s) and A
  counted them (`rx_global_pause` ~3070/s, then 15/s, then 0); `out_of_sequence` and the CNP counters stayed 0. The
  netdev `rx_bytes`/`tx_bytes` barely moved (offloaded RDMA). `ethtool -S` on the CX-5 (~7000 counters) takes about
  12 ms, so a 1 s poll is cheap. Non-root can read every live counter (sysfs `hw_counters`, `ethtool -S`), the
  Secure Boot EFI variable and `/sys/kernel/security/lockdown` (`[none] integrity confidentiality` with Secure Boot
  off), and the rdma_cm configfs directory (`/sys/kernel/config/rdma_cm/` exists with no per-device entry by default).
- umad order on the mixed host: `umad0` = `mlx5_0` (RoCE), `umad1` = `mlx5_1` (IB). IPoIB netdevs have sysfs
  `type` 32 (ARPHRD_INFINIBAND).
- Per-task checks (`TASK:` markers): hw-01, hw-02, hw-04 and hw-05 passed on both hosts with the RoCE profile
  (hw-02: 98.0 Gb/s, hw-05: 89.1 Gb/s under 20 s load); hw-03 fails Tasks 2-4 as expected with the default QoS
  (trust pcp, PFC off) and passes Task 5 (DOCA ECN switches on for priority 3). hw-01 `--task 8` reran only the
  report task.

## InfiniBand mode (verified 2026-10-23)

Port 2 of both ConnectX-5 VPI cards switched to InfiniBand (`mlxconfig ... LINK_TYPE_P2=1`, applied by a
physical host reboot), cabled back to back, DOCA-OFED 3.4 (infiniband-diags 2604.0.7, OpenSM from DOCA).
Port 1 stayed Ethernet, so `mlx5_0` is RoCE and `mlx5_1` is InfiniBand on the same host.

**Without a subnet manager** (link trained, fabric not configured):
- `ibstat mlx5_1`: `State: Initializing`, `Physical state: LinkUp`, `Rate: 100`, `Base lid: 65535`, `LMC: 0`,
  `SM lid: 0`, `Capability mask: 0x2651e848`. The unassigned LID is **65535** (`0xffff` in sysfs `lid` and in
  `ibstatus` `base lid: 0xffff`), not 0. `ibstatus`: `state: 2: INIT`, `phys state: 5: LinkUp`,
  `rate: 100 Gb/sec (4X EDR)`.
- `rdma link`: `link mlx5_1/1 subnet_prefix fe80:0000:0000:0000 lid 65535 sm_lid 0 lmc 0 state INIT
  physical_state LINK_UP ` (no `netdev` field in IB mode, even with an IPoIB interface present).
- `iblinkinfo` works without an SM (directed routes): `==( 4X      25.78125 Gbps Initialize/  LinkUp)==>`,
  LIDs shown as 65535. `ibnetdiscover` also works and prints `# lid 65535 lmc 0 ... 4xEDR`.
- `sminfo` -> `ibwarn: [pid] _do_madrpc: recv failed: Connection timed out` /
  `ibwarn: [pid] mad_rpc: _do_madrpc failed; dport (DR path slid 0; dlid 0; 0)` / `sminfo: iberror: failed: query`
  (exit 255). `perfquery` -> `... dport (Lid 65535)` / `perfquery: iberror: failed: classportinfo query`.
  `ibping` -> `ibping: iberror: failed: can't resolve destination port 65535` (exit 255). `ibqueryerrors` ->
  `sa_get_handle: No SM/SA found on port :1`. `ibhosts` works (directed routes). Trap: `ibaddr -C mlx5_1 -P 1`
  printed the PEER's GID (`GID fe80::1c34:da03:0:2229 LID start 0xffff end 0xffff`) because 0xffff is also the
  permissive LID.
- perftest on an INIT port: ` Port number 1 state is Init` / ` Couldn't set the link layer` /
  ` Couldn't get context for the device`. `ibv_rc_pingpong`: `Failed status transport retry counter exceeded
  (12) for wr_id 2` / `parse WC failed 1`, addresses `LID 0xffff ... GID ::`.

**Peer absent:** with the far host rebooting, the IB port showed `link mlx5_1/1 subnet_prefix fe80:0000:0000:0000 lid 65535
sm_lid 0 lmc 0 state DOWN physical_state POLLING` (the port keeps trying to train: POLLING means no link partner yet).

**Mixed RoCE + IB host:** umad tools open the FIRST RDMA device unless told otherwise. With `mlx5_0` RoCE,
`sudo sminfo` / `sudo perfquery` fail: `ibwarn: [pid] mad_rpc_open_port2: client_register for mgmt 1 failed` /
`sminfo: iberror: failed: Failed to open '(null)' port '0'` (bare `iblinkinfo` prints the unquoted
`Failed to open (null) port 0`). Always pass `-C <ca> -P <port>` (`ibdiagnet` uses
`-i <dev> -p <port>`). `ibstat -l` lists every CA, RoCE ones included.

**OpenSM:** DOCA's unit is `opensmd.service` (`opensm.service` does not exist; Ubuntu's own opensm package
differs). `opensm -B -g <port GUID>` binds it to one port; port GUID = low 64 bits of `gids/0`. With the SM up:
`sminfo -C mlx5_1 -P 1` -> `sminfo: sm lid 1 sm guid 0x248a0703000011ef, activity count 47 priority 0 state 3
SMINFO_MASTER`. Capability mask gains IsSM on the SM's port (`0x2651e84a`). Stopping the SM leaves ports ACTIVE
and running traffic unaffected (a 60 s ib_write_bw finished at 97.44 Gb/s), `sminfo` fails with `iberror: failed: query`.

**Two SMs (failover):** OpenSM on A with `-p 14`, on B with `-p 13`. `sminfo -C mlx5_1 -P 1` (from either host) ->
`sminfo: sm lid 1 sm guid 0x248a0703000011ef, activity count 57 priority 14 state 3 SMINFO_MASTER`; `sminfo` takes the
SM's LID as a positional argument: `sminfo -C mlx5_1 -P 1 2` -> `sminfo: sm lid 2 sm guid 0x1c34da0300002229, activity
count 24 priority 13 state 2 SMINFO_STANDBY`. After `pkill opensm` on A the standby became master 53 s later
(`sm lid 2 ... state 3 SMINFO_MASTER`; it then reported `priority 14`, not the 13 it was started with) and the ports
stayed ACTIVE throughout, their `SM lid` changing to 2. `iblinkinfo -C mlx5_9` (no such CA) -> `ibwarn: [pid]
get_smi_gsi_pair: Can't open UMAD port (No such device) (mlx5_9:0)` / `ibwarn: [pid] mad_rpc_open_port2: can't open
UMAD port (mlx5_9:0)` / `Failed to open mlx5_9 port 0`.

**With the SM running** (formats):
- `ibstat mlx5_1 1` (device AND port) prints a flat block with no indentation and no CA header fields:
  `CA: 'mlx5_1'` / `Port 1:` / `State: Active` / `Physical state: LinkUp` / `Rate: 100` / `Base lid: 1` / `LMC: 0` /
  `SM lid: 1` / `Capability mask: 0x2651e84a` / `Port GUID: 0x248a0703000011ef` / `Link layer: InfiniBand`.
  `ibstat mlx5_1` (device only) prints the usual indented block (`CA 'mlx5_1'`, `\tCA type: MT4119`, ...).
- `ibv_devinfo -d mlx5_1`: `transport: InfiniBand (0)`, `sm_lid: 1`, `port_lid: 1`, `link_layer: InfiniBand`.
- `rdma link`: `... lid 1 sm_lid 1 lmc 0 state ACTIVE physical_state LINK_UP `.
- P_Keys: `pkeys/0` = `0xffff`, `pkeys/1`, `pkeys/2` = `0x0000` (they exist in IB mode; in RoCE mode only index 0).
- `perfquery -C mlx5_1 -P 1`: `# Port counters: Lid 1 port 1 (CapMask: 0x5A00)` then dotted fields
  (`PortSelect:......................1`, `SymbolErrorCounter`, `LinkErrorRecoveryCounter`, `LinkDownedCounter`,
  `PortRcvErrors`, ..., `PortXmitWait`). `-x`: `# Port extended counters: Lid 1 port 1 (CapMask: 0x5A00 CapMask2:
  0x0000000)` for the local port (host B's port, queried as `-x 2 1`, reported `CapMask2: 0x0000002`) with
  `PortUnicastXmitPkts` etc. The 32-bit `PortXmitData` of plain `perfquery` saturates: it read `4294967295` while
  `-x` showed `199294892652` for the same port.
- `ibqueryerrors`: `Errors for "<node desc> mlx5_1"` / `   GUID 0x... port 1: [PortXmitDiscards == 11] [PortXmitWait
  == 65571]`, summary `## Summary: 2 nodes checked, 2 bad nodes found` / `##          2 ports checked, 2 ports have
  errors beyond threshold` / `## Thresholds: ` / `## Suppressed:` (exit 1). Counters with a rate threshold print as `[PortRcvErrors == 3 (3.000)]`. Node descriptions are
  `<hostname> mlx5_1`. Without an SM it prints only `ibwarn: [pid] sa_get_handle: No SM/SA found on port :1`
  (exit 0).
- `ibnetdiscover`: `Ca	1 "H-<guid>"		# "<host> mlx5_1"` and `[1](<guid>) 	"H-<peer guid>"[1] (<peer guid>) 		# lid 2
  lmc 0 "<peer>" lid 1 4xEDR`. `ibhosts`: `Ca	: 0x1c34da0300002229 ports 1 "ESXI-2-UbuntuServer-1 mlx5_1"`.
  `ibswitches` prints nothing back to back. `iblinkinfo`: `4X      25.78125 Gbps Active/  LinkUp` (the speed column is right-aligned; spacing for other
  speeds such as NDR `106.25` is inferred from that, not captured).
- `ibtracert -C mlx5_1 -P 1 1 2`: `From ca {0x...} portnum 1 lid 1-1 "<host> mlx5_1"` / `[1] -> ca port {0x...}[1]
  lid 2-2 "<peer> mlx5_1"` / `To ca {...} portnum 1 lid 2-2 "..."`. `ibaddr`: `GID fe80::248a:703:0:11ef LID start 0x1
  end 0x1`. `smpquery nodeinfo`: `# Node info: Lid 1`, `NodeType:........................Channel Adapter`.
- `ibping -S` (server) / `ibping -c 5 <lid>` (lab run; the capture used `-c 3 -L <lid>`): `Pong from <host>.(none) (Lid 2): time 0.057 ms`, then
  `--- <host>.(none) (Lid 2) ibping statistics ---` / `5 packets transmitted, 5 received, 0% packet loss, time 5000 ms`
  / `rtt min/avg/max = 0.036/0.046/0.060 ms`.
- perftest over IB: header ` Link type       : IB`, no `GID index` line, address lines ` local address: LID 0x01 QPN
  0x0149 PSN 0x5360f3 RKey ... VAddr ...` with NO `GID:` line. 94.8-97.2 Gb/s write (5000 iterations, two runs),
  97.4 Gb/s over 60 s, 0.83 us minimum write latency.
  `ibv_rc_pingpong`: `local address:  LID 0x0001, QPN 0x00014e, PSN 0x636282, GID ::`.
- `ibdiagnet -i mlx5_1 -p 1` runs (DOCA ibutils2): `-I- Fabric Discover finished successfully`, `Total switches/ports
  [0/0], CAs/ports [2/2]`, warns about mixed firmware (`... has FW version 16.29.1016 while the latest FW version for
  the same Devid/PSID on this fabric is 16.34.1002`), `Fabric Summary` / `Total Nodes : 2`.
- `smpquery portinfo` on this EDR link shows `LinkSpeedActive: 10.0 Gbps` / `LinkSpeedSupported: 2.5/5/10`: EDR
  lives in the extended-speed fields further down, so read those before concluding a link trained slowly.
- `mlxlink -d 03:00.1` (IB port): `Speed : IB-EDR`, `FEC : No FEC`, `Enabled Link Speed : 0x0000003f
  (EDR,FDR,FDR10,QDR,DDR,SDR)`.
- IPoIB: netdev `ibs64f1` (altname `ibp3s0f1`), DOWN until configured, `mtu 4092`, `ipoib pkey 0xffff mode datagram`,
  `link/infiniband 00:00:09:47:fe:80:...`. `ibdev2netdev`: `mlx5_1 port 1 ==> ibs64f1 (Down)`. `show_gids mlx5_1`:
  one row, `fe80:...` with empty IPv4 and DEV columns, VER `v1`, `n_gids_found=1`.
- RDMA hw_counters on an IB port: the same mlx5 set minus the CNP/ECN counters (no `np_cnp_sent`,
  `rp_cnp_handled`, `np_ecn_marked_roce_packets`; `lifespan` appears).

## InfiniBand operations and CPU collectives (verified 2026-10-23, labs hw-10 to hw-15)

Same hosts and stack as the InfiniBand section (OpenSM 5.27.1 from DOCA, ibutils2 `IBDIAGNET 2.26.0`), plus Ubuntu's
Open MPI 5.0.10 (`openmpi-bin`), DOCA's UCX 1.21.0, Ubuntu's UCC 1.7.0 and OSU Micro-Benchmarks 7.5.2 built from source.

**SM failover (hw-10):**
- `opensm -B -g <port GUID> -p <prio> -f <log> -J <pidfile>` works; `-F <file>` accepts a partial config file (two lines,
  `sminfo_polling_timeout 1000` / `polling_retry_number 2`, took effect). `opensm -c <file>` writes every option with defaults:
  `sm_priority 0`, `master_sm_priority 14`, `sminfo_polling_timeout 10000`, `polling_retry_number 4`, `sweep_interval 10`,
  `force_link_speed_ext 31`, `routing_engine ar_updn`, `partition_config_file /etc/opensm/partitions.conf` (absent on DOCA).
- Takeover with defaults after killing the master: 51, 54, 58 s (from the first failed `sminfo`); the standby's log shows five
  `ERR 3111: Received MAD with error status = 0xC` (SubnGetResp(SMInfo)) ten seconds apart, then `Entering DISCOVERING state` /
  `Entering MASTER state` ten seconds after the last. With the 1000 ms / 2 config: 3-4 s. Ports stayed ACTIVE; `sm_lid` changed.
- The new master reports `priority 14` (master_sm_priority), so a returning SM with priority 14 stays `SMINFO_STANDBY` (the master
  here also had the lower GUID). A returning SM with `-p 15` became master within about a second and the other dropped back to
  standby with its configured 13.

**IPoIB (hw-11):** with no partition file (or a `Default` line without `mtu=`) the IPv4 broadcast group is `Mtu 0x84` (2048) in
`saquery -g` and the IPoIB MTU is **2044**; with `Default=0x7fff, ipoib, mtu=5 : ALL=full ;` it is 4092 (the interfaces followed
the SM restart without intervention). `ip link set ibs64f1 mtu 9000` -> `RTNETLINK answers: Invalid argument`;
`ping -M do -s 4065` -> `ping: sendmsg: Message too long`. `echo connected > /sys/class/net/ibs64f1/mode` -> `Invalid argument`,
dmesg `ibs64f1: Connected Mode not supported from MLNX_OFED 23.07 and above` (inbox driver not tested). iperf3 over IPoIB:
25-37 Gb/s one stream, 79-95 Gb/s with 4 (EDR); `ping` RTT 0.2-0.3 ms; `ib_write_lat` 0.95 us typical.

**P_Keys (hw-12):** sysfs `pkeys/N` and `smpquery pkeys <lid>` (`128 pkeys capacity for this port`) show full (`0x8002`) and
limited (`0x0002`) entries as configured. Child `ip link add ... type ipoib pkey 0x8003` comes up on a limited entry; a P_Key not in
the table gives `NO-CARRIER`. Limited-limited: ping fails (neighbour `INCOMPLETE`), `ib_write_bw --pkey_index=3` ->
`Failed status-transport retry counter exceeded (12): wr_id 0 syndrom 0x81`; the receiver's PortInfo `PkeyViolations` rises and
saturates at 65535 (16-bit); `perfquery` error counters unchanged. Restarting OpenSM without `-P` rewrites the tables to `0xffff`
only; stopping the SM leaves them as they are.

**Triage (hw-13):** `ibdiagnet` exits 0 even when stages report errors (parse the Summary). `ibportstate -C mlx5_1 -P 1 -D 0 1
espeed 1` + `reset` trains FDR (`Rate: 56`, ib_write_bw 52 Gb/s); OpenSM restores LinkSpeedExtEnabled on its next sweep but the
link stays FDR until retrained; `iblinkinfo` shows `( Could be 25.78125 Gbps)`, ibdiagnet `-E- ... Unexpected actual link speed 14
(... therefore final speed should be 25)`. `espeed 31` restores all supported speeds. `disable`: local `Down`/`Disabled`, peer
`Down`/`Polling`; ibdiagnet on the peer: `-E- Failed to initialize - ... Ibis could't find viable ports in the system`, fatal.
SM stopped + `reset`: both ends `Initialize/LinkUp` in iblinkinfo, LIDs kept, ibdiagnet `Link logical state is INI` and
`Not found master subnet manager in fabric`, while the reset host's own `ibstat` said `State: Down` (driver view lagging).
`saquery --src-to-dst 1:2` path record: `mtu 0x85`, `rate 0x90`, `pkt_life 0x92`. ibdiagnet `--ls 50` flags the EDR link.

**MPI/UCX (hw-14/15):** DOCA 3.4's `openmpi` package (`/usr/mpi/gcc/openmpi-5.0.10rc2...`) has no UCX PML (`ompi_info`: pml cm,
monitoring, ob1, v only). Ubuntu's `openmpi-bin` installs next to DOCA (its `libucx0` dependency is satisfied by DOCA's `ucx`,
`Provides: libucx0`) and has `MCA pml: ucx`, `MCA osc: ucx`, `MCA coll: ucc`. `mpirun --version` prints the PRRTE "Sorry! You
were supposed to get help about: version" text (help files missing). UCC needs `libucc-dev` (unversioned plugin names), else
`UCC ERROR no CL components were found in the ucc modules dir`. `osu_* --help` aborts with `*** buffer overflow detected ***`
(Ubuntu 26.04 build); the benchmarks themselves run. `ucx_perftest` MB/s = MiB/s (source divides by 1024*1024; latency tests
report half the round trip). OSU MB/s = 10^6. Measured (1 rank per host): RC 0.92 us RoCE / 0.80-0.88 us IB, ~11-12 GB/s;
UD 1.0-1.2 us, ~8.5 GB/s; DC 2.8 us on RoCE, 1.2 us on IB; `UCX_IB_PATH_MTU=1024` ~5-7% lower bandwidth, `=999` makes the UCX
PML fail (`Failed to create UCP worker`); TCP (ob1/tcp btl) 14-15 us, ~6 GB/s; `--mca pml ucx -x UCX_TLS=tcp,self` fails
(`No components were able to be opened in the pml framework`, pml_ucx_tls). Allreduce on CPUs: 2 ranks busbw peak ~4.5-4.7 GB/s;
8 ranks (4/host) ring vs recursive doubling crossover between 64 and 256 KiB, 2.3x at 64 MiB; 8 ranks on one host as slow as across
hosts at 16-64 MiB (endpoint-bound); `--mca coll_ucc_enable 1` alone leaves `han` in charge, `coll_ucc_priority 100` makes UCC run
(`running ucc allreduce`), ~4x faster at 1 MiB. Open MPI's ring falls back to recursive doubling when count < ranks
(`coll_base_allreduce.c`).
