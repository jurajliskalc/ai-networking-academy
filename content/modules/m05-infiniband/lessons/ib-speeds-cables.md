---
id: ib-speeds-cables
title: "InfiniBand speeds, links and cables: SDR to NDR and XDR"
module: m05-infiniband
level: 3
estimated_minutes: 45
objectives:
  - Reconstruct the InfiniBand generations (SDR through NDR, with XDR as the newest) from lane rate, encoding/modulation and link width.
  - Explain NRZ versus PAM4, the role of FEC, and why effective data rate differs from signalling rate.
  - Choose between passive copper, active copper, active optical cables and transceivers for a given reach, and explain twin-port OSFP and splitter cables.
  - Verify negotiated speed and width and diagnose a link that trained at a lower rate.
  - Estimate switch counts and port reach for a two-tier fat tree from switch radix.
prerequisites: [ib-architecture]
quiz: quiz-ib-speeds-cables
widgets: [fabric-sizer, ib-speeds]
labs: []
tags: [infiniband, ndr, hdr, xdr, pam4, fec, osfp, qsfp, dac, aoc, transceivers, cabling]
further_reading:
  - title: InfiniBand Trade Association - InfiniBand roadmap
    url: https://www.infinibandta.org/infiniband-roadmap/
  - title: NVIDIA LinkX cables and transceivers
    url: https://www.nvidia.com/en-us/networking/interconnect/
  - title: NVIDIA Quantum-2 InfiniBand platform
    url: https://www.nvidia.com/en-us/networking/quantum2/
  - title: InfiniBand overview and history (Wikipedia, for generation timeline)
    url: https://en.wikipedia.org/wiki/InfiniBand
---

## Why this matters

A 1,000-GPU InfiniBand cluster has thousands of links, and every one of them must train at full speed and full width with a clean bit error rate. A single link that comes up at half width, or at the previous generation's speed, quietly halves the bandwidth of every collective that crosses it — and because collectives are synchronous, that one link can slow the whole job. Cables and optics are also a large share of the fabric's cost and power, and the choice between copper and optical, or between transceivers and active cables, shapes rack layout.

You need to be able to look at "4X 106.25 Gbps" in a tool's output and know whether that is right, explain why a 400 Gb/s port's ibstat says `Rate: 400` while its lanes signal at over 100 Gb/s, and pick a cable type for a 2 m in-rack hop versus a 40 m run to a spine row. That is this lesson.

## Concepts

### Lanes, widths and rates

An InfiniBand link is made of **lanes** (a transmit and receive pair of signals). Ports are typically **4x** (four lanes); 1x and 2x configurations exist (2x is used for "split" ports such as HDR100 and NDR200), and 8x and 12x widths appear in the specification. The headline speed of a port is lanes × per-lane data rate.

| Generation | Per-lane signalling (approx.) | Encoding / modulation | 4x data rate (nominal) | Typical connector | Approx. era |
|---|---|---|---|---|---|
| SDR | 2.5 Gb/s | 8b/10b, NRZ | 8 Gb/s (10 Gb/s signalling) | CX4 | early 2000s |
| DDR | 5 Gb/s | 8b/10b, NRZ | 16 Gb/s (20 signalling) | CX4 / QSFP | mid 2000s |
| QDR | 10 Gb/s | 8b/10b, NRZ | 32 Gb/s (40 signalling) | QSFP | ~2008 |
| FDR10 | 10.3125 Gb/s | 64b/66b, NRZ | ~40 Gb/s | QSFP | ~2011 |
| FDR | 14.0625 Gb/s | 64b/66b, NRZ | ~54 Gb/s (56 signalling) | QSFP | ~2011 |
| EDR | 25.78125 Gb/s | 64b/66b, NRZ, RS-FEC | 100 Gb/s | QSFP28 | ~2014 |
| HDR | 53.125 Gb/s | PAM4, RS-FEC | 200 Gb/s (HDR100: 2 lanes, 100 Gb/s) | QSFP56 | ~2018-2019 |
| NDR | 106.25 Gb/s | PAM4, RS-FEC | 400 Gb/s (NDR200: 2 lanes, 200 Gb/s) | OSFP, QSFP112 | ~2021-2022 |
| XDR | ~200 Gb/s class | PAM4 | 800 Gb/s | OSFP | ~2024-2025 |

