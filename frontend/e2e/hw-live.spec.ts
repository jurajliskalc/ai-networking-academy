// Real HW Live mode and resumable labs: the Live page polls a (mocked) `aina-hw serve` /api/live and shows
// rates from counter deltas; hardware lab pages show per-task progress from imported check results, offer
// "Resume at Task N", honour ?s= section deep links and embed the live readout once the agent was reached.
import type { Page, Route } from '@playwright/test';
import { content, expect, test } from './fixtures';
import type { ContentIndex, HandsOnLab } from '../src/types';

const ix = content<ContentIndex>('index.json');
const LAB = 'hw-02-roce-first-traffic';
const AGENT = 'http://127.0.0.1:8765';

/** A fake agent: each /api/live answer advances the clock by 1 s; A sends 10 GB/s (80 Gb/s) of RDMA and
 *  receives 250 PFC pauses/s; B (remote) receives the traffic and sends 3 CNPs/s. */
async function mockAgent(page: Page) {
  let n = 0;
  await page.route(`${AGENT}/api/**`, async (route: Route) => {
    const url = route.request().url();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    if (url.endsWith('/api/live')) {
      n += 1;
      const port = (c: Record<string, number>) => ({ dev: 'mlx5_0', port: 1, netdev: 'ens64f0np0', state: 'ACTIVE', phys_state: 'LinkUp', rate_gbps: 100, link_layer: 'Ethernet', operstate: 'up', counters: c });
      const snap = (host: string, role: string, c: Record<string, number>) => ({ schema: 'aina.hw.live/1', toolkit: '1.1.0', host, role, t: 1000 + n, prio: 3, ports: [port(c)] });
      return json({
        schema: 'aina.hw.live/1', toolkit: '1.1.0', generated: '2026-10-23T19:00:00+00:00', prio: 3, remote: true, hosts: [
          { role: 'A', ok: true, error: null, snapshot: snap('host-a', 'A', { tx_vport_rdma_unicast_bytes: n * 10e9, rx_vport_rdma_unicast_bytes: n * 1e7, rx_prio3_pause: n * 250, tx_prio3_pause: 0, out_of_sequence: 0, np_cnp_sent: 0, rp_cnp_handled: n * 3 }) },
          { role: 'B', ok: true, error: null, snapshot: snap('host-b', 'B', { rx_vport_rdma_unicast_bytes: n * 10e9, tx_vport_rdma_unicast_bytes: n * 1e7, tx_prio3_pause: n * 250, rx_prio3_pause: 0, out_of_sequence: 0, np_cnp_sent: n * 3, rp_cnp_handled: 0 }) },
        ],
      });
    }
    if (url.endsWith('/api/status')) return json({ schema: 'aina.hw.agent/1', toolkit: '1.1.0', host: 'host-a', read_only: true, report: false, checks: 0, live: true, live_remote: true });
    if (url.endsWith('/api/checks')) return json([]);
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' });
  });
}

const metric = (page: Page, host: string, id: string) => page.getByRole('region', { name: `Live counters, Host ${host} mlx5_0/1` }).locator(`[data-metric="${id}"]`);

test('Live page: start, rates from deltas with sparklines, stop', async ({ page }) => {
  await mockAgent(page);
  await page.goto('#/hw/live');
  await expect(page.getByRole('link', { name: 'Live', exact: true })).toHaveAttribute('aria-current', 'page');
  const start = page.getByRole('button', { name: 'Start live counters' });
  await start.click();
  await expect(page.getByText('Live · lossless priority 3')).toBeVisible();
  await expect(metric(page, 'A', 'rdmatx')).toHaveText('80.0 Gb/s', { timeout: 10_000 });
  await expect(metric(page, 'A', 'prx')).toHaveText('250/s');
  await expect(metric(page, 'A', 'cnph')).toHaveText('3.0/s');
  await expect(metric(page, 'B', 'rdmarx')).toHaveText('80.0 Gb/s');
  await expect(metric(page, 'B', 'cnps')).toHaveText('3.0/s');
  await expect(metric(page, 'B', 'oos')).toHaveText('0/s');
  await expect(page.getByTestId('sparkline').first()).toBeVisible();
  // Changing numbers are not a live region; transitions are announced politely in one place.
  await expect(page.locator('[aria-live="polite"]').filter({ hasText: 'traffic started' })).toHaveCount(1);
  await expect(page.locator('[data-metric]').first().locator('xpath=ancestor-or-self::*[@aria-live]')).toHaveCount(0);
  // Stop is a toggle on the same button.
  const stop = page.getByRole('button', { name: 'Stop live counters' });
  await expect(stop).toHaveAttribute('aria-pressed', 'true');
  await stop.click();
  await expect(page.getByRole('button', { name: 'Start live counters' })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('region', { name: /Live counters, Host A/ })).toHaveCount(0);
});

