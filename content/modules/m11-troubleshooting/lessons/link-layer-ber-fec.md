---
id: link-layer-ber-fec
title: "Link-layer troubleshooting: BER, FEC, symbol errors and flaps"
module: m11-troubleshooting
level: 4
estimated_minutes: 50
objectives:
  - Distinguish raw (pre-FEC) BER, effective (post-FEC) BER and uncorrectable codewords, and explain which one hurts RDMA traffic.
  - Interpret link health output from mlxlink, ethtool, ethtool -m and perfquery without relying on absolute counter values.
  - Isolate a bad link to the cable, optic, connector, NIC or switch port with a swap-based procedure.
  - Define link acceptance and alerting thresholds for a PAM4 AI fabric, hedged to vendor guidance.
prerequisites: [ib-speeds-cables, optics-cabling-power, ib-tools-diagnostics]
quiz: quiz-link-layer-ber-fec
widgets: [ber-fec]
labs: []
tags: [ber, fec, rs-fec, pam4, optics, mlxlink, link-flap, physical-layer]
further_reading:
  - title: IEEE 802.3 Ethernet Working Group
    url: https://www.ieee802.org/3/
  - title: NVIDIA Firmware Tools (MFT), including mlxlink
    url: https://network.nvidia.com/products/adapter-software/firmware-tools/
  - title: ethtool(8) manual page
    url: https://man7.org/linux/man-pages/man8/ethtool.8.html
  - title: Linux kernel documentation, mlx5 ethtool counters
    url: https://docs.kernel.org/networking/device_drivers/ethernet/mellanox/mlx5/counters.html
---

## Why this matters

A modern AI fabric has tens of thousands of 400G and 800G links running PAM4 signalling at
50-100+ Gb/s per lane, through pluggable optics, fibre patch panels and connectors that someone
cleaned (or did not) on a loading dock. At these speeds every link has a non-zero raw bit error rate
by design; forward error correction (FEC) is what makes them usable. That changes how you troubleshoot
the physical layer. "Any error is bad" no longer works: a perfectly healthy link can correct thousands to hundreds of
thousands of bit errors per second. What matters is the **margin**: how close the raw error rate is to what FEC can
correct, and whether any errors escape FEC.

Link-layer faults are among the most common hardware root causes of degraded AI jobs. A marginal link rarely
goes down cleanly. It corrupts a few packets per minute (each costing an RDMA retransmission or, on
InfiniBand generations that support it, a link-level retransmission), flaps for a second at 3 a.m., or retrains at a lower speed. The
training job sees a straggler or an NCCL timeout and nobody suspects a dusty connector. This lesson
teaches you to read link health quantitatively and isolate the failing part.

## Concepts

### Raw BER, effective BER and uncorrectable codewords

| Term | Meaning | Where measured |
|---|---|---|
| Raw (pre-FEC) BER | Fraction of bits received in error **before** FEC correction | PHY / SerDes, reported by tools such as `mlxlink` |
| Corrected errors | Bits or symbols FEC fixed; no packet impact, but they consume margin | FEC statistics (`ethtool -I --show-fec`, mlx5 PHY counters) |
| Uncorrectable codewords | FEC blocks with more errors than the code can fix; the data is corrupted | FEC statistics; leads to CRC/FCS errors |
| Effective (post-FEC) BER | Error rate that remains after FEC; this is what upper layers experience | Derived from uncorrectable blocks / symbol errors |
| Symbol errors | Errors detected at the symbol (coding) level; meaning depends on the PHY and tool | IB `SymbolErrorCounter`, mlx5 `rx_symbol_err_phy` |

The key mental model: **raw BER measures the health of the channel; effective BER measures the
damage to traffic.** A rising raw BER is an early warning. Non-zero effective BER is already an
incident for RDMA traffic.

### What FEC can and cannot do

Ethernet at 100G per port with 25G NRZ lanes typically uses RS(528,514) "KR4" FEC; PAM4 rates
(50G lanes and above, as in 200G/400G/800G Ethernet) use RS(544,514) "KP4" FEC. Reed-Solomon codes
work on multi-bit symbols (10-bit symbols in these codes) and can correct up to a fixed number of
symbol errors per codeword: 7 for RS(528,514) and 15 for RS(544,514). Errors that are spread out
are easy; **bursts** that put more than that many bad symbols in one codeword are not. InfiniBand
HDR and NDR also rely on FEC for their PAM4 lanes; the exact FEC mode is negotiated and reported by
the tools (check `mlxlink` output and your NVIDIA documentation for the mode in use on your
generation).

