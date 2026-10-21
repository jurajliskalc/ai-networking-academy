// Every simulator lab must (1) be broken before the fix, (2) pass all checks after its documented fix,
// and (3) produce the symptom its ticket describes. This is what keeps the labs honest.
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { CHECKS, createFabric, evaluateAllReduce, FAULT_TYPES } from '../src/sim/fabric';
import { exec } from '../src/sim/shell';
import { labState, parseFixLine, runChecks } from '../src/sim/lab';
import type { SimLab } from '../src/types';

const dir = path.resolve(__dirname, '../../content/labs/sim');
const labs = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'))
  .map((f) => yaml.load(fs.readFileSync(path.join(dir, f), 'utf8')) as SimLab & { fix: string[] });

/** Peak out-of-place busbw from an nccl-tests table (column 8), or 0 if no rows were printed. */
function peakBusbw(out: string): number {
  const rows = out.split('\n').filter((l) => /^\s+\d+\s+\d+\s+float/.test(l));
  return Math.max(0, ...rows.map((l) => Number(l.trim().split(/\s+/)[7])));
}

describe('healthy fabric', () => {
  it('prints a full nccl-tests sweep up to 8 GB with ~372 GB/s peak busbw', () => {
    const out = exec({ state: createFabric(), host: 'node01' }, 'all_reduce_perf -b 8 -e 8G -f 2 -g 1').out;
    expect(out).toMatch(/maxBytes 8589934592/);
    expect(out.match(/^\s+8589934592\s/m)).not.toBeNull();
    expect(peakBusbw(out)).toBeGreaterThan(360);
    expect(peakBusbw(out)).toBeLessThan(380);
  });

  it('runs all_reduce above 360 GB/s on IB', () => {
    const r = evaluateAllReduce(createFabric());
    expect(r.ok).toBe(true);
    expect(r.transport).toBe('IB');
    expect(r.busbw).toBeGreaterThan(360);
  });
  it('reaches line rate point to point', () => {
    expect(CHECKS.ib_write_bw_min(createFabric(), { node: 'node01', rail: 0, peer: 'node02', value: 390 })).toBe(true);
  });
});

describe.each(labs.map((l) => [l.id, l] as const))('%s', (_id, lab) => {
  it('uses known fault types and checks', () => {
    for (const f of lab.faults) expect(FAULT_TYPES).toContain(f.type);
    for (const c of lab.checks) expect(Object.keys(CHECKS)).toContain(c.check);
    expect(lab.diagnosis.options.filter((o) => o.correct)).toHaveLength(1);
  });

  if (lab.checks.length) {
    it('is broken before the fix', () => {
      const s = labState(lab.faults);
      expect(runChecks(s, lab.checks).some((r) => !r.pass)).toBe(true);
      expect(CHECKS.allreduce_min_busbw(s, { value: 360 })).toBe(false);
    });
    it('passes all checks after the documented fix', () => {
      const s = labState(lab.faults);
      for (const line of lab.fix) {
        const { host, cmd } = parseFixLine(line);
        const out = exec({ state: s, host }, cmd).out;
        expect(out).not.toMatch(/command not found|usage:|Error:|Invalid/);
      }
      const failed = runChecks(s, lab.checks).filter((r) => !r.pass).map((r) => r.check.description);
      expect(failed).toEqual([]);
    });
  }
});

describe('symptoms', () => {
  const lab = (id: string) => labs.find((l) => l.id === id)!;
  const node01 = (s: ReturnType<typeof labState>, cmd: string, host = 'node01') => exec({ state: s, host }, cmd).out;

  it('MTU black hole fails with a retry-exceeded completion and ping -M do shows it', () => {
    const s = labState(lab('sim-01-mtu-blackhole').faults);
    expect(node01(s, 'all_reduce_perf -b 8 -e 8G -f 2 -g 1')).toMatch(/status=12/);
    expect(node01(s, 'ping -M do -s 8972 -c 1 10.2.2.1')).toMatch(/100% packet loss/);
    expect(node01(s, 'ping -M do -s 1400 -c 1 10.2.2.1')).toMatch(/ 0% packet loss/);
  });

  it('PFC mismatch: point-to-point is fast, the collective is slow, pause counters move', () => {
    const s = labState(lab('sim-03-pfc-priority-mismatch').faults);
    expect(node01(s, 'ib_write_bw -d mlx5_5 -x 3 --report_gbits node01', 'node03')).toMatch(/391\.\d+/);
    const ar = node01(s, 'all_reduce_perf -b 8 -e 8G -f 2 -g 1');
    expect(peakBusbw(ar)).toBeGreaterThan(100);
    expect(peakBusbw(ar)).toBeLessThan(150);
    expect(node01(s, 'ethtool -S enp170s0np0 | grep rx_prio3_pause', 'node03')).toMatch(/rx_prio3_pause: [1-9]\d{4,}/);
  });

  it('PCIe downtrain caps one NIC', () => {
    const s = labState(lab('sim-06-pcie-downtrain').faults);
    const out = node01(s, 'ib_write_bw -d mlx5_6 --report_gbits node01', 'node04');
    const bw = Number(out.match(/65536\s+5000\s+[\d.]+\s+([\d.]+)/)![1]);
    expect(bw).toBeGreaterThan(200);
    expect(bw).toBeLessThan(240);
    expect(node01(s, 'lspci -vv -s cc:00.0 | grep LnkSta', 'node04')).toMatch(/x8 \(downgraded\)/);
  });

  it('IB disabled falls back to sockets', () => {
    const s = labState(lab('sim-09-ib-disabled').faults);
    node01(s, "sed -i 's/NCCL_DEBUG=WARN/NCCL_DEBUG=INFO/' /etc/nccl.conf");
    expect(node01(s, 'all_reduce_perf -b 8 -e 1G')).toMatch(/Using network Socket/);
  });

  it('stages switch config until nv config apply', () => {
    const s = labState(lab('sim-01-mtu-blackhole').faults);
    node01(s, 'nv set interface swp2 link mtu 9216', 'leaf03');
    expect(s.switches.leaf03.ports.swp2.mtu).toBe(1500);
    expect(node01(s, 'nv config diff', 'leaf03')).toMatch(/mtu: 9216/);
    node01(s, 'nv config apply -y', 'leaf03');
    expect(s.switches.leaf03.ports.swp2.mtu).toBe(9216);
  });

  it('supports pipes', () => {
    const s = createFabric();
    expect(node01(s, 'ibdev2netdev | grep -c Up')).toBe('8\n');
  });
});
