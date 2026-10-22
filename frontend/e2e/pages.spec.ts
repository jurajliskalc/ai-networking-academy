import { content, expect, progressOf, test } from './fixtures';

interface Index {
  glossary: { term: string; definition: string }[];
  commands: { id: string; title: string; commands: { cmd: string; summary: string; notes?: string; tags?: string[] }[] }[];
}
const ix = content<Index>('index.json');

test('flashcards: reveal a card, grade it, the schedule is stored and the queue advances', async ({ page }) => {
  await page.goto('#/flashcards');
  const total = ix.glossary.length;
  await expect(page.getByText(`1 / ${total}`)).toBeVisible();
  const reveal = page.getByRole('button').filter({ hasText: /to reveal/ });
  const front = (await reveal.locator('div > div').first().textContent())!.trim();
  const card = ix.glossary.find((t) => t.term === front)!;
  expect(card, `front of the card shows a glossary term (${front})`).toBeTruthy();
  await expect(page.getByRole('button', { name: 'Good', exact: true })).toHaveCount(0);
  await reveal.click();
  await expect(page.getByText(card.definition, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Easy', exact: true }).click();
  await expect(page.getByText(`2 / ${total}`)).toBeVisible();
  const p = await progressOf(page);
  expect(p.cards[card.term]).toMatchObject({ reps: 1, interval: 1 });
  // A reviewed card is no longer due, so a fresh "Due today" queue is one shorter.
  await page.reload();
  await expect(page.getByText(`1 / ${total - 1}`)).toBeVisible();
  await page.getByRole('button', { name: 'Cram all', exact: true }).click();
  await expect(page.getByText(`1 / ${total}`)).toBeVisible();
});

test('reference: the search box filters commands and glossary terms', async ({ page }) => {
  await page.goto('#/reference');
  const search = page.getByPlaceholder(/Search commands/);
  const all = ix.commands.flatMap((g) => g.commands);
  const needle = 'show_gids';
  const want = all.filter((c) => [c.cmd, c.summary, c.notes ?? '', ...(c.tags ?? [])].join(' ').toLowerCase().includes(needle));
  expect(want.length).toBeGreaterThan(0);
  const commandCodes = page.locator('main code.font-semibold');
  await expect(commandCodes).toHaveCount(all.length);
  await search.fill(needle);
  await expect(commandCodes).toHaveCount(want.length);
  for (const c of want) await expect(page.locator('main').getByText(c.cmd, { exact: true }).first()).toBeVisible();
  await search.fill('zzz-no-such-command');
  await expect(page.getByText('No commands match.')).toBeVisible();

  // Category filter.
  await search.fill('');
  const g = ix.commands[0];
  await page.getByRole('combobox').selectOption(g.id);
  await expect(commandCodes).toHaveCount(g.commands.length);

  // Glossary tab with its own search.
  await page.getByRole('button', { name: 'glossary', exact: true }).click();
  const term = ix.glossary.find((t) => t.term === 'PFC') ?? ix.glossary[0];
  await page.getByPlaceholder('Search terms').fill(term.term);
  await expect(page.locator('main dt').filter({ hasText: term.term }).first()).toBeVisible();
  const matches = ix.glossary.filter((t) => `${t.term} ${(t as { expansion?: string }).expansion ?? ''} ${t.definition}`.toLowerCase().includes(term.term.toLowerCase()));
  await expect(page.locator('main dt')).toHaveCount(matches.length);
});

test('theme toggle switches both ways and persists across reloads', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('#/');
  const html = page.locator('html');
  // Named "Toggle theme" or "Switch to light/dark theme" depending on the build.
  const toggle = page.getByRole('button', { name: /^(toggle theme|switch to (light|dark) theme)$/i });
  await expect(html).not.toHaveClass(/\bdark\b/);
  await toggle.click();
  await expect(html).toHaveClass(/\bdark\b/);
  expect((await progressOf(page)).settings.theme).toBe('dark');
  await page.reload();
  await expect(html).toHaveClass(/\bdark\b/);
  await toggle.click();
  await expect(html).not.toHaveClass(/\bdark\b/);
  expect((await progressOf(page)).settings.theme).toBe('light');
  await toggle.click();
  await expect(html).toHaveClass(/\bdark\b/);
  await page.reload();
  await expect(html).toHaveClass(/\bdark\b/);
  // The settings page shows the same choice.
  await page.goto('#/settings');
  await page.getByRole('button', { name: 'light', exact: true }).click();
  await expect(html).not.toHaveClass(/\bdark\b/);
  await toggle.click();
  await expect(html).toHaveClass(/\bdark\b/);
});

test('lesson with widgets and a mermaid diagram renders and the widget responds', async ({ page }) => {
  await page.goto('#/lesson/mtu-jumbo-frames');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  // Mermaid rendered an SVG (no error fallback).
  await expect(page.locator('main svg[id^="m"]').first()).toBeVisible();
  await expect(page.locator('[data-mermaid-error]')).toHaveCount(0);
  // Both widgets are on the page.
  await expect(page.getByText('RoCEv2 packet anatomy', { exact: true })).toBeVisible();
  await expect(page.getByText('End-to-end MTU checker', { exact: true })).toBeVisible();
  await expect(page.getByText(/Unknown widget/)).toHaveCount(0);
  // The MTU checker reacts: a 1500-byte netdev gives a 1024-byte RoCE active_mtu, 9000 gives 4096.
  const netdev = page.getByLabel('Host netdev MTU (ip link)');
  const active = page.getByText('RoCE active_mtu', { exact: true }).locator('..');
  await netdev.fill('1500');
  await expect(active).toContainText('1024');
  // Widget state survives page re-renders such as scrolling (it used to reset on every scroll).
  await page.mouse.wheel(0, 1500);
  await page.mouse.wheel(0, -700);
  await expect(netdev).toHaveValue('1500');
  await expect(active).toContainText('1024');
  await netdev.fill('9000');
  await expect(active).toContainText('4096');
  // Diagrams follow the theme.
  const diagram = page.locator('main svg[id^="m"]').first();
  const before = await diagram.innerHTML();
  await page.getByRole('button', { name: /^(toggle theme|switch to (light|dark) theme)$/i }).click();
  await expect.poll(() => diagram.innerHTML()).not.toBe(before);
  await expect(netdev).toHaveValue('9000');
  // Mark as read is stored.
  await page.getByRole('button', { name: 'Mark as read' }).click();
  expect((await progressOf(page)).lessons['mtu-jumbo-frames']).toBeTruthy();
});

test('an unknown route shows the not-found page with a way back', async ({ page }) => {
  await page.goto('#/no/such/page');
  await expect(page.getByText(/(^|\s)404$/).first()).toBeVisible();
  await expect(page.getByText('Destination host unreachable', { exact: false })).toBeVisible();
  await page.getByRole('link', { name: 'Back to the dashboard' }).click();
  await expect(page).toHaveURL(/#\/$/);
  // Unknown content ids also land on a not-found state rather than crashing.
  await page.goto('#/labs/sim-99-does-not-exist');
  await expect(page.getByText(/(^|\s)404$/).first()).toBeVisible();
});
