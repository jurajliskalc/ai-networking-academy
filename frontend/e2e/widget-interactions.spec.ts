// Drives the controls of 14 widgets across topics and checks the visible result moves the way the
// widget's own math says it should. Expected values come from the pure functions each widget exports
// (the same ones the unit tests in tests/widgets-g*.test.ts cover), never from snapshots.
import { readFileSync } from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { math } from './widget-math';
import type { HeadroomInput } from '../src/widgets/HeadroomCalculator';
import type { Assign } from '../src/widgets/PkeyMembership';
import type { FrameOptions } from '../src/widgets/EthernetFrame';

const { GENS: PCIE_GENS, linkGbps: pcieLink, verdict: pcieVerdict } = math.pcie;
const { GENS: IB_GENS, PCIE: IB_PCIE, linkData, pcieGbps } = math.ibSpeeds;
const { trace, tosOf } = math.dscp;
const { algbw, busFactor, ceiling, parseSize, verdict: ncclVerdict } = math.nccl;
const { headroom, totalReserved } = math.headroom;
const { cidrInfo, ipToString, parseCidr } = math.subnet;
const { QUOTED_LIMIT } = math.berFec;
const { workersForProb } = math.straggler;
const { busbwFactor, sentPerRank } = math.collective;
const { PORTS, PRESETS, canTalk, tenantsIsolated } = math.pkey;
const { buildFrame } = math.frame;
const { compareSweep, deviationPct } = math.perftest;
const { CX5_MODEL } = math.baselines;

const src = readFileSync(new URL('../src/widgets/registry.tsx', import.meta.url), 'utf8');
const titles = new Map([...src.matchAll(/\{ id: '([a-z0-9-]+)', title: '((?:[^'\\]|\\.)*)'/g)].map((m) => [m[1], m[2].replace(/\\'/g, "'")]));

/** Open a widget page and return its frame once the lazy widget has loaded. */
async function openWidget(page: Page, id: string): Promise<Locator> {
  const title = titles.get(id);
  expect(title, `${id} is in the registry`).toBeTruthy();
  await page.goto(`#/visualize/${id}`);
  const frame = page.getByRole('region', { name: `Interactive: ${title}` });
  await expect(frame).toBeVisible();
  await expect(frame.locator('.animate-pulse')).toHaveCount(0);
  return frame;
}

/** The value box next to a small caption label (the "Out" tiles most widgets use). */
const out = (frame: Locator, label: string) => frame.getByText(label, { exact: true }).first().locator('xpath=following-sibling::*[1]');
/** A segmented-control button inside its labelled group. */
const seg = (frame: Locator, group: string, name: string) => frame.getByRole('group', { name: group, exact: true }).getByRole('button', { name, exact: true });

const en = (x: number, d = 2) => x.toLocaleString('en-US', { maximumFractionDigits: d });

test('PCIe bandwidth: generation, port count and efficiency move the slot verdict', async ({ page }) => {
  const f = await openWidget(page, 'pcie-bandwidth');
  const status = f.getByRole('status');
  const TEXT = { ok: 'The slot can feed the port at line rate', marginal: 'probably cannot sustain line rate', short: 'PCIe, not the network, is the bottleneck' };
  const g4 = PCIE_GENS[3], g5 = PCIE_GENS[4];

  // Default Gen5 x16, one 400G port, 85 %.
  expect(pcieVerdict(g5, 16, 400, 0.85)).toBe('ok');
  await expect(status).toContainText(TEXT.ok);
  await expect(f.getByText(/^link = /)).toContainText(`${pcieLink(g5, 16)} Gb/s`); // 504.112, kernel style

  // Gen4 x16 is below 400G even before overhead.
  await seg(f, 'PCIe generation', 'Gen4').click();
  expect(pcieVerdict(g4, 16, 400, 0.85)).toBe('short');
  await expect(status).toContainText(TEXT.short);
  await expect(f.getByText(/^link = /)).toContainText(`${pcieLink(g4, 16)} Gb/s`);

  // Back to Gen5 and drop the assumed efficiency to its minimum: raw rate fits, usable does not.
  await seg(f, 'PCIe generation', 'Gen5').click();
  await expect(status).toContainText(TEXT.ok);
  const slider = f.getByRole('slider');
  await slider.focus();
  await page.keyboard.press('Home');
  await expect(slider).toHaveValue('70');
  expect(pcieVerdict(g5, 16, 400, 0.7)).toBe('marginal');
  await expect(status).toContainText(TEXT.marginal);

  // Two ports at line rate: 800 Gb/s of demand is more than the Gen5 x16 link.
  await seg(f, 'Ports at line rate', '2').click();
  expect(pcieVerdict(g5, 16, 800, 0.7)).toBe('short');
  await expect(status).toContainText(TEXT.short);
  await expect(f.getByText(/no Gen5 width up to x16 feeds 800 Gb\/s/)).toBeVisible();
});

