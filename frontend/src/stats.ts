import type { ContentIndex, LessonMeta, Module } from './types';
import type { Progress } from './progress';

/** A lesson counts as mastered when it is read and its quiz is passed. */
export const lessonDone = (p: Progress, l: LessonMeta) => !!p.lessons[l.id] && !!p.quizzes[l.quiz]?.passed;

export function moduleStats(ix: ContentIndex, p: Progress, m: Module) {
  const lessons = m.lessons.map((id) => ix.lessons.find((l) => l.id === id)).filter((l): l is LessonMeta => !!l);
  const read = lessons.filter((l) => p.lessons[l.id]).length;
  const passed = lessons.filter((l) => p.quizzes[l.quiz]?.passed).length;
  const done = lessons.filter((l) => lessonDone(p, l)).length;
  const minutes = lessons.reduce((s, l) => s + (l.minutes ?? 0), 0);
  return { lessons, read, passed, done, total: lessons.length, pct: lessons.length ? (100 * (read + passed)) / (2 * lessons.length) : 0, minutes };
}

export function overall(ix: ContentIndex, p: Progress) {
  const total = ix.lessons.length;
  const read = ix.lessons.filter((l) => p.lessons[l.id]).length;
  const passed = ix.lessons.filter((l) => p.quizzes[l.quiz]?.passed).length;
  const labsSolved = ix.labs.filter((l) => p.labs[l.id]?.solved).length;
  const examsPassed = new Set(p.exams.filter((e) => e.passed).map((e) => e.exam)).size;
  const pct = total ? (100 * (read + passed)) / (2 * total) : 0;
  return { total, read, passed, labsSolved, labsTotal: ix.labs.length, examsPassed, examsTotal: ix.exams.length, pct };
}

/** The first lesson in curriculum order that is not mastered yet. */
export function nextLesson(ix: ContentIndex, p: Progress): LessonMeta | undefined {
  for (const m of ix.modules) for (const id of m.lessons) {
    const l = ix.lessons.find((x) => x.id === id);
    if (l && !lessonDone(p, l)) return l;
  }
  return undefined;
}

export const RANKS = [
  { min: 0, title: 'Packet Padawan' },
  { min: 15, title: 'Frame Forwarder' },
  { min: 35, title: 'Queue Pair Practitioner' },
  { min: 60, title: 'Lossless Engineer' },
  { min: 85, title: 'Fabric Architect' },
  { min: 100, title: 'AI Networking Master' },
];
export const rankFor = (pct: number) => [...RANKS].reverse().find((r) => pct >= r.min)!;
