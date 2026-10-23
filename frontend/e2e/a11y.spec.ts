// Accessibility regression guard: axe-core (WCAG 2.0-2.2 A/AA plus best practice) on one page of every
// kind, in light and dark colour schemes. The full-site sweep (every route) is a manual check; this keeps
// regressions out of CI.
import { createRequire } from 'node:module';
import { test, expect } from './fixtures';

const axePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

const ROUTES = [
  '/', '/path', '/module/m04-rdma', '/lesson/mtu-jumbo-frames', '/lesson/pfc-priority-flow-control',
  '/quiz/quiz-mtu-jumbo-frames', '/labs', '/labs/sim-01-mtu-blackhole', '/simulator', '/exams', '/exams/exam-ai-fabric-1',
  '/flashcards', '/reference', '/visualize', '/visualize/parallelism-map', '/progress', '/settings', '/verified',
  '/hw', '/hw/connect', '/hw/labs', '/hw/labs/hw-03-host-qos-pfc-ecn', '/does-not-exist',
];

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`axe, ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    for (const route of ROUTES) {
      test(route, async ({ page }) => {
        await page.goto(`/#${route}`);
        await expect(page.locator('h1').first()).toBeVisible();
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(500); // widgets and diagrams settle after the first paint
        await page.addScriptTag({ path: axePath });
        const violations = await page.evaluate(async (tags) => {
          const r = await (window as any).axe.run(document, { runOnly: { type: 'tag', values: tags } });
          return r.violations.map((v: any) => `${v.id} (${v.nodes.length}): ${v.nodes.slice(0, 3).map((n: any) => n.target.join(' ')).join(' | ')}`);
        }, TAGS);
        expect(violations, `axe violations on ${route} (${scheme})`).toEqual([]);
      });
    }
  });
}

// Every non-default colour scheme, light and dark, on the pages with the most colour: widgets, diagrams,
// callouts, the simulator shell, badges and the scheme picker itself.
const SCHEME_ROUTES = ['/', '/lesson/pfc-priority-flow-control', '/labs/sim-01-mtu-blackhole', '/visualize/parallelism-map', '/hw/connect', '/settings'];
for (const colourScheme of ['ocean', 'violet', 'sepia', 'contrast'] as const) {
  for (const mode of ['light', 'dark'] as const) {
    test.describe(`axe, ${colourScheme} ${mode}`, () => {
      test.use({ colorScheme: mode });
      for (const route of SCHEME_ROUTES) {
        test(route, async ({ page }) => {
          await page.addInitScript((s) => {
            localStorage.setItem('aina.progress.v1', JSON.stringify({ version: 1, settings: { theme: 'system', scheme: s } }));
          }, colourScheme);
          await page.goto(`/#${route}`);
          await expect(page.locator('h1').first()).toBeVisible();
          await expect(page.locator('html')).toHaveAttribute('data-scheme', colourScheme);
          await page.waitForLoadState('networkidle');
          await page.waitForTimeout(500);
          await page.addScriptTag({ path: axePath });
          const violations = await page.evaluate(async (tags) => {
            const r = await (window as any).axe.run(document, { runOnly: { type: 'tag', values: tags } });
            return r.violations.map((v: any) => `${v.id} (${v.nodes.length}): ${v.nodes.slice(0, 3).map((n: any) => n.target.join(' ')).join(' | ')}`);
          }, TAGS);
          expect(violations, `axe violations on ${route} (${colourScheme} ${mode})`).toEqual([]);
        });
      }
    });
  }
}