test('InfiniBand speeds: ports, PCIe generation and IB generation move the slot verdict', async ({ page }) => {
  const f = await openWidget(page, 'ib-speeds');
  const status = f.getByRole('status');
  const fmt = (n: number, d: number) => (Math.abs(n - Math.round(n)) < 1e-9 ? String(Math.round(n)) : n.toFixed(d));
  const gen = (name: string) => IB_GENS.find((g) => g.name === name)!;
  const pcie = (g: number) => IB_PCIE.find((p) => p.gen === g)!;
  const pct = (ports: number, ib: string, pg: number) => fmt(((linkData(gen(ib), 4) * ports) / pcieGbps(pcie(pg), 16)) * 100, 0);

  // NDR 4x, one port, Gen5 x16: 400 / 504.112 = 79 %, headroom.
  await expect(out(f, 'Link data rate')).toHaveText(`${fmt(linkData(gen('NDR'), 4), 2)} Gb/s`);
  await expect(status).toContainText(`The slot has headroom: the link needs ${pct(1, 'NDR', 5)} % of PCIe Gen5 x16`);

  await seg(f, 'Active ports on the adapter', '2').click();
  await expect(status).toContainText(`The slot is the bottleneck: the network wants 800 Gb/s but PCIe Gen5 x16 moves at most ${fmt(pcieGbps(pcie(5), 16), 1)} Gb/s`);
  await expect(status).toContainText(`(${pct(2, 'NDR', 5)} %)`);

  await seg(f, 'PCIe generation', 'Gen6').click(); // 944 Gb/s after the FLIT share
  await expect(status).toContainText(`Tight: the link uses ${pct(2, 'NDR', 6)} % of the slot`);

  await seg(f, 'Generation', 'HDR').click();
  await expect(out(f, 'Link data rate')).toHaveText(`${fmt(linkData(gen('HDR'), 4), 2)} Gb/s`);
  await expect(status).toContainText(`The slot has headroom: the link needs ${pct(2, 'HDR', 6)} % of PCIe Gen6 x16`);
});

test('DSCP mapper: presets, the DSCP field and trust mode change the classification', async ({ page }) => {
  const f = await openWidget(page, 'dscp-mapper');
  const prio = f.getByText('Switch priority', { exact: true }).locator('xpath=following-sibling::*[1]');

  // NCCL_IB_TC=106: DSCP 26 + ECT(0), priority 3, lossless.
  const t106 = trace(26, 2, 'dscp', false, 3, 'cs');
  await expect(prio).toHaveText(`priority ${t106.prio}`);
  await expect(f.getByText('Classified as the plan intends (RoCE data class)', { exact: false })).toBeVisible();

  // The classic mistake: NCCL_IB_TC=26 is DSCP 6, priority 0, lossy.
  await f.getByRole('button', { name: 'NCCL_IB_TC=26 (mistake)' }).click();
  const t26 = trace(6, 2, 'dscp', false, 3, 'cs');
  expect(t26.prio).toBe(0);
  await expect(prio).toHaveText('priority 0');
  for (const p of t26.problems) await expect(f.getByText(p)).toBeVisible();
  await expect(f.getByLabel('ToS byte = NCCL_IB_TC')).toHaveValue('26');

  // Type DSCP 48: the ToS byte keeps the ECN bits (10), so 48 × 4 + 2 = 194 = 0xC2, priority 6 (CNP, strict).
  await f.getByRole('button', { name: 'NCCL_IB_TC=106 (DSCP 26, ECT(0))' }).click();
  const dscp = f.getByLabel('DSCP (0-63)');
  await dscp.fill('48');
  await expect(f.getByLabel('ToS byte = NCCL_IB_TC')).toHaveValue(String(tosOf(48, 2)));
  await expect(f.getByText('0xC2', { exact: true })).toBeVisible();
  await expect(prio).toHaveText(`priority ${trace(48, 2, 'dscp', false, 3, 'cs').prio}`);
  await expect(f.getByText('Classified as the plan intends (CNP class)', { exact: false })).toBeVisible();

  // Trust PCP on an untagged link: every frame lands on the default priority.
  await seg(f, 'Switch trust mode', 'trust pcp').click();
  const tPcp = trace(48, 2, 'pcp', false, 3, 'cs');
  await expect(prio).toHaveText(`priority ${tPcp.prio}`);
  await expect(f.getByText(tPcp.problems[0])).toBeVisible();
});

