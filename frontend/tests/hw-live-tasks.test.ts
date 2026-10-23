// Live counters (rates from /api/live snapshots), the review rules learned on the ConnectX-5 hosts, and
// per-task check results ("resume at Task N").
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import type { HwVariable } from '../src/types';
import { defaults, type Profile } from '../src/hw/profile';
import { cmpVersion, parseReport, review, type Report } from '../src/hw/report';
import { fromPastedText, mergeChecks, mergeTasks, parseCheckJson, parseCheckLines, taskView, tocTasks } from '../src/hw/checks';
import { advance, describeChange, emptyLive, flagsOf, fmtRate, liveRates, parseLive, pauseRate, type LiveSnapshot } from '../src/hw/live';
import real from './fixtures/real-report-cx5-doca.json';
import demo from '../src/hw/demo-report.json';

const ROOT = path.resolve(__dirname, '..', '..');
const VARS = (yaml.load(fs.readFileSync(path.join(ROOT, 'content/hardware/hardware.yaml'), 'utf8')) as { variables: HwVariable[] }).variables;
const P = defaults(VARS);
const REAL_P: Profile = { ...P, A_RDMA_DEV: 'mlx5_0', B_RDMA_DEV: 'mlx5_0', A_NETDEV: 'ens64f0np0', B_NETDEV: 'ens64f0np0', A_IP: '10.10.10.1', B_IP: '10.10.10.2', MTU: '9000' };
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const NOW = new Date('2026-10-23');
const ids = (r: Report, p = REAL_P) => review(r, p, NOW).map((f) => `${f.severity}:${f.id}`);
const find = (r: Report, id: string, p = REAL_P) => review(r, p, NOW).filter((f) => f.id === id);

// ------------------------------------------------------------------ live

const snap = (t: number, c: Record<string, number>, host = 'host-a'): LiveSnapshot => ({
  schema: 'aina.hw.live/1', host, role: 'A', t, prio: 3,
  ports: [{ dev: 'mlx5_0', port: 1, netdev: 'ens64f0np0', state: 'ACTIVE', phys_state: 'LinkUp', rate_gbps: 100, link_layer: 'Ethernet', operstate: 'up', counters: c }],
});

describe('live rates', () => {
  it('computes Gb/s and events per second from deltas', () => {
    // 12.5 GB in 1 s = 100 Gb/s; 500 pauses over 2 s = 250/s (numbers as moved on the reference hosts: ~81 Gb/s)
    const r = liveRates(snap(10, { tx_vport_rdma_unicast_bytes: 0, rx_prio3_pause: 0 }), snap(11, { tx_vport_rdma_unicast_bytes: 12.5e9, rx_prio3_pause: 250 })).get('mlx5_0/1')!;
    expect(r.rdma_tx_gbps).toBeCloseTo(100);
    expect(r.pfc_rx_ps).toBe(250);
    expect(r.cnp_sent_ps).toBeNull(); // absent counter
    expect(liveRates(snap(10, { rx_global_pause: 0 }), snap(12, { rx_global_pause: 500 })).get('mlx5_0/1')!.global_pause_rx_ps).toBe(250);
  });

  it('never reports a negative rate or one over a zero interval', () => {
    expect(liveRates(snap(10, { out_of_sequence: 50 }), snap(11, { out_of_sequence: 3 })).get('mlx5_0/1')!.oos_ps).toBeNull();
    expect(liveRates(snap(10, { out_of_sequence: 1 }), snap(10, { out_of_sequence: 9 })).get('mlx5_0/1')!.oos_ps).toBeNull();
    expect(liveRates(snap(10, {}), snap(11, {}, 'other')).size).toBe(0);
    expect(liveRates(null, snap(1, {})).size).toBe(0);
  });

  it('converts InfiniBand 4-octet data words', () => {
    expect(liveRates(snap(0, { port_xmit_data: 0 }), snap(1, { port_xmit_data: 250e6 })).get('mlx5_0/1')!.ib_tx_gbps).toBeCloseTo(8);
  });

  it('folds responses, skipping a remote snapshot seen twice', () => {
    const res = (a: LiveSnapshot, b?: LiveSnapshot) => parseLive({ schema: 'aina.hw.live/1', generated: '', prio: 3, remote: !!b, hosts: [{ role: 'A', ok: true, error: null, snapshot: a }, ...(b ? [{ role: 'B', ok: true, error: null, snapshot: { ...b, role: 'B' } }] : [])] });
    let s = emptyLive();
    s = advance(s, res(snap(1, { tx_vport_rdma_unicast_bytes: 0 }), snap(100, { rx_vport_rdma_unicast_bytes: 0 }, 'host-b')));
    expect(Object.keys(s.history)).toEqual([]);
    s = advance(s, res(snap(2, { tx_vport_rdma_unicast_bytes: 10e9 }), snap(100, { rx_vport_rdma_unicast_bytes: 0 }, 'host-b')));
    expect(s.history['A mlx5_0/1']).toHaveLength(1);
    expect(s.history['B mlx5_0/1']).toBeUndefined(); // same remote sample: no zero-length interval
    s = advance(s, res(snap(3, { tx_vport_rdma_unicast_bytes: 20e9 }), snap(102, { rx_vport_rdma_unicast_bytes: 20e9 }, 'host-b')));
    expect(s.history['B mlx5_0/1'][0].r.rdma_rx_gbps).toBeCloseTo(80);
    for (let i = 4; i < 80; i++) s = advance(s, res(snap(i, { tx_vport_rdma_unicast_bytes: i * 10e9 })));
    expect(s.history['A mlx5_0/1']).toHaveLength(60);
    expect(s.ports['B mlx5_0/1'].host).toBe('host-b');
  });

  it('rejects other JSON and formats readouts', () => {
    expect(() => parseLive({ schema: 'aina.hw.agent/1' })).toThrow(/live response/);
    expect(parseLive({ schema: 'aina.hw.live/1', hosts: [{ role: 'B', ok: false, error: 'Permission denied', snapshot: null }] }).hosts[0]).toEqual({ role: 'B', ok: false, error: 'Permission denied', snapshot: null });
    expect([fmtRate(81.234, 'gbps'), fmtRate(0.11, 'gbps'), fmtRate(0, 'gbps'), fmtRate(1791.4, 'ps'), fmtRate(3.3, 'ps'), fmtRate(null, 'ps')]).toEqual(['81.2 Gb/s', '0.11 Gb/s', '0.00 Gb/s', '1.8k/s', '3.3/s', 'n/a']);
  });

  it('prefers PFC pause counters and falls back to global pause', () => {
    const r = liveRates(snap(0, { rx_global_pause: 0, tx_prio3_pause: 0 }), snap(1, { rx_global_pause: 7, tx_prio3_pause: 2 })).get('mlx5_0/1')!;
    expect(pauseRate(r, 'rx')).toEqual({ value: 7, kind: 'global' });
    expect(pauseRate(r, 'tx')).toEqual({ value: 2, kind: 'pfc' });
  });

  it('announces transitions only', () => {
    const quiet = flagsOf(undefined);
    const busy = { ...quiet, traffic: true, pause: true };
    expect(describeChange('Host B mlx5_0/1', quiet, busy)).toBe('Host B mlx5_0/1: traffic started, pause frames started.');
    expect(describeChange('x', busy, busy)).toBeNull();
  });
});