Notes:

- Older generations quote "signalling rate" (for example QDR = 40 Gb/s) while the usable data rate was 80 % of that because of 8b/10b encoding. From FDR onward, 64b/66b (and then FEC-based framing) made the overhead small.
- From EDR onward the nominal port speeds (100, 200, 400, 800) are the data rates; the higher per-lane signalling figures include FEC and framing overhead.
- **XDR** details (exact lane rate, FEC, reach per cable type) are the newest and should be taken from current NVIDIA/IBTA documentation; NVIDIA's XDR products are the Quantum-X800 switch family and ConnectX-8 SuperNIC generation. The IBTA roadmap lists a further generation (GDR) beyond XDR.

Sort the generations, then pick a generation and width to compute the link data rate and check it against the PCIe slot it sits in:

```widget
ib-speeds
```

### NRZ, PAM4 and FEC

- **NRZ** (non-return-to-zero) sends one bit per symbol (two voltage levels). It served up to EDR.
- **PAM4** sends two bits per symbol (four levels), doubling throughput without doubling symbol rate — HDR lanes run at about 26.6 GBd and NDR lanes at about 53 GBd. The price is a smaller eye opening and a much higher raw bit error rate.
- **FEC** (forward error correction, Reed-Solomon variants) corrects most of those raw errors at the receiver. With PAM4, a non-zero pre-FEC (raw) BER is normal; what matters is that the **post-FEC** (effective) error rate stays extremely low and that symbol errors after correction remain near zero. FEC adds latency — on the order of tens to a hundred-plus nanoseconds per hop depending on FEC type — which is one reason latency per hop did not keep falling with each generation.

The `link-layer-ber-fec` lesson covers BER thresholds and how to read them.

> [!ANALOGY]
> PAM4 plus FEC is like moving from a clear two-lane country road to a four-lane motorway in fog, with a recovery service at the exit that fixes most fender-benders. Throughput doubles, accidents (raw bit errors) become routine, and the system works as long as the recovery service (FEC) keeps up. When raw errors exceed what FEC can fix, the link starts dropping packets or retraining — and the cause is usually physical: dirty connectors, a damaged cable, or a marginal transceiver.

### Cable and module types

| Type | What it is | Typical reach (order of magnitude, generation-dependent) | Power | Use |
|---|---|---|---|---|
| **DAC** (passive direct-attach copper) | Copper twinax, no electronics in the signal path | A few metres at NDR (shorter as speeds rise) | ~0 W | In-rack, GPU server to leaf in the same rack |
| **ACC** (active copper) | Copper with signal-conditioning chips in the connectors | Somewhat longer than DAC | Low (a few W) | Adjacent racks |
| **AOC** (active optical cable) | Fibre permanently attached to two optical modules | Tens of metres up to ~100 m | Several W per end | Row-scale runs |
| **Transceivers + fibre** | Pluggable optics (multimode SR-class or single-mode DR/FR-class) with separate patch fibre | Multimode tens of metres; single-mode hundreds of metres to kilometres | Highest per port | Leaf to spine, spine to core, structured cabling |

Always use the reach and power figures from the specific product's data sheet: they change with generation and module type.

### Connectors and twin-port OSFP

- **QSFP** family (QSFP, QSFP28, QSFP56, QSFP112): four electrical lanes, used from QDR to HDR and on some NDR adapters.
- **OSFP** (Octal Small Form-factor Pluggable): eight electrical lanes and better thermal capacity. NVIDIA's Quantum-2 NDR switches use **twin-port OSFP** cages: each cage carries eight 100G-class lanes as **two independent 4x NDR ports** (800 Gb/s per cage), so a 1U Quantum-2 switch provides 64 NDR ports through 32 cages. Switch-side modules are typically finned-top OSFP for airflow; adapter-side modules are typically flat-top or QSFP112; check compatibility matrices before ordering.
- **Splitter (breakout) cables** turn one twin-port OSFP into two 400G ports or four 200G (NDR200) ports, which is how one switch cage connects to two GPU servers, or how a 400G port feeds two 200G adapters.

