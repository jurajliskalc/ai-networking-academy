// Lab check results: JSON written by `aina-hw check <lab>` ("aina.hw.check/1"), or the raw PASS/FAIL
// output of any check.sh pasted into the page. Pure functions, unit-tested.

export type CheckStatus = 'PASS' | 'FAIL' | 'WARN' | 'SKIP';
export interface CheckLine { status: CheckStatus; text: string }
export interface CheckRecord {
  schema: string; toolkit?: string; lab: string; host: string | null; lab_name?: string | null; fabric?: string | null;
  started?: string; finished: string; duration_s?: number; exit_code?: number | null; passed: boolean;
  counts: Record<CheckStatus, number>; results: CheckLine[];
  /** 'toolkit' when produced by aina-hw, 'pasted' when parsed from text in the browser. */
  source: 'toolkit' | 'pasted';
}

export const CHECK_SCHEMA = 'aina.hw.check/1';

export function parseCheckLines(text: string): CheckLine[] {
  const out: CheckLine[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(PASS|FAIL|WARN|SKIP):\s?(.*)$/);
    if (m) out.push({ status: m[1] as CheckStatus, text: m[2].trim() });
  }
  return out;
}

export function countLines(results: CheckLine[]): Record<CheckStatus, number> {
  const c: Record<CheckStatus, number> = { PASS: 0, FAIL: 0, WARN: 0, SKIP: 0 };
  for (const r of results) c[r.status]++;
  return c;
}

/** Same rule as aina_hw.py: passed = at least one PASS, no FAIL (and a zero exit code when known). */
export const isPassed = (c: Record<CheckStatus, number>, exit?: number | null) => c.FAIL === 0 && c.PASS > 0 && (exit === undefined || exit === null || exit === 0);

export function parseCheckJson(json: unknown): CheckRecord {
  if (!json || typeof json !== 'object') throw new Error('Not a JSON object');
  const o = json as Record<string, unknown>;
  if (o.schema !== CHECK_SCHEMA) throw new Error(`Unknown schema ${JSON.stringify(o.schema)} (expected ${CHECK_SCHEMA})`);
  if (typeof o.lab !== 'string' || !Array.isArray(o.results)) throw new Error('Check result has no lab or results');
  const results = (o.results as unknown[]).filter((r): r is CheckLine => !!r && typeof r === 'object' && ['PASS', 'FAIL', 'WARN', 'SKIP'].includes((r as CheckLine).status) && typeof (r as CheckLine).text === 'string');
  const counts = countLines(results);
  const exit = typeof o.exit_code === 'number' ? o.exit_code : null;
  return {
    schema: CHECK_SCHEMA, toolkit: typeof o.toolkit === 'string' ? o.toolkit : undefined, lab: o.lab, host: typeof o.host === 'string' ? o.host : null,
    lab_name: typeof o.lab_name === 'string' ? o.lab_name : null, fabric: typeof o.fabric === 'string' ? o.fabric : null,
    started: typeof o.started === 'string' ? o.started : undefined, finished: typeof o.finished === 'string' ? o.finished : new Date().toISOString(),
    duration_s: typeof o.duration_s === 'number' ? o.duration_s : undefined, exit_code: exit,
    // Recomputed rather than trusted, so a hand-edited "passed": true does not count.
    passed: isPassed(counts, exit), counts, results, source: 'toolkit',
  };
}

export function fromPastedText(lab: string, text: string, now = new Date()): CheckRecord {
  const results = parseCheckLines(text);
  if (!results.length) throw new Error('No PASS:/FAIL:/WARN:/SKIP: lines found in the pasted text');
  const counts = countLines(results);
  return { schema: CHECK_SCHEMA, lab, host: null, finished: now.toISOString(), passed: isPassed(counts), counts, results, source: 'pasted' };
}

/** Newest record per lab. */
export function mergeChecks(existing: Record<string, CheckRecord>, incoming: CheckRecord[]): Record<string, CheckRecord> {
  const out = { ...existing };
  for (const r of incoming) if (!out[r.lab] || r.finished >= out[r.lab].finished) out[r.lab] = r;
  return out;
}
