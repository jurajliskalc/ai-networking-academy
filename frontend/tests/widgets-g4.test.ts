// Hand-checked numbers for group 4 widgets: PFC headroom, DSCP mapper, NCCL env explorer,
// nccl-tests reader, troubleshooting tree, counter decoder and telemetry sampling.
import { describe, expect, it } from 'vitest';
import { bytesAt, cellFactor, headroom, totalReserved, type HeadroomInput } from '../src/widgets/HeadroomCalculator';
import { csPriority, dscpName, dscpOf, ecnOf, priorityFor, tosOf, trace } from '../src/widgets/DscpMapper';
import { ibTimeoutUs, matches, parseSpec, SYMPTOMS, VARS } from '../src/widgets/NcclEnvExplorer';
import { algbw, busFactor, ceiling, parseLine, parseSize, verdict } from '../src/widgets/NcclTestsReader';
import { ROOT, TREE } from '../src/widgets/TroubleshootingTree';
import { COUNTERS, HYPOTHESES, PRESETS, rankHypotheses, RULES, ruleFires, type States } from '../src/widgets/CounterDecoder';
import { aboveInterval, BASE, burstAt, fmtUs, generateBursts, readings, summarize, THRESHOLD, type Burst } from '../src/widgets/TelemetrySampling';

describe('HeadroomCalculator', () => {
  const lesson: HeadroomInput = { gbps: 400, meters: 100, nsPerM: 5, mtu: 9216, resp: 1000, respUnit: 'ns', margin: 'none', marginPct: 20, cell: 256, pkt: 64 };
  it('reproduces the buffers-headroom-ets worked example', () => {
    const h = headroom(lesson);
    // cable: 2 × 100 m × 5 ns/m = 1000 ns; 400 Gb/s × 1000 ns = 400 000 bit = 50 000 B
    expect(h.cable).toBe(50_000);
    // response: 400 × 1000 / 8 = 50 000 B; frames: 2 × 9216 = 18 432
    expect(h.response).toBe(50_000);
    expect(h.frames).toBe(18_432);
    expect(h.total).toBe(118_432);
    // 64 ports × 1 PG × 118 432 = 7 579 648 B ≈ 7.6 MB
    expect(totalReserved(h.total, 1, 64)).toBe(7_579_648);
  });
  it('treats bit times and ns consistently, and 2 km gives ~1 MB of cable term', () => {
    // 1000 ns at 400G = 400 000 bit times -> /8 = 50 000 B
    expect(headroom({ ...lesson, resp: 400_000, respUnit: 'bits' }).response).toBe(50_000);
    // 2 × 2000 m × 5 ns/m = 20 µs; 400 Gb/s × 20 µs = 8 Mbit = 1 000 000 B
    expect(headroom({ ...lesson, meters: 2000 }).cable).toBe(1_000_000);
    expect(bytesAt(800, 1000)).toBe(100_000);
  });
  it('applies percent margin and cell rounding', () => {
    expect(headroom({ ...lesson, margin: 'percent' }).total).toBeCloseTo(118_432 * 1.2, 6);
    // 64 B packet in 256 B cells: 256 / (64 + 20) = 3.0476 buffer bytes per wire byte
    expect(cellFactor(64, 256)).toBeCloseTo(256 / 84, 12);
    // (50 000 + 50 000) × 256/84 = 304 761.9; + 2 × 36 cells × 256 = 18 432 -> 323 193.9; round up to 1263 cells = 323 328
    expect(headroom({ ...lesson, margin: 'cells' }).total).toBe(323_328);
  });
});