A commonly quoted figure is that KP4 FEC can bring a raw BER of around 2.4e-4 down to a post-FEC
error rate that meets the Ethernet target. Treat that as the **cliff**, not the operating point:
production links should run orders of magnitude below it so that temperature, ageing and dust do not
push them over. Vendors publish their own acceptance thresholds (often expressed as a maximum raw BER
in the 1e-6 to 1e-8 range plus zero, or near zero, uncorrectable blocks over a soak period). Use your
vendor's numbers.

### Why tiny effective BER still hurts

Make the numbers concrete. A 400 Gb/s link moves 4 x 10^11 bits per second.

| Effective BER | Errored bits per second at 400 Gb/s | Roughly one error every |
|---|---|---|
| 1e-9 | 400 | 2.5 ms |
| 1e-12 | 0.4 | 2.5 s |
| 1e-15 | 0.0004 | 42 minutes |

Each escaped error typically corrupts a packet, which fails its CRC and is dropped. For RoCEv2 that
means the receiver sees a sequence gap and the sender retransmits (with go-back-N on many NICs, the
whole window behind the lost packet). For a ring all-reduce with thousands of flows, a link that drops
a packet every few seconds can be a measurable straggler; a link at 1e-9 is a disaster.

Try it: pick a 400G or 800G link, slide the pre-FEC BER up to the KP4 limit and just past it, and watch the uncorrectable-codeword estimate collapse from "never" (at 1e-5) to hours (at ~2.4e-4) to one or more per second (at ~5e-4). That steepness is why the limit is a cliff, and real bursty errors make it worse than this random-error model shows.

```widget
ber-fec
```

> [!ANALOGY]
> FEC is like the error-correcting memory (ECC) in a server: a few corrected errors per day are
> normal and invisible, but a DIMM whose corrected-error rate climbs is about to fail, and you replace
> it before it throws an uncorrectable error. Where it breaks down: memory ECC corrects per word with
> tiny overhead and errors are rare; link FEC on PAM4 corrects errors **continuously**, thousands or
> more per second, so "corrected errors present" is never by itself a fault. You alert on the rate and trend.

### Link flaps and retraining

A **flap** is a link going down and up. On Ethernet, the switch logs carrier transitions; the
routing protocol (BGP in most AI fabrics) may withdraw and re-advertise routes, and ECMP groups
change. On InfiniBand, `LinkDownedCounter` increments and the subnet manager may reroute. Each flap
in an RDMA fabric can stall or kill in-flight QPs, causing NCCL errors. A related event is **link
error recovery** (IB `LinkErrorRecoveryCounter`): the link retrains without fully going down, still
pausing traffic for a moment. Also watch for links that come up at a **lower speed or width** than
planned (for example a 4x port at 2x, or 400G at 200G) after a retrain.

## How it works

### The physical chain and its failure modes

```text
 NIC SerDes -> host connector/cage -> transceiver (DSP, laser) -> fibre/connectors/patch panel
           -> transceiver (photodiode, DSP) -> switch cage -> switch SerDes
```

| Part | Typical failure | Signature |
|---|---|---|
| Fibre connector (MPO/MTP, LC) | Dirt, scratched end face, not fully latched | High raw BER on some lanes, low Rx power on those lanes |
| Fibre / patch panel | Tight bend, crushed cable, wrong polarity | Very low or no Rx power, link down or flapping |
| Transceiver | Ageing laser, DSP fault, overheating | Tx bias drifting, temperature high, BER rising over weeks |
| DAC/ACC copper cable | Damaged conductor, too long for the rate | High BER on specific lanes, no optical DDM to read |
| Host/switch SerDes or cage | Rare electrical fault, bent pins | Errors follow the port, not the cable or optic |
| Configuration | FEC mode mismatch, forced speed mismatch | Link does not come up, or up with errors |

Optical faults usually affect **specific lanes**. That is why per-lane data (per-lane BER, per-lane Rx
power) is so useful: a single lane far worse than its siblings points at one fibre pair or one
connector position.

### Isolating the bad part: swap and follow

The classic isolation method: change one component at a time and watch whether the errors follow it.

