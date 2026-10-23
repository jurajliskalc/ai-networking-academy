---
id: hw-05-link-health-optics
title: "Link health: optics, FEC and physical-layer error counters under load"
kind: handson
level: 2
estimated_minutes: 75
environment: hardware
tier: 1
fabric: any
requires: [two-rdma-hosts, ssh-mesh]
changes_config: false
lessons: [link-layer-ber-fec, optics-cabling-power, telemetry-counters, fabric-validation-burn-in]
files: labs/hw-05-link-health-optics
verified: false
summary: "Read the physical layer of a real link: speed and autonegotiation, transceiver DOM, FEC mode, and the error counters that reveal a dirty connector or a failing optic before NCCL does."
---

## Goal

Judge the health of the physical link between host A (`{{HOST_A}}`) and host B (`{{HOST_B}}`) the
way an operations team qualifies a new cable or chases a "slow rail": check what the link
negotiated, read the transceiver's own diagnostics, confirm the FEC mode, and prove that the error
counters stay flat while the link carries real load.

Physical-layer faults are the most common hardware problem in AI clusters, simply because there are
so many links. They rarely break a link outright. More often they cause corrected errors, then
occasional uncorrected ones, then retransmissions and a straggler GPU that slows every collective.
The counters in this lab are where that story starts.

By the end you can:

- Read link speed, autonegotiation and FEC, and explain why both ends must agree.
- Read a transceiver's DOM (temperature, transmit and receive power) and tell a DAC from an optic.
- Name the Ethernet and InfiniBand counters that count physical-layer errors and link drops.
- Run a timed load test and decide from counter deltas whether a link is clean.
- Describe a safe reseat-and-clean procedure.

> [!NOTE]
> Command output in this lab is **illustrative**. Counter names below are those of NVIDIA ConnectX
> (`mlx5`) drivers where stated; other vendors expose similar information under different names
> (`ethtool -S` on your NIC lists them).

## Before you start

- **Hardware:** two hosts with RDMA NICs and the cable (DAC, AOC or transceivers plus fiber) you want
  to qualify. A switch in between is fine; then you are checking two links (host-to-switch on each
  side), and the switch has its own counters to look at too.
- **Profile:** hosts, netdevs and RDMA devices filled in on the [Connect page](#/hw/connect).
- **Software:** `labs/hw-toolkit/setup-rdma-host.sh` on both hosts. NVIDIA's firmware tools (MFT,
  which provide `mlxlink`) are optional; Task 5 uses them if you have them.
- **SSH:** the check script starts the perftest server on host B over SSH.
- **Changes:** none. Reading module EEPROM is harmless. Task 7 (reseat) is a physical action you
  should only do on a lab link, never on a production one without a change window.

## Tasks

### Task 1: What did the link negotiate?

On an Ethernet (RoCE) host:

```bash
sudo ethtool {{A_NETDEV}}
```

Without `sudo` the settings still print, preceded by `netlink error: Operation not permitted`
(only the Wake-on-LAN query needs root). Illustrative excerpt (100GbE over a DAC):

```
Settings for ens1f0np0:
	Supported ports: [ Backplane ]
	Supported link modes:   ...
	Advertised link modes:  ...
	Advertised FEC modes: RS
	Speed: 100000Mb/s
	Lanes: 4
	Duplex: Full
	Auto-negotiation: on
	Port: Direct Attach Copper
	PHYAD: 0
	Transceiver: internal
	Link detected: yes
```

On any RDMA host (Ethernet or InfiniBand):

```bash
cat /sys/class/infiniband/{{A_RDMA_DEV}}/ports/{{RDMA_PORT}}/rate
cat /sys/class/infiniband/{{A_RDMA_DEV}}/ports/{{RDMA_PORT}}/phys_state
```

Repeat on host B. **Why:** the two ends of a link must agree on speed, lane count and encoding. A
link that came up at a lower speed than the cable and NICs support (for example 50 Gb/s on a
100 Gb/s pair) usually points to a cable or optic the NIC does not fully recognise, a mismatched
forced speed on one side, or a lane that failed training. On InfiniBand, `ibstat` shows the same
rate and the physical state for each port.

