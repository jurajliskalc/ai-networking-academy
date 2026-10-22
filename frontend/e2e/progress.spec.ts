import fs from 'node:fs';
import { choose, content, expect, progressOf, test, watchErrors } from './fixtures';

interface SimLab { id: string; kind: string; title: string; diagnosis: { options: { text: string; correct?: boolean }[] } }
const ix = content<{ labs: SimLab[]; glossary: unknown[] }>('index.json');
const orientation = ix.labs.find((l) => l.id === 'sim-00-orientation')!;

test('progress: export, import into a fresh browser restores it, reset clears it', async ({ page, browser, baseURL, consoleErrors }) => {
  // Make some real progress: solve the orientation lab and review one flashcard.
  await page.goto(`#/labs/${orientation.id}`);
  await choose(page, orientation.diagnosis.options.find((o) => o.correct)!.text);
  await page.getByRole('button', { name: 'Commit diagnosis', exact: true }).click();
  await page.getByRole('button', { name: 'Grade the fabric', exact: true }).click();
  await expect(page.getByText('Incident resolved.', { exact: false })).toBeVisible();
  await page.goto('#/flashcards');
  await page.getByRole('button').filter({ hasText: /to reveal/ }).click();
  await page.getByRole('button', { name: 'Good', exact: true }).click();
  const before = await progressOf(page);
  expect(before.labs[orientation.id].solved).toBe(true);
  expect(Object.keys(before.cards)).toHaveLength(1);

  // Export.
  await page.goto('#/settings');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export progress' }).click()]);
  expect(dl.suggestedFilename()).toMatch(/^ai-networking-academy-progress-\d{4}-\d{2}-\d{2}\.json$/);
  const exportedPath = (await dl.path())!;
  const exported = JSON.parse(fs.readFileSync(exportedPath, 'utf8'));
  expect(exported).toEqual(before);

  // Import into a fresh browser context (empty localStorage).
  const fresh = await browser.newContext({ baseURL });
  const p2 = await fresh.newPage();
  watchErrors(p2, consoleErrors);
  await p2.goto('#/');
  await expect(p2.getByText('Labs solved').locator('..')).toContainText(new RegExp(`Labs solved\\s*0/`));
  await p2.goto('#/settings');

  // A broken file is rejected and changes nothing.
  const [badChooser] = await Promise.all([p2.waitForEvent('filechooser'), p2.getByRole('button', { name: 'Import progress' }).click()]);
  await badChooser.setFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{not json') });
  await expect(p2.getByText('That file is not a valid progress export.')).toBeVisible();

  const [chooser] = await Promise.all([p2.waitForEvent('filechooser'), p2.getByRole('button', { name: 'Import progress' }).click()]);
  await chooser.setFiles(exportedPath);
  await expect(p2.getByText('Progress imported.')).toBeVisible();
  expect(await progressOf(p2)).toEqual(before);
  await p2.goto('#/');
  await expect(p2.getByText('Labs solved').locator('..')).toContainText(new RegExp(`Labs solved\\s*1/`));
  await p2.goto('#/labs');
  await expect(p2.getByRole('link').filter({ hasText: orientation.title })).toContainText('Solved');

  // Reset needs a confirmation, keeps the theme and clears everything else.
  await p2.goto('#/settings');
  await p2.getByRole('button', { name: 'dark', exact: true }).click();
  await p2.getByRole('button', { name: 'Reset all progress' }).click();
  expect((await progressOf(p2)).labs[orientation.id].solved).toBe(true);
  await p2.getByRole('button', { name: 'Really reset everything?' }).click();
  await expect(p2.getByText('Progress reset.')).toBeVisible();
  const after = await progressOf(p2);
  expect(after).toMatchObject({ lessons: {}, quizzes: {}, labs: {}, exams: [], cards: {}, activity: {}, settings: { theme: 'dark' } });
  await p2.goto('#/progress');
  await expect(p2.getByText('Labs', { exact: true }).locator('..')).toContainText(/Labs\s*0\//);
  await fresh.close();
});