```mermaid
flowchart TD
  A["Link with rising raw BER, CRC errors or flaps"] --> B["Read both ends: BER, FEC, DDM, lane data"]
  B --> C{"Rx power low on some lanes?"}
  C -->|"Yes"| D["Inspect and clean connectors on both ends"]
  C -->|"No"| E{"Temperature or Tx bias abnormal?"}
  D --> F{"Fixed after clean and reseat?"}
  F -->|"Yes"| G["Soak test, then return to service"]
  F -->|"No"| H["Swap optic at one end, retest"]
  E -->|"Yes"| H
  E -->|"No"| H
  H --> I{"Errors followed the optic?"}
  I -->|"Yes"| J["RMA the optic"]
  I -->|"No"| K["Replace the cable or patch path"]
  K --> L{"Still errors?"}
  L -->|"Yes"| M["Suspect port or NIC: move to known-good port"]
  L -->|"No"| G
```

Always read **both ends**. Errors are measured at the receiver, so a bad transmitter at switch port
A shows up as receive errors on NIC B. Check which direction is bad before you pull anything.

> [!WARNING]
> Inspect fibre end faces with a scope before and after cleaning, and never look into a connector
> with your eye. Reseating without cleaning often moves dust from the ferrule into the mating sleeve
> and makes the next reading worse.

### What the counters mean on each platform

**ConnectX NICs (Ethernet, mlx5 driver), via `ethtool -S`.** Physical-layer counters carry a `_phy`
suffix. Commonly available ones include `rx_crc_errors_phy` (frames with bad FCS),
`rx_symbol_err_phy`, `rx_corrected_bits_phy` and per-lane error counters on some firmware. Check the
kernel's mlx5 counters documentation; availability depends on driver and firmware.

**Generic FEC statistics via ethtool.** Recent kernels and drivers expose FEC statistics through
`ethtool -I --show-fec <dev>` (corrected blocks, uncorrectable blocks, sometimes per lane). The
configured and active FEC mode come from `ethtool --show-fec <dev>`.

**InfiniBand, via `perfquery` (PMA counters).** The standard port counters include
`SymbolErrorCounter`, `LinkErrorRecoveryCounter`, `LinkDownedCounter`, `PortRcvErrors`,
`PortRcvRemotePhysicalErrors`, `LocalLinkIntegrityErrors` and `ExcessiveBufferOverrunErrors`.
`ibqueryerrors` scans the whole fabric for ports whose error counters exceed thresholds, and
`iblinkinfo` shows the speed and width each link negotiated.

**Both, via `mlxlink`.** `mlxlink` (part of NVIDIA Firmware Tools) reads the PHY directly on
ConnectX adapters and NVIDIA switches: operational state, speed, FEC mode, raw and effective BER,
per-lane information, and module (transceiver) data. Section and field names vary between MFT
releases, so read the output rather than scripting against exact strings without checking.

> [!INTERVIEW]
> "A link shows millions of corrected FEC errors. Do you replace it?" A strong answer: not on that
> alone. Corrected errors are expected on PAM4. Look at the raw BER relative to vendor thresholds,
> the trend over days, per-lane balance, uncorrectable blocks and CRC errors, and compare to sibling
> links with the same optic type. Replace or clean when the margin is poor or degrading, or when any
> errors escape FEC. Bonus: mention checking both ends and DDM Rx power per lane.

## In practice

### Step 1: link state, speed and FEC mode

```bash
ethtool eth3 | grep -E 'Speed|Lanes|Link detected'   # without sudo, a "netlink error: Operation not permitted" line (the WoL query) comes first
ethtool --show-fec eth3
```

```text
# Illustrative output
        Speed: 400000Mb/s
        Lanes: 4
        Link detected: yes
FEC parameters for eth3:
Supported/Configured FEC encodings: Auto RS
Active FEC encoding: RS
```

On real hardware (100G ConnectX-5, 1 m DAC, as a regular user) the same commands print:

```text real=inbox
$ ethtool ens64f0np0 | grep -E 'Speed|Link detected'
netlink error: Operation not permitted
	Speed: 100000Mb/s
	Link detected: yes
$ ethtool --show-fec ens64f0np0
FEC parameters for ens64f0np0:
Supported/Configured FEC encodings: Auto
Active FEC encoding: RS
```

If the speed is lower than the design (for example 200000Mb/s on a 400G port), the link retrained
down: treat it as a fault even if it carries traffic.

### Step 2: PHY health with mlxlink

