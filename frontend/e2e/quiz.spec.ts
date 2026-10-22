import { choose, content, expect, progressOf, scoreLocator, test, type Q } from './fixtures';

interface Quiz { id: string; title: string; lesson: string; pass_pct: number; questions: Q[] }
const quiz = content<Quiz>('quizzes/quiz-ai-training-101.json');
const correct = (q: Q) => q.options.filter((o) => o.correct);
const wrong = (q: Q) => q.options.find((o) => !o.correct)!;

test('quiz: answer, check, see score, progress is stored and shown', async ({ page }) => {
  await page.goto(`#/quiz/${quiz.id}`);
  const n = quiz.questions.length;
  // Everything right except the last question, so the score is not trivially 100%.
  const expected = Math.round((100 * (n - 1)) / n);

  for (const [k, q] of quiz.questions.entries()) {
    await expect(page.getByText(`Question ${k + 1} / ${n}`)).toBeVisible();
    const check = page.getByRole('button', { name: 'Check answer', exact: true });
    await expect(check).toBeDisabled();
    const picks = k === n - 1 ? [wrong(q)] : correct(q);
    for (const o of picks) await choose(page, o.text);
    await check.click();
    // Revealed: every option's explanation is shown.
    await expect(page.getByText(q.options[0].explanation)).toBeVisible();
    await page.getByRole('button', { name: k < n - 1 ? 'Next' : 'See results', exact: true }).click();
  }

  await expect(scoreLocator(page, expected)).toBeVisible();
  await expect(page.getByText(expected >= quiz.pass_pct ? 'Passed' : `Not yet: ${quiz.pass_pct}% needed`)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Review what you missed' })).toBeVisible();

  const p = await progressOf(page);
  expect(p.quizzes[quiz.id]).toMatchObject({ best: expected, last: expected, attempts: 1, passed: expected >= quiz.pass_pct });

  // Survives a reload and is reflected on the progress page.
  await page.goto('#/progress');
  await page.reload();
  const avg = page.getByText('Average best quiz').locator('..');
  await expect(avg).toContainText(`${expected}%`);
  await expect(avg).toContainText('1 quizzes attempted');

  // The quiz page now shows the best score.
  await page.goto(`#/quiz/${quiz.id}`);
  await expect(page.getByText(`your best ${expected}%`)).toBeVisible();
});

test('quiz: retry resets the attempt and a perfect run raises the best score', async ({ page }) => {
  await page.goto(`#/quiz/${quiz.id}`);
  const n = quiz.questions.length;
  for (const [k, q] of quiz.questions.entries()) {
    for (const o of k === 0 ? [wrong(q)] : correct(q)) await choose(page, o.text);
    await page.getByRole('button', { name: 'Check answer', exact: true }).click();
    await page.getByRole('button', { name: k < n - 1 ? 'Next' : 'See results', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByText(`Question 1 / ${n}`)).toBeVisible();
  for (const [k, q] of quiz.questions.entries()) {
    for (const o of correct(q)) await choose(page, o.text);
    await page.getByRole('button', { name: 'Check answer', exact: true }).click();
    await page.getByRole('button', { name: k < n - 1 ? 'Next' : 'See results', exact: true }).click();
  }
  await expect(scoreLocator(page, 100)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Review what you missed' })).toHaveCount(0);
  const p = await progressOf(page);
  expect(p.quizzes[quiz.id]).toMatchObject({ best: 100, last: 100, attempts: 2, passed: true });
});