describe('DscpMapper', () => {
  it('converts DSCP/ECN <-> ToS (RFC 2474 / 3168)', () => {
    expect(tosOf(26, 2)).toBe(106); // 26 << 2 | ECT(0) = 104 + 2
    expect(tosOf(26, 0)).toBe(104);
    expect(tosOf(48, 0)).toBe(192);
    // NCCL_IB_TC=26 = 0b000110_10 -> DSCP 6, ECN 10 = ECT(0), class selector 0
    expect(dscpOf(26)).toBe(6);
    expect(ecnOf(26)).toBe(2);
    expect(csPriority(26)).toBe(3);
    expect(csPriority(48)).toBe(6);
  });
  it('names PHBs', () => {
    expect(dscpName(10)).toBe('AF11'); // 8·1 + 2·1
    expect(dscpName(26)).toBe('AF31'); // 8·3 + 2·1
    expect(dscpName(38)).toBe('AF43'); // 8·4 + 2·3
    expect(dscpName(46)).toBe('EF');
    expect(dscpName(44)).toBe('VOICE-ADMIT');
    expect(dscpName(48)).toBe('CS6');
    expect(dscpName(1)).toBe('LE');
    expect(dscpName(2)).toBe('unassigned / local use');
    expect(dscpName(42)).toBe('unassigned / local use'); // x = 5 is not an AF class
  });
  it('traces the trust pipeline and flags misconfigurations', () => {
    expect(priorityFor(24, 'cs')).toBe(3);
    expect(priorityFor(24, 'roce')).toBe(0);
    const good = trace(26, 2, 'dscp', false, 3, 'roce');
    expect(good).toMatchObject({ prio: 3, lossless: true, ecnEligible: true });
    expect(good.problems).toHaveLength(0);
    const cnp = trace(48, 0, 'dscp', false, 3, 'roce');
    expect(cnp).toMatchObject({ prio: 6, strict: true, lossless: false });
    expect(cnp.problems).toHaveLength(0);
    const mistake = trace(dscpOf(26), ecnOf(26), 'dscp', false, 3, 'cs'); // NCCL_IB_TC=26
    expect(mistake.prio).toBe(0);
    expect(mistake.problems.some((p) => p.includes('not the RoCE DSCP'))).toBe(true);
    const untagged = trace(26, 2, 'pcp', false, 3, 'cs');
    expect(untagged.prio).toBe(0);
    expect(untagged.problems[0]).toMatch(/untagged/);
    expect(trace(26, 0, 'dscp', false, 3, 'cs').problems.some((p) => p.startsWith('Not-ECT'))).toBe(true);
    expect(trace(24, 2, 'dscp', false, 3, 'roce').problems.some((p) => p.includes('maps only DSCP 26'))).toBe(true);
  });
});

describe('NcclEnvExplorer', () => {
  it('implements the documented prefix / = / ^ matcher', () => {
    const pre = parseSpec('mlx5_1');
    expect(matches(pre, 'mlx5_1').selected).toBe(true);
    expect(matches(pre, 'mlx5_10').selected).toBe(true); // documented prefix pitfall
    expect(matches(parseSpec('=mlx5_1'), 'mlx5_10').selected).toBe(false);
    const ex = parseSpec('^=mlx5_10,mlx5_11');
    expect(ex).toMatchObject({ exclude: true, exact: true });
    expect(matches(ex, 'mlx5_10').selected).toBe(false);
    expect(matches(ex, 'mlx5_1').selected).toBe(true);
    const ifn = parseSpec('^docker,lo');
    expect(matches(ifn, 'docker0').selected).toBe(false);
    expect(matches(ifn, 'bond0').selected).toBe(true);
    const port = parseSpec('=mlx5_0:1');
    expect(matches(port, 'mlx5_0', 1).selected).toBe(true);
    expect(matches(port, 'mlx5_0', 2).selected).toBe(false);
    // rail/plane form with an empty port field: mlx5_0::0:0 means all ports
    expect(matches(parseSpec('=mlx5_0::0:0'), 'mlx5_0', 2).selected).toBe(true);
  });
  it('computes the IB local ACK timeout', () => {
    // 4.096 µs × 2^20 = 4 294 967.296 µs ≈ 4.3 s; × 7 retries ≈ 30 s (NCCL docs)
    expect(ibTimeoutUs(20)).toBeCloseTo(4_294_967.296, 3);
    expect(ibTimeoutUs(20) * 7 / 1e6).toBeCloseTo(30.06, 2);
    expect(ibTimeoutUs(14)).toBeCloseTo(67_108.864, 3); // ~67 ms, the pre-2.14 default
    expect(ibTimeoutUs(18) / 1e6).toBeCloseTo(1.07, 2);
  });
  it('has unique variable names and every symptom points at a listed variable', () => {
    const names = VARS.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
    for (const s of SYMPTOMS) for (const v of s.vars) expect(names).toContain(v);
    expect(VARS.find((v) => v.name === 'NCCL_IB_TIMEOUT')!.def).toMatch(/^20/);
    expect(VARS.find((v) => v.name === 'NCCL_IB_QPS_PER_CONNECTION')!.def).toBe('1');
  });
});

