---
id: oversubscription-and-blocking
title: "Oversubscription and blocking: how much fabric is enough"
module: m03-dc-fabrics
level: 2
estimated_minutes: 40
objectives:
  - Calculate the oversubscription ratio of a leaf, a tier and an end-to-end path from port counts and speeds.
  - Distinguish strict-sense, rearrangeably non-blocking and "non-blocking in capacity" fabrics, and explain why packet fabrics with ECMP sit in the last category.
  - Define bisection bandwidth and use it to reason about collective performance across a fabric.
  - Choose appropriate oversubscription targets for back-end, storage and front-end AI networks and justify them.
prerequisites: [clos-leaf-spine]
quiz: quiz-oversubscription-and-blocking
widgets: [fabric-sizer]
labs: []
tags: [oversubscription, non-blocking, bisection-bandwidth, fabric-design, sizing]
further_reading:
  - title: "C. Clos, A Study of Non-Blocking Switching Networks (Bell System Technical Journal, 1953)"
    url: https://ieeexplore.ieee.org/document/6770468
  - title: "Al-Fares, Loukissas, Vahdat, A Scalable, Commodity Data Center Network Architecture (SIGCOMM 2008)"
    url: https://dl.acm.org/doi/10.1145/1402958.1402967
  - title: NVIDIA DGX SuperPOD reference architectures
    url: https://docs.nvidia.com/dgx-superpod/
  - title: "RFC 7938: Use of BGP for Routing in Large-Scale Data Centers (section on Clos topology)"
    url: https://www.rfc-editor.org/rfc/rfc7938
---

## Why this matters

Spines and optics are expensive. In a large fabric the leaf-to-spine and spine-to-super-spine layers
can account for most of the transceivers, a large share of the switch count and a big slice of the
power budget. The oldest cost lever in data center design is therefore **oversubscription**: provide
less upstream bandwidth than downstream bandwidth, on the bet that not every server talks across the
fabric at full rate at the same time.

For web and enterprise traffic that bet usually pays off. For AI training it usually does not: a
data-parallel all-reduce has every GPU sending at full rate at the same moment, step after step. An
oversubscribed back-end fabric does not make training a little slower on average; it makes every
synchronized collective as slow as the most oversubscribed link it crosses. Knowing how to calculate,
place and justify oversubscription is a core design skill.

## Concepts

### The oversubscription ratio

At any switch or tier, the **oversubscription ratio** is:

```text
oversubscription = total downstream (host-facing) bandwidth / total upstream (fabric-facing) bandwidth
```

Always compute it with **bandwidth**, not port counts, because downlinks and uplinks often run at
different speeds.

| Leaf configuration | Down | Up | Ratio |
|---|---|---|---|
| 48 × 25G servers, 6 × 100G uplinks (classic enterprise ToR) | 1,200G | 600G | 2:1 |
| 48 × 100G servers, 8 × 400G uplinks | 4,800G | 3,200G | 1.5:1 |
| 32 × 400G GPU NICs, 32 × 400G uplinks (AI back-end leaf) | 12,800G | 12,800G | 1:1 |
| 64 × 400G down, 16 × 800G up (on a 51.2T box) | 25,600G | 12,800G | 2:1 |

A ratio of 1:1 is called **non-blocking** (in the capacity sense, see below). A ratio above 1:1 means
the uplinks can carry only a fraction of what the hosts could offer: at 3:1, if every host sends
cross-fabric at once, each gets one third of its line rate.

### Ratios compound across tiers

End-to-end oversubscription is the **product** of the ratios on the path:

```text
leaf 3:1  ×  spine (pod) 2:1  =  6:1 between hosts in different pods
```

This is how classic three-tier designs ended up at 20:1 or worse at the core. In a leaf-spine-super-spine
design you must state the ratio at each tier, not just at the leaf.

### Bisection bandwidth

Cut the fabric into two equal halves of endpoints so that the bandwidth crossing the cut is minimal.
That bandwidth is the **bisection bandwidth**. For a non-blocking fabric with *N* endpoints at rate
*r*, the bisection bandwidth is *N* × *r* / 2: half the endpoints can send to the other half at full rate.
Oversubscription reduces it proportionally.

Bisection bandwidth matters for AI because collective patterns are dominated by many-to-many traffic.
An all-to-all (expert parallelism) or a large all-reduce across the whole cluster is ultimately
limited by how much bandwidth crosses the worst cut.