```bash
sudo mst status -v                    # lists each port's PCI address, RDMA name and, on new kernels, its FWCTL device
sudo mlxlink -d <mst-device>          # basic state, speed, FEC
sudo mlxlink -d <mst-device> -c       # add physical counters and BER
sudo mlxlink -d <mst-device> -m       # add transceiver (module) information
```

`<mst-device>` is whatever `mst status -v` lists for the port: an `/dev/mst/...` device after `mst start`,
or the PCI address or RDMA device name (`mlx5_3`) where MFT accepts them. Recent MFT often needs no `/dev/mst`
device at all (`mst start` then unloads its modules as "(unused)" and the tools use the PCI address or
RDMA name directly). On a host with Secure Boot and kernel lockdown those direct paths fail: `mlxlink -d mlx5_3` fails with
`-E- Failed to open device: "mlx5_3", No such file or directory`; with a recent kernel and MFT (for example
kernel 7.0 with MFT 4.37), `mst status -v` instead lists a `/dev/fwctl/fwctlN` device and
`mlxlink -d /dev/fwctl/fwctl0` works. Check your MFT release notes.

```text
# Illustrative output, trimmed; field names differ between MFT releases
Operational Info
----------------
State                              : Active
Physical state                     : LinkUp
Speed                              : 400G
Width                              : 4x
FEC                                : Standard RS-FEC - RS(544,514)

Troubleshooting Info
--------------------
Status Opcode                      : 0
Group Opcode                       : N/A
Recommendation                     : No issue was observed

Physical Counters and BER Info
------------------------------
Time Since Last Clear [Min]        : 4320.0
Effective Physical Errors          : 0
Raw Physical Errors Per Lane       : 1203994,1187420,1176002,98822310
Effective Physical BER             : 15E-255
Raw Physical BER                   : 1E-9
Link Down Counter                  : 0
Link Error Recovery Counter        : 0
```

Annotation:

- `Effective Physical Errors : 0` and a vanishingly small effective BER: no errors have escaped FEC
  in three days. Traffic is not yet affected.
- `Raw Physical BER : 1E-9` for the whole link looks comfortable, **but** lane 3 has about 80 times
  the raw errors of lanes 0-2. One lane is losing margin. This is the early warning you want: a dirty
  or damaged fibre position, or a weak optic lane.
- `Link Down Counter : 0`: no flaps. Combined with the lane imbalance this link is a candidate for
  a scheduled clean-and-inspect, not an emergency.

For comparison, a clean 100G link on the reference hardware (ConnectX-5 port 1, 1 m DAC, MFT 4.37 over
the fwctl device, 12 minutes after the counters were cleared). The 25G NRZ lanes use RS(528,514) here,
and both BER lines read `15E-255`, which is how `mlxlink` shows "no errors at all":

