import type { Page } from '@playwright/test';
import { choose, content, expect, progressOf, test } from './fixtures';

interface SimLab { id: string; kind: string; title: string; start?: string; fix: string[]; checks: unknown[]; diagnosis: { options: { text: string; correct?: boolean }[] } }
const labs = content<{ labs: SimLab[] }>('index.json').labs.filter((l) => l.kind === 'sim');
const lab = (id: string) => labs.find((l) => l.id === id)!;

/** Type a command into the simulated shell and wait until it has been echoed. */
async function run(page: Page, cmd: string) {
  const input = page.getByRole('textbox', { name: 'Terminal input' });
  const log = page.getByRole('log');
  const before = await log.textContent();
  await input.fill(cmd);
  await input.press('Enter');
  await expect(input).toHaveValue('');
  await expect.poll(async () => (await log.textContent())?.length ?? 0).toBeGreaterThan(before?.length ?? 0);
}

/** Replay the lab's documented fix ("host: command") through the UI, ssh-ing between hosts as needed. */
async function replayFix(page: Page, l: SimLab) {
  let host = l.start ?? 'node01';
  for (const line of l.fix) {
    const i = line.indexOf(':');
    const target = line.slice(0, i).trim();
    const cmd = line.slice(i + 1).trim();
    if (target !== host) {
      await run(page, `ssh ${target}`);
      host = target;
      await expect(page.getByText(`ssh ${host} · simulated`)).toBeVisible();
    }
    await run(page, cmd);
  }
}

async function commitAndGrade(page: Page, l: SimLab) {
  await choose(page, l.diagnosis.options.find((o) => o.correct)!.text);
  await page.getByRole('button', { name: 'Commit diagnosis', exact: true }).click();
  await page.getByRole('button', { name: 'Grade the fabric', exact: true }).click();
}

test('sim-01: diagnose the MTU black hole in the shell, fix it, grade, lab is solved', async ({ page }) => {
  const l = lab('sim-01-mtu-blackhole');
  await page.goto(`#/labs/${l.id}`);
  await expect(page.getByRole('heading', { level: 1, name: l.title })).toBeVisible();
  const log = page.getByRole('log');

  // Grading needs a committed diagnosis first.
  await expect(page.getByRole('button', { name: 'Grade the fabric', exact: true })).toBeDisabled();

  // Diagnosis: the symptom and the size test from the hints.
  await run(page, 'all_reduce_perf -b 8 -e 8G -f 2 -g 1');
  await expect(log).toContainText('status=12');
  await run(page, 'ping -M do -s 8972 -c 1 10.2.2.1');
  await expect(log).toContainText('100% packet loss');
  await run(page, 'ping -M do -s 1400 -c 1 10.2.2.1');
  await expect(log).toContainText(' 0% packet loss');
  await run(page, 'ssh leaf03');
  await expect(page.getByText('ssh leaf03 · simulated')).toBeVisible();
  await run(page, 'nv show interface');
  await expect(log).toContainText('swp2');

  // Grading before the fix fails the checks.
  await commitAndGrade(page, l);
  await expect(page.getByText('Not fixed yet. Keep investigating.')).toBeVisible();
  expect((await progressOf(page)).labs[l.id]).toMatchObject({ solved: false, diagnosisCorrect: true, attempts: 1 });

  // Fix on leaf03 (already there), then verify end to end from node01.
  for (const line of l.fix) await run(page, line.slice(line.indexOf(':') + 1).trim());
  await run(page, 'exit');
  await expect(page.getByText('ssh node01 · simulated')).toBeVisible();
  await run(page, 'ping -M do -s 8972 -c 1 10.2.2.1');
  await page.getByRole('button', { name: 'Grade the fabric', exact: true }).click();
  await expect(page.getByText('Incident resolved. Root cause identified and the fabric verifies clean.')).toBeVisible();
  expect((await progressOf(page)).labs[l.id]).toMatchObject({ solved: true, diagnosisCorrect: true, attempts: 2 });

  // The reference solution is available once solved.
  await page.getByRole('button', { name: 'Show the reference solution' }).click();
  await expect(page.getByText('Prevention: render switch config', { exact: false })).toBeVisible();

  // The lab list and the dashboard count it.
  await page.goto('#/labs');
  await expect(page.getByRole('link').filter({ hasText: l.title })).toContainText('Solved');
  await page.goto('#/');
  await expect(page.getByText('Labs solved').locator('..')).toContainText(/Labs solved\s*1\//);
});

test('sim lab state survives a reload, and Reset lab restores the fault', async ({ page }) => {
  const l = lab('sim-02-port-admin-down');
  await page.goto(`#/labs/${l.id}`);
  await replayFix(page, l);
  await page.reload();
  await commitAndGrade(page, l);
  await expect(page.getByText('Incident resolved.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Reset lab', exact: true }).click();
  await page.getByRole('button', { name: 'Grade the fabric', exact: true }).click();
  await expect(page.getByText('Not fixed yet. Keep investigating.')).toBeVisible();
  // Solved stays solved in progress even after a reset.
  expect((await progressOf(page)).labs[l.id].solved).toBe(true);
});

for (const l of labs) {
  test(`every sim lab is solvable through the UI: ${l.id}`, async ({ page }) => {
    await page.goto(`#/labs/${l.id}`);
    await expect(page.getByRole('heading', { level: 1, name: l.title })).toBeVisible();
    await replayFix(page, l);
    await commitAndGrade(page, l);
    await expect(page.getByText('Incident resolved. Root cause identified and the fabric verifies clean.')).toBeVisible();
    expect((await progressOf(page)).labs[l.id]).toMatchObject({ solved: true });
  });
}
