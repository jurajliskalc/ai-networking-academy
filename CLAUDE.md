# CLAUDE.md: AI Networking Academy

Working rules for AI coding agents in this repository. Static, browser-only training platform for AI
cluster networking (RDMA, InfiniBand, RoCEv2, lossless Ethernet, NCCL, rail-optimized fabrics). Read
`ROADMAP.md` first, then `docs/ARCHITECTURE.md`.

## Layout
`content/` (lessons, quizzes, labs, exams, commands, glossary) · `frontend/` (React/TS/Vite/Tailwind;
`scripts/build-content.mjs` validates and compiles content; `src/sim/` is the Fabric Simulator) ·
`labs/` (hands-on lab files) · `docs/` · `scripts/` (launchers).

## Rules
- Treat your own output as untrusted until it has passed the checks below. A claim is kept only if a
  primary source, a test, a recomputation or a run on real hardware supports it.
- Technical accuracy first. Never invent CLI flags, counters, env vars or APIs; hedge vendor/version
  specifics; label sample output as illustrative; never present practice questions as real exam questions.
- Content follows `docs/AUTHORING.md`; simulator labs follow `docs/SIMULATOR.md`. IDs are permanent.
- Host-tool output and behaviour (in content and the simulator) must match `docs/HARDWARE_VERIFICATION.md`.
- Never claim a hands-on lab works end to end unless it was run; keep `verified: false` until then.
- One observation on the reference hardware is an observation on that hardware, not vendor behaviour in
  general: say what it was seen on.
- Say who reviewed what. A review by an agent is an "AI review pass", never a "reviewer" that could be read
  as a person. Do not write that a human reviewed something unless a human did.
- Node is portable: prefix PATH with `.tools/node` (PowerShell: `$env:PATH="$PWD\.tools\node;$env:PATH"`).

## Required checks before finishing work
```bash
cd frontend
npm run validate   # must print "Content OK"
npm test           # all tests pass (replays every sim lab's fix; checks the counts the docs advertise)
npm run build      # tsc + vite build
npm run e2e        # Playwright browser tests against dist/ (installed Chrome; after build)
for f in ../labs/**/*.sh ../scripts/*.sh; do bash -n "$f"; done
```
Update `IMPLEMENTATION_STATUS.md`, `ROADMAP.md` and `CHANGELOG.md` when status changes.

## Gotchas
- New widgets need a file in `frontend/src/widgets/`, an entry in `registry.tsx` and the ID in the
  `WIDGETS` list of `build-content.mjs` (and in `docs/CURRICULUM_PLAN.md`).
- New sim fault types or checks go in `src/sim/fabric.ts` (`FAULT_TYPES`, `CHECKS`) and `docs/SIMULATOR.md`.
- `frontend/public/content/` is generated; never edit it.
- Counts in `README.md` and the other docs listed in `frontend/scripts/doc-stats.mjs` must equal
  `npm run stats` (`build-content.mjs --stats`). Adding a lesson, lab, question, widget or command means
  updating those docs; `tests/doc-stats.test.ts` fails otherwise. Never type a count from memory.
- `docs/PORTFOLIO_TOUR.md` is a picture-led highlights page: keep it short and non-technical. It holds a
  command walkthrough of `sim-03` that `tests/portfolio-tour.test.ts` replays; change the lab and the page
  together.
- Images in the README and the tour are generated: `npm run build && npm run screenshots`; the animations
  with `npm run tour-gif` (needs Python with Pillow). Regenerate both when a page they show changes.
- A `further_reading` link on a new host must be classified in `frontend/scripts/source-kinds.mjs`.
- Captures committed to the repository carry placeholder GUIDs and MACs and no serial numbers.
- vitest 2 bundles its own vite; keep test config in `vitest.config.ts`, not `vite.config.ts`.
- Browser tests are Playwright (`frontend/e2e/*.spec.ts`, `playwright.config.ts`), not vitest. They use the
  installed Chrome; install with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`. Select by role, label or text.
