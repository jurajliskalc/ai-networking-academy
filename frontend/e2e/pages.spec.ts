import { appearanceMenu, chooseMode, chooseScheme, content, expect, progressOf, test } from './fixtures';

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

test('appearance menu: light and dark mode switch and persist', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('#/');
  const html = page.locator('html');
  await expect(html).not.toHaveClass(/\bdark\b/);
  await chooseMode(page, 'Dark');
  await expect(html).toHaveClass(/\bdark\b/);
  expect((await progressOf(page)).settings.theme).toBe('dark');
  await page.reload();
  await expect(html).toHaveClass(/\bdark\b/);
  await chooseMode(page, 'Light');
  await expect(html).not.toHaveClass(/\bdark\b/);
  expect((await progressOf(page)).settings.theme).toBe('light');
  // System follows the operating system preference.
  await chooseMode(page, 'System');
  await expect(html).not.toHaveClass(/\bdark\b/);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(html).toHaveClass(/\bdark\b/);
  expect((await progressOf(page)).settings.theme).toBe('system');
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
  await chooseMode(page, 'Dark');
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

test('appearance menu: every colour scheme visibly recolours the app, persists and keeps the mode', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('#/');
  const html = page.locator('html');
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await expect(html).not.toHaveAttribute('data-scheme');
  const menu = await appearanceMenu(page);
  await expect(menu.getByRole('menuitemradio')).toHaveCount(8); // 3 modes + 5 schemes
  await expect(menu.getByRole('menuitemradio', { name: 'NOC', exact: true })).toHaveAttribute('aria-checked', 'true');
  // Each scheme gives the page a different background in both modes: switching is visible, not just the accent.
  for (const mode of ['Dark', 'Light'] as const) {
    await chooseMode(page, mode);
    const seen = new Set<string>();
    for (const [name, id] of [['NOC', ''], ['Ocean', 'ocean'], ['Violet', 'violet'], ['Sepia', 'sepia'], ['High contrast', 'contrast']]) {
      await chooseScheme(page, name);
      if (id) await expect(html).toHaveAttribute('data-scheme', id); else await expect(html).not.toHaveAttribute('data-scheme');
      await expect(menu.getByRole('menuitemradio', { name, exact: true })).toHaveAttribute('aria-checked', 'true');
      seen.add(await bg());
    }
    expect(seen.size, `distinct ${mode.toLowerCase()} backgrounds`).toBe(5);
  }
  // The choice persists and is applied before first paint; changing the mode keeps the scheme.
  await chooseScheme(page, 'Sepia');
  expect((await progressOf(page)).settings).toMatchObject({ theme: 'light', scheme: 'sepia' });
  await page.reload();
  await expect(html).toHaveAttribute('data-scheme', 'sepia');
  await expect(html).not.toHaveClass(/\bdark\b/);
  await chooseMode(page, 'Dark');
  await expect(html).toHaveClass(/\bdark\b/);
  await expect(html).toHaveAttribute('data-scheme', 'sepia');
  // Escape closes the menu and returns focus to its button; the colour settings live only in this menu.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu', { name: 'Appearance' })).toBeHidden();
  await expect(page.getByRole('button', { name: /^Appearance:/ })).toBeFocused();
  await page.goto('#/settings');
  await expect(page.getByRole('group', { name: /theme|colour scheme/i })).toHaveCount(0);
});

test('appearance menu works with the keyboard alone', async ({ page }) => {
  await page.goto('#/');
  const button = page.getByRole('button', { name: /^Appearance:/ });
  await button.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu', { name: 'Appearance' });
  await expect(menu).toBeVisible();
  // Focus starts on the checked scheme (NOC); ArrowDown moves to Ocean, Enter picks it.
  await expect(menu.getByRole('menuitemradio', { name: 'NOC', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitemradio', { name: 'Ocean', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('data-scheme', 'ocean');
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(button).toBeFocused();
  await expect(button).toHaveAccessibleName(/^Appearance: Ocean, (light|dark)$/);
});
