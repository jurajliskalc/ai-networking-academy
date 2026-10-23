---
id: optics-cabling-power
title: "Optics, cabling and power: DAC to co-packaged optics"
module: m09-cluster-design
level: 4
estimated_minutes: 55
objectives:
  - Choose between DAC, ACC, AEC, AOC and pluggable transceivers for a link based on reach, power and serviceability.
  - Decode form factors (OSFP, QSFP112, QSFP-DD) and lane math for 400G, 800G and 1.6T, including twin-port modules and breakouts.
  - Estimate transceiver power and expected failure counts for a fabric from explicit assumptions.
  - Explain what LPO and co-packaged optics change, and what they cost in interoperability and serviceability.
  - Plan cable lengths, labeling and cleaning practices that keep link error rates low.
prerequisites: [ib-speeds-cables, fabric-sizing-math]
quiz: quiz-optics-cabling-power
widgets: [fabric-sizer, optics-planner]
labs: []
tags: [optics, transceivers, cabling, power, cpo, lpo, osfp]
further_reading:
  - title: OSFP MSA (Octal Small Form Factor Pluggable)
    url: https://osfpmsa.org/
  - title: QSFP-DD MSA
    url: http://www.qsfp-dd.com/
  - title: IEEE P802.3df 400 Gb/s and 800 Gb/s Ethernet task force
    url: https://www.ieee802.org/3/df/
  - title: "Optical Internetworking Forum (OIF): co-packaging and linear interface work"
    url: https://www.oiforum.com/
  - title: "The Llama 3 Herd of Models (Meta, 2024): section on infrastructure reliability"
    url: https://arxiv.org/abs/2407.21783
---

## Why this matters

The previous lesson turned a 4,096-GPU fabric into roughly ten thousand transceivers. Those modules
are a large share of the network bill, they consume tens to hundreds of kilowatts, and they are
among the most failure-prone components in the cluster. A single dirty fiber connector can raise a
link's bit error rate enough to trigger retransmissions or link flaps, and because collectives are
synchronous, one bad link slows the entire job.

Physical-layer decisions also constrain everything above them: where switches sit in the hall
(because copper only reaches a few meters), how many racks a scalable unit spans, how the hall is
cooled, and how quickly a technician can replace a failed part. An architect who treats optics as
"just a line item" will be surprised in all of these places.

## Concepts

### Media types

| Medium | What it is | Typical reach (order of magnitude, 100G/lane generation) | Power | Notes |
|---|---|---|---|---|
| **DAC** (direct attach copper) | Passive twinax with connectors on both ends | ~1-3 m | ~0 W | Cheapest, most reliable; thick and stiff at high lane counts |
| **ACC** (active copper cable) | Copper with linear redrivers (equalizers) | A little beyond DAC | Low | Extends copper slightly |
| **AEC** (active electrical cable) | Copper with retimers (DSP) in the ends | Up to several meters (~5-7 m) | A few W per end (varies) | Thinner gauges, longer copper reach |
| **AOC** (active optical cable) | Fixed-length fiber with optics built into both ends | Tens of meters | Similar to transceivers | One part to replace if either end fails |
| **Transceiver + fiber** | Pluggable optical module plus separate structured fiber | Multimode ~50-100 m; single-mode ~500 m (DR) to ~2 km (FR) and beyond | ~10-30 W per module depending on speed | Most flexible; most parts; cleaning required |

Exact reaches depend on lane rate, modulation, fiber grade and the specific product; copper reach
shrinks as lane rates go from 100G to 200G. Treat the column as orders of magnitude and use the
datasheet for design limits.

### Form factors and lanes

A port speed is lanes x lane rate. Today's high-speed modules use PAM4 electrical lanes at 50G,
100G or 200G:

| Speed | Common lane math | Typical form factors |
|---|---|---|
| 400G | 4 x 100G (or 8 x 50G in older QSFP-DD) | QSFP112, OSFP, QSFP-DD |
| 800G | 8 x 100G (or 4 x 200G) | OSFP, QSFP-DD800 |
| 1.6T | 8 x 200G | OSFP (1.6T class) |

- **OSFP**: 8 electrical lanes, larger than QSFP and with more thermal headroom. Comes in
  **finned-top** variants for switch cages and **flat-top** variants for hosts with riding heat
  sinks (check the mechanical spec for your NIC and switch).
- **Twin-port OSFP**: one 8-lane module that presents **two independent 4-lane ports** (for example
  2 x 400G NDR), each with its own fiber connector. Quantum-2 class InfiniBand switches expose 64 NDR
  ports through 32 OSFP cages this way, and DGX H100-class servers use twin-port modules on the host
  side too.
- **QSFP112**: 4 lanes of 100G, 400G per port, common on NICs and some switches.
- **QSFP-DD**: double-density QSFP with 8 lanes, popular in Ethernet switches.

### Breakouts

A **breakout** splits one high-speed port into several lower-speed ports: an 800G twin-port module
into 2 x 400G, or a 400G port into 2 x 200G or 4 x 100G, using splitter fiber or splitter DAC. The
switch must support the split mode (port splitting is a platform and software feature) and every
logical port counts toward the switch's limits for MAC tables, routes and buffers.