test('QP state machine: walk RESET to RTS, inject failures, switch to UD', async ({ page }) => {
  const f = await openWidget(page, 'qp-state-machine');
  const current = f.getByText(/^current:/);
  const go = (s: string) => f.getByRole('button', { name: `Modify QP to ${s}`, exact: true });
  const log = f.locator('[aria-live="polite"]').last();

  await expect(current).toHaveText('current: RESET');
  await expect(f.getByRole('button', { name: 'Wrong dest GID' })).toBeDisabled();
  await go('INIT').click();
  await expect(current).toHaveText('current: INIT');
  await go('RTR').click();
  await go('RTS').click();
  await expect(current).toHaveText('current: RTS');
  await expect(f.getByText(/^post_send:/)).toHaveText('post_send: yes');
  await expect(log).toContainText('ibv_modify_qp(RTR → RTS)');

  // A wrong destination GID exhausts the retries: the QP lands in ERR and only RESET is left.
  await f.getByRole('button', { name: 'Wrong dest GID' }).click();
  await expect(current).toHaveText('current: ERR');
  await expect(log).toContainText('IBV_WC_RETRY_EXC_ERR');
  await expect(f.getByRole('button', { name: /^Modify QP to / })).toHaveCount(1);
  await expect(go('RESET')).toBeVisible();
  await go('RESET').click();
  await expect(current).toHaveText('current: RESET');

  // UD: a bad lkey on send moves the QP to SQE (send queue error), not ERR.
  await f.getByRole('button', { name: 'UD', exact: true }).click();
  await expect(log).toContainText('IBV_QPT_UD');
  await go('INIT').click();
  await go('RTR').click();
  await go('RTS').click();
  await f.getByRole('button', { name: 'Bad lkey on send' }).click();
  await expect(current).toHaveText('current: SQE');
  await expect(log).toContainText('IBV_WC_LOC_PROT_ERR');
  await go('RTS').click();
  await expect(current).toHaveText('current: RTS');
});

test('nccl-tests reader: NIC speed, time, collective and a pasted row change busbw and the verdict', async ({ page }) => {
  const f = await openWidget(page, 'nccl-tests-reader');
  const status = f.getByRole('status');
  const TITLE = { latency: 'Latency-bound region', healthy: 'Healthy: close to the first-order ceiling', suspicious: 'Suspicious', bad: 'Bad: far below the ceiling', above: 'Above the ring ceiling' };
  const S = parseSize('8G')!;
  const expectRun = async (coll: 'all_reduce' | 'broadcast', us: number, nic: number) => {
    const a = algbw(S, us), b = a * busFactor(coll, 16);
    const c = ceiling({ coll, n: 16, g: 8, topo: 'multi', nvl: 450, k: 8, nicGbps: nic }).value;
    await expect(out(f, 'algbw = S / t')).toHaveText(`${en(a)} GB/s`);
    await expect(f.getByText(/^busbw = algbw ×/).locator('xpath=following-sibling::*[1]')).toHaveText(`${en(b)} GB/s`);
    await expect(out(f, 'efficiency')).toHaveText(`${en((b / c) * 100, 1)} %`);
    await expect(status).toContainText(TITLE[ncclVerdict(S, b / c)]);
    return ncclVerdict(S, b / c);
  };

  // The built-in sample: 8 GiB all_reduce on 16 ranks in 46.5 ms, 8 × 400G per node: healthy.
  expect(await expectRun('all_reduce', 46500, 400)).toBe('healthy');
  // With 200G NICs the same busbw is above the ring ceiling.
  await f.getByLabel('NIC Gb/s').selectOption('200');
  expect(await expectRun('all_reduce', 46500, 200)).toBe('above');
  // Back to 400G and three times slower: bad.
  await f.getByLabel('NIC Gb/s').selectOption('400');
  await f.getByLabel('Time t (µs, out-of-place)').fill('150000');
  expect(await expectRun('all_reduce', 150000, 400)).toBe('bad');
  // Broadcast has a busbw factor of 1.
  await seg(f, 'Collective (binary *_perf)', 'broadcast').click();
  await expectRun('broadcast', 150000, 400);

  // Paste a 1 GiB data row: size and time are taken from it.
  await seg(f, 'Collective (binary *_perf)', 'all_reduce').click();
  await f.getByLabel('Or paste an nccl-tests data row').fill('  1073741824   268435456  float    sum    -1  6000.0  178.96  335.55      0  5990.0  179.25  336.10      0');
  await f.getByRole('button', { name: 'Parse row' }).click();
  await expect(f.getByLabel('Time t (µs, out-of-place)')).toHaveValue('6000');
  await expect(out(f, 'algbw = S / t')).toHaveText(`${en(algbw(1073741824, 6000))} GB/s`);
});

