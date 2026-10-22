// Shared fixtures for the browser tests: every test fails on an uncaught page error or a console error,
// and helpers read the compiled content (dist/content) to know the right answers, since option order is shuffled.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const contentDir = path.resolve(here, '../dist/content');

/** Read a JSON file relative to frontend/. */
export const readJson = <T = unknown>(rel: string): T => JSON.parse(fs.readFileSync(path.resolve(here, '..', rel), 'utf8')) as T;

export interface Opt { id: string; text: string; correct?: boolean; explanation: string }
export interface Q { id: string; type: string; prompt: string; domain?: string; options: Opt[] }

export function content<T = unknown>(rel: string): T {
  const file = path.join(contentDir, rel);
  if (!fs.existsSync(file)) throw new Error(`${file} is missing: run "npm run build" before "npm run e2e".`);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

export const STORAGE_KEY = 'aina.progress.v1';

/** Read the learner's progress object straight from localStorage. */
export async function progressOf(page: Page): Promise<Record<string, any>> {
  return page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? 'null'), STORAGE_KEY);
}

/** Click an answer option by its exact text. Works whether options are buttons, radios or checkboxes. */
export async function choose(page: Page, text: string) {
  await page.getByText(text, { exact: true }).click();
}

/** Record uncaught page errors and console errors of a page into `errors`. */
export function watchErrors(page: Page, errors: string[]) {
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
}

/** Every test fails on an uncaught page error or a console error. Pages opened in other contexts can be
 *  watched too: push them through `watchErrors(page, consoleErrors)`. */
export const test = base.extend<{ consoleErrors: string[] }>({
  consoleErrors: [async ({ page }, use) => {
    const errors: string[] = [];
    watchErrors(page, errors);
    await use(errors);
    expect(errors, 'uncaught page errors or console errors').toEqual([]);
  }, { auto: true }],
});

export { expect };

/** The big score on a results page ("86%"), whether or not it carries a screen-reader prefix. */
export const scoreLocator = (page: Page, pct: number) => page.getByText(new RegExp(`(^|[\s:])${pct}%$`)).first();
