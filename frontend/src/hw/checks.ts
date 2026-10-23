// Lab check results: JSON written by `aina-hw check <lab>` ("aina.hw.check/1"), or the raw PASS/FAIL
// output of any check.sh pasted into the page. Pure functions, unit-tested.
//
// Per-task progress (toolkit 1.1+): check scripts print `TASK: <n> <title>` before the checks of the lab's
// Task n, result lines carry `task`, and records carry a `tasks` summary. `aina-hw check LAB --task N`
// writes a single-task record (`only_task: N`) that never verifies the whole lab. Older records without
// any of this still parse; they just have no per-task view.
//
// Grading (toolkit 1.2+): scripts declare required measurements (`REQUIRE: <task> <key> <what>`), report them
// made (`MET: <key>`) and report performance targets (`PERF: <key> ok|low`). `passed` (the lab is verified)
// needs the verdict PASSED: no failure, every requirement met, no declared task left unrun, nothing below target.
import type { TocEntry } from '../types';

export type CheckStatus = 'PASS' | 'FAIL' | 'WARN' | 'SKIP';
export interface CheckLine { status: CheckStatus; text: string; task?: number }
/** NONE: the task printed no PASS/FAIL/WARN/SKIP line (information only). NOTRUN: the script declared the
 *  task (`TASKS: 1 2 3`) but stopped before it, usually at failed prerequisites. */
export type TaskStatus = CheckStatus | 'NONE' | 'NOTRUN';
export interface TaskResult { n: number; title: string; status: TaskStatus; counts: Record<CheckStatus, number> }
export interface Requirement { task: number; key: string; text: string }
export type Verdict = 'PASSED' | 'FAILED' | 'INCONCLUSIVE' | 'BELOW_TARGET';
export interface Grade { functional: boolean; complete: boolean; performance: 'ok' | 'low' | null; missing: string[]; notrun: number[]; verdict: Verdict }
export interface CheckRecord {
  schema: string; toolkit?: string; lab: string; host: string | null; lab_name?: string | null; fabric?: string | null;
  started?: string; finished: string; duration_s?: number; exit_code?: number | null; passed: boolean;
  counts: Record<CheckStatus, number>; results: CheckLine[];
  /** Per-task summary, recomputed from the result lines; empty for scripts without TASK markers. */
  tasks: TaskResult[];
  /** Set for `aina-hw check LAB --task N`: only that task (and the prerequisites) ran. */
  only_task: number | null;
  /** 'toolkit' when produced by aina-hw, 'pasted' when parsed from text in the browser. */
  source: 'toolkit' | 'pasted';
  required: Requirement[]; met: string[]; perf: Record<string, 'ok' | 'low'>;
  /** Recomputed by gradeCheck, never read from the file. */
  verdict: Verdict; functional: boolean; complete: boolean; performance: 'ok' | 'low' | null; missing: string[]; notrun: number[];
}

export const CHECK_SCHEMA = 'aina.hw.check/1';
const STATUSES: CheckStatus[] = ['PASS', 'FAIL', 'WARN', 'SKIP'];

/** Result lines; `TASK: n title` markers set `task` on the lines that follow (lines before the first have none). */
export function parseCheckLines(text: string): CheckLine[] {
  const out: CheckLine[] = [];
  let task: number | undefined;
  for (const line of text.split(/\r?\n/)) {
    const t = line.match(/^\s*TASK:\s*(\d+)\b/);
    if (t) {
      task = Number(t[1]);
      continue;
    }
    const m = line.match(/^\s*(PASS|FAIL|WARN|SKIP):\s?(.*)$/);
    if (m) out.push({ status: m[1] as CheckStatus, text: m[2].trim(), ...(task !== undefined ? { task } : {}) });
  }
  return out;
}

/** `TASK: 3 PFC on priority 3` -> Map {3 => 'PFC on priority 3'} (first title per number). */
export function parseTaskMarkers(text: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of text.split(/\r?\n/)) {
    const t = line.match(/^\s*TASK:\s*(\d+)\s*(.*)$/);
    if (t && !out.has(Number(t[1]))) out.set(Number(t[1]), t[2].trim());
  }
  return out;
}

export function countLines(results: CheckLine[]): Record<CheckStatus, number> {
  const c: Record<CheckStatus, number> = { PASS: 0, FAIL: 0, WARN: 0, SKIP: 0 };
  for (const r of results) c[r.status]++;
  return c;
}

/** Same rule as aina_hw.task_status: FAIL wins, then PASS (warnings allowed), then WARN, SKIP, NONE. */
export function taskStatus(c: Record<CheckStatus, number>): TaskStatus {
  return c.FAIL ? 'FAIL' : c.PASS ? 'PASS' : c.WARN ? 'WARN' : c.SKIP ? 'SKIP' : 'NONE';
}