> [!ANALOGY]
> Oversubscription is the same bet a service provider makes when it sells 1 Gb/s to each of 100
> homes behind a 10 Gb/s uplink: 10:1 works because homes rarely all download at once. AI training is
> the pathological customer for whom it fails: every "home" downloads at full speed at exactly the same
> instant, every few hundred milliseconds, and the job waits for the slowest one.

### Blocking: three meanings

"Non-blocking" has precise meanings from circuit-switching theory and a looser one in packet networks:

| Term | Meaning | Clos condition (*n* inputs per ingress switch, *m* middle switches) |
|---|---|---|
| **Strict-sense non-blocking** | Any new connection between free endpoints can be made without disturbing existing ones | *m* ≥ 2*n* − 1 |
| **Rearrangeably non-blocking** | Any set of connections can be made, but existing connections may need to be moved | *m* ≥ *n* |
| **Non-blocking in capacity** (packet fabrics) | Enough total bandwidth exists at every tier (1:1); whether flows actually get it depends on load balancing | 1:1 bandwidth at every tier |

A 1:1 leaf-spine is the *m* = *n* case: rearrangeably non-blocking. In a circuit switch, a controller
would rearrange connections onto free middle switches. In a packet fabric with ECMP, nobody
rearranges: each flow is hashed onto a spine, and two large flows can land on the same uplink while
another sits idle (`ecmp-hashing`). That is why a "non-blocking" fabric can still show hot links, and
why AI fabrics invest in adaptive routing and packet spraying (`adaptive-routing-packet-spraying`).

## How it works

### Why synchronized traffic defeats statistical multiplexing

Oversubscription relies on **statistical multiplexing**: with many independent bursty sources, the sum
rarely approaches the peak. Three properties of AI training traffic (see `ai-traffic-patterns`) break
that assumption:

1. **Synchrony.** All ranks of a data-parallel group start the gradient all-reduce at roughly the same
   time.
2. **Full-rate flows.** Each GPU's NIC sends at or near line rate for the duration of the collective.
3. **Barrier semantics.** The step finishes only when the slowest rank finishes, so the throughput that
   matters is the minimum, not the average.

A worked example: a leaf with 32 GPU NICs at 400G and 3:1 oversubscription has about 4.3 Tb/s of uplink
capacity. During a cluster-wide all-reduce, if all 32 GPUs need to send cross-leaf at once, each gets
about 133 Gb/s instead of 400 Gb/s. The communication phase takes about three times longer. Whether
that costs 5 % or 50 % of step time depends on how much communication overlaps with compute, but at
scale it is rarely negligible.

### Where traffic actually crosses the fabric

Not all traffic leaves the leaf, and how much does depends on topology and software:

- In a **rail-optimized** design (`rail-optimized-topology`), GPUs with the same local index on
  different servers share a rail leaf. NCCL can move data between rails inside a server over NVLink
  (its PXN feature, `nccl-architecture`) so that more inter-node traffic stays on one rail leaf.
- Tensor-parallel traffic stays inside the NVLink domain (`nvlink-nvswitch`) and never reaches the
  scale-out fabric.
- Pipeline-parallel traffic is point-to-point between neighbouring stages.

Because of this, some designs taper the upper tier (for example a 1:1 leaf layer with modest tapering
above it) when the expected job sizes and placement make cross-pod traffic rare. That is a deliberate,
workload-specific decision, documented with the traffic analysis that supports it, not a default.

### Typical targets per network

| Network (see `four-networks-of-an-ai-cluster`) | Typical target | Reasoning |
|---|---|---|
| Compute / back-end | 1:1 (non-blocking) at every tier | Synchronized full-rate collectives; the job runs at the pace of the worst link |
| Storage | 1:1 to around 2:1 | Checkpoint bursts are synchronized; reads are more statistical |
| Front-end / in-band | Around 3:1 or more | User traffic, orchestration, logs: classic statistical behaviour |
| Out-of-band management | Heavily oversubscribed | Tiny traffic, cost dominated by port count |

These are common starting points in published reference designs, not rules. Your traffic analysis
decides.

### Failures change the ratio

A non-blocking fabric with one failed uplink is no longer non-blocking. A leaf with 16 uplinks that
loses one runs at 16:15, about 6 % less uplink capacity. With ECMP, the flows that hashed to the failed
link are redistributed and the remaining links run hotter. In a synchronized job that shows up as a
small, persistent slowdown. Operational practice: track **effective** oversubscription per leaf from
link state, and alarm on it (`telemetry-counters`).