```text real=doca
$ sudo mlxlink -d /dev/fwctl/fwctl0 -c

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

> [!VERIFIED]
> **Under Secure Boot lockdown, debugfs and MFT's NV/flash access were blocked, but `mlxlink` worked over `/dev/fwctl/fwctl0`.**
> On Ubuntu 26.04 (kernel 7.0, Secure Boot on, lockdown `integrity`) with ConnectX-5 fw 16.29 and MFT 4.37,
> `sudo mst status -v` listed `/dev/fwctl/fwctl0` and `/dev/fwctl/fwctl1` in its FWCTL column and
> `mlxlink -d /dev/fwctl/fwctl0` (also `-c` and `-m`) worked, while `mlxlink -d mlx5_0` failed with
> `-E- Failed to open device: "mlx5_0", No such file or directory`. Firmware configuration and flash
> access did not work by any path: `mlxconfig -d /dev/fwctl/fwctl0 q` -> `-E- Cannot access NV register.
> Either FW does not support NV access register, or HW access is disabled. rc=(265)`, `flint -d
> /dev/fwctl/fwctl0 q` -> `-E- Cannot open Device: /dev/fwctl/fwctl0. Operation not supported.
> MFE_BAD_PARAMS`, and `mlxconfig -d mlx5_0 q` -> `-E- Failed to open the device`. Debugfs was blocked
> for root too: reading the mlx5 DCQCN parameters (`/sys/kernel/debug/mlx5/0000:03:00.0/cc_params/rp_ai_rate`)
> gave `Operation not permitted`, with dmesg `Lockdown: cat: debugfs access is restricted; see man
> kernel_lockdown.7`. With Secure Boot off, `mlxconfig q` and `flint q` worked on the same hosts. So on a
> locked-down host you can still read link health with `mlxlink` over fwctl, but changing firmware
> settings (such as the port type) needs Secure Boot off or a signed MFT kernel module; check your MFT
> release notes for what your version supports.

### Step 3: optics digital diagnostics (DDM)

```bash
sudo ethtool -m eth3     # needs root; without it: netlink error: Operation not permitted
```

```text
# Illustrative output, trimmed (QSFP-DD / OSFP style, per-lane values)
Module temperature                        : 52.10 degrees C / 125.78 degrees F
Module voltage                            : 3.2950 V
Laser tx bias current (Channel 1)         : 7.120 mA
Laser tx bias current (Channel 4)         : 7.080 mA
Transmit avg optical power (Channel 1)    : 0.8913 mW / -0.50 dBm
Rcvr signal avg optical power (Channel 1) : 0.7943 mW / -1.00 dBm
Rcvr signal avg optical power (Channel 2) : 0.7762 mW / -1.10 dBm
Rcvr signal avg optical power (Channel 3) : 0.8128 mW / -0.90 dBm
Rcvr signal avg optical power (Channel 4) : 0.2512 mW / -6.00 dBm
```

Channel 4 receives about 5 dB less light than its siblings: that matches the lane with high raw
errors in `mlxlink` (lanes numbered from 0 there and from 1 here; confirm lane mapping for your
module type). A 5 dB deficit on one lane almost always means a dirty or damaged connector position or
fibre, not a bad receiver. Compare against the module's warning and alarm thresholds, which `ethtool
-m` also prints for most modules. Field names and units vary with module type and ethtool version.
A passive DAC has no optical power or bias lines at all (and may report a module temperature of 0.00 degrees C);
there you rely on BER and error counters alone. This is the 1 m DAC on the reference hardware:

```text real=inbox
$ sudo ethtool -m ens64f0np0
	Identifier                                : 0x0d (QSFP+)
	...
	Transceiver type                          : 100G Ethernet: 100G Base-CR4 or 25G Base-CR CA-L
	...
	Length (Copper or Active cable)           : 1m
	Transmitter technology                    : 0xa0 (Copper cable, unequalized)
	...
	Vendor name                               : Mellanox
	Vendor PN                                 : MCP1600-E00AE30
	...
	Module temperature                        : 0.00 degrees C / 32.00 degrees F
	Module voltage                            : 0.0000 V
```

> [!VERIFIED]
> **`ethtool -m` needs root: as a regular user it printed only `netlink error: Operation not permitted`.**
> On Ubuntu 26.04 (ethtool 6.19, kernel 7.0) with ConnectX-5 and both driver stacks, `ethtool -m
> ens64f0np0` without sudo printed that single line and exited 1; `sudo ethtool -m` printed the module
> data. Plain `ethtool <if>` prints the same `netlink error` line first and then the link settings, so
> the message is easy to dismiss as noise; with `-m` it is the whole output. Run module (DDM) reads with
> sudo, and make sure monitoring agents that collect them have the privileges to do so.

### Step 4: InfiniBand port counters

```bash
perfquery <lid> <port>         # error counters for one port (-x for extended data counters)
ibqueryerrors                  # scan the fabric for ports with errors above thresholds
iblinkinfo                     # negotiated width and speed of every link
```

```text
# Illustrative perfquery output, trimmed
# Port counters: Lid 412 port 17
SymbolErrorCounter:..............1834
LinkErrorRecoveryCounter:........3
LinkDownedCounter:...............1
PortRcvErrors:...................211
PortRcvRemotePhysicalErrors:.....0
PortXmitDiscards:................0
PortXmitWait:....................102938
```

Reading it: symbol errors and receive errors on the same port, plus retrains and a link-down event,
is a physical-layer problem on the link **arriving at** this port. `PortXmitWait` is about congestion
(time the port had data but no credits to send) and is not a physical-layer indicator; do not mix
them up. Take a second reading after a known interval to get rates before acting.

For comparison, a healthy EDR port on the reference hardware after bandwidth tests (back to back,
DOCA-OFED 3.4, OpenSM running; on a host with several RDMA devices pass `-C <ca> -P <port>`):

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
...
PortXmitDiscards:................11
...
PortXmitData:....................4294967295
...
PortXmitWait:....................65571
```