### Task 2: Identify the cable and read its diagnostics

```bash
sudo ethtool -m {{A_NETDEV}}
```

`ethtool -m` needs root: without `sudo` it only prints `netlink error: Operation not permitted`.
Illustrative excerpt from an optical module:

```
	Identifier                                : 0x11 (QSFP28)
	Vendor name                               : EXAMPLE
	Vendor PN                                 : EX-100G-SR4
	Transmitter technology                    : 0x00 (850 nm VCSEL)
	Length (OM4)                              : 100m
	Module temperature                        : 41.20 degrees C / 106.16 degrees F
	Module voltage                            : 3.2950 V
	Transmit avg optical power (Channel 1)    : 0.8020 mW / -0.96 dBm
	...
	Rcvr signal avg optical power (Channel 1) : 0.7413 mW / -1.30 dBm
	Rcvr signal avg optical power (Channel 2) : 0.7012 mW / -1.54 dBm
	Rcvr signal avg optical power (Channel 3) : 0.1820 mW / -7.40 dBm
	Rcvr signal avg optical power (Channel 4) : 0.7230 mW / -1.41 dBm
```

**Read it:**

- **Identifier and technology** tell you the form factor and whether this is copper (DAC: no laser,
  no power readings) or an optic. Active optical cables (AOC) report like optics.
- **DOM** (digital optical monitoring) gives temperature, supply voltage and per-lane transmit and
  receive power. In the illustrative output, lane 3 receives roughly 6 dB less light than its
  siblings: a classic sign of a dirty or damaged fiber or connector on that lane, even if the link is
  still up today.
- Modules also store **alarm and warning thresholds**; newer `ethtool` versions print them, and the
  values are module-specific. Compare against those thresholds and, above all, against identical
  healthy links rather than against a number you remember.

Which fields appear depends on the module type and on your `ethtool` and kernel versions. A passive
DAC shows identification, attenuation and length but no laser: illustrative lines from a 1 m
100G DAC:

```
	Transceiver type                          : 100G Ethernet: 100G Base-CR4 or 25G Base-CR CA-L
	Length (Copper or Active cable)           : 1m
	Transmitter technology                    : 0xa0 (Copper cable, unequalized)
	Module temperature                        : 0.00 degrees C / 32.00 degrees F
	Module voltage                            : 0.0000 V
```

The zero temperature and voltage are normal for a passive cable (it has no monitoring), and there
are no optical power lines at all. If the command fails even with `sudo`, the driver may not expose
module EEPROM for that port; that is not an error in the link.

### Task 3: Forward error correction

```bash
ethtool --show-fec {{A_NETDEV}}
```

Illustrative output:

```
FEC parameters for ens1f0np0:
Supported/Configured FEC encodings: Auto
Active FEC encoding: RS
```

**Why:** at 25 Gb/s per lane and above, links rely on forward error correction to turn a raw bit
error rate that is far from perfect into an effective error rate close to zero. **RS-FEC** (Reed
Solomon) is standard for 100G-and-faster ports, and PAM4 links (for example 50G lanes in 200G and
400G ports) depend on it. Both ends must use the same FEC: a mismatch typically keeps the link down,
or (with some auto modes) makes it come up in an unexpected mode. Newer `ethtool` versions can also
print FEC statistics (corrected and uncorrectable blocks) where the driver supports it; see
`man ethtool` on your system for the statistics option.

