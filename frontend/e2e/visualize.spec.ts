import { readFileSync } from 'node:fs';
import { expect, test } from './fixtures';

// Read the registry as text: importing it would pull in React and every widget module.
const src = readFileSync(new URL('../src/widgets/registry.tsx', import.meta.url), 'utf8');
const widgets = [...src.matchAll(/\{ id: '([a-z0-9-]+)', title: '((?:[^'\\]|\\.)*)'/g)].map((m) => ({ id: m[1], title: m[2].replace(/\\'/g, "'") }));
const topics = [...src.matchAll(/\{ name: '([^']+)', ids: \[/g)].map((m) => m[1]);

test('visualizations page lists every widget under its topic and the filter narrows the list', async ({ page }) => {
  expect(widgets.length).toBeGreaterThan(40);
  await page.goto('#/visualize');
  for (const t of topics) await expect(page.getByRole('heading', { level: 2, name: new RegExp(`^${t}`) })).toBeVisible();
  const cards = page.locator('main a[href^="#/visualize/"]');
  await expect(cards).toHaveCount(widgets.length);

  const filter = page.getByLabel('Filter visualizations');
  await filter.fill('infiniband');
  const n = await cards.count();
  expect(n).toBeGreaterThan(2);
  expect(n).toBeLessThan(widgets.length);
  await expect(page.getByText(`${n} of ${widgets.length} shown`)).toBeVisible();
  await filter.fill('zzz-nothing');
  await expect(cards).toHaveCount(0);
  await expect(page.getByText(/No visualization matches/)).toBeVisible();
});

test('every widget page renders its widget without errors', async ({ page }) => {
  test.setTimeout(180_000);
  for (const w of widgets) {
    await page.goto(`#/visualize/${w.id}`);
    const frame = page.getByRole('region', { name: `Interactive: ${w.title}` });
    await expect(frame, w.id).toBeVisible();
    // The lazy widget has loaded once the skeleton is gone and the frame holds real content.
    await expect(frame.locator('.animate-pulse'), w.id).toHaveCount(0);
    await expect(frame.getByText(/coming soon/i), w.id).toHaveCount(0);
    expect((await frame.innerText()).length, w.id).toBeGreaterThan(200);
  }
});

test('number fields accept a retyped value and clamp only when focus leaves', async ({ page }) => {
  await page.goto('#/visualize/queue-latency');
  const frame = page.getByLabel(/Frame size/);
  // Clearing used to snap the field to its minimum (64), so typing 1500 gave 641500 or 64.
  await frame.fill('');
  await frame.pressSequentially('1500');
  await expect(frame).toHaveValue('1500');
  await expect(page.getByText('(1500 + 20) × 8 / 400G')).toBeVisible();
  // Out of range while typing is kept as typed, then clamped to the maximum on blur.
  await frame.fill('99999');
  await frame.blur();
  await expect(frame).toHaveValue('9216');
  // A preset button still updates the field.
  await page.getByRole('button', { name: '64 byte frame' }).click();
  await expect(frame).toHaveValue('64');
});
