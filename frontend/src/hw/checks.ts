// Lab check results: JSON written by `aina-hw check <lab>` ("aina.hw.check/1"), or the raw PASS/FAIL
// output of any check.sh pasted into the page. Pure functions, unit-tested.
//
// Per-task progress (toolkit 1.1+): check scripts print `TASK: <n> <title>` before the checks of the lab's
// Task n, result lines carry `task`, and records carry a `tasks` summary. `aina-hw check LAB --task N`
// writes a single-task record (`only_task: N`) that never verifies the whole lab. Older records without
// any of this still parse; they just have no per-task view.
import type { TocEntry } from '../types';

export type CheckStatus = 'PASS' | 'FAIL' | 'WARN' | 'SKIP';
export interface CheckLine { status: CheckStatus; text: string; task?: number }
/** NONE: the task printed no PASS/FAIL/WARN/SKIP line (information only). NOTRUN: the script declared the
 *  task (`TASKS: 1 2 3`) but stopped before it, usually at failed prerequisites. */
export type TaskStatus = CheckStatus | 'NONE' | 'NOTRUN';
export interface TaskResult { n: number; title: string; status: TaskStatus; counts: Record<CheckStatus, number> }
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

/** Same rule as aina_hw.py: passed = at least one PASS, no FAIL (and a zero exit code when known). */
export const isPassed = (c: Record<CheckStatus, number>, exit?: number | null) => c.FAIL === 0 && c.PASS > 0 && (exit === undefined || exit === null || exit === 0);

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
  return {
    schema: CHECK_SCHEMA, toolkit: typeof o.toolkit === 'string' ? o.toolkit : undefined, lab: o.lab, host: typeof o.host === 'string' ? o.host : null,
    lab_name: typeof o.lab_name === 'string' ? o.lab_name : null, fabric: typeof o.fabric === 'string' ? o.fabric : null,
    started: typeof o.started === 'string' ? o.started : undefined, finished: typeof o.finished === 'string' ? o.finished : new Date().toISOString(),
    duration_s: typeof o.duration_s === 'number' ? o.duration_s : undefined, exit_code: exit,
    // Recomputed rather than trusted, so a hand-edited "passed": true does not count; one task never verifies a lab.
    passed: only === null && isPassed(counts, exit), counts, results, tasks: summarizeTasks(results, titles, declared), only_task: only, source: 'toolkit',
  };
}

export function fromPastedText(lab: string, text: string, now = new Date()): CheckRecord {
  const results = parseCheckLines(text);
  if (!results.length) throw new Error('No PASS:/FAIL:/WARN:/SKIP: lines found in the pasted text');
  const counts = countLines(results);
  return { schema: CHECK_SCHEMA, lab, host: null, finished: now.toISOString(), passed: isPassed(counts), counts, results, tasks: summarizeTasks(results, parseTaskMarkers(text), parseDeclaredTasks(text)), only_task: null, source: 'pasted' };
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
