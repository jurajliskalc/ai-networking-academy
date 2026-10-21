import { describe, expect, it } from 'vitest';
import { emptyProgress, isCorrect, recordQuiz, review, sanitize, streak } from '../src/progress';

describe('progress', () => {
  it('scores multi-answer questions only on an exact match', () => {
    const opts = [{ id: 'a', correct: true }, { id: 'b', correct: true }, { id: 'c' }];
    expect(isCorrect(opts, ['a', 'b'])).toBe(true);
    expect(isCorrect(opts, ['a'])).toBe(false);
    expect(isCorrect(opts, ['a', 'b', 'c'])).toBe(false);
  });
  it('keeps the best quiz score and the passed flag', () => {
    let p = recordQuiz(emptyProgress(), 'quiz-x', 80, 70);
    p = recordQuiz(p, 'quiz-x', 50, 70);
    expect(p.quizzes['quiz-x']).toMatchObject({ best: 80, last: 50, attempts: 2, passed: true });
  });
  it('counts a streak ending today or yesterday', () => {
    const now = new Date('2026-10-22T12:00:00Z');
    expect(streak({ '2026-10-22': 1, '2026-10-21': 2, '2026-10-19': 1 }, now)).toBe(2);
    expect(streak({ '2026-10-21': 1, '2026-10-20': 1 }, now)).toBe(2);
    expect(streak({ '2026-10-19': 1 }, now)).toBe(0);
  });
  it('implements SM-2 intervals', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    let c = review(undefined, 5, now);
    expect(c.interval).toBe(1);
    c = review(c, 5, now);
    expect(c.interval).toBe(6);
    c = review(c, 4, now);
    expect(c.interval).toBeGreaterThanOrEqual(15);
    expect(review(c, 1, now).interval).toBe(1);
  });
  it('sanitizes garbage imports', () => {
    expect(sanitize('nope')).toEqual(emptyProgress());
    expect(sanitize({ lessons: [], settings: { theme: 'neon' } }).settings.theme).toBe('system');
  });
});

describe('option shuffle', () => {
  it('is deterministic per seed, a permutation, and does not keep "a" first', async () => {
    const { shuffleOptions } = await import('../src/components/QuestionCard');
    const opts = ['a', 'b', 'c', 'd'].map((id) => ({ id, text: id, explanation: id, correct: id === 'a' }));
    expect(shuffleOptions(opts, 's1').map((o) => o.id)).toEqual(shuffleOptions(opts, 's1').map((o) => o.id));
    expect(shuffleOptions(opts, 's1').map((o) => o.id).sort()).toEqual(['a', 'b', 'c', 'd']);
    const firstIsA = Array.from({ length: 400 }, (_, i) => shuffleOptions(opts, `q${i}`)[0].id === 'a').filter(Boolean).length;
    expect(firstIsA).toBeGreaterThan(60);
    expect(firstIsA).toBeLessThan(140);
  });
});
