// The visit counter. GoatCounter is never contacted from these tests: the built app is served to the
// browser under the published URL by answering those requests from the preview server, and the two
// GoatCounter endpoints are stubbed (the count in the stub is made up).
import type { Page, Request } from '@playwright/test';
import { GOATCOUNTER_CODE, PUBLISHED_URL } from '../src/visitors';
import { expect, test } from './fixtures';

const site = new URL(PUBLISHED_URL);
const GOATCOUNTER = `https://${GOATCOUNTER_CODE}.goatcounter.com`;
// index.html loads its two typefaces from Google Fonts; those are the app's only other outside requests.
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
// The 1x1 GIF that GoatCounter's /count answers with (handlers/count.go).
const GIF = Buffer.from('47494638396101000100800100000000ffffff21f904010a0001002c00000000010001000002024c01003b', 'hex');

interface CountAnswer { status: number; body: string; cors?: boolean }

/** Make the browser see the build at PUBLISHED_URL. */
async function publish(page: Page, baseURL: string) {
  await page.route(`${site.origin}/**`, async (route) => {
    const u = new URL(route.request().url());
    if (!u.pathname.startsWith(site.pathname)) return route.fulfill({ status: 404, body: 'not part of the site' });
    const response = await route.fetch({ url: new URL(u.pathname.slice(site.pathname.length) + u.search, baseURL).href });
    await route.fulfill({ response });
  });
}

/** Stub GoatCounter; returns the pings it received. `count` answers the visitor-count request. */
async function stubGoatCounter(page: Page, count: CountAnswer | 'blocked') {
  const pings: URL[] = [];
  const cors = { 'access-control-allow-origin': '*' };
  await page.route(`${GOATCOUNTER}/**`, async (route) => {
    const u = new URL(route.request().url());
    if (count === 'blocked') return route.abort('blockedbyclient');
    if (u.pathname === '/count') {
      pings.push(u);
      return route.fulfill({ status: 200, contentType: 'image/gif', headers: cors, body: GIF });
    }
    return route.fulfill({ status: count.status, contentType: count.cors === false ? 'text/html' : 'application/json', headers: count.cors === false ? {} : cors, body: count.body });
  });
  return pings;
}

const sidebar = (page: Page) => page.getByRole('complementary', { name: 'Sidebar' });
const visitsLine = (page: Page) => sidebar(page).getByText(/^[\d,]+ visits?$/);

test('served locally, the app never contacts the visit counter', async ({ page, baseURL }) => {
  const outside = new Set<string>();
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (/^https?:$/.test(u.protocol) && u.origin !== new URL(baseURL!).origin) outside.add(u.hostname);
  });
  await page.goto('#/');
  await expect(sidebar(page).getByRole('link', { name: /Source on GitHub/ })).toBeVisible();
  await sidebar(page).getByRole('link', { name: 'Learning path' }).click();
  await expect(page).toHaveURL(/#\/path$/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect([...outside].filter((h) => !FONT_HOSTS.includes(h)), 'hosts contacted besides the app itself and Google Fonts').toEqual([]);
  await expect(visitsLine(page)).toHaveCount(0);
});

test.describe('on the published site', () => {
  test.skip(!GOATCOUNTER_CODE, 'no GoatCounter site code is configured in src/visitors.ts, so the counter is off');

  test('one ping per page load, and the count sits right above "Source on GitHub"', async ({ page, baseURL }) => {
    await publish(page, baseURL!);
    // GoatCounter formats the number with the account's separator; a thin space here, shown with a comma.
    const pings = await stubGoatCounter(page, { status: 200, body: '{"count_unique":"1 234", "count":"1 234"}' });
    const counted = page.waitForRequest((r) => r.url().startsWith(`${GOATCOUNTER}/counter/`));
    await page.goto(PUBLISHED_URL);

    const line = sidebar(page).getByText('1,234 visits', { exact: true });
    await expect(line).toBeVisible();
    expect(new URL((await counted).url()).pathname).toBe('/counter/%2Fai-networking-academy.json');

    // Position: below the "13 modules" line, directly above the GitHub link, with nothing in between.
    const link = sidebar(page).getByRole('link', { name: /Source on GitHub/ });
    const [modules, visits, github] = await Promise.all([sidebar(page).getByText(/Beginner → Master/).boundingBox(), line.boundingBox(), link.boundingBox()]);
    expect(visits!.y).toBeGreaterThan(modules!.y + modules!.height - 1);
    expect(visits!.y + visits!.height).toBeLessThanOrEqual(github!.y + 1);
    expect(github!.y - (visits!.y + visits!.height), 'gap between the count and the link').toBeLessThan(visits!.height);

    // Moving around the app is not another visit, and the ping says nothing about the route or the visitor.
    await sidebar(page).getByRole('link', { name: 'Learning path' }).click();
    await expect(page).toHaveURL(/#\/path$/);
    await sidebar(page).getByRole('link', { name: 'Mock exams' }).click();
    await expect(page).toHaveURL(/#\/exams$/);
    await expect(line).toBeVisible();
    expect(pings).toHaveLength(1);
    const sent = Object.fromEntries(pings[0].searchParams);
    expect(Object.keys(sent).sort()).toEqual(['b', 'p', 'rnd']);
    expect(sent.p).toBe('/ai-networking-academy');
    expect(sent.b, 'Playwright drives the browser through WebDriver, so the ping is flagged as a bot').toBe('153');
  });

  const failures: [string, CountAnswer | 'blocked'][] = [
    ['a content blocker stops both requests', 'blocked'],
    ['GoatCounter has not recorded the path yet (404)', { status: 404, body: '{"count_unique":"0", "count":"0"}' }],
    ['the account has the visitor counter switched off (403, no CORS header)', { status: 403, body: '<h1>Error 403</h1>', cors: false }],
    ['the answer is not a count', { status: 200, body: '{"count":"lots"}' }],
  ];
  for (const [name, count] of failures) {
    test(`the app works without a count when ${name}`, async ({ page, baseURL, consoleErrors }) => {
      await publish(page, baseURL!);
      await stubGoatCounter(page, count);
      const isCount = (r: Request) => r.url().startsWith(`${GOATCOUNTER}/counter/`);
      const asked = count === 'blocked' ? page.waitForEvent('requestfailed', isCount) : page.waitForEvent('requestfinished', isCount);
      await page.goto(PUBLISHED_URL);
      await asked;
      await expect(sidebar(page).getByRole('link', { name: /Source on GitHub/ })).toBeVisible();
      await sidebar(page).getByRole('link', { name: 'Reference' }).click();
      await expect(page).toHaveURL(/#\/reference$/);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(visitsLine(page)).toHaveCount(0);
      // Chrome reports the failed GoatCounter requests in the console; nothing else may be there.
      const expected = /Failed to load resource|blocked by CORS policy/;
      expect(consoleErrors.filter((e) => !expected.test(e))).toEqual([]);
      consoleErrors.length = 0;
    });
  }
});
