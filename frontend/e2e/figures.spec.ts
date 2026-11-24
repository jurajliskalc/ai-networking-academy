// Figures: compiled at build time (scripts/figures.mjs) and drawn by components/Figure.tsx.
import { content, expect, test } from './fixtures';

interface Fig { kind: string; alt: string; w: number; flowing: boolean }
const figuresOf = (rel: string): Fig[] => [...content<{ body: string }>(rel).body.matchAll(/```figure\n(.*)\n```/g)].map((m) => JSON.parse(m[1]) as Fig);

test('a flow figure is drawn with a text alternative and animates briefly when it comes into view', async ({ page }) => {
  const [incast] = figuresOf('lessons/incast-and-congestion-hotspots.json');
  expect(incast.flowing).toBe(true);
  await page.goto('#/lesson/incast-and-congestion-hotspots');
  const figure = page.locator('main figure.figure').first();
  const svg = figure.getByRole('img');
  await expect(svg).toHaveAttribute('aria-label', incast.alt);
  expect(incast.alt).toContain('Sender 1 (400G) to Leaf egress queue to R');
  // Every label of the source is on the page, as text.
  for (const label of ['Sender 1 (400G)', 'Sender 4 (400G)', 'Leaf egress queue to R', '400G drain', 'Receiver R']) await expect(figure.getByText(label, { exact: true })).toBeVisible();
  // It flows for under five seconds once in view, then rests; the button replays it.
  await figure.scrollIntoViewIfNeeded();
  await expect(svg).toHaveClass(/is-flowing/);
  const replay = figure.getByRole('button', { name: 'Replay the flow' });
  await expect(replay).toBeDisabled();
  await expect(svg).not.toHaveClass(/is-flowing/, { timeout: 8000 });
  await replay.click();
  await expect(svg).toHaveClass(/is-flowing/);
});

test('a sequence figure can be played step by step', async ({ page }) => {
  await page.goto('#/lesson/verbs-qps-mrs');
  const figure = page.locator('main figure.figure[data-kind="sequence"]').first();
  await figure.scrollIntoViewIfNeeded();
  await expect(figure.locator('.is-active')).toHaveCount(0);
  await figure.getByRole('button', { name: 'Play step by step' }).click();
  await expect(figure.locator('.is-active')).toHaveCount(1);
  await expect(figure.locator('.fig-message.is-active')).toContainText('build WQE in send queue');
  await expect(figure.locator('.is-active')).toContainText('ring doorbell', { timeout: 4000 });
  // It ends with nothing highlighted and nothing dimmed.
  await expect(figure.locator('.is-active, .is-dim')).toHaveCount(0, { timeout: 15000 });
});

test('with reduced motion a figure is complete and still', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('#/lesson/incast-and-congestion-hotspots');
  const figure = page.locator('main figure.figure').first();
  await figure.scrollIntoViewIfNeeded();
  await expect(figure.getByText('Receiver R', { exact: true })).toBeVisible();
  await page.waitForTimeout(600);
  await expect(figure.getByRole('img')).not.toHaveClass(/is-flowing/);
  // Its size comes from the build, not from measuring in the page: it is as wide as the compiler made it.
  const [incast] = figuresOf('lessons/incast-and-congestion-hotspots.json');
  expect(await figure.locator('svg.fig').evaluate((el) => (el as SVGSVGElement).viewBox.baseVal.width)).toBe(incast.w);
});

test('a figure in a hardware guide shows the values of the lab profile', async ({ page }) => {
  await page.goto('#/hw/network-setup');
  const figure = page.locator('main figure.figure').first();
  await expect(figure.getByText(/^Host A node-a$/)).toBeVisible();
  await expect(figure.getByText('192.168.50.11')).toBeVisible();
  await expect(page.locator('main figure.figure').getByText(/\{\{[A-Z_]+\}\}/)).toHaveCount(0);
});

test('phone: a wide figure scrolls inside its frame, not the page', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await page.goto('#/lesson/lossless-misconfigurations');
  const figure = page.locator('main figure.figure').first();
  await figure.scrollIntoViewIfNeeded();
  const scroller = figure.locator('.figure-scroll');
  await expect(scroller).toHaveAttribute('tabindex', '0');
  expect(await scroller.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  // Text stays at a readable size: the figure is never drawn below 82 % of its natural size.
  expect(await figure.locator('svg.fig').evaluate((el) => el.getBoundingClientRect().width / (el as SVGSVGElement).viewBox.baseVal.width)).toBeGreaterThanOrEqual(0.819);
  await context.close();
});
