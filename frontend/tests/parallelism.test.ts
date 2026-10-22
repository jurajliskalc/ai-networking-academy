// Hand-checked numbers for the Parallelism map: rank layout, network placement and traffic formulas.
import { describe, expect, it } from 'vitest';
import { commKey, coords, MODELS, placement, trafficPerGpu } from '../src/widgets/ParallelismMap';

describe('rank layout (Megatron-Core tp-cp-ep-dp-pp, cp = 1)', () => {
  it('puts TP fastest, then DP, then PP', () => {
    const cs = coords(64, 8, 2, 1); // DP = 4
    expect(cs[9]).toMatchObject({ tp: 1, dp: 1, pp: 0, server: 1 });
    expect(cs[32]).toMatchObject({ tp: 0, dp: 0, pp: 1, server: 4 });
  });
  it('takes EP groups from consecutive DP indices', () => {
    const cs = coords(64, 2, 1, 4); // DP = 32
    expect(cs[2 * 5]).toMatchObject({ dp: 5, ep: 1, epGroup: 1 });
  });
});

describe('placement', () => {
  const at = (N: number, TP: number, PP: number, EP: number, kind: 'tp' | 'dp' | 'ep') => {
    const DP = N / (TP * PP);
    return placement(coords(N, TP, PP, EP), (c) => commKey(c, kind, TP, DP, EP));
  };
  it('keeps TP up to 8 inside a server and spills TP 16 across servers', () => {
    expect(at(128, 8, 4, 1, 'tp')).toBe('nvlink');
    expect(at(128, 16, 2, 1, 'tp')).toBe('hier');
  });
  it('runs DP across servers only when TP fills the server, hierarchically otherwise', () => {
    expect(at(128, 8, 4, 1, 'dp')).toBe('rdma');
    expect(at(128, 2, 2, 1, 'dp')).toBe('hier');
  });
  it('keeps a small EP group inside the server', () => {
    expect(at(128, 1, 1, 8, 'ep')).toBe('nvlink');
    expect(at(128, 1, 1, 16, 'ep')).toBe('hier');
  });
});

describe('traffic per GPU per step (bf16)', () => {
  const dense70 = MODELS[1]; // 70e9 params, L = 80, h = 8192
  it('matches the hand-worked 70B example: TP8 PP4 DP4, s = 4096, 8 micro-batches', () => {
    const t = trafficPerGpu({ TP: 8, PP: 4, DP: 4, EP: 1, model: dense70, seq: 4096, micro: 1, mb: 8 });
    const act = 4096 * 8192 * 2; // 67,108,864 bytes
    expect(t.tp).toBeCloseTo(8 * 20 * 4 * 1.75 * act, -3); // 75.2 GB
    expect(t.tp / 1e9).toBeCloseTo(75.16, 1);
    expect(t.pp).toBeCloseTo((2 * 8 * act) / 8, -3); // 134 MB
    expect(t.dp / 1e9).toBeCloseTo(1.5 * (70e9 / 32) * 2 / 1e9, 6); // 6.5625 GB
    expect(t.ep).toBe(0);
  });
  it('reduces expert gradients over DP/EP and counts 4 all-to-alls per MoE layer', () => {
    const moe = MODELS[2]; // 47e9, 96 % expert, L = 32, h = 4096, top-2
    const t = trafficPerGpu({ TP: 1, PP: 1, DP: 64, EP: 8, model: moe, seq: 4096, micro: 1, mb: 1 });
    const dense = 47e9 * 0.04;
    const expert = (47e9 * 0.96) / 8;
    expect(t.dp).toBeCloseTo(((2 * 63) / 64 * dense + (2 * 7) / 8 * expert) * 2, -3);
    expect(t.ep).toBeCloseTo(32 * 4 * 4096 * 2 * 4096 * 2 * (7 / 8), -3);
  });
  it('has no TP, PP or DP traffic at degree 1', () => {
    const t = trafficPerGpu({ TP: 1, PP: 1, DP: 1, EP: 1, model: dense70, seq: 4096, micro: 1, mb: 8 });
    expect(t).toEqual({ tp: 0, pp: 0, dp: 0, ep: 0 });
  });
});