/** `TASKS: 1 2 3 5 8` (lib.sh aina_tasks): the lab tasks a script covers. */
export function parseDeclaredTasks(text: string): number[] {
  const m = text.match(/^\s*TASKS:\s*([\d\s]+)$/m);
  return m ? [...new Set(m[1].trim().split(/\s+/).map(Number))].sort((a, b) => a - b) : [];
}

/** Same as aina_hw.summarize_tasks: task 0 ("Before you start") holds the lines before the first marker;
 *  declared tasks that never started are NOTRUN. */
export function summarizeTasks(results: CheckLine[], titles: Map<number, string>, declared: number[] = []): TaskResult[] {
  const used = new Set(results.filter((r) => r.task !== undefined).map((r) => r.task!));
  if (!titles.size && !used.size && !declared.length) return [];
  const t = new Map(titles);
  const pre = results.some((r) => r.task === undefined);
  if (pre && !t.has(0)) t.set(0, 'Before you start');
  const nums = [...new Set([...t.keys(), ...used, ...declared])].sort((a, b) => a - b);
  return nums.map((n) => {
    const mine = results.filter((r) => (r.task ?? 0) === n);
    const counts = countLines(mine);
    const started = n === 0 || t.has(n) || mine.length > 0;
    return { n, title: t.get(n) ?? '', status: started ? taskStatus(counts) : 'NOTRUN', counts };
  });
}

/** The functional rule: at least one PASS, no FAIL, and a zero exit code when known. Not enough to verify a lab. */
export const isPassed = (c: Record<CheckStatus, number>, exit?: number | null) => c.FAIL === 0 && c.PASS > 0 && (exit === undefined || exit === null || exit === 0);

const KEY = '[A-Za-z0-9_.-]+';
const REQ_RE = new RegExp(`^\\s*REQUIRE:\\s*(\\d+)\\s+(${KEY})\\s*(.*)$`);
const MET_RE = new RegExp(`^\\s*MET:\\s*(${KEY})\\s*$`);
const PERF_RE = new RegExp(`^\\s*PERF:\\s*(${KEY})\\s+(ok|low)\\s*$`);
const KEY_RE = new RegExp(`^${KEY}$`);

/** `REQUIRE: 4 bw RDMA bandwidth measured` lines (lib.sh require), first per key. */
export function parseRequirements(text: string): Requirement[] {
  const out: Requirement[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(REQ_RE);
    if (m && !out.some((r) => r.key === m[2])) out.push({ task: Number(m[1]), key: m[2], text: m[3].trim() });
  }
  return out;
}

/** `MET: bw` lines (lib.sh met), sorted and unique. */
export const parseMet = (text: string) =>
  [...new Set(text.split(/\r?\n/).map((l) => l.match(MET_RE)?.[1]).filter((k): k is string => !!k))].sort();

/** `PERF: bw ok|low` lines; one low result makes the key low. */
export function parsePerf(text: string): Record<string, 'ok' | 'low'> {
  const out: Record<string, 'ok' | 'low'> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(PERF_RE);
    if (m && out[m[1]] !== 'low') out[m[1]] = m[2] as 'ok' | 'low';
  }
  return out;
}

/** Same as aina_hw.grade_check: functional, complete (requirements met, no declared task unrun), performance,
 *  then one verdict. A single-task run owes only its own task's and the prerequisites' requirements. */
export function gradeCheck(counts: Record<CheckStatus, number>, exit: number | null | undefined, tasks: TaskResult[],
  required: Requirement[], met: string[], perf: Record<string, 'ok' | 'low'>, only: number | null = null): Grade {
  const functional = isPassed(counts, exit);
  const missing = required.filter((r) => only === null || r.task === 0 || r.task === only).map((r) => r.key).filter((k) => !met.includes(k));
  const notrun = only === null ? tasks.filter((t) => t.status === 'NOTRUN').map((t) => t.n) : [];
  const complete = functional && !missing.length && !notrun.length;
  const vals = Object.values(perf);
  const performance = vals.length ? (vals.includes('low') ? 'low' : 'ok') : null;
  const verdict: Verdict = !functional ? 'FAILED' : !complete ? 'INCONCLUSIVE' : performance === 'low' ? 'BELOW_TARGET' : 'PASSED';
  return { functional, complete, performance, missing, notrun, verdict };
}

export const VERDICT_LABEL: Record<Verdict, string> = { PASSED: 'Passed', FAILED: 'Not passed', INCONCLUSIVE: 'Inconclusive', BELOW_TARGET: 'Below target' };