describe('NcclTestsReader', () => {
  const SAMPLE = '  8589934592   2147483648  float    sum    -1 46500.0  184.73  346.37      0 46420.0  185.05  346.97      0';
  it('uses the PERFORMANCE.md bus bandwidth factors', () => {
    expect(busFactor('all_reduce', 16)).toBe(1.875); // 2·15/16
    expect(busFactor('all_gather', 8)).toBe(0.875); // 7/8
    expect(busFactor('reduce_scatter', 8)).toBe(0.875);
    expect(busFactor('alltoall', 4)).toBe(0.75);
    expect(busFactor('broadcast', 64)).toBe(1);
    expect(busFactor('reduce', 64)).toBe(1);
  });
  it('parses binary size suffixes like nccl-tests -b/-e', () => {
    expect(parseSize('8G')).toBe(8 * 1024 ** 3);
    expect(parseSize('512M')).toBe(536_870_912);
    expect(parseSize('1KiB')).toBe(1024);
    expect(parseSize('1.5K')).toBe(1536);
    expect(parseSize('4096')).toBe(4096);
    expect(parseSize('8i')).toBeNull();
    expect(parseSize('abc')).toBeNull();
  });
  it('parses a data row and recomputes algbw / busbw', () => {
    const p = parseLine(SAMPLE)!;
    expect(p).toMatchObject({ size: 8589934592, time: 46500, algbw: 184.73, busbw: 346.37 });
    // 8 589 934 592 B / 46 500 µs / 1e3 = 184.73 GB/s; × 1.875 = 346.37
    expect(algbw(8589934592, 46500)).toBeCloseTo(184.73, 2);
    expect(algbw(8589934592, 46500) * busFactor('all_reduce', 16)).toBeCloseTo(346.37, 1);
    // broadcast row with root 0 (time column must not be confused with the root)
    const b = parseLine('   1048576  262144  float  none  0  105.3  9.96  9.96  0  104.9 10.00 10.00 0')!;
    expect(b.time).toBe(105.3);
    expect(parseLine('#       size         count      type   redop    root     time   algbw   busbw')).toBeNull();
  });
  it('computes first-order ceilings and verdicts', () => {
    // 8 × 400 Gb/s / 8 = 400 GB/s per node, below NVLink 450
    expect(ceiling({ coll: 'all_reduce', n: 16, g: 8, topo: 'multi', nvl: 450, k: 8, nicGbps: 400 }).value).toBe(400);
    // all-to-all: per GPU 50 GB/s × (n−1)/(n−g) = 50 × 15/8 = 93.75
    expect(ceiling({ coll: 'alltoall', n: 16, g: 8, topo: 'multi', nvl: 450, k: 8, nicGbps: 400 }).value).toBe(93.75);
    expect(ceiling({ coll: 'all_reduce', n: 8, g: 8, topo: 'single', nvl: 450, k: 8, nicGbps: 400 }).value).toBe(450);
    const big = 8 * 1024 ** 3;
    expect(verdict(big, 346.37 / 400)).toBe('healthy'); // 86.6 %
    expect(verdict(big, 0.7)).toBe('suspicious');
    expect(verdict(big, 0.5)).toBe('bad');
    expect(verdict(big, 1.2)).toBe('above');
    expect(verdict(1024 ** 2, 0.1)).toBe('latency');
  });
});

describe('TroubleshootingTree', () => {
  it('has only valid, acyclic edges and every node is reachable from the root', () => {
    const seen = new Set<string>();
    const walk = (id: string, stack: string[]) => {
      expect(TREE[id], `missing node ${id}`).toBeDefined();
      expect(stack).not.toContain(id);
      seen.add(id);
      const n = TREE[id];
      if (n.kind === 'q') for (const c of n.choices) walk(c.next, [...stack, id]);
    };
    walk(ROOT, []);
    expect([...seen].sort()).toEqual(Object.keys(TREE).sort());
  });
  it('gives every leaf at least two pieces of evidence and a fix', () => {
    for (const [id, n] of Object.entries(TREE)) {
      if (n.kind !== 'leaf') continue;
      expect(n.evidence.length, id).toBeGreaterThanOrEqual(2);
      expect(n.fix.length, id).toBeGreaterThan(10);
    }
  });
  it('uses the verbs status codes correctly', () => {
    const mid = TREE.midrun;
    expect(mid.kind).toBe('q');
    if (mid.kind === 'q') {
      expect(mid.choices[0].label).toMatch(/Status 12: IBV_WC_RETRY_EXC_ERR/);
      expect(mid.choices[1].label).toMatch(/Status 13: IBV_WC_RNR_RETRY_EXC_ERR/);
      expect(mid.body).toMatch(/status 5 \(IBV_WC_WR_FLUSH_ERR\)/);
    }
  });
});