test('PFC headroom: speed, cable length and port count scale the reserve', async ({ page }) => {
  const f = await openWidget(page, 'headroom-calculator');
  const summary = f.getByText(/PG × \d+ ports =/).locator('..');
  const base: HeadroomInput = { gbps: 400, meters: 100, nsPerM: 5, mtu: 9216, resp: 1000, respUnit: 'ns', margin: 'none', marginPct: 20, cell: 256, pkt: 64 };
  const kb = (b: number) => `${(b / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })} KB`;
  const mb = (b: number) => `${(b / 1e6).toLocaleString('en-US', { maximumFractionDigits: 2 })} MB`;
  const check = async (i: HeadroomInput, ports: number) => {
    const h = headroom(i).total, total = totalReserved(h, 1, ports);
    await expect(summary).toContainText(`${kb(h)} × 1 PG × ${ports} ports = ${mb(total)}`);
    await expect(summary).toContainText(`${((total / 64e6) * 100).toFixed(1)} %`);
    return total / 64e6;
  };

  // The lesson example: 400G, 100 m, 9216 B, 1 µs → 118,432 B per PG per port.
  expect(headroom(base).total).toBe(118432);
  await check(base, 64);
  // Doubling the speed doubles every rate term.
  await seg(f, 'Port speed', '800G').click();
  const at800 = await check({ ...base, gbps: 800 }, 64);
  expect(headroom({ ...base, gbps: 800 }).total).toBeGreaterThan(headroom(base).total);
  // A 3 m cable removes most of the round-trip term.
  await seg(f, 'Cable length (m)', '3').click();
  const short = await check({ ...base, gbps: 800, meters: 3 }, 64);
  expect(short).toBeLessThan(at800);
  // 512 ports reserve most of a 64 MB buffer.
  const ports = f.getByLabel('Ports', { exact: true });
  await ports.fill('512');
  await ports.blur();
  expect(await check({ ...base, gbps: 800, meters: 3 }, 512)).toBeGreaterThan(0.5);
  await expect(summary).toContainText('most of the buffer is idle reserve');
});

test('subnet calculator: examples, typed prefixes and invalid input', async ({ page }) => {
  const f = await openWidget(page, 'subnet-calculator');
  const field = f.getByLabel('IPv4 address / prefix');
  const expectCidr = async (cidr: string) => {
    const p = parseCidr(cidr)!;
    const i = cidrInfo(p.addr, p.len);
    await expect(out(f, 'Network')).toHaveText(`${ipToString(i.network)}/${p.len}`);
    await expect(out(f, 'Broadcast')).toHaveText(i.broadcast === null ? 'none' : ipToString(i.broadcast));
    await expect(out(f, 'First usable')).toHaveText(ipToString(i.first));
    await expect(out(f, 'Last usable')).toHaveText(ipToString(i.last));
    await expect(out(f, 'Usable hosts')).toHaveText(i.usable.toLocaleString('en-US'));
  };

  await expectCidr('10.0.3.77/26');
  // /31 point-to-point (RFC 3021): two usable addresses, no broadcast.
  await f.getByRole('button', { name: '10.0.0.10/31', exact: true }).click();
  await expect(field).toHaveValue('10.0.0.10/31');
  await expectCidr('10.0.0.10/31');
  await expect(out(f, 'Usable hosts')).toHaveText('2');
  await field.fill('192.168.1.130/25');
  await expectCidr('192.168.1.130/25');
  await field.fill('10.0.0.300/24');
  await expect(f.getByRole('alert')).toContainText('Enter an address like');
  await expect(field).toHaveAttribute('aria-invalid', 'true');
});