/** Why a record is not verified, in one sentence (empty when it passed). */
export function verdictDetail(r: CheckRecord): string {
  if (r.verdict === 'FAILED') return r.counts.FAIL ? `${r.counts.FAIL} check(s) failed.` : 'No check passed.';
  if (r.verdict === 'INCONCLUSIVE') {
    const parts: string[] = [];
    if (r.missing.length) parts.push(`not measured: ${r.missing.map((k) => r.required.find((q) => q.key === k)?.text || k).join('; ')}`);
    if (r.notrun.length) parts.push(`task${r.notrun.length > 1 ? 's' : ''} ${r.notrun.join(', ')} not run`);
    return `Nothing failed, but the run is incomplete (${parts.join('; ')}).`;
  }
  if (r.verdict === 'BELOW_TARGET') return `Functional checks passed, but below the performance target: ${Object.keys(r.perf).filter((k) => r.perf[k] === 'low').join(', ')}.`;
  return '';
}

/** Re-grade a stored record (older ones have no requirements, tasks or verdict fields). */
export function regrade(r: CheckRecord): CheckRecord {
  return graded({ ...r, tasks: r.tasks ?? [], only_task: r.only_task ?? null, required: r.required ?? [], met: r.met ?? [], perf: r.perf ?? {} });
}

function graded(base: Omit<CheckRecord, 'passed' | keyof Grade>): CheckRecord {
  const g = gradeCheck(base.counts, base.exit_code, base.tasks, base.required, base.met, base.perf, base.only_task);
  return { ...base, ...g, passed: base.only_task === null && g.verdict === 'PASSED' };
}

export function parseCheckJson(json: unknown): CheckRecord {
  if (!json || typeof json !== 'object') throw new Error('Not a JSON object');
  const o = json as Record<string, unknown>;
  if (o.schema !== CHECK_SCHEMA) throw new Error(`Unknown schema ${JSON.stringify(o.schema)} (expected ${CHECK_SCHEMA})`);
  if (typeof o.lab !== 'string' || !Array.isArray(o.results)) throw new Error('Check result has no lab or results');
  const results = (o.results as unknown[]).filter((r): r is CheckLine => !!r && typeof r === 'object' && STATUSES.includes((r as CheckLine).status) && typeof (r as CheckLine).text === 'string')
    .map((r) => ({ status: r.status, text: r.text, ...(Number.isInteger(r.task) && r.task! >= 0 ? { task: r.task } : {}) }));
  const counts = countLines(results);
  const exit = typeof o.exit_code === 'number' ? o.exit_code : null;
  // Titles come from the file; statuses are recomputed from the lines, like `passed`.
  // A task the file calls NOTRUN stays "not run" only if no line belongs to it; it can never become a pass.
  const titles = new Map<number, string>();
  const declared: number[] = [];
  if (Array.isArray(o.tasks)) for (const t of o.tasks as { n?: unknown; title?: unknown; status?: unknown }[]) {
    if (!t || !Number.isInteger(t.n) || (t.n as number) < 0) continue;
    if (t.status === 'NOTRUN' && !results.some((r) => r.task === t.n)) declared.push(t.n as number);
    else titles.set(t.n as number, typeof t.title === 'string' ? t.title : '');
  }
  const only = Number.isInteger(o.only_task) && (o.only_task as number) >= 0 ? (o.only_task as number) : null;
  const required = Array.isArray(o.required)
    ? (o.required as Partial<Requirement>[]).filter((r) => !!r && Number.isInteger(r.task) && typeof r.key === 'string' && KEY_RE.test(r.key))
      .map((r) => ({ task: r.task!, key: r.key!, text: typeof r.text === 'string' ? r.text : '' }))
    : [];
  const met = Array.isArray(o.met) ? (o.met as unknown[]).filter((k): k is string => typeof k === 'string') : [];
  const perf: Record<string, 'ok' | 'low'> = {};
  if (o.perf && typeof o.perf === 'object') for (const [k, v] of Object.entries(o.perf as Record<string, unknown>)) if (v === 'ok' || v === 'low') perf[k] = v;
  return graded({
    schema: CHECK_SCHEMA, toolkit: typeof o.toolkit === 'string' ? o.toolkit : undefined, lab: o.lab, host: typeof o.host === 'string' ? o.host : null,
    lab_name: typeof o.lab_name === 'string' ? o.lab_name : null, fabric: typeof o.fabric === 'string' ? o.fabric : null,
    started: typeof o.started === 'string' ? o.started : undefined, finished: typeof o.finished === 'string' ? o.finished : new Date().toISOString(),
    duration_s: typeof o.duration_s === 'number' ? o.duration_s : undefined, exit_code: exit,
    // passed and the verdict are recomputed rather than trusted; one task never verifies a lab.
    counts, results, tasks: summarizeTasks(results, titles, declared), only_task: only, source: 'toolkit', required, met, perf,
  });
}