## How it works

### Link training

When a cable is inserted, the two ports go through **Polling** (detect a partner), then **Configuration/Training** (agree on width and speed, tune equalisation), and finally **LinkUp**. The negotiated result is the highest speed and width supported by *both* ports *and* the cable. Common reasons for a lower result:

- One end (HCA, switch or cable) only supports the older generation, for example an HDR-rated cable in an NDR port.
- A lane failed to train, so the link came up at reduced width (for example 2x or 1x instead of 4x).
- Speed was restricted administratively (ports can be configured to allow only certain speeds).
- Signal integrity is marginal and training settles on a lower speed.

After LinkUp, the logical state still needs the SM (see `ib-architecture`).

### Matching the rest of the system

| Element | Must match the link rate |
|---|---|
| HCA | ConnectX-6 class for HDR, ConnectX-7 class for NDR, ConnectX-8 class for XDR (check product briefs for exact speeds and port configurations) |
| PCIe | Gen4 x16 is enough for 200G; NDR 400G needs Gen5 x16; 800G needs Gen6 x16 or an equivalent arrangement |
| Switch | Quantum (HDR, 40 ports at 200G or 80 at HDR100), Quantum-2 (NDR, 64 ports at 400G), Quantum-X800 (XDR; NVIDIA lists 144 ports at 800G — verify the current data sheet) |
| Cable/optics | Rated for the generation; mixing generations forces the lowest common speed |

### Fabric sizing from radix

A switch's **radix** (number of ports at full speed) decides how large a non-blocking fat tree can be:

```text
Two-tier non-blocking fat tree, radix k:
  leaf: k/2 ports down to hosts, k/2 up to spines
  max host ports   = k^2 / 2
  leaves = k, spines = k/2

  Quantum-2 (k = 64):   2,048 host ports with 64 leaves + 32 spines
  Three tiers:          k^3 / 4 = 65,536 host ports
```

With eight NICs per GPU server and one GPU per NIC, 2,048 host ports means 2,048 GPUs on a single two-tier NDR fabric. Beyond that, you need a third tier or a higher-radix switch. The `fabric-sizing-math` lesson goes deeper; experiment here:

```widget
fabric-sizer
```

Cable count follows directly: a non-blocking two-tier fabric has as many leaf-spine links as host links, and every one of those uplinks typically needs optics because spines sit rows away.

## In practice

### Checking negotiated rate and width

```text
$ ibstat mlx5_0 1 | grep -E "State|Rate|Physical"
                State: Active
                Physical state: LinkUp
                Rate: 400
```

*(Illustrative.)* `Rate` is the data rate in Gb/s. For the full picture of every link in the fabric:

```text
$ iblinkinfo | grep -vE "4X +106.25 Gbps"
Switch: 0xfc6a1c0300e4f100 leaf01:
          2    17[  ] ==( 4X      53.125 Gbps Active/  LinkUp)==>      57    1[  ] "node09 HCA-1" ( Could be 106.25 Gbps)
          2    18[  ] ==( 2X     106.25 Gbps Active/  LinkUp)==>      58    1[  ] "node09 HCA-2" ( Could be 4X)
```

*(Illustrative; exact formatting depends on the infiniband-diags version.)* Filtering out links at the expected 4X width and NDR lane rate leaves only the anomalies (a plain `grep -v "106.25 Gbps"` would also hide port 17, because its "Could be" annotation contains that string). Here port 17 trained at HDR lane speed (perhaps an HDR cable or an adapter set to a lower speed), and port 18 trained at NDR speed but only 2x width (a failed lane, a damaged cable or a dirty connector). Recent iblinkinfo versions annotate links that "could be" faster or wider; check your version's options.

`ibportstate <lid> <port>` queries a port's speed and width settings (enabled, supported and active) and can also enable, disable or reset a port, which is useful to retrain a link after reseating a cable.

### Physical-layer details

