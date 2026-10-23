// Phone-width viewport (390 × 844, touch): no horizontal page scroll, the navigation drawer works, and the
// main page kinds stay usable. The shared fixture fails every test on page or console errors.
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { choose, content, expect, test, type Q } from './fixtures';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

const src = readFileSync(new URL('../src/widgets/registry.tsx', import.meta.url), 'utf8');
const widgets = [...src.matchAll(/\{ id: '([a-z0-9-]+)', title: '((?:[^'\\]|\\.)*)'/g)].map((m) => ({ id: m[1], title: m[2].replace(/\\'/g, "'") }));

/** The page itself must not scroll sideways; wide content (tables, terminals, code) scrolls inside its own box. */
async function expectNoHorizontalScroll(page: Page, what: string) {
  const m = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, vw: window.innerWidth }));
  expect(m.doc, `${what}: page wider than the viewport`).toBeLessThanOrEqual(m.vw);
  expect(m.body, `${what}: body wider than the viewport`).toBeLessThanOrEqual(m.vw);
}

test('phone: dashboard fits and the menu drawer navigates', async ({ page }) => {
  await page.goto('#/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expectNoHorizontalScroll(page, 'dashboard');
  // The measurement is not vacuous: a 600px element does register as page overflow.
  const probe = await page.evaluate(() => {
    const d = document.createElement('div');
    d.style.cssText = 'width:600px;height:1px';
    document.body.appendChild(d);
    const w = document.documentElement.scrollWidth;
    d.remove();
    return w;
  });
  expect(probe).toBeGreaterThan(390);
  // The desktop sidebar is hidden; the menu button opens a drawer with the main navigation.
  await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeHidden();
  const open = page.getByRole('button', { name: 'Open menu' });
  await expect(open).toBeVisible();
  await expect(open).toHaveAttribute('aria-expanded', 'false');
  await open.tap();
  const drawer = page.getByRole('dialog', { name: 'Menu' });
  await expect(drawer).toBeVisible();
  await expect(open).toHaveAttribute('aria-expanded', 'true');
  await expectNoHorizontalScroll(page, 'dashboard with the drawer open');
  await drawer.getByRole('link', { name: 'Simulator labs' }).tap();
  await expect(page).toHaveURL(/#\/labs$/);
  await expect(drawer).toBeHidden();
  await expectNoHorizontalScroll(page, 'labs');
  // Close without navigating.
  await open.tap();
  await expect(drawer).toBeVisible();
  await drawer.getByRole('button', { name: 'Close menu' }).tap();
  await expect(drawer).toBeHidden();
  // The appearance menu stays reachable in the header and fits on the screen.
  await page.getByRole('button', { name: /^Appearance:/ }).click();
  const appearance = page.getByRole('menu', { name: 'Appearance' });
  await expect(appearance).toBeInViewport({ ratio: 1 });
  await page.keyboard.press('Escape');
});

test('phone: a lesson with widgets and a diagram fits', async ({ page }) => {
  await page.goto('#/lesson/mtu-jumbo-frames');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('main svg[id^="m"]').first()).toBeVisible();
  await expect(page.getByText('End-to-end MTU checker', { exact: true })).toBeVisible();
  await expect(page.locator('.animate-pulse')).toHaveCount(0);
  await expectNoHorizontalScroll(page, 'lesson');
  // The embedded widget still responds at this width.
  const netdev = page.getByLabel('Host netdev MTU (ip link)');
  await netdev.fill('1500');
  await expect(page.getByText('RoCE active_mtu', { exact: true }).locator('..')).toContainText('1024');
  await expect(page.getByRole('button', { name: 'Mark as read' })).toBeVisible();
});

test('phone: a quiz can be answered and checked', async ({ page }) => {
  const quiz = content<{ id: string; questions: Q[] }>('quizzes/quiz-mtu-jumbo-frames.json');
  await page.goto(`#/quiz/${quiz.id}`);
  const q = quiz.questions[0];
  await expect(page.getByText(`Question 1 / ${quiz.questions.length}`)).toBeVisible();
  await expectNoHorizontalScroll(page, 'quiz');
  for (const o of q.options.filter((x) => x.correct)) await choose(page, o.text);
  await page.getByRole('button', { name: 'Check answer', exact: true }).tap();
  await expect(page.getByText(q.options[0].explanation)).toBeVisible();
  await expectNoHorizontalScroll(page, 'quiz after checking');
  await expect(page.getByRole('button', { name: quiz.questions.length > 1 ? 'Next' : 'See results', exact: true })).toBeVisible();
});

test('phone: a simulator lab shell takes commands and wide output scrolls inside the terminal', async ({ page }) => {
  await page.goto('#/labs/sim-01-mtu-blackhole');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const input = page.getByRole('textbox', { name: 'Terminal input' });
  await input.scrollIntoViewIfNeeded();
  await input.tap();
  await input.fill('nvidia-smi topo -m'); // a wide matrix
  await input.press('Enter');
  await expect(page.getByRole('log')).toContainText('GPU0');
  await expectNoHorizontalScroll(page, 'sim lab');
  await expect(page.getByRole('button', { name: 'Grade the fabric', exact: true })).toBeAttached();
});

test('phone: the fabric simulator sandbox fits', async ({ page }) => {
  await page.goto('#/simulator?run=ibdev2netdev');
  await expect(page.getByRole('log')).toContainText('mlx5_0 port 1 ==>');
  await expectNoHorizontalScroll(page, 'simulator');
});

test('phone: every widget page fits the viewport', async ({ page }) => {
  test.setTimeout(180_000);
  const wide: string[] = [];
  for (const w of widgets) {
    await page.goto(`#/visualize/${w.id}`);
    const frame = page.getByRole('region', { name: `Interactive: ${w.title}` });
    await expect(frame, w.id).toBeVisible();
    await expect(frame.locator('.animate-pulse'), w.id).toHaveCount(0);
    const m = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, vw: window.innerWidth }));
    if (m.doc > m.vw) wide.push(`${w.id} (${m.doc}px)`);
  }
  expect(wide, 'widget pages wider than a 390px phone').toEqual([]);
});

test('phone: Real HW Connect and the hardware lab list fit', async ({ page }) => {
  await page.goto('#/hw/connect');
  await page.getByRole('button', { name: 'Load demo report', exact: true }).tap();
  await expect(page.getByText('This is an illustrative report', { exact: false })).toBeVisible();
  await expectNoHorizontalScroll(page, 'hw connect with the demo report');
  await page.goto('#/hw/labs');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expectNoHorizontalScroll(page, 'hw labs');
});