> [!ANALOGY]
> Media choice is like choosing between a patch cable, a structured cabling run and a WAN circuit in
> an enterprise: short, cheap and dumb in the rack; longer and engineered across the room; very long
> and active across the building. The difference in an AI hall is density: a single scalable unit
> has hundreds of 400G links, and their combined bulk, weight and airflow impact is a design
> problem on its own.

## How it works

### Choosing media by link class

Divide the fabric into link classes and pick media per class. Assumptions for an example hall: GPU
servers 4 per rack (power-limited), rail leaves in dedicated network racks at the end of each row,
spines in a central network row.

| Link class | Assumed distance | Reasonable choice | Reason |
|---|---|---|---|
| Server to rail leaf (same row) | 10-30 m | Multimode or single-mode transceivers, or AOC | Beyond copper reach |
| Leaf to spine (across rows) | 30-150 m | Single-mode (DR-class) transceivers + structured fiber | Beyond multimode comfort, needs patch panels |
| Leaf and NIC inside one rack | 1-3 m | DAC or AEC | Zero or low power, very reliable |
| NVLink spine inside an NVL72 rack | < 1-2 m | Copper (NVIDIA's NVL72 design uses a copper spine) | Lowest power and cost at very short reach |

The lesson: the physical layout determines the media, and the media determines power and failure
rates. Placing leaves in the middle of a row can bring server links within AEC reach on some
designs; that saves optics but concentrates heat and cable bulk.

Try the planner with each link class's distance: watch where copper stops reaching at 400G versus 800G, then use the fabric calculator below it to turn module counts into kilowatts.

```widget
optics-planner
```

### Worked example: optics power

Take Design B from the sizing lesson (4,096 GPUs, two tiers, **10,240** modules) and Design A (three
tiers, **14,336** modules). Assumption: an average of **15 W per module** (a plausible order of
magnitude for 400G/800G-class optics; real values range roughly 8-20 W depending on type, check
datasheets).

1. Design B: 10,240 x 15 W = 153,600 W = **153.6 kW**.
2. Design A: 14,336 x 15 W = 215,040 W = **215.0 kW**.
3. Difference: 215.0 - 153.6 = **61.4 kW**, from the third tier alone.
4. Per GPU (Design B): 10,240 / 4,096 = 2.5 modules x 15 W = **37.5 W** per GPU.

With a GPU drawing on the order of 1 kW, optics in this example add a few percent to the GPU power
budget. That sounds small until you multiply by the whole hall and realize that every watt is also
cooled.

Use the sizer to see how the module count (and therefore optics power) moves when you change radix
or tier count:

```widget
fabric-sizer
```

### Worked example: expected failures

Assumption: an annualized failure rate (AFR) of **0.5%** per module (illustrative; real rates vary
by vendor, generation, temperature and handling, so use your own field data).

1. Expected module failures per year = 10,240 x 0.005 = **51.2**, roughly **one per week**.
2. Spares: holding 1% spares = 102 modules covers about two years of failures at this rate, but
   order by type (host versus switch, multimode versus single-mode) because modules are not
   interchangeable across classes.

Optics are only part of the story. Meta's Llama 3 paper attributed a share of unexpected training
interruptions to network switches and cables (alongside the much larger share from GPUs and their
memory); the lesson for architects is that link-level faults are routine, so detection, isolation
and fast replacement must be designed in.

### Signal integrity and FEC

At 100G and 200G per lane, every link runs forward error correction (FEC). The pre-FEC bit error
rate (BER) is the early-warning signal: a healthy link has a pre-FEC BER far below the FEC
correction limit, while a degrading link creeps toward it before any packet is dropped. Dirty
connectors, tight bends and marginal modules all show up here first. Module m11 covers BER and FEC
in depth.

### LPO: removing the DSP

A conventional optical module contains a **DSP** (retimer) that cleans up the electrical signal from
the switch before driving the laser. **Linear pluggable optics (LPO)** remove the DSP and rely on
the switch or NIC SerDes to drive linear analog optics directly. Claimed benefits: substantially
lower module power (vendor claims are often in the range of tens of percent) and lower latency.
Costs: tighter coupling between the host SerDes and the module (interoperability must be validated
per platform), and less margin. Variants that retime only one direction (often called LRO) sit in
between. Industry work on linear interfaces happens in MSAs and the OIF.

### CPO: optics on the package

**Co-packaged optics (CPO)** move the optical engines onto the switch package, next to the ASIC,
so the electrical path is millimeters instead of centimeters. Lasers are typically external,
pluggable light sources. In March 2025 NVIDIA announced **Quantum-X Photonics** (InfiniBand) and
**Spectrum-X Photonics** (Ethernet) CPO switches, with NVIDIA citing large improvements in power
efficiency and resiliency versus pluggable transceivers and stating availability timelines that
started with Quantum-X Photonics; other vendors (for example Broadcom) have shown CPO switches as
well. Treat the claimed ratios as vendor figures until independent data is available.

| | Pluggable (DSP) | LPO | CPO |
|---|---|---|---|
| Module power | Highest | Lower | Lowest per bit (vendor claims) |
| Field replacement | Swap one module | Swap one module | Optical engines fixed; lasers pluggable |
| Interoperability | Broad (MSA standard) | Must be validated per host | Vendor-integrated system |
| Maturity (as of 2025-2026) | Mature | Emerging | Early deployments |

> [!INTERVIEW]
> **"Your 8,000-GPU design has 20,000 transceivers. How would you reduce optics cost and power?"**
> Strong answer: raise radix to remove a tier (port splitting or larger switches), use copper (DAC,
> AEC) wherever layout allows by moving leaves closer to servers, consider LPO where validated,
> evaluate CPO for spines where serviceability trade-offs are acceptable, and show the arithmetic
> (modules x watts, AFR x modules) for each option.

## In practice

### Reading module health

On Linux hosts, `sudo ethtool -m <interface>` (it needs root; without it ethtool prints
`netlink error: Operation not permitted`) dumps the module EEPROM and digital diagnostics (DOM):
type, vendor, temperature, supply voltage, and per-lane transmit and receive optical power. A
passive copper DAC has no optical power or bias lines at all, and may report a module
temperature of 0.00 degrees C. On
NVIDIA NICs and switches, the MFT tools `mlxlink` and `mlxcables` show link and cable details;
check the MFT documentation for the options available in your version.

```text
# Illustrative, trimmed output of: ethtool -m eth2
	Identifier                                : 0x19 (OSFP 8X Pluggable Transceiver)
	Vendor name                               : EXAMPLEVENDOR
	Module temperature                        : 52.30 degrees C / 126.14 degrees F
	Transmit avg optical power (Channel 1)    : 1.2000 mW / 0.79 dBm
	Rcvr signal avg optical power (Channel 1) : 0.9800 mW / -0.09 dBm
	Rcvr signal avg optical power (Channel 3) : 0.2100 mW / -6.78 dBm     <- lane far below its peers
```

One lane receiving several dB less than its neighbours is a classic dirty or damaged connector.
Clean both ends with a proper fiber cleaning tool, inspect with a scope, and recheck before
replacing the module.

### Cabling practices that pay off

- **Label both ends** with source device, port, destination device, port and rail. Generate labels
  from the same cable plan the audit scripts use.
- **Pre-terminated trunks** (MPO) between rows reduce field termination errors; check polarity
  (method A/B/C) end to end.
- **Respect bend radius** and do not overfill trays; tight bends cause intermittent errors that are
  hard to trace.
- **Keep airflow clear**: dense copper bundles behind servers can block exhaust.
- **Inspect and clean every connector before mating**, every time. Contamination is a leading
  cause of optical link problems in practice.
- **Order slack and spares by type**: lengths come in fixed increments; a missing 30 m AOC delays a
  whole rack.

### Burn-in

Before handing over a fabric, run traffic on every link (for example all-to-all `nccl-tests` or
`ib_write_bw` pairs) for hours and record error counters and pre-FEC BER per link. Replace outliers
before production. Module m10 covers fabric validation in depth.

## Common pitfalls

- **Assuming copper reach from an older generation.** Symptom: links fail to train or show high
  BER at 800G on a 3 m DAC that worked at 200G. Cause: copper reach shrinks with lane rate. Fix: use
  the datasheet reach for the current lane rate; switch to AEC or optics.
- **Wrong module variant for the cage.** Symptom: module does not seat or overheats. Cause:
  finned-top versus flat-top OSFP mismatch, or wrong form factor. Fix: match module mechanical type
  to the NIC or switch specification.
- **Breakout mode not configured.** Symptom: a split cable lights only one logical port. Cause:
  switch port left in unsplit mode. Fix: configure port splitting per the platform guide before
  cabling.
- **Skipping cleaning.** Symptom: random high-BER links after a move, add or change. Cause: dust
  introduced while re-patching. Fix: inspect-clean-inspect before every mating.
- **Ignoring optics power in the facility plan.** Symptom: network racks exceed their power or
  cooling budget. Cause: switch power counted, module power forgotten. Fix: add modules x watts per
  rack to the facility model.

## Key takeaways

- Copper (DAC, ACC, AEC) is cheap, low-power and reliable but reaches only meters; optics reach tens
  of meters to kilometers at roughly 10-30 W per module depending on speed.
- Port speed = lanes x lane rate: 400G = 4 x 100G, 800G = 8 x 100G, 1.6T = 8 x 200G; twin-port OSFP
  carries two independent ports.
- Estimate optics power as modules x watts and failures as modules x AFR; state the assumptions.
- LPO removes the DSP to save power at the cost of interoperability margin; CPO (announced by NVIDIA
  in 2025 as Quantum-X and Spectrum-X Photonics) moves optics onto the switch package.
- Layout determines media: decide rack and switch placement with cable reach in mind.
- Clean and inspect every connector; watch pre-FEC BER as an early-warning signal.
