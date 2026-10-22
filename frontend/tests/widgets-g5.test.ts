// Hand-checked numbers for group 5 widgets: rail path explorer, GPU bandwidth ladder and pipeline schedules.
import { describe, expect, it } from 'vitest';
import { GPUS, NODES, railPath, suOf, type Fabric, type Gpu } from '../src/widgets/RailPathExplorer';
import { hostDirGBs, ladder, logPos, moveSeconds, PLATFORMS } from '../src/widgets/BandwidthLadder';
import { NV_GENS } from '../src/widgets/NvlinkGenerations';
import { boundaryBytesPerStep, bubbleFormula, bubbleOverIdeal, p2pBytes, simulate, stageOrder, type Sched } from '../src/widgets/PipelineSchedule';

const one: Fabric = { layout: '1su', spine: true, pxn: false };
const g = (node: number, gpu: number): Gpu => ({ node, gpu });

describe('RailPathExplorer', () => {
  it('same node: one NVLink hop through the NVSwitch, no NIC, no switch', () => {
    const p = railPath(one, g(0, 2), g(0, 5));
    expect(p.kind).toBe('nvlink');
    expect([p.switchHops, p.nvlinkHops, p.pcieHops, p.netLinks]).toEqual([0, 1, 0, 0]);
    expect(p.egressRail).toBeNull();
  });
  it('same rail, same SU: GPU -> NIC -> rail leaf -> NIC -> GPU, one switch', () => {
    const p = railPath(one, g(0, 3), g(1, 3));
    expect(p.kind).toBe('rail');
    expect(p.elems.map((e) => e.t)).toEqual(['gpu', 'nic', 'leaf', 'nic', 'gpu']);
    // 1 switch, 2 cables (NIC-leaf, leaf-NIC), 2 PCIe crossings (GPU-NIC at each end)
    expect([p.switchHops, p.netLinks, p.pcieHops, p.spine]).toEqual([1, 2, 2, false]);
    // PXN changes nothing when the rails already match
    expect(railPath({ ...one, pxn: true }, g(0, 3), g(1, 3))).toEqual(p);
  });
  it('cross-rail without PXN goes leaf -> spine -> leaf (3 switches, 4 cables)', () => {
    const p = railPath(one, g(0, 2), g(1, 5));
    expect(p.kind).toBe('cross-spine');
    expect(p.elems.map((e) => e.t)).toEqual(['gpu', 'nic', 'leaf', 'spine', 'leaf', 'nic', 'gpu']);
    expect([p.switchHops, p.netLinks, p.nvlinkHops, p.spine, p.egressRail]).toEqual([3, 4, 0, true, 2]);
    expect(p.elems[2]).toEqual({ t: 'leaf', su: 0, rail: 2 });
    expect(p.elems[4]).toEqual({ t: 'leaf', su: 0, rail: 5 });
  });
  it('cross-rail with PXN: NVLink to the GPU on the destination rail, then that NIC, one switch', () => {
    const p = railPath({ ...one, pxn: true }, g(0, 2), g(1, 5));
    expect(p.kind).toBe('pxn');
    expect(p.relay).toEqual({ node: 0, gpu: 5 });
    expect(p.egressRail).toBe(5);
    expect(p.elems).toEqual([
      { t: 'gpu', node: 0, gpu: 2 }, { t: 'nvswitch', node: 0 }, { t: 'gpu', node: 0, gpu: 5 },
      { t: 'nic', node: 0, rail: 5 }, { t: 'leaf', su: 0, rail: 5 }, { t: 'nic', node: 1, rail: 5 }, { t: 'gpu', node: 1, gpu: 5 },
    ]);
    expect([p.switchHops, p.nvlinkHops, p.spine]).toEqual([1, 1, false]);
  });
  it('another SU needs the spine even on the same rail; PXN removes the rail change, not the SU change', () => {
    const two: Fabric = { layout: '2su', spine: true, pxn: false };
    expect([suOf('2su', 0), suOf('2su', 1), suOf('2su', 2), suOf('2su', 3)]).toEqual([0, 0, 1, 1]);
    const same = railPath(two, g(0, 3), g(3, 3));
    expect([same.kind, same.switchHops, same.spine]).toEqual(['rail-spine', 3, true]);
    const px = railPath({ ...two, pxn: true }, g(0, 2), g(3, 5));
    expect([px.kind, px.switchHops, px.nvlinkHops]).toEqual(['pxn-spine', 3, 1]);
  });
  it('rail-only (no spine): cross-rail has no network path unless PXN relays over NVLink', () => {
    const ro: Fabric = { layout: '1su', spine: false, pxn: false };
    expect(railPath(ro, g(0, 2), g(1, 5)).kind).toBe('unreachable');
    expect(railPath(ro, g(0, 3), g(1, 3)).switchHops).toBe(1);
    const px = railPath({ ...ro, pxn: true }, g(0, 2), g(1, 5));
    expect([px.kind, px.switchHops]).toEqual(['pxn', 1]);
  });
  it('over every pair: hops are 0, 1 or 3, PXN never adds switch hops, the spine is used exactly when rails or SUs differ', () => {
    for (const layout of ['1su', '2su'] as const) for (let a = 0; a < NODES * GPUS; a++) for (let b = 0; b < NODES * GPUS; b++) {
      const s = g(Math.floor(a / GPUS), a % GPUS), d = g(Math.floor(b / GPUS), b % GPUS);
      if (a === b) continue;
      const off = railPath({ layout, spine: true, pxn: false }, s, d), on = railPath({ layout, spine: true, pxn: true }, s, d);
      expect([0, 1, 3]).toContain(off.switchHops);
      expect(on.switchHops).toBeLessThanOrEqual(off.switchHops);
      if (s.node !== d.node) {
        const diffSu = suOf(layout, s.node) !== suOf(layout, d.node);
        expect(off.spine).toBe(diffSu || s.gpu !== d.gpu);
        expect(on.spine).toBe(diffSu);
        expect(on.nvlinkHops).toBe(s.gpu !== d.gpu ? 1 : 0);
      }
    }
  });
});

