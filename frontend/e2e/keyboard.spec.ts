import type { Page } from '@playwright/test';
import { content, expect, progressOf, scoreLocator, test, type Q } from './fixtures';

interface Quiz { id: string; pass_pct: number; questions: Q[] }
const quiz = content<Quiz>('quizzes/quiz-ai-training-101.json');

/** Text of the focused control (button, link, form field, radio or checkbox); '' for anything else, such as
 *  a question container that receives focus programmatically. */
const focusedText = (page: Page) => page.evaluate(() => {
  const el = document.activeElement as HTMLElement | null;
  const control = el && (el.matches('button, a[href], input, select, textarea') || ['radio', 'checkbox'].includes(el.getAttribute('role') ?? ''));
  return control ? `${el.getAttribute('aria-label') ?? ''} ${el.innerText ?? ''}`.trim() : '';
});

/** Move focus with Tab (or Shift+Tab) only, until the focused element's text satisfies `want`. */
async function tabTo(page: Page, want: (text: string) => boolean, label: string) {
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let i = 0; i < 60; i++) {
      if (want(await focusedText(page))) return;
      await page.keyboard.press(key);
    }
  }
  throw new Error(`could not reach "${label}" with the keyboard (focus is on "${await focusedText(page)}")`);
}

test('keyboard only: tab through the quiz, answer every question, see the result', async ({ page }) => {
  await page.goto(`#/quiz/${quiz.id}`);
  await expect(page.getByText(`Question 1 / ${quiz.questions.length}`)).toBeVisible();
  const n = quiz.questions.length;
  for (const [k, q] of quiz.questions.entries()) {
    await expect(page.getByText(`Question ${k + 1} / ${n}`)).toBeVisible();
    for (const o of q.options.filter((x) => x.correct)) {
      // Checkboxes are each a tab stop. A radio group may be a single tab stop (roving tabindex):
      // then Tab into the group and move with the arrow keys, as with native radios.
      await tabTo(page, (t) => t.includes(o.text) || (q.type !== 'multi' && q.options.some((x) => t.includes(x.text))), o.text);
      for (let i = 0; i < q.options.length && !(await focusedText(page)).includes(o.text); i++) await page.keyboard.press('ArrowDown');
      expect(await focusedText(page)).toContain(o.text);
      await page.keyboard.press('Space');
    }
    await tabTo(page, (t) => t === 'Check answer', `Check answer (question ${k + 1})`);
    await page.keyboard.press('Enter');
    await expect(page.getByText(q.options[0].explanation)).toBeVisible();
    const next = k < n - 1 ? 'Next' : 'See results';
    await tabTo(page, (t) => t === next, next);
    await page.keyboard.press('Enter');
  }
  await expect(scoreLocator(page, 100)).toBeVisible();
  await expect(page.getByText('Passed', { exact: true })).toBeVisible();
  expect((await progressOf(page)).quizzes[quiz.id]).toMatchObject({ best: 100, passed: true });

  // The result actions are reachable too.
  await tabTo(page, (t) => t === 'Retry', 'Retry');
  await page.keyboard.press('Enter');
  await expect(page.getByText(`Question 1 / ${n}`)).toBeVisible();
});
