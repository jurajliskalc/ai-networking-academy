# Portfolio tour

A five-minute route through AI Networking Academy for someone evaluating the engineering, not taking the
course. It shows one fault-injection lab end to end, then where the evidence behind it lives.

## Start here

| | |
|---|---|
| **Live academy** | <https://jurajliskalc.github.io/ai-networking-academy/> (static site, no account, nothing leaves the browser) |
| **Flagship incident** | [PFC on the wrong priority](https://jurajliskalc.github.io/ai-networking-academy/#/labs/sim-03-pfc-priority-mismatch): the demo below |
| **A real-hardware lab** | [Host-side lossless QoS on two ConnectX hosts](https://jurajliskalc.github.io/ai-networking-academy/#/hw/labs/hw-03-host-qos-pfc-ecn) (`hw-03`, run end to end on the reference hardware) |
| **Hardware verification** | [HARDWARE_VERIFICATION.md](HARDWARE_VERIFICATION.md), and the [Verified on hardware](https://jurajliskalc.github.io/ai-networking-academy/#/verified) page in the app |
| **Architecture** | [ARCHITECTURE.md](ARCHITECTURE.md) |

## The five-minute demo: a PFC incident

Open the [flagship incident](https://jurajliskalc.github.io/ai-networking-academy/#/labs/sim-03-pfc-priority-mismatch).
The left side is the ticket and the grading, the right side is a shell on the jump host of a simulated
32-GPU rail-optimized RoCE cluster (4 nodes, 8 x 400G rails, 8 leaves, 2 spines).

**The ticket.** `INC-4519`: since node03 was re-imaged, multi-node jobs run at a third of normal speed, yet
`ib_write_bw` between node03 and its neighbours reports ~392 Gb/s on every rail. "So the network is fine,
right?"

Type these commands in the shell, in order (Tab completes; the lab's three hints lead to the same place if
you would rather find the rail yourself):

<!-- tour-commands: sim-03-pfc-priority-mismatch (replayed by frontend/tests/portfolio-tour.test.ts) -->
```text
all_reduce_perf -b 8 -e 8G -f 2 -g 1
ssh leaf06
nv show interface swp3 counters
ssh node03
ethtool -S enp170s0np0 | grep pause
rdma statistic show link mlx5_5/1
mlnx_qos -i enp170s0np0
mlnx_qos -i enp170s0np0 --pfc 0,0,0,1,0,0,0,0
exit
all_reduce_perf -b 8 -e 8G -f 2 -g 1
```

What each step shows (simulated output, trimmed to the lines that matter):

<!-- tour-evidence: every line below is printed by the simulator for the commands above -->
```text
# 1. Symptom: the collective peaks near 130 GB/s of bus bandwidth (a healthy fabric gives about 372)
  8589934592    2147483648     float     sum      -1    127864   67.18  130.16      0    127481   67.18  130.16      0

# 2. The leaf facing node03 on rail 5 is pausing priority 3 hard, and still dropping
TX drops           1886197
TX PFC pause       412377  (priority 3)

# 3. node03's NIC on that rail has pause counters for priority 4 only: it is not listening on priority 3
     rx_prio4_pause: 0

# 4. The RDMA transport sees the loss: go-back-N retransmissions
    out_of_sequence 1735301 

# 5. Root cause: PFC enabled on priority 4, where the fabric uses 3
	enabled     0   0   0   0   1   0   0   0   

# 6. After the fix the collective is back at full speed
  8589934592    2147483648     float     sum      -1     44777  191.84  371.68      0     44643  191.84  371.68      0
```

Then, in the left panel:

1. **Commit the diagnosis**: the option that says node03 `mlx5_5` enables PFC on priority 4 instead of 3.
   Grading is locked until a diagnosis is committed, so the fix cannot be guessed first.
2. **Grade the fabric.** The lab runs its checks against the fabric state (the NIC's PFC vector, and
   all-reduce bus bandwidth above 360 GB/s) and reports "Incident resolved" only if the diagnosis was right
   *and* every check passes. Run it before the fix and it fails.

Why this incident: a single `ib_write_bw` flow never congests a port, so it never needs PFC and still runs
at line rate. Point-to-point tests prove the data path, not the lossless configuration. That is the
misleading-evidence pattern that makes real lossless-Ethernet faults expensive.

**What is real here and what is modelled.** The clue in step 3 is hardware behaviour: on the reference
ConnectX-5 hosts, `ethtool -S` shows `prioN_pause` counters only for priorities with PFC enabled
([HARDWARE_VERIFICATION.md](HARDWARE_VERIFICATION.md), "PFC and global pause"), and the simulator's host-tool
output formats are pinned to captures from that hardware by golden tests. The bandwidth numbers and counter
magnitudes are a deterministic teaching model, not a measurement
([SIMULATOR.md](SIMULATOR.md), "How performance is computed"); the switch output follows vendor
documentation and has not been checked against a switch.

**How it is tested.** Every simulator lab is replayed in the unit tests (it must fail its checks before the
documented fix and pass all of them after), and solved again through the UI by Playwright in headless
Chrome. The command list above is replayed by `frontend/tests/portfolio-tour.test.ts`, so this page cannot
drift from the lab.

## What I built

Built with AI coding agents working under my direction; how their output is verified is described under
[AI-assisted engineering](#ai-assisted-engineering) below.

| Subsystem | What it is | Where |
|---|---|---|
| Curriculum and content system | 76 lessons in 13 modules with quizzes, 3 mock exams, a command reference and a glossary, as Markdown and YAML. A compiler validates structure, IDs, cross-references, quiz rules and capture tags, and fails the build on a violation | `content/`, `frontend/scripts/build-content.mjs`, [AUTHORING.md](AUTHORING.md) |
| Fabric Simulator | A deterministic model of a rail-optimized RoCE cluster (plus an InfiniBand variant) with a shell that speaks real tool syntax, fault injection and state-based grading. 22 Fabric Simulator labs | `frontend/src/sim/`, `content/labs/sim/`, [SIMULATOR.md](SIMULATOR.md) |
| Lab framework | 22 hands-on labs in four tiers (one VM up to GPU nodes), each with scripts and a `check.sh`. Checks declare the measurements they require and are graded PASSED, FAILED, INCONCLUSIVE or BELOW_TARGET | `labs/`, `content/labs/handson/`, [labs/README.md](../labs/README.md) |
| Hardware toolkit | `aina-hw`: a dependency-free Python tool that inventories RDMA hosts over SSH, runs lab checks (resumable per task) and serves results and live port counters through a read-only local agent | `labs/hw-toolkit/` |
| Validation and tests | Content validation, unit tests, a replay of every simulator lab, golden-format tests against real captures, Playwright browser tests with axe accessibility checks, shell syntax checks and Python toolkit tests, all in CI | `frontend/tests/`, `frontend/e2e/`, `.github/workflows/ci.yml` |
| Front end | A static React and TypeScript single-page app: 45 interactive visualizations, site-wide search, progress tracking, spaced-repetition flashcards, WCAG 2.2 AA target | `frontend/src/` |

## Engineering decisions

- **Static site, no backend.** The same build runs from GitHub Pages or from a laptop, progress stays in the
  browser, and there is no service to operate or to leak learner data.
- **A deterministic teaching model, not an emulator.** The simulator reproduces which counters move, which
  tests fail and roughly how much bandwidth each fault class costs. Performance comes from a fixed factor
  per fault class; no packets or queues are simulated. Being deterministic is what lets a test replay every
  lab and grade the state of the fabric.
- **Verified versus illustrative is part of the data model.** Output blocks are tagged as real captures per
  driver stack, hardware observations are `[!VERIFIED]` callouts collected onto one page, and a lab carries
  `verified: false` until it has been run end to end. The validator rejects a capture tagged with the
  wrong stack.
- **Two driver stacks as first-class variants.** Device names, tools and behaviour differ between the
  distribution's inbox RDMA stack and NVIDIA DOCA-OFED, so commands exist in both forms and the learner
  picks the stack once.
- **Lab checks as executable evidence.** A lab counts as verified only when its `check.sh` passed with
  every required measurement made. A run whose main measurement was skipped is INCONCLUSIVE, not a pass.
- **A local-only hardware agent.** The browser cannot reach a learner's servers, so `aina-hw serve` binds to
  127.0.0.1 by default, answers only read requests, checks the Host header and an origin allow-list, and is
  reached through an SSH tunnel. Importing JSON files works without it.

## What is verified, and what is not

- **Run on real hardware:** 19 of the 22 hands-on labs, end to end. Host commands and their output in the
  content and the simulator were compared with two ConnectX-5 VPI hosts (100GbE RoCE and EDR InfiniBand,
  back to back): RoCE on both driver stacks, InfiniBand on DOCA-OFED. The record is
  [HARDWARE_VERIFICATION.md](HARDWARE_VERIFICATION.md) and [labs/README.md](../labs/README.md).
- **Not verified on hardware:** the three labs that need a lossless switch or GPU nodes (`hw-06`, `hw-07`,
  `hw-08`, all `verified: false`), switch CLIs, switched-fabric behaviour, 400G-specific and optical-module
  output, and GPU or NCCL output. These follow primary sources and are labelled illustrative.
- **Scope of the observations:** one NIC model, no switch, inside VMs with PCI passthrough. An observation
  on that hardware is stated as an observation, not as vendor behaviour in general.

The open items are listed in [ROADMAP.md](../ROADMAP.md).

## AI-assisted engineering

The code, content and labs were produced with AI coding agents (Anthropic's Claude Code) working under my
direction; every commit carries a `Co-Authored-By` trailer. Nothing an agent produces is kept until it has
survived a check that fits the kind of claim:

| Kind of claim | What it must survive |
|---|---|
| A CLI flag, counter, environment variable or spec fact | A check against the primary source: the RFC or specification, the tool's source code, or vendor documentation |
| A number in a lesson, quiz or lab | Recomputation in a separate pass |
| A quiz or exam answer key | Blind re-answering with shuffled options by an AI solver that cannot see the key |
| Host-tool output and behaviour | Comparison with captures from the reference hardware, then pinned by golden tests |
| A simulator lab | Unit tests: broken before the documented fix, clean after it |
| A hands-on lab | An end-to-end run on a reference VM or reference hardware, graded by its own `check.sh` |
| The app | Type checking, unit tests and browser tests on every push |

The review passes described in [IMPLEMENTATION_STATUS.md](../IMPLEMENTATION_STATUS.md) were run by AI agents
that had not written the material under review. They are not human peer review, and nothing in the
repository claims they are. The working rules the agents follow are in [CLAUDE.md](../CLAUDE.md).
