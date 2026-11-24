---
id: exam-strategy
title: "Exam strategy: preparing for AI networking and infrastructure certifications"
module: m12-capstone
level: 4
estimated_minutes: 60
objectives:
  - Identify which vendor certification tracks are relevant to AI networking roles and verify their current details from official sources.
  - Build a study plan that maps an exam blueprint to this academy's modules and labs.
  - Apply spaced repetition and retrieval practice to retain protocol details, counters and sizing formulas.
  - Use the academy's three mock exams diagnostically, including an error log and domain-level score analysis.
  - Manage time and question-reading technique on scenario-heavy multiple-choice exams.
prerequisites: [interview-preparation]
quiz: quiz-exam-strategy
widgets: []
labs: []
tags: [career, certification, study-skills, spaced-repetition, mock-exams]
further_reading:
  - title: NVIDIA certification program (official catalogue, exam guides and policies)
    url: https://www.nvidia.com/en-us/learn/certification/
  - title: "NVIDIA-Certified Professional: AI Networking (NCP-AIN) exam page and blueprint"
    url: https://www.nvidia.com/en-us/learn/certification/ai-networking-professional/
  - title: NVIDIA Academy / training courses
    url: https://academy.nvidia.com/
  - title: "Roediger and Karpicke (2006): Test-enhanced learning (retrieval practice)"
    url: https://doi.org/10.1111/j.1467-9280.2006.01693.x
  - title: "Cepeda et al. (2006): Distributed practice in verbal recall tasks (spacing effect review)"
    url: https://doi.org/10.1037/0033-2909.132.3.354
---

## Why this matters

Certifications do not make you a fabric engineer, but they do three useful things: they give hiring
filters something to match, they force you to cover the parts of a domain you would otherwise skip,
and the exam blueprint is a vendor's own statement of what it thinks practitioners must know. For AI
networking, where much of the knowledge is vendor-specific (InfiniBand tooling, Spectrum-X features,
UFM, NVUE), a vendor exam is also a structured way to learn those specifics.

The cost of preparing badly is real: exam fees, a waiting period before a retake, and, worse, weeks
spent memorising facts that are not tested while the scenario questions, which are most of the score
on modern exams, go unpractised. This lesson shows how to find out what an exam actually covers, how
to study so that it sticks, and how to use this academy's mock exams as a diagnostic instrument rather
than a score to chase.

## Concepts

### The certification landscape (verify before you plan)

> [!WARNING]
> Certification catalogues change often: exams are renamed, retired, re-versioned and re-priced. Treat
> everything in this section as a starting point and **confirm the current exam name, code, blueprint,
> format, duration, price, language options and validity period on the official NVIDIA certification
> pages** (linked in further reading) before you book or study.

At the time of writing, NVIDIA's certification programme has offered tracks at two levels that are
relevant to this course:

| Level | Examples of tracks offered (names as published at the time of writing; confirm) | Relevance to this academy |
|---|---|---|
| NVIDIA-Certified **Associate** | AI Infrastructure and Operations | Broad entry-level coverage of GPUs, AI workloads, data centre infrastructure and operations; maps to modules m00-m02 plus parts of m09-m10. |
| NVIDIA-Certified **Professional** | AI Infrastructure; AI Operations; AI Networking; AI Rack and Interconnect | Practitioner-level, deeper and more hands-on. The AI Networking track (which covers InfiniBand and Spectrum-X Ethernet) maps most directly to m03-m11. An earlier standalone InfiniBand professional exam has been retired, with NVIDIA pointing candidates to AI Networking instead. |

What you can generally expect from vendor professional exams of this kind (confirm for your exam):
an online, remotely proctored or test-centre delivery; multiple-choice and multiple-select questions,
many of them scenario-based; a fixed time limit; a published exam guide or blueprint listing domains
and their weights; and a validity period after which you recertify. The exact numbers (question count,
minutes, passing score, price) are deliberately not quoted here because they change; the official exam
guide is the only authority.

> [!NOTE]
> Other vendors (switch, NIC and cloud providers) run data centre networking certifications that
> overlap with parts of this course: BGP/EVPN fabrics, automation, QoS. They rarely cover RDMA and
> collectives in depth. If your target employer runs a specific vendor's switches, check that vendor's
> programme too.

### The exam blueprint is your syllabus

