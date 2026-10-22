import { choose, content, expect, progressOf, scoreLocator, test, type Q } from './fixtures';

interface Exam { id: string; title: string; duration_minutes: number; pass_pct: number; domains: { id: string; title: string }[]; questions: Q[] }
const exam = content<Exam>('exams/exam-ai-fabric-1.json');
const n = exam.questions.length;
const correct = (q: Q) => q.options.filter((o) => o.correct);

function expectedByDomain(answeredRight: Set<string>) {
  const by: Record<string, [number, number]> = {};
  for (const q of exam.questions) {
    const d = q.domain ?? 'other';
    by[d] = [(by[d]?.[0] ?? 0) + (answeredRight.has(q.id) ? 1 : 0), (by[d]?.[1] ?? 0) + 1];
  }
  return by;
}

test('mock exam: answer some, flag, jump, submit, per-domain results are shown and stored', async ({ page }) => {
  await page.goto(`#/exams/${exam.id}`);
  await expect(page.getByText(`${n} questions`, { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Begin', exact: true }).click();
  await expect(page.getByText(`${exam.duration_minutes}:00`)).toBeVisible();

  // Answer the first five correctly, using Next.
  const right = new Set<string>();
  for (let k = 0; k < 5; k++) {
    const q = exam.questions[k];
    await expect(page.getByText(`Question ${k + 1} / ${n}`)).toBeVisible();
    for (const o of correct(q)) await choose(page, o.text);
    right.add(q.id);
    await page.getByRole('button', { name: 'Next', exact: true }).click();
  }
  await expect(page.getByText(`5/${n}`, { exact: true })).toBeVisible();

  // Flag question 6, then jump to the last question with the grid and answer it wrong.
  await page.getByRole('button', { name: 'Flag', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Flagged', exact: true })).toBeVisible();
  // Grid buttons are named "Question <k>, <answered|unanswered>[, flagged]".
  await page.getByRole('navigation', { name: 'Jump to question' }).getByRole('button', { name: new RegExp(`^Question ${n},`) }).click();
  await expect(page.getByText(`Question ${n} / ${n}`)).toBeVisible();
  const last = exam.questions[n - 1];
  await choose(page, last.options.find((o) => !o.correct)!.text);
  await expect(page.getByText(`6/${n}`, { exact: true })).toBeVisible();

  // Answers are not revealed during the exam.
  await expect(page.getByText(last.options[0].explanation)).toHaveCount(0);

  await page.getByRole('button', { name: `Submit now (${n - 6} unanswered)`, exact: true }).click();
  const score = Math.round((100 * 5) / n);
  await expect(scoreLocator(page, score)).toBeVisible();
  await expect(page.getByText(`Below the pass mark · 5/${n} correct`)).toBeVisible();

  const by = expectedByDomain(right);
  for (const d of exam.domains) {
    const [r, t] = by[d.id] ?? [0, 0];
    await expect(page.getByText(d.title, { exact: true }).locator('..')).toContainText(`${r}/${t}`);
  }
  // Review reveals explanations.
  await expect(page.getByRole('heading', { name: 'Review' })).toBeVisible();
  await expect(page.getByText(last.options[0].explanation)).toBeVisible();

  const p = await progressOf(page);
  expect(p.exams).toHaveLength(1);
  expect(p.exams[0]).toMatchObject({ exam: exam.id, score, passed: false, byDomain: by });

  await page.goto('#/progress');
  const card = page.getByText('Mock exam domains (all attempts)').locator('..');
  for (const [d, [r, t]] of Object.entries(by)) await expect(card.getByText(d, { exact: true }).locator('..')).toContainText(`${Math.round((100 * r) / t)}%`);
});

test('mock exam: the timer counts down and submits automatically when time runs out', async ({ page }) => {
  await page.clock.install();
  await page.goto(`#/exams/${exam.id}`);
  await page.getByRole('button', { name: 'Begin', exact: true }).click();
  await expect(page.getByText(`${exam.duration_minutes}:00`)).toBeVisible();
  for (const o of correct(exam.questions[0])) await choose(page, o.text);

  await page.clock.runFor(61_000);
  await expect(page.getByText(`${exam.duration_minutes - 2}:59`)).toBeVisible();
  // Results are not shown while time remains.
  await expect(page.getByText(`1/${n} correct`)).toHaveCount(0);

  await page.clock.runFor(exam.duration_minutes * 60_000);
  const score = Math.round(100 / n);
  await expect(scoreLocator(page, score)).toBeVisible();
  await expect(page.getByText(`Below the pass mark · 1/${n} correct`)).toBeVisible();
  const p = await progressOf(page);
  expect(p.exams).toHaveLength(1);
  expect(p.exams[0]).toMatchObject({ exam: exam.id, score });
  expect(p.exams[0].seconds).toBeGreaterThanOrEqual(exam.duration_minutes * 60);
});
