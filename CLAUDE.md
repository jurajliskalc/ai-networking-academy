# CLAUDE.md: AI Networking Academy

Static, browser-only training platform for AI cluster networking (RDMA, InfiniBand, RoCEv2, lossless
Ethernet, NCCL, rail-optimized fabrics). Read `NEXT_STEPS.md` first, then `docs/ARCHITECTURE.md`.

## Layout
`content/` (lessons, quizzes, labs, exams, commands, glossary) · `frontend/` (React/TS/Vite/Tailwind;
`scripts/build-content.mjs` validates and compiles content; `src/sim/` is the Fabric Simulator) ·
`labs/` (hands-on lab files) · `docs/` · `scripts/` (launchers).

## Rules
- Technical accuracy first. Never invent CLI flags, counters, env vars or APIs; hedge vendor/version
  specifics; label sample output as illustrative; never present practice questions as real exam questions.
- Content follows `docs/AUTHORING.md`; simulator labs follow `docs/SIMULATOR.md`. IDs are permanent.
- Never claim a hands-on lab works end to end unless it was run; keep `verified: false` until then.
- Node is portable: prefix PATH with `.tools/node` (PowerShell: `$env:PATH="$PWD\.tools\node;$env:PATH"`).

## Required checks before finishing work
```bash
cd frontend
npm run validate   # must print "Content OK"
npm test           # all tests pass (includes replaying every sim lab's fix)
npm run build      # tsc + vite build
for f in ../labs/**/*.sh ../scripts/*.sh; do bash -n "$f"; done
```
Update `IMPLEMENTATION_STATUS.md` / `NEXT_STEPS.md` when status changes.

## Gotchas
- New widgets need a file in `frontend/src/widgets/`, an entry in `registry.tsx` and the ID in the
  `WIDGETS` list of `build-content.mjs` (and in `docs/CURRICULUM_PLAN.md`).
- New sim fault types or checks go in `src/sim/fabric.ts` (`FAULT_TYPES`, `CHECKS`) and `docs/SIMULATOR.md`.
- `frontend/public/content/` is generated; never edit it.
- vitest 2 bundles its own vite; keep test config in `vitest.config.ts`, not `vite.config.ts`.