test('BER and FEC: the FEC choice and the BER slider move the margin to the FEC limit', async ({ page }) => {
  const f = await openWidget(page, 'ber-fec');
  const margin = out(f, 'Margin to quoted limit');
  const decades = (fec: 'kr4' | 'kp4', exp: number) => Math.log10(QUOTED_LIMIT[fec] / 10 ** exp);

  // 400G 4×100G PAM4, RS(544,514) at BER 1e-6.
  await expect(margin).toHaveText(`${decades('kp4', -6).toFixed(1)} decades`);
  // KR4 corrects fewer symbols: less margin, and the widget flags the non-standard pairing.
  await seg(f, 'FEC', 'RS(528,514) "KR4"').click();
  await expect(margin).toHaveText(`${decades('kr4', -6).toFixed(1)} decades`);
  expect(decades('kr4', -6)).toBeLessThan(decades('kp4', -6));
  await expect(f.getByRole('alert')).toContainText('normally uses KP4');
  await seg(f, 'FEC', 'RS(544,514) "KP4"').click();
  await expect(f.getByRole('alert')).toHaveCount(0);
  // The worst BER on the slider (1e-3) is over the KP4 limit.
  const slider = f.getByRole('slider');
  await slider.focus();
  await page.keyboard.press('End');
  await expect(slider).toHaveValue('-3');
  expect(decades('kp4', -3)).toBeLessThan(0);
  await expect(margin).toHaveText(`${(-decades('kp4', -3)).toFixed(1)} over`);
});

test('straggler tail: the slow-event odds and the job size change who waits', async ({ page }) => {
  const f = await openWidget(page, 'straggler-tail');
  const story = f.getByText('Rare per node, certain per step.').locator('..');
  const n50 = (p: number) => workersForProb(p, 0.5).toLocaleString('en-US');
  const n99 = (p: number) => workersForProb(p, 0.99).toLocaleString('en-US');

  await expect(story).toContainText(`from ${n50(1e-3)} workers and 99% from ${n99(1e-3)}`);
  await seg(f, 'Chance one worker has a slow event in a step (p)', '1 in 10,000').click();
  await expect(story).toContainText(`from ${n50(1e-4)} workers and 99% from ${n99(1e-4)}`);
  expect(workersForProb(1e-4, 0.5)).toBeGreaterThan(workersForProb(1e-3, 0.5));

  // The largest job: 32,768 workers, 32,767 healthy GPUs idle behind one slow one.
  const workers = f.getByLabel('Workers (GPUs) in the job');
  await workers.focus();
  await page.keyboard.press('End');
  await expect(workers).toHaveAttribute('aria-valuetext', '32,768 workers');
  await expect(story).toContainText('32,767 healthy GPUs idle');
});

test('fabric sizer: GPUs per server, NIC speed and rail optimisation', async ({ page }) => {
  const f = await openWidget(page, 'fabric-sizer');
  // 1024 GPUs at 8 per server = 128 servers; at 4 per server = 256.
  await expect(out(f, 'Servers')).toHaveText('128');
  await expect(f.getByText('8 rails', { exact: true })).toBeVisible();
  await seg(f, 'GPUs per server', '4').click();
  await expect(out(f, 'Servers')).toHaveText('256');
  await expect(f.getByText('4 rails', { exact: true })).toBeVisible();
  // A 64-port switch is 64 × 400G = 25.6 Tb/s, at 800G 51.2 Tb/s.
  await expect(f.getByText('switch ≈ 25.6 Tb/s (64×400G)')).toBeVisible();
  await seg(f, 'NIC speed', '800G').click();
  await expect(f.getByText('switch ≈ 51.2 Tb/s (64×800G)')).toBeVisible();
  await f.getByLabel('Rail-optimized').uncheck();
  await expect(f.getByText(/^\d+ rails$/)).toHaveCount(0);
  await expect(f.getByText('Leaves', { exact: true })).toBeVisible();
});

