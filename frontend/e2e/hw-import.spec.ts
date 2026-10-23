// Real HW result import: an `aina-hw collect-all` report (the real ConnectX-5 capture in tests/fixtures)
// and `aina-hw check` result files ("aina.hw.check/1") through the Connect page and a lab page, plus
// pasted check.sh output. Expected findings and pass states come from the same parsers the page uses.
import type { Page } from '@playwright/test';
import { content, expect, progressOf, readJson, test } from './fixtures';
import { defaults } from '../src/hw/profile';
import { parseReport, review } from '../src/hw/report';
import { parseCheckJson } from '../src/hw/checks';
import type { ContentIndex } from '../src/types';

const ix = content<ContentIndex>('index.json');
const real = readJson('tests/fixtures/real-report-cx5-doca.json');
const profile = defaults(ix.hardware.variables);
const LAB = 'hw-02-roce-first-traffic';
const OTHER = 'hw-03-host-qos-pfc-ecn';
const title = (id: string) => ix.labs.find((l) => l.id === id)!.title;

/** A check result as `aina-hw check <lab>` writes it. */
const check = (lab: string, results: { status: string; text: string }[], extra: Record<string, unknown> = {}) => ({
  schema: 'aina.hw.check/1', toolkit: '1.0.0', lab, host: 'host-a', lab_name: 'e2e', fabric: 'roce',
  started: '2026-10-23T10:00:00+00:00', finished: '2026-10-23T10:00:42+00:00', duration_s: 42, exit_code: 0, passed: true,
  counts: {}, results, ...extra,
});
const file = (name: string, json: unknown) => ({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(json)) });
const status = (page: Page) => page.getByRole('status').filter({ hasText: /Imported:|Error:/ });