/** An `aina-hw check` record with TASK markers (toolkit 1.1). */
const record = (finished: string, lines: { status: string; text: string; task?: number }[], extra: Record<string, unknown> = {}) => ({
  schema: 'aina.hw.check/1', toolkit: '1.1.0', lab: LAB, host: 'host-a', started: finished, finished, exit_code: 1, passed: false, counts: {}, results: lines,
  tasks: [{ n: 0, title: 'Before you start' }, { n: 1, title: 'Prove the IP path and the MTU first' }, { n: 2, title: 'Inspect the RDMA port and find the right GID' }, { n: 3, title: 'An RC ping-pong across the wire' }, { n: 5, title: 'Bandwidth with perftest' }, { n: 8, title: 'Watch the counters while traffic runs' }],
  only_task: null, ...extra,
});
const file = (name: string, json: unknown) => ({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(json)) });

test('Hardware lab: per-task progress, resume at the failed task, single-task rerun, ?s= deep link', async ({ page }) => {
  const lab = ix.labs.find((l): l is HandsOnLab => l.id === LAB && l.kind === 'handson')!;
  expect(lab.toc.some((t) => t.text.startsWith('Task 5:'))).toBe(true);
  await page.goto(`#/hw/labs/${LAB}`);
  const progress = page.getByRole('list', { name: 'Task progress' });
  await expect(page.getByText('Run the check (or one task with')).toBeVisible();

  const full = record('2026-10-23T10:00:00+00:00', [
    { status: 'PASS', text: 'ib_write_bw is installed' },
    { status: 'PASS', text: 'netdev MTU matches on both hosts (9000)', task: 1 },
    { status: 'FAIL', text: 'host B: index 3 is not a RoCE v2 IPv4 GID', task: 2 },
    { status: 'PASS', text: 'ibv_rc_pingpong: 100 iterations A -> B', task: 3 },
    { status: 'PASS', text: 'ib_write_bw: 98.02 Gb/s average', task: 5 },
    { status: 'PASS', text: 'no sequence errors on host B during the test', task: 8 },
  ]);
  await page.getByLabel('Check result file').setInputFiles(file('check-full.json', full));
  await expect(page.getByText('Check not passed yet (1 FAIL).')).toBeVisible();
  await expect(progress.getByRole('button', { name: /Task 2 .*: failed$/ })).toBeVisible();
  await expect(progress.getByRole('button', { name: /Task 1 .*: done$/ })).toBeVisible();
  await expect(progress.getByRole('button', { name: /Task 4 .*: not checked by check\.sh$/ })).toBeVisible();
  await expect(progress).toContainText('host B: index 3 is not a RoCE v2 IPv4 GID');
  const banner = page.getByTestId('resume-banner');
  await expect(banner).toContainText('Tasks 1, 3, 5, 8 done. Task 2 failed.');
  await expect(banner).toContainText(`aina-hw check ${LAB} --task 2`);

  // Resume jumps to the Task 2 heading and moves focus there.
  await banner.getByRole('button', { name: /^Resume at Task 2/ }).click();
  const task2 = page.getByRole('heading', { name: /^Task 2:/ });
  await expect(task2).toBeFocused();
  await expect(task2).toBeInViewport();

  // A single-task rerun of Task 2 that passes: progress updates, the lab is not marked verified by it.
  const part = record('2026-10-23T11:00:00+00:00', [{ status: 'PASS', text: 'ib_write_bw is installed' }, { status: 'PASS', text: 'host B: RoCE v2 IPv4 GID at index 3', task: 2 }], { only_task: 2, exit_code: 0, tasks: [{ n: 0, title: 'Before you start' }, { n: 2, title: 'Inspect the RDMA port and find the right GID' }] });
  await page.getByLabel('Check result file').setInputFiles(file('check-task2.json', part));
  await expect(page.getByText('Task 2 passes. A single-task run updates the task progress')).toBeVisible();
  await expect(progress.getByRole('button', { name: /Task 2 .*: done$/ })).toBeVisible();
  await expect(banner).toContainText('Every task the check covers passes.');
  await expect(page.getByRole('button', { name: 'Mark completed' })).toBeVisible(); // not verified by a partial run

  // Survives a reload (stored with the hardware state).
  await page.reload();
  await expect(page.getByTestId('resume-banner')).toContainText('Every task the check covers passes.');

  // ?s=<heading id> deep links scroll to the section, as on lesson pages.
  await page.goto(`#/hw/labs/${LAB}?s=task-5-bandwidth-with-perftest`);
  const task5 = page.getByRole('heading', { name: /^Task 5: Bandwidth with perftest/ });
  await expect(task5).toBeFocused();
  await expect(task5).toBeInViewport();
});

test('Hardware lab embeds the live readout once the agent was reached', async ({ page }) => {
  await mockAgent(page);
  await page.goto(`#/hw/labs/${LAB}`);
  const card = page.locator('aside').getByText('Live counters', { exact: true }).locator('..').locator('..');
  await expect(card.getByRole('link', { name: 'connect it' })).toBeVisible();
  // Connect once on the Connect page, as a learner would.
  await page.goto('#/hw/connect');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByText('Connected to host-a', { exact: false })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open the live counters' })).toBeVisible();
  await page.goto(`#/hw/labs/${LAB}`);
  await page.locator('aside').getByRole('button', { name: 'Start live counters' }).click();
  await expect(metric(page, 'A', 'rdmatx')).toHaveText('80.0 Gb/s', { timeout: 10_000 });
  await expect(metric(page, 'B', 'ptx')).toHaveText('250/s');
});
