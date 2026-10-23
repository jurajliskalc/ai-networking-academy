<div align="center">

# AI Networking Academy

**From beginner to master in AI cluster networking.**
RDMA · InfiniBand · RoCEv2 · lossless Ethernet · NCCL · rail-optimized fabrics · troubleshooting

[![CI](https://github.com/jurajliskalc/ai-networking-academy/actions/workflows/ci.yml/badge.svg)](https://github.com/jurajliskalc/ai-networking-academy/actions/workflows/ci.yml)
![Lessons](https://img.shields.io/badge/lessons-76-4ade80)
![Questions](https://img.shields.io/badge/questions-723-22d3ee)
![Labs](https://img.shields.io/badge/labs-35-fbbf24)
![Verified](https://img.shields.io/badge/verified%20on-real%20ConnectX%20hardware-76b900)
![License](https://img.shields.io/badge/code-PolyForm%20Noncommercial-blue) ![License](https://img.shields.io/badge/content-CC%20BY--NC--SA%204.0-lightgrey)

**[▶ Run it locally](#run-it-locally)** · runs entirely in your browser, no account, no backend

<img src="docs/screenshots/dashboard.png" alt="Dashboard" width="900" />

</div>

## Why this exists

Training a frontier model is a distributed systems problem in which the network decides how fast
thousands of GPUs can work together. One mis-set PFC priority, a marginal optic or a stale NCCL variable
can cost a third of a cluster's throughput while every dashboard stays green.

The knowledge needed to prevent that is scattered across IEEE standards, InfiniBand specifications,
vendor manuals, SIGCOMM papers and tribal knowledge. This academy puts it in one place as a structured,
hands-on curriculum. It starts at "what is an Ethernet frame" and ends at designing and debugging a
1,024-GPU fabric.

## What's inside

| | |
|---|---|
| **76 lessons** in 13 modules, ~187,000 words | Four levels: Beginner → Practitioner → Engineer → Master. Every lesson follows the same structure: *Why this matters → Concepts → How it works → In practice → Common pitfalls → Key takeaways*. Lessons include callouts for network engineers (ANALOGY) and interview prep (INTERVIEW). |
| **567 quiz questions** | Each lesson ends with a quiz, mostly scenario questions ("given these counters, what is wrong?"). **Every option is explained**, including the wrong ones. |
| **19 Fabric Simulator labs** | Break/fix incident tickets in a browser-simulated 32-GPU rail-optimized RoCE cluster, plus an InfiniBand variant (`ibstat`, `iblinkinfo`, `perfquery`, `sminfo`). You investigate with real tool syntax (`ethtool -S`, `mlnx_qos`, `show_gids`, `ib_write_bw`, `all_reduce_perf`, NVUE), commit a diagnosis, apply a fix, and the lab grades the fabric state. |
| **22 Real HW labs** in four tiers | Bring your own gear. **Tier 0** (one VM): Soft-RoCE, RoCEv2 captures, containerlab BGP-unnumbered Clos, ECMP entropy, ECN/DCTCP, EVPN-VXLAN. **Tier 1** (two RDMA hosts): inventory, first RoCEv2 traffic, host PFC/DSCP/ECN, link health and optics, break/fix with fault injection, InfiniBand bring-up, subnet manager failover, IPoIB, P_Key partitions, ibdiagnet triage, MPI over UCX and CPU allreduce bus bandwidth (collectives without GPUs). **Tier 2** (lossless switch): incast, PFC and ECN on real counters. **Tier 3** (GPU nodes): GPUDirect RDMA and multi-node NCCL. Every lab is personalised with your lab profile and graded by a `check.sh`. |
| **Real HW toolkit** | A Connect page that builds your lab profile and generates `lab.env`, netplan/nmcli, `/etc/hosts` and switch snippets; `aina-hw`, a dependency-free Python tool that inventories hosts over SSH, runs lab checks (resumable per task) and serves results and live port counters (Live Lab: RDMA throughput, pauses, CNPs, ECN marks) through a read-only local agent; and a fabric health review (MTU, PCIe, GIDs, QoS, firmware, counters) in the browser. Guides for requirements, host and network setup, safety and troubleshooting. |
| **45 interactive visualizations** | Grouped by topic, embedded 131 times in 74 lessons and runnable on their own. Examples: a parallelism-to-network map with a per-step traffic estimator, pipeline schedules and their bubble, a rail-optimized path explorer with NCCL PXN, the GPU bandwidth ladder (HBM, NVLink, PCIe, NIC), KV cache transfer for disaggregated inference, straggler tail amplification, the life of an RDMA WRITE, kernel TCP/IP vs RDMA data path, a perftest message-size explorer, InfiniBand diagnostic tools and P_Key partitions, PFC headroom, DSCP mapping and deadlocks, ECMP collisions, packet spraying and reordering, ring vs in-network (SHARP) all-reduce, an nccl-tests reader, a cabling validator, BER/FEC, a counter decoder and a slow-job triage tree. Every widget's math is unit-tested and each was reviewed against primary sources by someone other than its author. |
| **3 timed mock exams** (156 questions) | Fundamentals, engineer and master level, scored by domain. Original practice material, not real certification questions. |
| **Reference** | 164 annotated commands (Linux, rdma-core, perftest, InfiniBand, NVIDIA tools, NCCL, Cumulus NVUE, SONiC) and a 241-term glossary that also drives **SM-2 spaced-repetition flashcards**. |
| **Search and accessibility** | Site-wide search (`/` or Ctrl+K) across lesson sections, labs, guides, commands and the glossary, with deep links to the matching section. Built to WCAG 2.2 AA: keyboard-operable everywhere, including quizzes, the simulator shell and all widgets; axe-clean in light and dark themes. Five colour schemes (NOC, Ocean, Violet, Sepia and a 7:1 High contrast), each in light and dark, chosen from the palette menu in the top-right corner. |
| **Progress tracking** | A lesson counts as mastered only when it is read *and* its quiz is passed. Streaks, an activity heatmap, weak-spot review, and exam domain profiles. Everything stays in your browser, with export and import. |

### The curriculum

| # | Module | Level |
|---|---|---|
| 0 | Networking foundations for AI engineers | Beginner |
| 1 | Why AI needs a different network | Beginner |
| 2 | Inside the GPU server: PCIe, NUMA, NICs/DPUs, GPUDirect, NVLink | Practitioner |
| 3 | Data center fabric fundamentals: Clos, ECMP, BGP, EVPN-VXLAN | Practitioner |
| 4 | RDMA fundamentals: verbs, QPs, transports, perftest | Practitioner |
| 5 | InfiniBand: SM, routing, credits and VLs, SHARP, diagnostics | Engineer |
| 6 | RoCEv2 and lossless Ethernet: PFC, headroom, ECN/DCQCN, QoS, storms | Engineer |
| 7 | Load balancing and congestion: entropy, adaptive routing, Spectrum-X, Ultra Ethernet | Engineer |
| 8 | Collective communication and NCCL | Engineer |
| 9 | AI cluster design: rail-optimized topologies, SuperPOD, sizing, optics, NVL72 | Master |
| 10 | Operations: telemetry, gNMI, burn-in, automation, UFM/NetQ | Master |
| 11 | Troubleshooting mastery: methodology, BER/FEC, lossless misconfigs, stragglers, case studies | Master |
| 12 | Capstone (a 1,024-GPU fabric design), interview prep, exam strategy | Master |

The full lesson map is in [docs/CURRICULUM_PLAN.md](docs/CURRICULUM_PLAN.md).

## The Fabric Simulator

<img src="docs/screenshots/simulator.png" alt="Fabric Simulator running nccl-tests and NVUE" width="900" />

A deterministic model of 4 nodes × 8 GPUs, 8 × 400G RoCE NICs per node, 8 rail leaves and 2 spines. It
reproduces the symptoms that real faults produce: which counters move, which tests fail and roughly how
much bandwidth is lost. One example is a PFC priority mismatch, where `ib_write_bw` runs at line rate
while the collective runs at a third of normal speed. Faults include MTU black holes, PFC and trust
misconfigurations, lost switch QoS, marginal optics, PCIe downtraining, GID index errors and NCCL
configuration drift.

Every lab is checked by the test suite: it must fail its checks before the documented fix and pass all
of them after the fix is replayed. The model and its limits are documented in
[docs/SIMULATOR.md](docs/SIMULATOR.md).

## Real hardware labs

The **Real HW labs** section is for people who want to study on their own gear, from one VM up to GPU
nodes behind a lossless switch. It has guides for requirements, host setup, network setup, safety and
troubleshooting, plus a **Connect** page:

1. Describe your lab once (hosts, data IPs, RDMA devices, MTU, lossless priority and DSCP, switch).
   Every lab and guide command is filled in with your values, and the page generates `lab.env`,
   netplan/nmcli snippets, `/etc/hosts` lines and a switch baseline.
2. On host A, `labs/hw-toolkit/aina-hw collect-all` inventories every host over SSH, and
   `aina-hw check <lab>` runs a lab's `check.sh`.
3. `aina-hw serve` exposes the results read-only on `127.0.0.1:8765`. Reach it through an SSH tunnel,
   or import the JSON files instead. The academy reviews the fabric's health in the browser (MTU, PCIe,
   GIDs, QoS, firmware, counters) and marks labs whose check passed as verified. Nothing leaves your
   browser.

Labs that change NIC or kernel settings save the original state and ship restore scripts. The labs are
written for NVIDIA ConnectX NICs, with notes on the generic Linux equivalents. Their commands, sample
output, `setup-rdma-host.sh` and `aina-hw collect-all` have been checked on real ConnectX-5 hosts, on both
the distribution's inbox driver stack and NVIDIA DOCA-OFED (see the accuracy policy below).

<img src="docs/screenshots/parallelism.png" alt="Parallelism to network map with traffic estimator" width="900" />

<table><tr>
<td><img src="docs/screenshots/lesson.png" alt="Lesson in dark mode" /></td>
<td><img src="docs/screenshots/lab.png" alt="P1 incident lab" /></td>
</tr><tr>
<td><img src="docs/screenshots/ecmp.png" alt="ECMP collision visualization" /></td>
<td><img src="docs/screenshots/sizer.png" alt="Fabric sizer" /></td>
</tr></table>

## Run it locally

**Windows:** double-click **`start-academy.bat`**. On first run it fetches a portable, checksum-verified
Node.js into `.tools/`, builds the site, and opens http://127.0.0.1:8740. Nothing is installed system-wide.

**Linux / macOS** (Node.js 20+):

```bash
./scripts/start.sh            # build if needed, serve on http://127.0.0.1:8740
```

**Development:**

```bash
cd frontend
npm ci
npm run dev        # hot reload
npm run validate   # content rules: IDs, structure, quiz rules, cross-references, tables
npm test           # unit tests + every simulator lab replayed
npm run build      # type check + production build into frontend/dist
npm run e2e        # Playwright browser tests against the build (uses your installed Google Chrome)
```

Tier 0 labs need an Ubuntu 24.04 VM; Tier 1-3 labs need your own RDMA hosts (see the Real HW labs section in the app, and [labs/README.md](labs/README.md)). Toolkit tests: `python3 -m unittest discover -s labs/hw-toolkit/tests` (Linux).

## How it is built

A static single-page app (React 19, TypeScript, Vite, Tailwind CSS v4) with no backend. All learning
content is plain Markdown and YAML under [`content/`](content), validated and compiled to JSON at build
time. GitHub Actions validates, tests, builds and browser-tests every push. A GitHub Pages deploy workflow is
included but disabled until the site is published. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```
content/      lessons, quizzes, labs, exams, commands, glossary (Markdown + YAML)
frontend/     React app, content compiler, Fabric Simulator, tests
labs/         lab files (topologies, scripts, check.sh) and hw-toolkit/ (aina-hw, lib.sh, setup-rdma-host.sh)
docs/         architecture, authoring guide, simulator, curriculum plan, hardware verification reference
```

## Accuracy policy

Content is written for engineers who will act on it, so accuracy comes first:

* No invented CLI flags, counters, environment variables or APIs.
* Vendor- and generation-specific facts are hedged and point to the authoritative documentation.
* Sample command output is labelled illustrative unless it is a real capture.
* Every lesson, quiz and exam was reviewed after it was written, then went through a source-based
  fact-check (about 2,800 claims checked against RFCs, specifications, tool source code and vendor
  documentation, over 200 corrections), a blind re-answering of the questions with shuffled options,
  and a recomputation of every number in the newer material. Details in
  [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md). The hands-on and hardware labs are
  syntax-checked (`bash -n`; the original Tier 0 labs also with ShellCheck) and are marked `verified: false`
  until they have been run end to end on a reference VM or reference hardware. 19 of the 22 labs have been run end
  to end and are marked verified: all seven Tier 0 labs and twelve real-hardware labs (`hw-01` to `hw-05` and
  `hw-09` to `hw-15`, the InfiniBand and collectives tracks) on ConnectX-5 hosts (see `labs/README.md`); the remaining three need a
  lossless switch or GPU nodes.
* **Checked on real hardware.** Every host command and sample output in the lessons, labs, guides,
  command reference, quizzes, exams and the Fabric Simulator was compared with what the tools print on
  two ConnectX-5 hosts (100GbE and EDR InfiniBand back to back, Ubuntu 26.04, kernel 7.0), on both the inbox stack
  (kernel mlx5 + distribution rdma-core) and NVIDIA DOCA-OFED 3.4. Real-world behaviour that the docs
  rarely mention is taught where it matters: device names differ per driver stack, enabling PFC turns
  802.3x pause off and re-enabling pause silently clears PFC, which tools exist only with NVIDIA's stack,
  what Secure Boot lockdown blocks, and how to capture offloaded RoCE. The verified formats and behaviours
  are recorded in [docs/HARDWARE_VERIFICATION.md](docs/HARDWARE_VERIFICATION.md) and pinned by tests.
  Not yet verified on hardware: output that needs a switch (InfiniBand switch LIDs and routing, PFC and
  ECN at a switch), 400G-specific strings, optical-module readouts, switch CLIs (NVUE, SONiC) and GPU/NCCL output.

Found an error? Please [open an issue](https://github.com/jurajliskalc/ai-networking-academy/issues/new?template=content-error.md)
with a source. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Free for noncommercial use: personal study, teaching, research, and use by educational and other
noncommercial organisations. Code: PolyForm Noncommercial 1.0.0. Learning content: CC BY-NC-SA 4.0.
Commercial use (for example company training, hosting it as a service, or including it in a paid
product or course) needs a separate license from the copyright holder. See [LICENSE](LICENSE). This is an independent, unofficial
study resource. Product names belong to their owners, and nothing here is endorsed by any vendor or
certification body.