### Speed mismatches

Mixing speeds complicates both math and behaviour. A leaf with 400G downlinks and 800G uplinks has half
as many uplink ports for the same ratio, so each ECMP member carries more flows, and a single 400G flow
can use at most half of one 800G uplink. Fewer, fatter uplinks reduce hashing granularity; more, thinner
uplinks increase it. Neither is free: thinner links mean more optics and cables.

```widget
fabric-sizer
```

Use the sizer to compare 1:1, 2:1 and 3:1 designs for the same GPU count: watch the spine count, the
number of optics and the bisection bandwidth change.

## In practice

### Compute the ratio from an inventory

Whatever the NOS, you can export interface names, roles and speeds (from LLDP, your source of truth or
the switch API). A tiny calculation turns that into a ratio. Illustrative input and script:

```text
# leaf01 interfaces: name role speed_gbps
swp1  host   400
...
swp32 host   400
swp33 fabric 400
...
swp64 fabric 400
```

```bash
awk '$2=="host"{d+=$3} $2=="fabric"{u+=$3} END{printf "down=%dG up=%dG ratio=%.2f:1\n", d, u, d/u}' leaf01.txt
```

```text
down=12800G up=12800G ratio=1.00:1
```

Run it from your automation against the *operational* link state as well as the intended design, and
you get both the designed and the effective ratio (`network-automation-for-ai`).

### Measure it

Bandwidth math is a prediction; measure the real thing with collectives:

1. Run `nccl-tests` all-reduce on a set of nodes that all sit on the **same** leaf (or rail set).
2. Run it again with the same number of nodes spread across leaves, so traffic must cross spines.
3. Compare bus bandwidth. On a healthy non-blocking fabric with good load balancing, the two should be
   close; a large gap points to oversubscription, failed links or ECMP collisions (`nccl-tests-interpretation`).

### Watch uplink utilization during a job

During a large job, compare uplink and downlink utilization on each leaf from interface counters
(or streaming telemetry, `streaming-telemetry-gnmi`). On a 1:1 leaf, uplinks running at 100 % while
downlinks run at 60 % mean traffic is not spread evenly (hashing) or a link is missing. Uneven
utilization *between* uplinks of the same leaf is the signature of ECMP collisions.

## Common pitfalls

- **Counting ports instead of bandwidth.** Symptom: a "1:1" leaf that is really 2:1. Cause: 32 down and
  32 up ports, but uplinks at 400G and downlinks at 800G (or vice versa). Fix: always multiply by speed.
- **Stating only the leaf ratio.** Symptom: unexpected slowdowns for jobs spanning pods. Cause: the
  super-spine tier is tapered and ratios compound. Fix: document the ratio at every tier and end to end.
- **Equating non-blocking with congestion-free.** Symptom: hot uplinks on a 1:1 fabric. Cause: ECMP hash
  collisions; the fabric is only non-blocking in capacity. Fix: improve entropy, use adaptive routing or
  spraying (`ecmp-hashing`, `adaptive-routing-packet-spraying`).
- **Ignoring failed links.** Symptom: a slow, persistent slowdown after "minor" link failures. Cause:
  effective oversubscription rose and ECMP concentrated flows. Fix: alarm on effective ratio, repair or
  drain promptly.
- **Copying front-end ratios to the back-end.** Symptom: a cheaper fabric and much slower training. Cause:
  enterprise intuition about statistical multiplexing applied to synchronized traffic. Fix: start from
  1:1 for compute fabrics and deviate only with workload evidence.

## Key takeaways

- Oversubscription = downstream bandwidth / upstream bandwidth, computed with speeds, at each tier; ratios
  multiply end to end.
- Bisection bandwidth is the capacity across the worst half-half cut; for a non-blocking fabric it is
  *N* × *r* / 2.
- A 1:1 leaf-spine is rearrangeably non-blocking in theory; with ECMP it is only non-blocking in capacity,
  so collisions still happen.
- Synchronized, full-rate, barrier-bound AI collectives defeat statistical multiplexing; back-end fabrics
  are therefore built 1:1.
- Storage can tolerate modest oversubscription and the front-end much more; deviations from 1:1 on the
  back-end need workload evidence.
- Failed links silently raise effective oversubscription: track and alarm on it.
