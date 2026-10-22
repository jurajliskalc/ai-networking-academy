import { useEffect, useState } from 'react';
import type { ContentIndex, Exam, Quiz } from './types';

// Content is compiled to static JSON by scripts/build-content.mjs and fetched relative to the page,
// so the app works from any base path (GitHub Pages project sites included).
const cache = new Map<string, Promise<unknown>>();

export function fetchJson<T>(rel: string): Promise<T> {
  if (!cache.has(rel)) {
    cache.set(
      rel,
      fetch(`./content/${rel}`).then((r) => {
        if (!r.ok) throw new Error(`${r.status} loading ${rel}`);
        return r.json();
      }).catch((e) => {
        cache.delete(rel);
        throw e;
      }),
    );
  }
  return cache.get(rel) as Promise<T>;
}

export function useJson<T>(rel: string | null): { data: T | null; error: string | null } {
  const [state, setState] = useState<{ rel: string | null; data: T | null; error: string | null }>({ rel: null, data: null, error: null });
  useEffect(() => {
    if (!rel) return;
    let alive = true;
    fetchJson<T>(rel).then(
      (data) => alive && setState({ rel, data, error: null }),
      (e: Error) => alive && setState({ rel, data: null, error: e.message }),
    );
    return () => {
      alive = false;
    };
  }, [rel]);
  return state.rel === rel ? { data: state.data, error: state.error } : { data: null, error: null };
}

export const useIndex = () => useJson<ContentIndex>('index.json');
export const useLessonBody = (id: string) => useJson<{ id: string; body: string; minutes: number }>(`lessons/${id}.json`);
export const useQuiz = (id: string) => useJson<Quiz>(`quizzes/${id}.json`);
export const useExam = (id: string) => useJson<Exam>(`exams/${id}.json`);
export const useLabBody = (id: string) => useJson<{ id: string; body: string }>(`labs/${id}.json`);
export const useGuideBody = (id: string | null) => useJson<{ id: string; body: string }>(id ? `hardware/${id}.json` : null);

/** Simulator labs live under /labs, everything that runs on the learner's own machines under /hw/labs. */
export const labPath = (lab: { id: string; kind: string } | string) =>
  typeof lab === 'string' ? (lab.startsWith('sim-') ? `/labs/${lab}` : `/hw/labs/${lab}`) : lab.kind === 'sim' ? `/labs/${lab.id}` : `/hw/labs/${lab.id}`;

export const LEVELS: Record<number, { name: string; label: string }> = {
  1: { name: 'Beginner', label: 'L1 · Beginner' },
  2: { name: 'Practitioner', label: 'L2 · Practitioner' },
  3: { name: 'Engineer', label: 'L3 · Engineer' },
  4: { name: 'Master', label: 'L4 · Master' },
};

export const slug = (s: string) =>
  s.toLowerCase().replace(/<[^>]+>/g, '').replace(/[`*_]/g, '').replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