Every serious exam publishes a blueprint: domains, their percentage weight, and a list of tasks or
topics per domain. Your first study artefact is a **blueprint map**: one row per blueprint topic, with
the academy lesson(s) that cover it, your confidence (1-5), and your last practice date.

| Blueprint topic (example wording) | Academy lessons | Confidence | Last practised |
|---|---|---|---|
| Configure lossless Ethernet for RoCE | `pfc-priority-flow-control`, `ecn-and-dcqcn`, `rocev2-configuration-end-to-end` | 3 | 2026-10-12 |
| Validate fabric health with diagnostic tools | `ib-tools-diagnostics`, `telemetry-counters`, `fabric-validation-burn-in` | 2 | 2026-10-05 |
| Understand rail-optimized topologies | `rail-optimized-topology`, `fabric-sizing-math` | 4 | 2026-10-15 |

Weight your study time by `blueprint weight × (5 − confidence)`. A 25% domain at confidence 2 deserves
far more time than a 10% domain at confidence 4.

### Worked example: the NCP-AIN blueprint mapped to this academy

As a worked example, here is the blueprint of NVIDIA's professional AI networking exam (NCP-AIN) **as
published on NVIDIA's certification page when this lesson was last updated (2026-10-22)**. At that
time the page listed a two-hour exam of 70-75 questions, pass/fail scoring, two-year validity and no
formal prerequisites (with 2-3 years of data centre networking experience recommended), and announced
that lab exercises would be added to the exam from 1 November. Treat all of this as a snapshot and
re-check the official page before you plan.

| Domain (weight as published) | Blueprint tasks, paraphrased | Academy lessons |
|---|---|---|
| AI data center design and optimization (5%) | AI factory architecture and components (GPUs, BlueField, scalable units, switches); rail-optimized topologies; GPU-to-GPU communication | `four-networks-of-an-ai-cluster`, `superpod-reference-architecture`, `rail-optimized-topology`, `nvlink-nvswitch`, `nics-dpus-supernics` |
| NVIDIA Spectrum networking (30%) | Configure Spectrum-X switches for RoCE; enable and verify QoS, ECN, PFC, adaptive routing and telemetry; multi-tenant BGP-EVPN; simulate with NVIDIA DSX Air; diagnose congestion and loss with in-band telemetry and WJH; monitor with NetQ; install DOCA; configure SuperNIC functions | `rocev2-configuration-end-to-end`, `qos-trust-and-mapping`, `pfc-priority-flow-control`, `ecn-and-dcqcn`, `evpn-vxlan-frontend`, `multi-tenancy-isolation`, `spectrum-x-architecture`, `adaptive-routing-packet-spraying`, `drop-reasons-in-band-telemetry`, `ufm-netq-management`, `network-automation-for-ai`, `rdma-on-linux` |
| NVIDIA InfiniBand networking (30%) | Initial configuration and provisioning including high availability; P_Keys for multi-tenancy; QoS and adaptive routing; UFM monitoring of link status and bandwidth | `ib-architecture`, `subnet-manager-routing`, `ib-flow-control-vls`, `multi-tenancy-isolation`, `ai-fabric-security`, `ufm-netq-management` |
| Kubernetes integration (5%) | Deploy and verify the NVIDIA Network Operator for RDMA and InfiniBand in Kubernetes | `kubernetes-network-operator` |
| Troubleshooting tools (20%) | `cl-resource-query`; WJH; verifying GPU, CPU and storage interconnects; UFM system health; `ib_write_lat`, `ib_write_bw`, `ibping`, `ibstat`, `ibdiagnet`, `ibnodes`, `iblinkinfo` | `drop-reasons-in-band-telemetry`, `ib-tools-diagnostics`, `perftest-benchmarking`, `reading-server-topology`, `ufm-netq-management`, `troubleshooting-methodology` |
| Automation and configuration (10%) | NVUE templates for Spectrum-X switches; Ansible playbooks for tasks such as VLAN or RoCE configuration | `network-automation-for-ai`, `rocev2-configuration-end-to-end` |

Two observations a study plan should act on. First, 60% of the published weight sits in the two
vendor-platform domains, and many tasks are procedural ("install", "configure", "use"): this academy
explains the mechanisms and the verification, but product procedures such as installing DOCA,
configuring SuperNIC features or building a DSX Air simulation are best practised with NVIDIA's own
documentation, courses and lab environments. Second, the announced lab exercises reward hands-on
fluency with real tool output, so pair the lessons above with the simulator labs and the Real HW labs.