export function fromPastedText(lab: string, text: string, now = new Date()): CheckRecord {
  const results = parseCheckLines(text);
  if (!results.length) throw new Error('No PASS:/FAIL:/WARN:/SKIP: lines found in the pasted text');
  const counts = countLines(results);
  return graded({
    schema: CHECK_SCHEMA, lab, host: null, finished: now.toISOString(), counts, results,
    tasks: summarizeTasks(results, parseTaskMarkers(text), parseDeclaredTasks(text)), only_task: null, source: 'pasted',
    required: parseRequirements(text), met: parseMet(text), perf: parsePerf(text),
  });
}

/** Newest full run per lab. Single-task runs never replace a full run here (they go to mergeTasks). */
export function mergeChecks(existing: Record<string, CheckRecord>, incoming: CheckRecord[]): Record<string, CheckRecord> {
  const out = { ...existing };
  for (const r of incoming) if ((r.only_task ?? null) === null && (!out[r.lab] || r.finished >= out[r.lab].finished)) out[r.lab] = r;
  return out;
}

// ------------------------------------------------------------------ per-task progress

export interface TaskEntry extends TaskResult { finished: string; host: string | null; source: CheckRecord['source']; lines: CheckLine[]; partial: boolean }
/** Per lab: the newest full run's tasks, overlaid by newer single-task runs. */
export interface LabTasks { base: string | null; tasks: Record<string, TaskEntry> }

const entry = (r: CheckRecord, t: TaskResult): TaskEntry => ({ ...t, finished: r.finished, host: r.host, source: r.source, partial: r.only_task !== null, lines: r.results.filter((l) => (l.task ?? 0) === t.n) });

/** Fold records into per-task state. A newer full run replaces the lab's state (it re-checked everything it
 *  reached); a single-task run updates its task and the prerequisites when it is newer than what is there. */
export function mergeTasks(existing: Record<string, LabTasks>, incoming: CheckRecord[]): Record<string, LabTasks> {
  const out: Record<string, LabTasks> = { ...existing };
  for (const r of [...incoming].sort((a, b) => a.finished.localeCompare(b.finished))) {
    if (!r.tasks?.length) continue;
    const cur = out[r.lab];
    if (r.only_task === null) {
      if (cur?.base && r.finished < cur.base) continue;
      out[r.lab] = { base: r.finished, tasks: Object.fromEntries(r.tasks.map((t) => [String(t.n), entry(r, t)])) };
    } else {
      if (cur?.base && r.finished < cur.base) continue;
      const tasks = { ...(cur?.tasks ?? {}) };
      for (const t of r.tasks) if (!tasks[t.n] || r.finished >= tasks[t.n].finished) tasks[t.n] = entry(r, t);
      out[r.lab] = { base: cur?.base ?? null, tasks };
    }
  }
  return out;
}

export type TaskViewStatus = TaskStatus | 'unchecked' | 'notrun' | 'unknown';
export interface TaskView { n: number; title: string; status: TaskViewStatus; entry?: TaskEntry }

/** "Task 5 (optional): the vendor view" -> {n: 5, title: 'the vendor view'} */
export function tocTasks(toc: TocEntry[]): { n: number; title: string }[] {
  const out: { n: number; title: string }[] = [];
  for (const t of toc) {
    const m = t.text.match(/^Task\s+(\d+)\b[^:]*:\s*(.*)$/);
    if (m && !out.some((x) => x.n === Number(m[1]))) out.push({ n: Number(m[1]), title: m[2].trim() });
  }
  return out;
}

/** The lab's tasks with their latest check status and where to resume (null: nothing failed or not run). */
export function taskView(toc: TocEntry[], lt: LabTasks | undefined): { pre: TaskEntry | null; items: TaskView[]; resume: number | null; any: boolean } {
  const pre = lt?.tasks['0'] ?? null;
  const blocked = pre?.status === 'FAIL';
  const items = tocTasks(toc).map(({ n, title }): TaskView => {
    const e = lt?.tasks[String(n)];
    return { n, title, status: e ? (e.status === 'NOTRUN' ? 'notrun' : e.status) : !lt ? 'unknown' : blocked ? 'notrun' : 'unchecked', entry: e };
  });
  const resume = blocked ? 0 : items.find((i) => i.status === 'FAIL' || i.status === 'notrun')?.n ?? null;
  return { pre, items, resume, any: !!lt && Object.keys(lt.tasks).length > 0 };
}