All physical-layer counters are zero. `PortXmitWait` and the few `PortXmitDiscards` (packets dropped on
transmit, typically because of congestion or a port that was not ready) are not physical-layer
indicators. `PortXmitData` reads 4294967295: the 32-bit counter has saturated, so use `perfquery -x`
(64-bit extended counters) for data volumes.

### Step 5: soak and accept

After any repair, clear (or snapshot) the counters, run traffic at line rate for a defined period
(for example `ib_write_bw` bidirectional or an all-pairs test) and check against acceptance criteria:
zero effective errors, raw BER under the vendor threshold with no lane far out of family, no flaps,
correct speed and width.

The hardware lab [Link health: optics, FEC and physical-layer error counters under load](#/hw/labs/hw-05-link-health-optics)
walks through these readings and a soak on your own RDMA hosts.

### Decision table

| Symptom | Likely cause | Evidence command | Fix |
|---|---|---|---|
| High raw BER on one lane, low Rx power on that lane | Dirty or damaged connector / fibre | `mlxlink -c`, `ethtool -m` | Inspect, clean, reseat; replace patch cord |
| High raw BER on all lanes, normal Rx power | Optic DSP or SerDes issue, wrong cable type/length | `mlxlink -c -m` both ends | Swap optic, then cable, then port |
| Non-zero effective errors / uncorrectable blocks | Margin exhausted | `mlxlink -c`, `ethtool -I --show-fec` | Treat as incident: drain traffic, repair now |
| `rx_crc_errors_phy` rising on NIC | Errors escaping FEC on the link into the NIC | `ethtool -S` deltas | Same as above; check switch transmit side |
| Link flaps (`LinkDownedCounter`, carrier changes) | Loose connector, failing optic, thermal | Switch logs, `perfquery`, DDM temperature | Reseat, replace optic, check airflow |
| Link up at lower speed or width | Retrain after errors, bad lane, mismatch | `ethtool`, `iblinkinfo`, `mlxlink` | Repair lane, re-negotiate, verify config |
| Link will not come up | FEC/speed mismatch, polarity, no light | `ethtool --show-fec`, DDM Rx power | Align FEC/speed config; check fibre path |
| Temperature high, Tx bias drifting up | Optic ageing or airflow problem | `ethtool -m` trend | Proactive optic replacement, fix cooling |

## Common pitfalls

- **Alerting on corrected errors.** Symptom: thousands of "FEC error" alerts on healthy links. Cause:
  treating corrected errors as faults on PAM4. Fix: alert on raw BER thresholds, lane imbalance,
  uncorrectable blocks and CRC rates.
- **Reading only one end.** Symptom: you replace the NIC-side optic and errors persist. Cause: the
  errors were caused by the switch-side transmitter or the fibre. Fix: always read both ends and
  establish the bad direction.
- **Reseating without cleaning.** Symptom: BER is worse after the "fix". Cause: contamination moved
  to the mating surface. Fix: inspect with a scope, clean, inspect again.
- **Confusing congestion counters with physical errors.** Symptom: a link with high `PortXmitWait` is
  sent for RMA. Cause: `PortXmitWait` measures credit starvation (congestion), not bit errors. Fix:
  use `SymbolErrorCounter`, `PortRcvErrors` and BER for link health.
- **Ignoring speed downshift.** Symptom: one rail is slow with no errors. Cause: a link retrained at
  half rate. Fix: check negotiated speed and width in monitoring, and alert on deviations from plan.
- **Forcing FEC off to "make it come up".** Symptom: link comes up, then RDMA retransmissions soar.
  Cause: running PAM4 without FEC. Fix: match FEC mode on both ends as the vendor specifies.
- **Clearing counters during an investigation.** Symptom: you lose the evidence of intermittent
  flaps. Cause: reset before snapshot. Fix: snapshot first; clear only when starting a soak test.

## Key takeaways

- On PAM4 links, corrected errors are normal; raw BER is margin, effective BER is damage.
- RS(544,514) KP4 FEC corrects up to 15 symbols per codeword; production links must run far below
  its correction limit, using vendor thresholds.
- Any error that escapes FEC becomes a dropped packet and an RDMA retransmission, so non-zero
  effective errors are an incident.
- Per-lane data (BER and Rx power) localizes faults to a fibre position or connector.
- Read both ends, swap one part at a time, and let the errors tell you which part they follow.
- Flaps, retrains and speed downshifts are link faults even when the link is "up".
- `PortXmitWait` is congestion, not physical-layer health; keep the two diagnoses separate.
