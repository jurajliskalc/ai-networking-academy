import fs from 'node:fs';
import { content, expect, readJson, test } from './fixtures';
import { defaults, sanitizeProfile } from '../src/hw/profile';
import { parseReport, review } from '../src/hw/report';
import type { ContentIndex } from '../src/types';

const ix = content<ContentIndex>('index.json');
const demoReport = readJson('src/hw/demo-report.json');
const vars = ix.hardware.variables;
const LAB = 'hw-02-roce-first-traffic';
const base = defaults(vars);
const edits = { LAB_NAME: 'e2e-lab', B_IP: '10.77.0.2', A_RDMA_DEV: 'mlx5_3' };

test('Real HW Connect: edit the profile, placeholders follow, lab.env downloads, demo report shows findings', async ({ page }) => {
  // Before: the hardware lab uses the example values.
  await page.goto(`#/hw/labs/${LAB}`);
  await expect(page.getByText('example values')).toBeVisible();
  await expect(page.locator('main')).toContainText(base.B_IP);

  await page.goto('#/hw/connect');
  const download = page.getByRole('button', { name: 'Download lab.env', exact: true });

  // Validation: a bad IP is flagged and blocks the download.
  await page.getByLabel('Host B data IP').fill('not-an-ip');
  await expect(page.getByText('Not an IPv4 address')).toBeVisible();
  await expect(page.getByText('1 value(s) to fix')).toBeVisible();
  await expect(download).toBeDisabled();

  await page.getByLabel('Host B data IP').fill(edits.B_IP);
  await page.getByLabel('Host A RDMA device').fill(edits.A_RDMA_DEV);
  await page.getByLabel('Lab name').fill(edits.LAB_NAME);
  await expect(page.getByText('Not an IPv4 address')).toHaveCount(0);
  await expect(download).toBeEnabled();

  // Download the generated lab.env and check the edited values are in it.
  const [file] = await Promise.all([page.waitForEvent('download'), download.click()]);
  expect(file.suggestedFilename()).toBe('lab.env');
  const env = fs.readFileSync((await file.path())!, 'utf8');
  expect(env).toMatch(/^B_IP=["']?10\.77\.0\.2["']?$/m);
  expect(env).toMatch(/^A_RDMA_DEV=["']?mlx5_3["']?$/m);
  expect(env).toMatch(/^LAB_NAME=["']?e2e-lab["']?$/m);

  // The lab.env preview tab shows the same content.
  await page.getByRole('button', { name: 'lab.env', exact: true }).click();
  await expect(page.locator('pre').filter({ hasText: 'B_IP=' })).toContainText(edits.B_IP);

  // Values persist across a reload.
  await page.reload();
  await expect(page.getByLabel('Host B data IP')).toHaveValue(edits.B_IP);

  // {{VAR}} substitution on a hardware lab page now uses the profile.
  await page.goto(`#/hw/labs/${LAB}`);
  const main = page.locator('main');
  await expect(page.getByText('Commands personalised for')).toContainText(edits.LAB_NAME);
  await expect(main).toContainText(edits.B_IP);
  await expect(main).toContainText(edits.A_RDMA_DEV);
  await expect(main).not.toContainText('{{B_IP}}');
  const count = (s: string, needle: string) => s.split(needle).length - 1;
  const filled = (await main.textContent())!;
  await page.getByLabel('Show placeholders').check();
  await expect(main).toContainText('{{B_IP}}');
  const raw = (await main.textContent())!;
  // Every placeholder became the profile value (the extra one is the "Your values" card, shown in both modes).
  expect(count(raw, '{{B_IP}}')).toBeGreaterThan(0);
  expect(count(filled, edits.B_IP)).toBe(count(raw, '{{B_IP}}') + count(raw, edits.B_IP));
  expect(count(filled, base.B_IP)).toBe(count(raw, base.B_IP)); // only literal sample output keeps the example IP
  await page.getByLabel('Show placeholders').uncheck();

  // Load the demo report: the health review lists the findings computed for this profile.
  await page.goto('#/hw/connect');
  await page.getByRole('button', { name: 'Load demo report', exact: true }).click();
  await expect(page.getByText('This is an illustrative report', { exact: false })).toBeVisible();
  const findings = review(parseReport(demoReport), sanitizeProfile({ ...base, ...edits }, vars));
  const errors = findings.filter((f) => f.severity === 'error').length;
  expect(findings.length).toBeGreaterThan(0);
  await expect(page.getByText('Errors', { exact: true }).locator('..')).toContainText(String(errors));
  await expect(page.getByRole('button', { name: `All ${findings.length}`, exact: true })).toBeVisible();
  for (const f of findings.slice(0, 5)) await expect(page.locator('li').filter({ hasText: f.title }).first()).toBeVisible();

  // Filter to errors only.
  const warn = findings.find((f) => f.severity === 'warn' && !findings.some((e) => e.severity === 'error' && e.title === f.title));
  await page.getByRole('button', { name: `Error ${errors}`, exact: true }).click();
  if (warn) await expect(page.locator('li').filter({ hasText: warn.title })).toHaveCount(0);

  await page.getByRole('button', { name: 'Forget report', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Load demo report', exact: true })).toBeVisible();
});
