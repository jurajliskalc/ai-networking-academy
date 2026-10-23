// Integrity of the measured ConnectX-5 perftest baselines and of the comparison math in PerftestExplorer.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CX5_BW_SWEEP, CX5_LAT_SWEEP, CX5_MODEL, CX5_RUNS, CX5_SETUP, cx5LargeMessagePct } from '../src/widgets/perftestBaselines';
import { MAX_SIZE, SWEEP, bwBps, compareSweep, deviationPct, latUs } from '../src/widgets/PerftestExplorer';

describe('measured ConnectX-5 baselines', () => {
  it('cover the perftest -a sweep exactly, 2 B to 8 MiB', () => {
    expect(CX5_BW_SWEEP.map((p) => p.size)).toEqual(SWEEP);
    expect(CX5_LAT_SWEEP.map((p) => p.size)).toEqual(SWEEP);
    expect(SWEEP[SWEEP.length - 1]).toBe(MAX_SIZE);
  });

  it('are self-consistent: BW average = size x 8 x MsgRate, within the rounding perftest prints', () => {
    for (const p of CX5_BW_SWEEP) {
      const fromRate = (p.size * 8 * p.mpps * 1e6) / 1e9;
      expect(Math.abs(fromRate - p.bwGbps), `${p.size} B`).toBeLessThan(Math.max(0.006, 0.002 * p.bwGbps));
    }
  });

  it('stay physically plausible for a 100 Gb/s link', () => {
    for (const p of CX5_BW_SWEEP) expect(p.bwGbps).toBeLessThan(CX5_SETUP.linkGbps);
    // Latency only grows with size, t_min <= t_typical, and 8 MiB takes at least its serialization time at 100G.
    CX5_LAT_SWEEP.forEach((p, i) => {
      expect(p.tMinUs).toBeLessThanOrEqual(p.tTypicalUs);
      if (i) expect(p.tTypicalUs).toBeGreaterThanOrEqual(CX5_LAT_SWEEP[i - 1].tTypicalUs);
    });
    const ser8M = (MAX_SIZE * 8) / 100e9 * 1e6; // 671.09 us of payload alone
    expect(CX5_LAT_SWEEP[22].tTypicalUs).toBeGreaterThan(ser8M);
    expect(CX5_LAT_SWEEP[22].tTypicalUs).toBeLessThan(ser8M * 1.2);
    // 8 MiB: 91.22 Gb/s of 100 = 91.2 %
    expect(cx5LargeMessagePct()).toBeCloseTo(91.22, 6);
  });

  it('keep the single runs complete and honest about their setup', () => {
    const ids = CX5_RUNS.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of CX5_RUNS) {
      expect(r.bwGbps ?? r.latTypicalUs, r.id).toBeDefined();
      if (r.bwGbps !== undefined) expect(r.bwGbps).toBeLessThan(r.bidir ? 2 * CX5_SETUP.linkGbps : CX5_SETUP.linkGbps);
      if (r.latTypicalUs !== undefined) expect(r.latMinUs!).toBeLessThanOrEqual(r.latTypicalUs);
      expect(r.command).toMatch(/^ib_write_(bw|lat)|^ib_write_bw \/ ib_write_lat/);
      expect(r.command.includes(`-q ${r.qps}`) || r.qps === 1).toBe(true);
      expect(r.command.includes('-b') === r.bidir).toBe(true);
      if (r.mtu !== 4096) expect(r.command).toContain(`-m ${r.mtu}`);
    }
    // path MTU 1024 vs 4096 at 4 KiB, 64 KiB and 1 MiB; RoCE vs InfiniBand; 1 vs 4 QPs; bidirectional
    for (const s of [4096, 65536, 1048576]) for (const m of [1024, 4096]) expect(CX5_RUNS.some((r) => r.group === 'mtu' && r.size === s && r.mtu === m)).toBe(true);
    expect(CX5_RUNS.filter((r) => r.group === 'transport').map((r) => r.transport).sort()).toEqual(['ib', 'roce4']);
    expect(CX5_RUNS.filter((r) => r.group === 'qps').map((r) => r.qps)).toEqual([1, 4]);
    expect(CX5_RUNS.some((r) => r.bidir)).toBe(true);
  });

  it('match the numbers recorded in docs/HARDWARE_VERIFICATION.md', () => {
    const doc = fs.readFileSync(path.resolve(__dirname, '../../docs/HARDWARE_VERIFICATION.md'), 'utf8');
    expect(doc).toContain('0.83 us minimum write latency');
    expect(CX5_RUNS.find((r) => r.id === 'ib')!.latMinUs).toBe(0.83);
    expect(doc).toMatch(/94\.8-97\.2 Gb\/s write/);
    expect(CX5_RUNS.find((r) => r.id === 'ib')!.bwGbps).toBeCloseTo(94.8, 0);
    expect(doc).toContain(CX5_SETUP.date);
  });
});

describe('model vs measurement', () => {
  it('compares every sweep size with the model', () => {
    const rows = compareSweep(CX5_MODEL);
    expect(rows).toHaveLength(23);
    expect(rows[15]).toEqual({ size: 65536, realGbps: 97.13, modelGbps: bwBps(65536, CX5_MODEL) / 1e9, realUs: 9.38, modelUs: latUs(65536, CX5_MODEL) });
    // 64 KiB at 100G RoCEv2/IPv4, MTU 4096: 100e9 x 65536 / 66864 wire bytes = 98.01 Gb/s, 2 % above the measured 97.13
    expect(rows[15].modelGbps).toBeCloseTo((100 * 65536) / 66_864, 6);
    expect(deviationPct(rows[15].modelGbps, rows[15].realGbps)).toBeCloseTo(0.91, 1);
    // 2 B with a 5 M msgs/s ceiling: 2 x 8 x 5e6 = 0.08 Gb/s vs 0.0773 measured
    expect(rows[0].modelGbps).toBeCloseTo(0.08, 9);
    // latency at 2 B: alpha 0.9 + 102 x 8 / 100e9 s = 0.90816 us vs 0.89 measured
    expect(rows[0].modelUs).toBeCloseTo(0.90816, 6);
  });
  it('signs the deviation: positive when the model is above the measurement', () => {
    expect(deviationPct(110, 100)).toBeCloseTo(10, 9);
    expect(deviationPct(90, 100)).toBeCloseTo(-10, 9);
  });
  it('sets the model to the measured setup', () => {
    expect(CX5_MODEL).toEqual({ t: 'roce4', mtu: 4096, gbps: 100, alphaUs: 0.9, mrM: 5 });
  });
});