For PHY-level detail (raw and effective BER, FEC mode, module temperature, received optical power), NVIDIA's firmware tools (MFT) provide `mlxlink` for link diagnostics and `mlxcables` for cable/module information. Their options depend on the MFT version; run them with `--help` and consult the MFT documentation. `ibdiagnet` (see `ib-tools-diagnostics`) can also collect cable and PHY information fabric-wide.

### Cabling practice for AI fabrics

| Practice | Why |
|---|---|
| Label both ends with switch, port and host/HCA | Miscabling breaks ftree balance and rail alignment |
| Keep a machine-readable cabling plan and compare it with `ibnetdiscover` output | Detect swaps and missing links automatically |
| Clean and inspect fibre end faces before insertion | Dirty connectors are a top cause of high BER on optics |
| Respect bend radius and avoid crushing copper bundles | Damage causes lane failures and width downgrades |
| Keep spare cables and modules of each type on site | Fast replacement of the long tail of failing optics |
| Record serial numbers per port | Track failure patterns by batch or vendor |

> [!TIP]
> In burn-in, compare every link's speed and width with the plan programmatically (iblinkinfo or UFM reports) before running any bandwidth test. A single 2X link explains a "mysterious" 50 % slow pair in perftest.

> [!INTERVIEW]
> *"Why does NDR need FEC when SDR did not, and what does that cost?"* Strong answer: NDR uses PAM4 at about 53 GBd per lane to reach 100G-class lanes; PAM4's four levels shrink the eye and raise the raw BER far above what a link can tolerate, so Reed-Solomon FEC corrects errors at the receiver. The cost is added latency per hop (tens to around a hundred nanoseconds, depending on the FEC) and some overhead in the signalling rate; the operational consequence is that you monitor pre-FEC BER as an early-warning signal and post-FEC errors as real problems.

## Common pitfalls

- **Link trained at reduced width.** Symptom: `2X` or `1X` in iblinkinfo, half or quarter bandwidth in perftest. Cause: a lane failed to train (damaged or dirty cable, bad module). Fix: reseat, clean, replace the cable or module, then retrain.
- **Link trained at the older generation's speed.** Symptom: HDR lane rate on an NDR fabric. Cause: older cable or adapter, or speed restricted in configuration. Fix: check cable part numbers against the compatibility matrix and port speed settings.
- **Misreading signalling as data rate.** Symptom: "the lane says 106.25, so the port should do 425". Cause: signalling rate includes FEC and framing. Fix: use the nominal data rate (400 Gb/s for NDR 4x) as the target.
- **Ignoring PCIe.** Symptom: link shows 400 but perftest caps near 200-ish. Cause: adapter in a Gen4 slot or at reduced PCIe width. Fix: check `lspci -vv` LnkSta (see `perftest-benchmarking`).
- **Wrong module form factor or top.** Symptom: module does not seat or overheats. Cause: finned versus flat-top OSFP, or OSFP versus QSFP112 mismatch between switch and adapter sides. Fix: follow the vendor's cable and module matrix.
- **Using passive copper beyond its reach.** Symptom: high BER or flapping on long DACs. Cause: copper reach shrinks with each speed generation. Fix: use ACC, AOC or optics for longer runs.

## Key takeaways

- Port speed = lanes × per-lane data rate; 4x is standard: EDR 100, HDR 200, NDR 400 and XDR 800 Gb/s, with 2-lane split ports (HDR100, NDR200).
- From HDR onward lanes use PAM4 with RS-FEC; pre-FEC errors are normal, post-FEC errors are not.
- Signalling rates (53.125, 106.25 Gb/s per lane) are higher than data rates because they include FEC and framing.
- DAC for in-rack, ACC/AOC for adjacent racks and rows, transceivers plus fibre for structured leaf-spine cabling; check reach and power per product.
- Quantum-2 uses twin-port OSFP cages (two NDR ports per cage, 64 ports per 1U); splitter cables give 2×400G or 4×200G.
- A two-tier non-blocking fat tree supports k²/2 host ports for radix k — 2,048 for 64-port NDR switches.
- Verify speed and width on every link (ibstat, iblinkinfo, ibportstate) before benchmarking.