test('collective explorer: rank count and collective change buffers and the busbw factor', async ({ page }) => {
  const f = await openWidget(page, 'collective-explorer');
  const factor = f.getByText('nccl-tests busbw factor', { exact: true }).locator('xpath=following-sibling::*[1]');

  await expect(factor).toContainText(`2(n−1)/n = ${busbwFactor('allreduce', 4).toFixed(3)}`);
  await expect(f.getByText('rank 7', { exact: true })).toHaveCount(0);
  await seg(f, 'Ranks n', '8').click();
  await expect(factor).toContainText(`2(n−1)/n = ${busbwFactor('allreduce', 8).toFixed(3)}`);
  await expect(f.getByText('rank 7', { exact: true })).toHaveCount(2); // before and after panels

  await seg(f, 'Collective', 'Broadcast').click();
  await expect(factor).toContainText(`1 = ${busbwFactor('broadcast', 8).toFixed(3)}`);
  await expect(f.getByLabel('Root')).toBeVisible();
  await f.getByLabel('Root').selectOption('3');
  await expect(f.getByText('rank 3*', { exact: true })).toHaveCount(2);

  await seg(f, 'Collective', 'All-gather').click();
  await expect(f.getByLabel('Root')).toHaveCount(0);
  await expect(factor).toContainText(`(n−1)/n = ${busbwFactor('allgather', 8).toFixed(3)}`);
  await expect(f.getByText(`${(sentPerRank('allgather', 8) * 1024).toFixed(1)} MB`, { exact: true })).toBeVisible();
});

test('P_Key membership: presets and a single cell change who can talk', async ({ page }) => {
  const f = await openWidget(page, 'pkey-membership');
  const talking = (a: Assign) => {
    let n = 0;
    for (let i = 0; i < PORTS.length; i++) for (let j = i + 1; j < PORTS.length; j++) if (canTalk(a, PORTS[i].id, PORTS[j].id).ok) n++;
    return `${n} / ${(PORTS.length * (PORTS.length - 1)) / 2}`;
  };
  const preset = (id: string) => PRESETS.find((p) => p.id === id)!;
  const ab = out(f, 'Tenant A ↔ B');
  const pairs = out(f, 'Pairs that can talk');

  // Default design: tenants isolated from each other, both reach storage.
  expect(tenantsIsolated(preset('tenants').assign)).toBe(true);
  await expect(ab).toHaveText('isolated');
  await expect(pairs).toHaveText(talking(preset('tenants').assign));
  await expect(out(f, 'Tenants → storage')).toHaveText('all reach it');

  // Tenants full in the storage partition: A and B now reach each other through it.
  await f.getByRole('button', { name: 'Mistake: tenants full in storage' }).click();
  expect(tenantsIsolated(preset('mistake').assign)).toBe(false);
  await expect(ab).toHaveText('reachable');
  await expect(pairs).toHaveText(talking(preset('mistake').assign));

  // From the tenant design, make B1 a full member of tenant A's partition.
  await f.getByRole('button', { name: 'Tenants, default limited' }).click();
  await expect(ab).toHaveText('isolated');
  await f.getByLabel('B1 membership in tenant_a', { exact: true }).selectOption('full');
  const custom: Assign = { ...preset('tenants').assign, B1: { ...preset('tenants').assign.B1, tenant_a: 'full' } };
  await expect(ab).toHaveText('reachable');
  await expect(pairs).toHaveText(talking(custom));
  await expect(f.getByText('Custom assignment', { exact: false })).toBeVisible();
});