test('Connect: importing the real ConnectX-5 report shows its hosts and the computed findings', async ({ page }) => {
  await page.goto('#/hw/connect');
  await expect(page.getByRole('button', { name: 'Load demo report', exact: true })).toBeVisible();
  const r = parseReport(real);
  await page.getByLabel('Report or check result files').setInputFiles(file('aina-report.json', real));
  await expect(status(page)).toContainText(`aina-report.json: inventory of ${r.hosts.length} host(s)`);

  // Not the demo: no demo callout, and the summary reflects this report.
  await expect(page.getByText('This is an illustrative report', { exact: false })).toHaveCount(0);
  const health = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Fabric health review' }) });
  const tile = (k: string) => health.getByText(k, { exact: true }).locator('xpath=following-sibling::*[1]');
  await expect(tile('Hosts')).toHaveText(String(r.hosts.length));
  await expect(tile('Collected')).toHaveText(r.generated.slice(0, 10));
  for (const h of r.hosts) await expect(health.getByText(h.host.hostname!).first()).toBeVisible();

  const findings = review(r, profile);
  const count = (s: string) => findings.filter((f) => f.severity === s).length;
  await expect(tile('Errors')).toHaveText(String(count('error')));
  await expect(tile('Warnings')).toHaveText(String(count('warn')));
  if (findings.length) {
    await expect(page.getByRole('button', { name: `All ${findings.length}`, exact: true })).toBeVisible();
    for (const f of findings.slice(0, 5)) await expect(page.locator('li').filter({ hasText: f.title }).first()).toBeVisible();
  } else {
    await expect(page.getByText('No problems found against your profile.', { exact: false })).toBeVisible();
  }

  // The report survives a reload and can be forgotten.
  await page.reload();
  await expect(tile('Hosts')).toHaveText(String(r.hosts.length));
  await page.getByRole('button', { name: 'Forget report', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Load demo report', exact: true })).toBeVisible();

  // Something that is neither a report nor a check result is rejected with a reason.
  await page.getByLabel('Report or check result files').setInputFiles({ name: 'notes.json', mimeType: 'application/json', buffer: Buffer.from('{not json') });
  await expect(page.getByRole('status').filter({ hasText: 'notes.json:' })).toContainText('Error:');
  await expect(page.getByRole('button', { name: 'Load demo report', exact: true })).toBeVisible();
});

test('Connect: check result files mark labs verified or not, unknown labs are reported', async ({ page }) => {
  const pass = check(LAB, [{ status: 'PASS', text: 'ib_write_bw reached 90% of line rate' }, { status: 'PASS', text: 'GID index 3 is RoCE v2' }, { status: 'WARN', text: 'MTU 1500' }]);
  // A hand-edited "passed": true does not count when a FAIL line is present.
  const fail = check(OTHER, [{ status: 'PASS', text: 'trust dscp' }, { status: 'FAIL', text: 'PFC not enabled on priority 3' }]);
  const unknown = check('hw-99-no-such-lab', [{ status: 'PASS', text: 'x' }]);
  expect(parseCheckJson(pass).passed).toBe(true);
  expect(parseCheckJson(fail).passed).toBe(false);

  await page.goto('#/hw/connect');
  await expect(page.getByText('No check results yet.', { exact: false })).toBeVisible();
  await page.getByLabel('Report or check result files').setInputFiles([file('check-a.json', pass), file('check-b.json', fail), file('check-c.json', unknown)]);
  const msgs = page.getByRole('status').filter({ hasText: 'check-a.json' });
  await expect(msgs).toContainText(`check-a.json: check result for ${LAB}`);
  await expect(msgs).toContainText(`check-b.json: check result for ${OTHER}`);
  await expect(msgs).toContainText('1 check result(s) are for labs this academy does not know.');

  // Step 5 lists both known labs with their state and counts.
  const row = (id: string) => page.locator('details').filter({ has: page.getByRole('link', { name: title(id), exact: true }) });
  await expect(row(LAB).locator('[aria-label="Passed"]')).toBeVisible();
  await expect(row(LAB)).toContainText('2 pass · 0 fail · 1 warn · host-a');
  await expect(row(OTHER).locator('[aria-label="Not passed"]')).toBeVisible();
  await expect(row(OTHER)).toContainText('1 pass · 1 fail · 0 warn');

  // Progress: the passing lab is solved with evidence; the failing one is not solved.
  const p = await progressOf(page);
  expect(p.labs[LAB]).toMatchObject({ solved: true, evidence: { host: 'host-a', pass: 2, warn: 1, source: 'toolkit' } });
  expect(p.labs[OTHER].solved).toBe(false);
  expect(p.labs['hw-99-no-such-lab']).toBeUndefined();

  // The lab list shows the verified badge on the passing lab only.
  await page.goto('#/hw/labs');
  const card = (id: string) => page.getByRole('link').filter({ hasText: title(id) });
  await expect(card(LAB)).toContainText('Verified');
  await expect(card(OTHER)).not.toContainText('Verified');

  // The lab page shows the imported result and the evidence line.
  await page.goto(`#/hw/labs/${LAB}`);
  await expect(page.getByText('Passed · 2 pass, 0 fail, 1 warn')).toBeVisible();
  await expect(page.getByText('Verified 2026-10-23 on host-a (2 checks)')).toBeVisible();
  await page.goto(`#/hw/labs/${OTHER}`);
  await expect(page.getByText('Not passed · 1 pass, 1 fail, 0 warn')).toBeVisible();
  await expect(page.getByText(/^Verified \d{4}-/)).toHaveCount(0);
});

test('lab page: import a result for this lab, reject one for another lab, then a newer pass verifies it', async ({ page }) => {
  await page.goto(`#/hw/labs/${OTHER}`);
  const input = page.getByLabel('Check result file');
  const msg = page.getByRole('status').filter({ hasText: /Check|That result/ });

  await input.setInputFiles(file('check-wrong.json', check(LAB, [{ status: 'PASS', text: 'ok' }])));
  await expect(msg).toHaveText(`That result is for ${LAB}, not this lab.`);
  expect((await progressOf(page))?.labs?.[LAB]).toBeUndefined();

  await input.setInputFiles(file('check-1.json', check(OTHER, [{ status: 'FAIL', text: 'PFC off' }, { status: 'PASS', text: 'trust dscp' }], { exit_code: 1, passed: false })));
  await expect(msg).toHaveText('Check not passed yet (1 FAIL).');
  await expect(page.getByText('Not passed · 1 pass, 1 fail, 0 warn')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark completed' })).toBeVisible();

  await input.setInputFiles(file('check-2.json', check(OTHER, [{ status: 'PASS', text: 'PFC on priority 3' }, { status: 'PASS', text: 'trust dscp' }], { finished: '2026-10-23T11:00:00+00:00' })));
  await expect(msg).toHaveText('Check passed: lab verified on your hardware.');
  await expect(page.getByText('Passed · 2 pass, 0 fail, 0 warn')).toBeVisible();
  await expect(page.getByText('Verified 2026-10-23 on host-a (2 checks)')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Completed', exact: true })).toBeVisible();
  // The lines are there behind "Show lines".
  await page.getByText('Show lines').click();
  await expect(page.getByText('PFC on priority 3', { exact: true })).toBeVisible();
});

test('Connect: pasted check.sh output is recorded as a pasted result', async ({ page }) => {
  await page.goto('#/hw/connect');
  await page.getByText('Or paste the output of a check.sh').click();
  const record = page.getByRole('button', { name: 'Record result', exact: true });
  await expect(record).toBeDisabled();
  await page.getByLabel('Lab the pasted output belongs to').selectOption(LAB);
  const box = page.getByLabel('check.sh output');
  await box.fill('just some noise');
  await record.click();
  await expect(page.getByRole('status').filter({ hasText: 'Error:' })).toContainText('No PASS:/FAIL:/WARN:/SKIP: lines found');

  await box.fill('== hw-02 ==\nPASS: link up\nPASS: ib_write_bw ok\nWARN: MTU 1500\n');
  await record.click();
  await expect(page.getByRole('status').filter({ hasText: 'Imported:' })).toContainText(`Recorded 2 PASS, 0 FAIL for ${LAB}: lab verified.`);
  const row = page.locator('details').filter({ has: page.getByRole('link', { name: title(LAB), exact: true }) });
  await expect(row).toContainText('2 pass · 0 fail · 1 warn · pasted');
  expect((await progressOf(page)).labs[LAB]).toMatchObject({ solved: true, evidence: { source: 'pasted', host: null } });
  await page.goto(`#/hw/labs/${LAB}`);
  await expect(page.getByText(/^Verified \d{4}-\d\d-\d\d \(2 checks, pasted\)$/)).toBeVisible();
});