describe('BandwidthLadder', () => {
  it('reuses the PCIe widget: Gen5 x16 = 504.112 Gb/s = 63.014 GB/s, Gen4 x16 = 31.506 GB/s per direction', () => {
    // Gen5: floor(32000 × 128/130) = 31 507 Mb/s per lane × 16 = 504 112 Mb/s; ÷ 8 = 63.014 GB/s
    expect(hostDirGBs({ kind: 'pcie', gen: 5, width: 16 })).toBeCloseTo(63.014, 6);
    // Gen4: floor(16000 × 128/130) = 15 753 × 16 = 252 048 Mb/s; ÷ 8 = 31.506 GB/s
    expect(hostDirGBs({ kind: 'pcie', gen: 4, width: 16 })).toBeCloseTo(31.506, 6);
    // NVLink-C2C 900 GB/s bidirectional -> 450 per direction
    expect(hostDirGBs({ kind: 'c2c', bidiGBs: 900 })).toBe(450);
  });
  it('H100: NVLink 900 GB/s bidirectional = 450 per direction = 9× a 400G NIC (50 GB/s)', () => {
    const h = ladder(PLATFORMS.find((p) => p.id === 'h100')!);
    const by = (id: string) => h.find((r) => r.id === id)!;
    expect(by('hbm').dirGBs).toBe(3350);
    expect(by('hbm').bidiGBs).toBeNull(); // memory bandwidth is not doubled
    expect([by('nvlink').dirGBs, by('nvlink').bidiGBs]).toEqual([450, 900]);
    expect([by('nic').dirGBs, by('nic').bidiGBs]).toEqual([50, 100]);
    expect(by('nvlink').dirGBs / by('nic').dirGBs).toBe(9);
    // front-end: 400 Gb/s per node ÷ 8 GPUs = 50 Gb/s = 6.25 GB/s per GPU
    expect(by('frontend').dirGBs).toBe(6.25);
  });
  it('A100, B200 and GB200 figures', () => {
    const a = ladder(PLATFORMS.find((p) => p.id === 'a100')!);
    // 600 / 2 = 300 GB/s NVLink vs 200 / 8 = 25 GB/s NIC -> 12×
    expect(a.find((r) => r.id === 'nvlink')!.dirGBs / a.find((r) => r.id === 'nic')!.dirGBs).toBe(12);
    const b = ladder(PLATFORMS.find((p) => p.id === 'b200')!);
    expect(b.find((r) => r.id === 'nvlink')!.dirGBs).toBe(900); // 1800 / 2
    const gb = ladder(PLATFORMS.find((p) => p.id === 'gb200')!);
    expect(gb.find((r) => r.id === 'frontend')!.dirGBs).toBe(12.5); // 400 Gb/s ÷ 8 ÷ 4 GPUs per tray
    expect(gb.find((r) => r.id === 'host')!.dirGBs).toBe(450);
    // 800G override: 100 GB/s
    expect(ladder(PLATFORMS[1], 800).find((r) => r.id === 'nic')!.dirGBs).toBe(100);
    // a 400G NIC (50 GB/s) cannot run at line rate behind a Gen4 x16 link (31.5 GB/s); 800G (100) outruns Gen5 x16 (63)
    expect(ladder(PLATFORMS[0], 400).find((r) => r.id === 'host')!.dirGBs).toBeLessThan(50);
    expect(ladder(PLATFORMS[1], 800).find((r) => r.id === 'host')!.dirGBs).toBeLessThan(100);
  });
  it('the ladder is ordered HBM > NVLink > host link > NIC > front-end share on every platform', () => {
    for (const p of PLATFORMS) {
      expect(NV_GENS.some((n) => n.id === p.nv)).toBe(true);
      const v = ladder(p).map((r) => r.dirGBs);
      for (let i = 1; i < v.length; i++) expect(v[i]).toBeLessThan(v[i - 1]);
    }
  });
  it('time to move and log axis', () => {
    expect(moveSeconds(10, 50)).toBe(0.2); // 10 GB over a 400G NIC
    expect(moveSeconds(10, 450)).toBeCloseTo(0.02222, 5); // over H100 NVLink, one direction
    expect(logPos(100, 1, 10000)).toBe(0.5);
    expect(logPos(0.5, 1, 10000)).toBe(0);
  });
});

