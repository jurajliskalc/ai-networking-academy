// Learner progress. Everything stays in the browser (localStorage); export/import moves it between
// machines. Pure functions live here so they can be unit tested; the React binding is in store.tsx.

export const STORAGE_KEY = 'aina.progress.v1';

export interface QuizRecord { best: number; last: number; attempts: number; passed: boolean; at: string }
/** `evidence` is set when a hardware lab was verified by an imported check result (aina-hw check). */
export interface LabEvidence { host: string | null; finished: string; pass: number; warn: number; source: 'toolkit' | 'pasted' }
export interface LabRecord { solved: boolean; diagnosisCorrect: boolean; attempts: number; hintsUsed: number; at: string; evidence?: LabEvidence }
export interface ExamAttempt { exam: string; score: number; passed: boolean; at: string; seconds: number; byDomain: Record<string, [number, number]> }
export interface Card { ef: number; interval: number; reps: number; due: string }
export type Theme = 'system' | 'light' | 'dark';

export interface Progress {
  version: 1;
  lessons: Record<string, string>; // lesson id -> completed at (ISO)
  quizzes: Record<string, QuizRecord>;
  labs: Record<string, LabRecord>;
  exams: ExamAttempt[];
  cards: Record<string, Card>; // glossary term -> SM-2 state
  activity: Record<string, number>; // YYYY-MM-DD -> actions that day
  settings: { theme: Theme };
}

export const emptyProgress = (): Progress => ({
  version: 1, lessons: {}, quizzes: {}, labs: {}, exams: [], cards: {}, activity: {}, settings: { theme: 'system' },
});

export function sanitize(raw: unknown): Progress {
  const base = emptyProgress();
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Partial<Progress>;
  const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  return {
    version: 1,
    lessons: obj(r.lessons) as Progress['lessons'],
    quizzes: obj(r.quizzes) as Progress['quizzes'],
    labs: obj(r.labs) as Progress['labs'],
    exams: Array.isArray(r.exams) ? r.exams : [],
    cards: obj(r.cards) as Progress['cards'],
    activity: obj(r.activity) as Progress['activity'],
    settings: { theme: ['system', 'light', 'dark'].includes(r.settings?.theme as string) ? (r.settings!.theme as Theme) : 'system' },
  };
}

export const today = (d = new Date()) => d.toISOString().slice(0, 10);

export function bump(p: Progress, d = new Date()): Progress {
  const k = today(d);
  return { ...p, activity: { ...p.activity, [k]: (p.activity[k] ?? 0) + 1 } };
}

/** Consecutive days with activity, ending today or yesterday. */
export function streak(activity: Record<string, number>, now = new Date()): number {
  let n = 0;
  const d = new Date(now);
  if (!activity[today(d)]) d.setUTCDate(d.getUTCDate() - 1);
  while (activity[today(d)]) {
    n++;
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return n;
}

export function recordQuiz(p: Progress, id: string, pct: number, passPct: number, d = new Date()): Progress {
  const prev = p.quizzes[id];
  const rec: QuizRecord = {
    best: Math.max(prev?.best ?? 0, pct), last: pct, attempts: (prev?.attempts ?? 0) + 1,
    passed: (prev?.passed ?? false) || pct >= passPct, at: d.toISOString(),
  };
  return bump({ ...p, quizzes: { ...p.quizzes, [id]: rec } }, d);
}

/** Record an imported hardware-lab check. A passing check marks the lab solved with evidence; a failing one
 *  only counts as an attempt (it never un-solves a lab). */
export function recordHwCheck(p: Progress, lab: string, rec: { passed: boolean; host: string | null; finished: string; counts: { PASS: number; WARN: number }; source: 'toolkit' | 'pasted' }, d = new Date()): Progress {
  const prev = p.labs[lab];
  if (prev?.evidence?.finished === rec.finished && prev.evidence.host === rec.host) return p;
  const evidence: LabEvidence | undefined = rec.passed ? { host: rec.host, finished: rec.finished, pass: rec.counts.PASS, warn: rec.counts.WARN, source: rec.source } : prev?.evidence;
  return bump({
    ...p,
    labs: { ...p.labs, [lab]: { solved: (prev?.solved ?? false) || rec.passed, diagnosisCorrect: true, attempts: (prev?.attempts ?? 0) + 1, hintsUsed: 0, at: d.toISOString(), ...(evidence ? { evidence } : {}) } },
  }, d);
}

/** Score a question: full credit only for exactly the correct set. */
export function isCorrect(options: { id: string; correct?: boolean }[], chosen: string[]): boolean {
  const want = options.filter((o) => o.correct).map((o) => o.id).sort();
  const got = [...new Set(chosen)].sort();
  return want.length === got.length && want.every((v, i) => v === got[i]);
}

/** SM-2 spaced repetition. grade: 0 (forgot) .. 5 (perfect). */
export function review(card: Card | undefined, grade: number, now = new Date()): Card {
  const c = card ?? { ef: 2.5, interval: 0, reps: 0, due: now.toISOString() };
  let { ef, interval, reps } = c;
  if (grade < 3) {
    reps = 0;
    interval = 1;
  } else {
    reps += 1;
    interval = reps === 1 ? 1 : reps === 2 ? 6 : Math.round(interval * ef);
  }
  ef = Math.max(1.3, ef + (0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02)));
  const due = new Date(now);
  due.setUTCDate(due.getUTCDate() + interval);
  return { ef: Math.round(ef * 100) / 100, interval, reps, due: due.toISOString() };
}

export const isDue = (card: Card | undefined, now = new Date()) => !card || new Date(card.due) <= now;