### How memory actually works (the short version)

Two findings from learning science matter most for exam preparation:

- **Retrieval practice (the testing effect).** Trying to recall an answer strengthens memory far more
  than re-reading it. Re-reading feels productive because the material becomes familiar, but
  familiarity is not recall. Quizzes, flashcards and explaining aloud are retrieval; highlighting is not.
- **Spacing.** Reviews spread out over days and weeks beat the same total time crammed into one
  session. The best gap grows as an item becomes better known.

Combined, these give **spaced repetition**: review each item just before you would forget it, and
push the next review further out every time you recall it successfully.

## How it works

### A Leitner system for this course

The simplest workable spaced-repetition scheme uses boxes:

| Box | Review interval | Item moves here when |
|---|---|---|
| 1 | Every day | New, or answered wrong anywhere |
| 2 | Every 3 days | Answered right from box 1 |
| 3 | Every week | Answered right from box 2 |
| 4 | Every 2 weeks | Answered right from box 3 |
| 5 | Monthly / before the exam | Answered right from box 4 |

Any wrong answer sends the card back to box 1. Software flashcard tools (and this academy's glossary
flashcards) implement more refined versions of the same idea, adjusting intervals by how hard each
recall felt.

### What to put on cards

Good cards test **one** fact or relationship and force recall, not recognition.

| Weak card | Strong card |
|---|---|
| "PFC" → "Priority Flow Control, 802.1Qbb, pauses priorities..." | "A host's `tx_prio3_pause` climbs while `rx_prio3_pause` is flat. Who is pausing whom?" |
| "RoCEv2 UDP port?" | "Which UDP header field gives RoCEv2 its ECMP entropy, and why does that matter for AI flows?" |
| "busbw" | "All-reduce on 16 ranks, algbw 200 GB/s. busbw = ? (show the factor)" (answer: 200 × 2 × 15 ÷ 16 = 375 GB/s) |
| "Fat tree" | "Max endpoints of a non-blocking two-tier fabric of radix-k switches?" (k²/2) |

Formulas, counter meanings, state machines and "which tool shows X" are ideal card material. Long
procedures are not; practise those in labs.

### Using the academy's mock exams

The academy ships three original practice exams (they are not questions from any real certification):

| Exam | Level | Questions / time | Use it |
|---|---|---|---|
| `exam-ai-fabric-1` | Fundamentals-weighted | 44 questions, 66 min | After modules m00-m04, as a baseline |
| `exam-ai-fabric-2` | Engineer | 56 questions, 100 min | After m05-m08 |
| `exam-ai-fabric-3` | Master: troubleshooting, design, calculations | 56 questions, 135 min | After m09-m11, and again a week before a real exam |

All three tag every question with one of seven domains: foundations, server, fabric, rdma, roce,
collectives and ops. The domain breakdown of your score is worth more than the total.

The diagnostic loop:

1. **Take the exam under real conditions**: timed, no notes, one sitting.
2. **Review every question, including the ones you got right.** Read every option's explanation; a
   correct answer reached by a wrong argument is a future wrong answer.
3. **Log each miss** in an error log with a cause category:
   - *Knowledge gap*: did not know the fact or mechanism.
   - *Misread*: missed a qualifier such as "NOT", "first", "most likely" or a number in the output.
   - *Reasoning slip*: knew the facts, combined them wrongly (often arithmetic or units).
   - *Time pressure*: guessed because the clock ran out.
4. **Act by category**: knowledge gaps → reread the lesson section and make two or three cards;
   misreads → slow down on the stem, underline qualifiers; reasoning slips → redo the calculation
   on paper; time pressure → practise pacing.
5. **Retake after a gap of at least a week**, not the next day: an immediate retake mostly measures
   memory of the answers.

### Exam-day technique for scenario questions

- **Read the last line first.** Know what is being asked ("which is the most likely cause?") before
  you read the counters, so you read the evidence with a purpose.
- **Translate output into a sentence.** "Pause frames received on priority 3 by the host, no
  discards, ECN marks zero" → "the switch is pausing the host, and ECN is not acting first".
- **Eliminate with reasons.** Strike options that contradict the evidence; usually two fall quickly.
  Between the last two, ask which one explains *all* of the evidence.