describe('CounterDecoder', () => {
  const st = (rising: string[], flat: string[]): States =>
    Object.fromEntries([...rising.map((c) => [c, 'rising']), ...flat.map((c) => [c, 'flat'])]);
  const preset = (label: string) => { const p = PRESETS.find((x) => x.label === label)!; return rankHypotheses(st(p.rising, p.flat)); };
  it('references only known counters and hypotheses', () => {
    const ids = new Set(COUNTERS.map((c) => c.id));
    const hyps = new Set(HYPOTHESES.map((h) => h.id));
    for (const r of RULES) {
      expect(hyps.has(r.hyp)).toBe(true);
      for (const c of [...(r.rising ?? []), ...(r.anyRising ?? []), ...(r.flat ?? [])]) expect(ids.has(c), c).toBe(true);
    }
    for (const p of PRESETS) for (const c of [...p.rising, ...p.flat]) expect(ids.has(c), c).toBe(true);
    expect(ruleFires({ hyp: 'link', pts: 1, why: 'empty' }, {})).toBe(false);
  });
  it('ranks the presets as intended (hand-summed rule points)', () => {
    // Dirty optic: link 3 (crc/sym) + 1 (oos, no buffer drops) = 4; nopfc 2 (oos/pse)
    expect(preset('Dirty optic').map((r) => [r.hyp.id, r.score])).toEqual([['link', 4], ['nopfc', 2]]);
    // PFC on wrong priority: nopfc 4 + 2 + 2 = 8; deadlock 2 (lat)
    expect(preset('PFC on wrong priority').map((r) => [r.hyp.id, r.score])).toEqual([['nopfc', 8], ['deadlock', 2]]);
    // ECN disabled: noecn 4 (pause, no CNP) + 2 (watermark, no ECN) = 6
    expect(preset('ECN disabled')[0]).toMatchObject({ hyp: { id: 'noecn' }, score: 6 });
    // Host cannot drain: slowrx 3 (txp) + 3 (storm) + 1 (swpfcrx) = 7; storm 3 + 1 + 2 = 6
    expect(preset('Host cannot drain').map((r) => [r.hyp.id, r.score])).toEqual([['slowrx', 7], ['storm', 6]]);
    // Healthy incast: busy 2 + 2 + 1 = 5
    expect(preset('Healthy incast')[0]).toMatchObject({ hyp: { id: 'busy' }, score: 5 });
  });
  it('returns nothing when nothing is marked', () => {
    expect(rankHypotheses({})).toEqual([]);
  });
});

describe('TelemetrySampling', () => {
  const b: Burst = { s: 100, r: 100, d: 200, p: 50 };
  it('models a triangular burst and its above-threshold interval', () => {
    expect(burstAt(b, 150)).toBe(25);
    expect(burstAt(b, 200)).toBe(50);
    expect(burstAt(b, 300)).toBe(25);
    expect(burstAt(b, 400)).toBe(0);
    // threshold 30 % over base 5 % -> 25 above base = half the 50 peak: [100 + 50, 200 + 100]
    expect(THRESHOLD - BASE).toBe(25);
    expect(aboveInterval(b)).toEqual([150, 300]);
  });
  it('computes exact sample, average, watermark and counter readings', () => {
    // one 1000 µs window [0, 1000), read at 1000
    expect(readings([b], 1000, 'sample', 1000)[0]).toBe(5);
    // average: (5 × 1000 + 50 × 300 / 2) / 1000 = (5000 + 7500) / 1000 = 12.5
    expect(readings([b], 1000, 'avg', 1000)[0]).toBeCloseTo(12.5, 10);
    expect(readings([b], 1000, 'max', 1000)[0]).toBe(55);
    // 150 µs above threshold in a 1000 µs window = 15 %
    expect(readings([b], 1000, 'counter', 1000)[0]).toBeCloseTo(15, 10);
  });
  it('detects bursts only when a sample lands inside them', () => {
    // dt 1000: samples at 1000, 2000 ... none in [150, 300]
    expect(summarize([b], 1000, 'sample', readings([b], 1000, 'sample', 2000)).detected).toBe(0);
    // dt 200: sample at 200 sees the apex (55 %)
    const R = readings([b], 200, 'sample', 1000);
    expect(R[0]).toBe(55);
    expect(summarize([b], 200, 'sample', R).detected).toBe(1);
  });
  it('generates threshold-crossing, non-overlapping bursts; watermarks catch all, 10 s samples almost none', () => {
    const bs = generateBursts(7);
    expect(bs.length).toBeGreaterThan(1000);
    for (let i = 0; i < bs.length; i++) {
      expect(BASE + bs[i].p).toBeGreaterThanOrEqual(THRESHOLD);
      if (i) expect(bs[i].s).toBeGreaterThanOrEqual(bs[i - 1].s + bs[i - 1].r + bs[i - 1].d);
    }
    const wm = summarize(bs, 1e7, 'max', readings(bs, 1e7, 'max'));
    expect(wm.peakSeen).toBeCloseTo(wm.truePeak, 6);
    expect(summarize(bs, 1e3, 'max', readings(bs, 1e3, 'max')).detected).toBe(bs.length);
    // 60 samples in 10 minutes can catch at most 60 bursts
    expect(summarize(bs, 1e7, 'sample', readings(bs, 1e7, 'sample')).detected).toBeLessThanOrEqual(60);
  });
  it('formats durations', () => {
    expect(fmtUs(600e6)).toBe('10 min');
    expect(fmtUs(1500)).toBe('1.5 ms');
    expect(fmtUs(2e6)).toBe('2 s');
    expect(fmtUs(250)).toBe('250 µs');
  });
});