test('Ethernet frame builder: payload, VLAN tag and transport change the frame size', async ({ page }) => {
  const f = await openWidget(page, 'ethernet-frame');
  const frame = out(f, 'Frame (dst MAC..FCS)');
  const size = (o: FrameOptions) => `${buildFrame(o).frame.toLocaleString('en-US')} B`;
  const o: FrameOptions = { vlan: false, l3: 'ipv4', l4: 'udp', roce: true, payload: 1024 };

  await expect(frame).toHaveText(size(o)); // RoCEv2 over IPv4, 1024 B payload
  // An empty RoCE payload is padded up to the 64-byte minimum frame.
  await seg(f, 'Payload presets', '0').click();
  const empty = buildFrame({ ...o, payload: 0 });
  expect(empty.pad).toBeGreaterThan(0);
  await expect(frame).toHaveText('64 B');
  await expect(f.getByText(`padded +${empty.pad} B to 64`)).toBeVisible();
  // The 802.1Q tag adds 4 bytes, enough that no pad is needed.
  await f.getByLabel('802.1Q VLAN tag').check();
  await expect(frame).toHaveText(size({ ...o, payload: 0, vlan: true }));
  await expect(f.getByText(/^padded \+/)).toHaveCount(0);
  await expect(f.getByRole('group', { name: 'Frame segments' })).toContainText('802.1Q');
  // TCP instead of RoCE: no BTH or ICRC.
  await seg(f, 'Transport', 'TCP').click();
  await expect(f.getByText('IPv4/TCP', { exact: true })).toBeVisible();
  await expect(f.getByRole('group', { name: 'Frame segments' })).not.toContainText('BTH');
  await seg(f, 'Payload presets', '1460').click();
  await expect(frame).toHaveText(size({ vlan: true, l3: 'ipv4', l4: 'tcp', roce: false, payload: 1460 }));
});

test('perftest explorer: the real ConnectX-5 overlay and the matching model setup', async ({ page }) => {
  const f = await openWidget(page, 'perftest-explorer');
  const overlay = f.getByRole('button', { name: 'Overlay the measurement', exact: true });
  const match = f.getByRole('button', { name: 'Set the model to this setup', exact: true });
  const measured = f.locator('[data-series="measured"]');
  // Off by default: the setup is described, nothing is drawn.
  await expect(overlay).toHaveAttribute('aria-pressed', 'false');
  await expect(f.getByText(/One pair, one setup, measured on 2026-10-23/)).toBeVisible();
  await expect(measured).toHaveCount(0);
  // Keyboard: Space toggles the overlay on both charts.
  await overlay.focus();
  await page.keyboard.press('Space');
  await expect(overlay).toHaveAttribute('aria-pressed', 'true');
  await expect(measured).toHaveCount(2);
  // The default model (400G) is not the measured setup: the widget says so.
  await expect(f.getByText(/the measurement is 100G RoCEv2 \/ IPv4/)).toBeVisible();
  // Match the model to the measured setup; at 64 KiB compare the tiles with the widget's own math.
  await match.click();
  await expect(match).toHaveAttribute('aria-pressed', 'true');
  await expect(f.getByText(/the measurement is 100G RoCEv2 \/ IPv4/)).toHaveCount(0);
  await expect(seg(f, 'Link data rate', '100G')).toHaveAttribute('aria-pressed', 'true');
  const row = compareSweep(CX5_MODEL).find((r) => r.size === 65536)!;
  await expect(out(f, 'Measured BW at 64 KiB')).toHaveText(`${row.realGbps.toFixed(1)} Gb/s`);
  const dev = deviationPct(row.modelGbps, row.realGbps);
  await expect(f.getByText(`model ${row.modelGbps.toFixed(1)} Gb/s (${dev >= 0 ? '+' : ''}${dev.toFixed(0)} %)`)).toBeVisible();
  await expect(f.getByRole('table', { name: /measured vs this model/ })).toContainText('97.1 Gb/s');
  await expect(f.getByRole('table', { name: /Other runs on the same pair/ })).toContainText('InfiniBand, 4X EDR');
  // Changing a model control leaves the measurement in place but breaks the like-for-like match.
  await seg(f, 'Path MTU (bytes; perftest -m)', '1024').click();
  await expect(match).toHaveAttribute('aria-pressed', 'false');
  await expect(out(f, 'Measured BW at 64 KiB')).toHaveText(`${row.realGbps.toFixed(1)} Gb/s`);
  await overlay.click();
  await expect(measured).toHaveCount(0);
});