- **Watch for scope words**: "first step", "most likely", "best", "NOT". The first step is usually the
  least invasive one that gathers evidence.
- **Do arithmetic on scratch paper**, with units. Bits versus bytes and per-direction versus
  bidirectional are the classic traps.
- **Pace**: divide minutes by questions to get a budget (for example 90 ÷ 50 = 1.8 min); flag and
  move on when a question exceeds about twice the budget, and come back at the end.
- **Multiple-select questions**: judge each option independently as true or false against the stem;
  do not try to guess "how many" are correct unless the exam states it.

## In practice

### A six-week plan for a professional-level networking exam

| Week | Study | Practice | Retrieval |
|---|---|---|---|
| 0 | Download the official exam guide; build the blueprint map; book a date | `exam-ai-fabric-1` as baseline | Start glossary flashcards (10 new/day) |
| 1-2 | Lowest-confidence, highest-weight domains first | Hands-on labs for those domains | Daily cards; one short quiz per lesson studied |
| 3 | Remaining domains | Simulator labs (break/fix) | Cards; explain one topic aloud per day |
| 4 | Review error log; revisit weak lessons | `exam-ai-fabric-2` timed | Cards; redo missed quiz questions |
| 5 | Weak spots only; vendor-specific tooling in the blueprint | `exam-ai-fabric-3` timed | Cards from box 1-2 only |
| 6 | Light review, rest, logistics check (ID, room, system check for online proctoring) | One quiz per domain | Boxes 1-3 |

### Logistics checklist (confirm each item on the official pages)

- Exam name, code and version match the blueprint you studied.
- Delivery method: online proctoring system requirements and room rules, or test centre location.
- Identification requirements and name matching your registration.
- Retake policy and waiting period, so you know the cost of a failed attempt.
- Validity period and recertification path.

### Keeping a study log

```text
# illustrative study log entry
2026-10-14  exam-ai-fabric-2 (timed): 43/56 (77%)
  foundations 5/5  server 5/6  fabric 8/9  rdma 7/9  roce 7/11  collectives 6/8  ops 5/8
  misses: roce x4 (2 knowledge: headroom math, CNP priority; 2 misread: "NOT")
          ops x3 (time pressure on last 3 questions)
  actions: reread buffers-headroom-ets; 4 new cards; pace drill 1.5 min/question
```

> [!TIP]
> Teach to learn. Explaining PFC, DCQCN or the busbw formula to a colleague (or to an empty room) is
> one of the strongest forms of retrieval practice, and it doubles as interview preparation.

## Common pitfalls

- **Studying from a stale blueprint.** Symptom: unfamiliar topics on exam day. Cause: an old exam guide
  or a third-party summary. Fix: download the current guide from the official vendor page when you book,
  and check again a week before.
- **Trusting "exam dumps".** Symptom: memorised answers that do not transfer, and a possible violation of
  the candidate agreement. Cause: shortcuts. Fix: use original practice material, such as this academy's
  mock exams, and labs.
- **Re-reading instead of recalling.** Symptom: material feels familiar, scores do not improve. Fix:
  close the lesson and write or say what you remember; use flashcards and quizzes.
- **Cramming.** Symptom: good scores the day after study, poor scores a week later. Fix: spaced reviews
  over weeks.
- **Chasing the total score on mock exams.** Symptom: retaking the same mock until it shows 95%. Cause:
  answer memorisation. Fix: analyse domain scores and the error log; leave a week between attempts.
- **Ignoring units and qualifiers.** Symptom: "careless" misses on calculation and NOT questions. Fix:
  scratch paper with units; underline the question's qualifier.
- **Skipping hands-on practice.** Symptom: unable to recognise real tool output in scenario questions.
  Fix: run the commands in this academy's labs until the output looks familiar.

## Key takeaways

- Certification details change: confirm the current track, code, blueprint and format on the official
  NVIDIA certification pages before you plan or book.
- The blueprint is the syllabus; map each topic to lessons and weight study time by blueprint weight and
  your weakness.
- Retrieval practice plus spacing (spaced repetition) is the most efficient way to retain counters,
  formulas and mechanisms.
- Use the three mock exams diagnostically: timed attempt, full review including correct answers, error
  log by cause, targeted action, retake after a gap.
- On scenario questions: read the ask first, translate output into a sentence, eliminate with reasons,
  and watch scope words and units.
- Original practice and hands-on labs transfer to real work; memorised dumps do not.
