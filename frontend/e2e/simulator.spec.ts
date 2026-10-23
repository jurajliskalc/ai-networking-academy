// The free-play Fabric Simulator page (#/simulator): commands typed into the shell, shareable ?run= links,
// history recall and Reset cluster. Selectors are by role and text only, so extra controls on the page
// (such as a fabric-variant switch) do not affect these tests.
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const input = (page: Page) => page.getByRole('textbox', { name: 'Terminal input' });
const log = (page: Page) => page.getByRole('log');

/** Type a command and wait until it has been echoed into the log. */
async function run(page: Page, cmd: string) {
  const before = (await log(page).textContent())?.length ?? 0;
  await input(page).fill(cmd);
  await input(page).press('Enter');
  await expect(input(page)).toHaveValue('');
  await expect.poll(async () => (await log(page).textContent())?.length ?? 0).toBeGreaterThan(before);
}

test('sandbox: help, ibv_devinfo and ib_write_bw on the healthy cluster', async ({ page }) => {
  await page.goto('#/simulator');
  await expect(page.getByRole('heading', { level: 1, name: 'Fabric simulator' })).toBeVisible();
  await expect(log(page)).toContainText('Fabric Simulator sandbox. Healthy cluster.');
  await expect(input(page)).toBeFocused(); // the sandbox focuses the shell on load
  await expect(page.getByText('ssh node01 · simulated')).toBeVisible();

  await run(page, 'help');
  await expect(log(page)).toContainText('Fabric Simulator - GPU node commands');
  await expect(log(page)).toContainText('ib_write_bw -d <dev>');

  await run(page, 'ibv_devinfo -d mlx5_3');
  await expect(log(page)).toContainText(/hca_id:\s+mlx5_3/);
  await expect(log(page)).toContainText('PORT_ACTIVE (4)');
  await expect(log(page)).not.toContainText(/hca_id:\s+mlx5_2/); // -d selects one device

  await run(page, 'ibv_devinfo -d mlx5_9');
  await expect(log(page)).toContainText("IB device 'mlx5_9' wasn't found");

  // A healthy rail-0 pair runs at close to 400G line rate.
  await run(page, 'ib_write_bw -d mlx5_0 -x 3 --report_gbits node02');
  await expect(log(page)).toContainText('RDMA_Write BW Test');
  await expect(log(page)).toContainText('BW average[Gb/sec]');
  const text = (await log(page).textContent())!;
  const row = text.match(/\n\s*65536\s+\d+\s+([\d.]+)\s+([\d.]+)\s+[\d.]+/);
  expect(row, 'ib_write_bw printed a 65536-byte result row').toBeTruthy();
  const avg = Number(row![2]);
  expect(avg).toBeGreaterThan(300);
  expect(avg).toBeLessThanOrEqual(400);
  await expect(log(page)).not.toContainText('Completion with error');

  await run(page, 'no_such_tool');
  await expect(log(page)).toContainText('no_such_tool: command not found');
});

test('sandbox: ssh to a switch, history recall, clear and Reset cluster', async ({ page }) => {
  await page.goto('#/simulator');
  await run(page, 'ssh leaf04');
  await expect(page.getByText('ssh leaf04 · simulated')).toBeVisible();
  await run(page, 'nv show interface');
  await expect(log(page)).toContainText('swp1');

  // Up arrow recalls the last command, then the one before it.
  await input(page).press('ArrowUp');
  await expect(input(page)).toHaveValue('nv show interface');
  await input(page).press('ArrowUp');
  await expect(input(page)).toHaveValue('ssh leaf04');
  await input(page).press('ArrowDown');
  await expect(input(page)).toHaveValue('nv show interface');
  await input(page).fill('');

  await run(page, 'exit');
  await expect(page.getByText('ssh node01 · simulated')).toBeVisible();

  // Break a link on purpose, then Reset cluster restores the healthy fabric and a fresh shell.
  await run(page, 'ip link set dev enp99s0np0 down');
  await run(page, 'ibdev2netdev');
  await expect(log(page)).toContainText('mlx5_3 port 1 ==> enp99s0np0 (Down)');
  await page.getByRole('button', { name: 'Reset cluster' }).click();
  await expect(log(page)).not.toContainText('enp99s0np0 (Down)');
  await expect(log(page)).toContainText('Fabric Simulator sandbox. Healthy cluster.');
  await run(page, 'ibdev2netdev');
  await expect(log(page)).toContainText('mlx5_3 port 1 ==> enp99s0np0 (Up)');
});

test('a ?run= link executes its commands once, in order, and follows ssh', async ({ page }) => {
  const cmds = ['ibdev2netdev', 'ssh leaf04', 'nv show interface swp1'];
  await page.goto(`#/simulator?${cmds.map((c) => `run=${encodeURIComponent(c)}`).join('&')}`);
  await expect(log(page)).toContainText('mlx5_0 port 1 ==> enp24s0np0 (Up)');
  // ssh in the link moved the shell to the switch, and the next command ran there.
  await expect(page.getByText('ssh leaf04 · simulated')).toBeVisible();
  await expect(log(page)).toContainText('cumulus@leaf04:mgmt:~$ nv show interface swp1');
  await expect(log(page)).toContainText('Welcome to NVIDIA Cumulus Linux (simulated)');
  // Each command ran exactly once.
  const text = (await log(page).textContent())!;
  expect(text.split('root@node01:~# ibdev2netdev').length - 1).toBe(1);
  // The linked commands are in the shell history.
  await input(page).press('ArrowUp');
  await expect(input(page)).toHaveValue(cmds[2]);
  // A reload runs the link again from a fresh cluster rather than twice in one session.
  await page.reload();
  await expect(log(page)).toContainText('mlx5_0 port 1 ==> enp24s0np0 (Up)');
  expect(((await log(page).textContent())!).split('root@node01:~# ibdev2netdev').length - 1).toBe(1);
});

test('the example link in the page text works', async ({ page }) => {
  await page.goto('#/simulator?run=ibdev2netdev&run=nvidia-smi%20topo%20-m');
  await expect(log(page)).toContainText('root@node01:~# nvidia-smi topo -m');
  await expect(log(page)).toContainText('GPU0');
  await expect(log(page)).toContainText('mlx5_0 port 1 ==> enp24s0np0 (Up)');
});