The key idea from the [BER and FEC lesson](#/lesson/link-layer-ber-fec): **corrected** errors are
normal and expected at some rate; a **rising** corrected rate is an early warning; **uncorrectable**
errors mean frames are being dropped.

### Task 4: The counters that matter

Ethernet driver counters (names from `mlx5`; check `ethtool -S` on your NIC for its equivalents):

```bash
ethtool -S {{A_NETDEV}} | grep -E 'crc_errors_phy|symbol_err_phy|link_down_events_phy|corrected_bits_phy|discards_phy'
```

Illustrative output:

```
     rx_crc_errors_phy: 0
     rx_symbol_err_phy: 0
     rx_discards_phy: 0
     tx_discards_phy: 0
     link_down_events_phy: 1
     rx_pcs_symbol_err_phy: 0
     rx_corrected_bits_phy: 18342
```

RDMA port counters (generic sysfs, present for InfiniBand ports and, on many drivers, for RoCE
ports too):

```bash
D=/sys/class/infiniband/{{A_RDMA_DEV}}/ports/{{RDMA_PORT}}/counters
grep -H . $D/symbol_error $D/link_downed $D/link_error_recovery $D/port_rcv_errors 2>/dev/null
```

**What each tells you:**

| Counter | Meaning | Typical cause when it rises |
|---|---|---|
| `rx_crc_errors_phy` | Frames received with a bad checksum, dropped | Uncorrected bit errors: cable, optic, connector |
| `rx_symbol_err_phy` | Physical-layer symbol errors | Same family as above |
| `rx_corrected_bits_phy` | Bits FEC had to correct (on drivers that expose it) | Normal at low rates; a trend matters |
| `link_down_events_phy` | Times the link went down | Flaps: cable, optic, or the far end |
| `symbol_error` (IB) | Minor link errors on the port | Marginal link |
| `link_downed` (IB) | Times the port gave up link-error recovery and went down | Flapping link |
| `port_rcv_errors` (IB) | Received packets with errors | Bad link or a misbehaving peer |

Counters are cumulative since driver load (or the last reset). A single number means little; the
**delta over a known interval under known load** is the evidence.

### Task 5 (optional): the vendor view with `mlxlink`

If NVIDIA's MFT is installed:

```bash
sudo mst start
sudo mst status -v
sudo mlxlink -d <your device>          # state, speed, width, FEC, recommendations
sudo mlxlink -d <your device> -c       # add physical counters: raw and effective BER, symbol errors
sudo mlxlink -d <your device> -m       # module info: vendor, part, cable length, temperature, per-lane power
```

Take the device name from `mst status -v` (for example `/dev/mst/mt4129_pciconf0`). On a host with
**Secure Boot** (kernel lockdown) the MST modules cannot provide devices: `mst start` ends with
`Unloading MST PCI module (unused)` and `mlxlink -d mlx5_0` or `-d <pci-address>` fails with
`-E- Failed to open device`. With a recent kernel and MFT, `mst status -v` then lists a
`/dev/fwctl/fwctl0` device in its `FWCTL` column, and `sudo mlxlink -d /dev/fwctl/fwctl0` works.
Without Secure Boot, recent MFT versions may also accept a PCI address; check the
MFT user manual for your release.

Illustrative excerpt (values start in a fixed column; on a terminal some are coloured):

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
...
Physical Counters and BER Info
------------------------------
Time Since Last Clear [Min]        : 12.6
Effective Physical Errors          : 0
Raw Physical Errors Per Lane       : 0,0,0,0
Effective Physical BER             : 15E-255
Raw Physical BER                   : 15E-255
Link Down Counter                  : 0
Link Error Recovery Counter        : 0
```

**Why:** `mlxlink` reports the **raw (pre-FEC) BER** and **effective (post-FEC) BER** directly, and
prints troubleshooting recommendations. It is the quickest way to compare one link against its
neighbours. Acceptable BER depends on speed and FEC mode; the habit that works is comparing a
suspect link with healthy peers of the same type.

### Task 6: Watch the counters under load for 60 seconds

Snapshot the counters on **both** hosts, run 60 seconds of traffic, snapshot again and compare.
On host B start the server. The commands use your RoCE GID index (`-x`, as in the First traffic
lab); on InfiniBand leave out `-x {{GID_INDEX}}` on both sides, since ports are addressed by LID:

```bash
ib_write_bw -d {{B_RDMA_DEV}} -i {{RDMA_PORT}} -x {{GID_INDEX}} -q 4 -D 60 -F --report_gbits           # host B
```

On host A:

```bash
snap() { { ethtool -S {{A_NETDEV}} 2>/dev/null | grep -E 'crc_errors_phy|symbol_err_phy|link_down_events_phy|corrected_bits_phy|discards_phy';
           grep -H . /sys/class/infiniband/{{A_RDMA_DEV}}/ports/{{RDMA_PORT}}/counters/{symbol_error,link_downed,port_rcv_errors} 2>/dev/null; } | tr -s ' '; }
snap > /tmp/before.txt
ib_write_bw -d {{A_RDMA_DEV}} -i {{RDMA_PORT}} -x {{GID_INDEX}} -q 4 -D 60 -F --report_gbits {{B_IP}}
snap > /tmp/after.txt
diff /tmp/before.txt /tmp/after.txt && echo "no counter changed"
```

Do the same snapshots on host B (its counters see the traffic A sends). **Interpret:**

- **Nothing changed** except perhaps corrected bits: a clean link at this load.
- **Corrected bits rose steadily but nothing else**: FEC is doing its job. Compare the rate with an
  identical healthy link; if this one is much worse, clean and reseat (Task 7).
- **CRC or symbol errors rose**: frames were lost. RoCE recovers by retransmission (and
  `out_of_sequence` on the receiver rises), at a cost in throughput and tail latency.
- **Link-down events rose**: the link flapped during the test. Treat it as broken.

This is a miniature version of the burn-in that cluster operators run on every new link before
handing nodes to users (see [fabric validation and burn-in](#/lesson/fabric-validation-burn-in)).

### Task 7: Reseat and clean, safely

When a link shows a weak lane or rising errors, the first remedies are physical. On a **lab** link:

1. Note the counters and DOM readings (your "before").
2. Bring the interface down if you want a clean event history: `sudo ip link set dev {{A_NETDEV}} down`.
3. Unplug the module or cable. **Never look into an optical port or fiber end**, even when you
   believe the laser is off: many modules emit invisible infrared light. Cap open ports.
4. For fiber, inspect and clean both connector ends with a proper fiber cleaner or scope, following
   the module and cleaner vendor's instructions. Do not use breath or cloth.
5. Reinsert firmly until it latches, bring the interface up, and repeat Tasks 2, 4 and 6.

Handle modules by the body, observe ESD precautions, and remember that optics get warm in operation.
If the problem follows the module when you swap it to a known-good port, replace the module; if it
stays with the port or fiber, look there.

## Verify

On host A:

```bash
cd {{AINA_DIR}}/labs
./hw-toolkit/aina-hw check hw-05-link-health-optics
```

The check confirms that both RDMA ports report a physical link up, that both ends report the same
rate (a warning instead of a failure when your profile has a switch in between),
that the FEC mode is readable on Ethernet ports (skipped on InfiniBand), that module information is
readable (skipped for DACs or ports that do not expose it), and then runs a 20-second, 4-QP
`ib_write_bw` from A to B and compares physical-layer error counters on both hosts before and
after. Any increase in CRC, symbol, receive-error or link-down counters is reported as a warning
with the counter name; corrected-bit counts are reported for information.

## Restore

Nothing to restore unless you took an interface down in Task 7:

```bash
sudo ip link set dev {{A_NETDEV}} up
```

Delete the snapshot files when you are done: `rm -f /tmp/before.txt /tmp/after.txt`.

## What you learned

- Both ends must agree on speed and FEC; a lower-than-expected rate is a physical-layer clue.
- `ethtool -m` (or `mlxlink -m`) shows the module type and per-lane DOM; one weak lane points to a
  dirty or damaged connector.
- Corrected errors are expected; uncorrectable errors (CRC, symbol) and link-down events are not.
- Counter **deltas under a known load** are evidence; absolute counter values are not.
- Clean, reseat and swap methodically, and never look into an optical port.

## Going further

- If there is a switch in the path, read its port counters for the same interval (the
  [telemetry and counters lesson](#/lesson/telemetry-counters) lists the usual names) and decide
  which of the two links is the bad one.
- Extend Task 6 to an hour and record corrected-bit rates per link: that is your baseline for future
  comparisons.
- On InfiniBand, `perfquery` and `ibqueryerrors` read the same kind of counters across the whole
  fabric (the InfiniBand bring-up lab uses them).