describe('PipelineSchedule', () => {
  it('p = 4, m = 8, tb = 2·tf: step = (m + p − 1)(tf + tb) = 11 × 3 = 33, bubble 9/33 = 27.3 %', () => {
    for (const s of ['gpipe', '1f1b'] as const) {
      const r = simulate(s, 4, 8, 1, 2);
      expect(r.makespan).toBe(33);
      expect(r.busy).toBe(24); // 8 × (1 + 2)
      expect(r.bubbleFrac).toBeCloseTo(9 / 33, 12);
    }
    expect(bubbleFormula(4, 8)).toBeCloseTo(3 / 11, 12);
    expect(bubbleOverIdeal(4, 8)).toBe(3 / 8); // the paper's (p − 1)/m
  });
  it('the closed form matches the brute-force schedule for any p, m and backward/forward ratio', () => {
    for (const s of ['gpipe', '1f1b'] as Sched[]) for (let p = 2; p <= 8; p++) for (let m = 1; m <= 16; m++) for (const tb of [1, 2, 3]) {
      expect(simulate(s, p, m, 1, tb).bubbleFrac).toBeCloseTo(bubbleFormula(p, m), 10);
    }
  });
  it('interleaved: bubble shrinks by v; p = 4, m = 8, v = 2, tb = 2: step = 24 + 3 × 3 / 2 = 28.5', () => {
    const r = simulate('interleaved', 4, 8, 1, 2, 2);
    expect(r.makespan).toBeCloseTo(28.5, 10);
    expect(r.bubbleFrac).toBeCloseTo(4.5 / 28.5, 10); // = 3/19
    expect(bubbleFormula(4, 8, 2)).toBeCloseTo(3 / 19, 12);
    for (let p = 2; p <= 8; p++) for (const v of [2, 3, 4]) for (const k of [1, 2, 3]) for (const tb of [1, 2]) {
      expect(simulate('interleaved', p, p * k, 1, tb, v).bubbleFrac).toBeCloseTo(bubbleFormula(p, p * k, v), 9);
    }
    // Megatron-LM warm-up on stage 0: (p − 1)·2 + (v − 1)·p = 3·2 + 4 = 10 forwards before the first backward
    const o = stageOrder('interleaved', 4, 8, 0, 2);
    expect(o.findIndex((x) => x.kind === 'B')).toBe(11); // 10 warm-up forwards, then the first steady-state forward
    expect(() => simulate('interleaved', 4, 6, 1, 2, 2)).toThrow(); // m not a multiple of p is not a valid order
  });
  it('memory: GPipe holds m micro-batches per stage, 1F1B at most p − s', () => {
    expect(simulate('gpipe', 4, 8, 1, 2).peakInFlight).toEqual([8, 8, 8, 8]);
    expect(simulate('1f1b', 4, 8, 1, 2).peakInFlight).toEqual([4, 3, 2, 1]);
    expect(simulate('1f1b', 8, 3, 1, 2).peakInFlight).toEqual([3, 3, 3, 3, 3, 3, 2, 1]); // capped at m = 3
  });
  it('every stage runs m forwards and m backwards without overlap, and dependencies hold', () => {
    const r = simulate('1f1b', 4, 8, 1, 2);
    for (let s = 0; s < 4; s++) {
      const ops = r.ops.filter((o) => o.stage === s).sort((a, b) => a.start - b.start);
      expect(ops.filter((o) => o.kind === 'F')).toHaveLength(8);
      for (let i = 1; i < ops.length; i++) expect(ops[i].start).toBeGreaterThanOrEqual(ops[i - 1].end);
    }
    const at = (k: 'F' | 'B', s: number, j: number) => r.ops.find((o) => o.kind === k && o.stage === s && o.mb === j)!;
    expect(at('F', 1, 0).start).toBe(at('F', 0, 0).end);
    expect(at('B', 3, 0).start).toBe(at('F', 3, 0).end); // last stage turns around immediately
    expect(at('B', 2, 0).start).toBeGreaterThanOrEqual(at('B', 3, 0).end);
  });
  it('activation traffic: 1 × 8192 × 8192 × 2 B = 134 217 728 B per micro-batch per boundary', () => {
    const t = p2pBytes(1, 8192, 8192, 2);
    expect(t).toBe(134_217_728); // the lesson's "134 MB"
    expect(boundaryBytesPerStep(8, t)).toBe(1_073_741_824); // 8 micro-batches, each direction
    expect(boundaryBytesPerStep(8, t, 2)).toBe(2_147_483_648); // interleaving v = 2 doubles it
    // one send at 400 Gb/s: 134 217 728 × 8 / 400e9 = 2.684 ms
    expect((t * 8) / 400e9).toBeCloseTo(0.0026844, 6);
  });
});