// ------------------------------------------------------------------ review rules

describe('review rules from the reference hardware', () => {
  const r = parseReport(real);

  it('reads the real report (DOCA, RoCE port 1 + InfiniBand port 2, default QoS)', () => {
    const got = ids(r);
    expect(got).toEqual(expect.arrayContaining(['warn:trust', 'warn:fw-mismatch', 'info:pfc', 'info:global-pause', 'info:umad-first']));
    expect(got.filter((x) => x.startsWith('error:'))).toEqual([]);
    expect(got).not.toContain('info:lockdown'); // Secure Boot was off when this was collected
    expect(got).not.toContain('warn:roce-tos'); // kernel default ToS on a lossy setup: nothing to align
  });

  it('global pause on with PFC off: default, informational, with the counters it saw', () => {
    const f = find(r, 'global-pause')[0];
    expect(f.detail).toMatch(/rx_global_pause/);
    expect(f.fix).toMatch(/silently clears PFC/);
  });

  it('no flow control at all, and a mismatch between the hosts', () => {
    const x = clone(r);
    x.hosts[1].netdevs[0].pause = { autonegotiate: false, rx: false, tx: false };
    expect(find(x, 'no-flow-control')[0]?.severity).toBe('warn');
    expect(find(x, 'no-flow-control')[0]?.detail).toMatch(/out_of_sequence \+30 and np_cnp_sent \+17/);
    expect(ids(x)).toContain('warn:flow-control-mismatch');
  });

  it('PFC on while ethtool -a still shows global pause', () => {
    const x = clone(r);
    for (const h of x.hosts) h.netdevs[0].qos!.pfc_enabled = [3];
    expect(find(x, 'pfc-global-pause')).toHaveLength(2);
    for (const h of x.hosts) h.netdevs[0].pause = { autonegotiate: false, rx: false, tx: false };
    expect(find(x, 'pfc-global-pause')).toHaveLength(0);
    expect(find(x, 'no-flow-control')).toHaveLength(0);
  });

  it('trust and DSCP mapping must match between hosts', () => {
    const x = clone(r);
    x.hosts[0].netdevs[0].qos = { source: 'mlnx_qos', trust: 'dscp', pfc_enabled: [3], dscp_prio: { '26': 3 } };
    expect(find(x, 'trust-mismatch')[0]?.severity).toBe('error'); // PFC is on somewhere: traffic leaves the lossless priority
    x.hosts[1].netdevs[0].qos = { source: 'mlnx_qos', trust: 'dscp', pfc_enabled: [3], dscp_prio: { '26': 4 } };
    expect(find(x, 'trust-mismatch')).toHaveLength(0);
    expect(find(x, 'dscp-map-mismatch')[0]?.severity).toBe('error');
  });

  it('rdma_cm default ToS against the profile traffic class', () => {
    const x = clone(r);
    const port = x.hosts[0].rdma[0].ports[0];
    port.rdma_cm = { configured: true, default_roce_tos: 106, default_roce_mode: 'RoCE v2' };
    expect(find(x, 'roce-tos')).toHaveLength(0);
    port.rdma_cm.default_roce_tos = 96;
    expect(find(x, 'roce-tos')[0]?.title).toMatch(/is 96, profile traffic class is 106/);
    port.rdma_cm = { configured: false, default_roce_tos: null, default_roce_mode: null };
    x.hosts[0].netdevs[0].qos!.pfc_enabled = [3];
    const f = find(x, 'roce-tos')[0];
    expect(f.title).toMatch(/0 \(kernel default\)/);
    expect(f.fix).toContain('/sys/kernel/config/rdma_cm/mlx5_0/ports/1/default_roce_tos');
  });

  it('memlock: 8192 KiB is the verified failure, other limits are a hint', () => {
    const x = clone(r);
    x.hosts[0].host.memlock = '8192';
    expect(find(x, 'memlock')[0]).toMatchObject({ severity: 'warn' });
    expect(find(x, 'memlock')[0].detail).toMatch(/Couldn't allocate MR/);
    x.hosts[0].host.memlock = '65536';
    expect(find(x, 'memlock')[0].severity).toBe('info');
  });

  it('mixed firmware names the newest version, like ibdiagnet', () => {
    expect(['16.34.1002', '16.29.1016', '16.4.1'].sort(cmpVersion)).toEqual(['16.4.1', '16.29.1016', '16.34.1002']);
    expect(find(r, 'fw-mismatch')[0].detail).toContain('has FW version 16.29.1016 while the latest FW version for the same Devid/PSID on this fabric is 16.34.1002');
  });

  it('kernel lockdown', () => {
    const x = clone(r);
    x.hosts[0].host.lockdown = 'integrity';
    x.hosts[0].host.secure_boot = true;
    const f = find(x, 'lockdown')[0];
    expect(f.title).toBe('Kernel lockdown is on (integrity), Secure Boot enabled');
    expect(f.fix).toMatch(/fwctl0/);
  });

  it('umad first device only on hosts with RoCE and InfiniBand ports, when the first one is RoCE', () => {
    expect(find(r, 'umad-first')[0].fix).toContain('sminfo -C mlx5_1 -P 1');
    const x = clone(r);
    x.hosts[0].umad = [{ name: 'umad0', ibdev: 'mlx5_1', port: 1 }, { name: 'umad1', ibdev: 'mlx5_0', port: 1 }];
    expect(find(x, 'umad-first').map((f) => f.where)).toEqual([find(r, 'umad-first')[1].where]);
    expect(ids(parseReport(demo), P)).not.toContain('info:umad-first');
  });

  it('InfiniBand port in INIT and IPoIB down', () => {
    const x = clone(r);
    const ib = x.hosts[0].rdma[1].ports[0];
    Object.assign(ib, { state: 'INIT', lid: 65535, sm_lid: 0 });
    x.hosts[0].netdevs[1].operstate = 'down';
    expect(find(x, 'ib-init')[0]).toMatchObject({ severity: 'info', title: 'mlx5_1/1 (InfiniBand) is INIT: no subnet manager' });
    expect(find(x, 'ib-init', { ...REAL_P, FABRIC: 'ib' })[0].severity).toBe('warn');
    expect(find(x, 'ib-init')[0].detail).toContain('65535');
    expect(find(x, 'ipoib-down')).toHaveLength(0); // RoCE profile: the IPoIB port is not the lab's
    const ibp = { ...REAL_P, FABRIC: 'ib', A_RDMA_DEV: 'mlx5_1', B_RDMA_DEV: 'mlx5_1', A_NETDEV: 'ibs64f1', B_NETDEV: 'ibs64f1' };
    expect(find(x, 'port-state', ibp)[0].detail).toContain('Port number 1 state is Init');
    expect(find(x, 'ipoib-down', ibp)[0].title).toBe('IPoIB interface ibs64f1 is down');
    // An ACTIVE IB port whose LID is still 0xffff has no SM-assigned address.
    Object.assign(ib, { state: 'ACTIVE', lid: 65535, sm_lid: 1 });
    expect(find(x, 'ib-no-sm', ibp)).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ per-task results

const OUT = 'PASS: tools\nTASK: 1 Prove the IP path\nPASS: mtu\nTASK: 2 GIDs\nFAIL: no gid\nTASK: 5 Bandwidth\nINFO: x\n';
const TOC = [{ depth: 2, text: 'Tasks' }, { depth: 3, text: 'Task 1: Prove the IP path and the MTU first' }, { depth: 3, text: 'Task 2: Inspect the RDMA port' },
  { depth: 3, text: 'Task 3: An RC ping-pong' }, { depth: 3, text: 'Task 5 (optional): the vendor view with `mlxlink`' }, { depth: 2, text: 'Verify' }];
const rec = (over: Record<string, unknown>) => parseCheckJson({ schema: 'aina.hw.check/1', lab: 'hw-02', host: 'a', finished: '2026-10-23T10:00:00Z', exit_code: 1, results: parseCheckLines(OUT), tasks: [{ n: 1, title: 'Prove the IP path' }, { n: 2, title: 'GIDs' }, { n: 5, title: 'Bandwidth', status: 'PASS' }], ...over });

describe('per-task check results', () => {
  it('parses TASK markers and recomputes task status', () => {
    const r = rec({});
    expect(r.tasks.map((t) => `${t.n}:${t.status}`)).toEqual(['0:PASS', '1:PASS', '2:FAIL', '5:NONE']); // 5 claimed PASS in the file: recomputed
    expect(fromPastedText('hw-02', OUT).tasks.map((t) => t.n)).toEqual([0, 1, 2, 5]);
    expect(parseCheckJson({ schema: 'aina.hw.check/1', lab: 'x', results: [{ status: 'PASS', text: 'a' }] }).tasks).toEqual([]); // toolkit 1.0 record
  });

  it('a single-task run is never a verified lab and does not replace the full run', () => {
    const part = rec({ only_task: 2, finished: '2026-10-23T11:00:00Z', exit_code: 0, results: [{ status: 'PASS', text: 'tools' }, { status: 'PASS', text: 'gid', task: 2 }] });
    expect(part.passed).toBe(false);
    const full = rec({});
    expect(mergeChecks({}, [full, part])['hw-02']).toBe(full);
  });

  it('merges per-task progress and finds where to resume', () => {
    const full = rec({});
    let st = mergeTasks({}, [full]);
    let v = taskView(TOC, st['hw-02']);
    expect(tocTasks(TOC).map((t) => t.n)).toEqual([1, 2, 3, 5]);
    expect(tocTasks(TOC)[3].title).toBe('the vendor view with `mlxlink`');
    expect(v.items.map((i) => `${i.n}:${i.status}`)).toEqual(['1:PASS', '2:FAIL', '3:unchecked', '5:NONE']);
    expect(v.resume).toBe(2);
    // learner fixes task 2 and reruns only that task
    const part = rec({ only_task: 2, finished: '2026-10-23T11:00:00Z', exit_code: 0, results: [{ status: 'PASS', text: 'tools' }, { status: 'PASS', text: 'gid', task: 2 }] });
    st = mergeTasks(st, [part]);
    v = taskView(TOC, st['hw-02']);
    expect(v.items.find((i) => i.n === 2)?.status).toBe('PASS');
    expect(v.items.find((i) => i.n === 2)?.entry?.partial).toBe(true);
    expect(v.resume).toBeNull();
    // an older full run does not undo that; a newer one replaces everything
    expect(mergeTasks(st, [rec({ finished: '2026-10-22T00:00:00Z' })])).toEqual(st);
    // As aina-hw writes it when check_ssh fails: TASKS declared, no marker reached.
    const prereqFail = rec({ finished: '2026-10-24T00:00:00Z', results: [{ status: 'FAIL', text: 'SSH to host B' }], tasks: [{ n: 0, title: 'Before you start', status: 'FAIL' }, { n: 1, title: '', status: 'NOTRUN' }, { n: 2, title: '', status: 'NOTRUN' }, { n: 5, title: '', status: 'NOTRUN' }] });
    expect(prereqFail.tasks.map((t) => t.status)).toEqual(['FAIL', 'NOTRUN', 'NOTRUN', 'NOTRUN']);
    expect(fromPastedText('x', 'TASKS: 1 2\nFAIL: ssh').tasks.map((t) => t.status)).toEqual(['FAIL', 'NOTRUN', 'NOTRUN']);
    st = mergeTasks(st, [prereqFail]);
    v = taskView(TOC, st['hw-02']);
    expect(v.pre?.status).toBe('FAIL');
    expect(v.items.every((i) => i.status === 'notrun')).toBe(true);
    expect(v.resume).toBe(0);
    expect(taskView(TOC, undefined)).toMatchObject({ any: false, resume: null });
  });
});
