// Hand-checked numbers for group 6 widgets: KV cache transfer, straggler tail and in-network reduction (SHARP).
import { describe, expect, it } from 'vitest';
import { kvBytes, kvBytesPerToken, kvBytesPerTokenMHA, LINKS, MODELS, streamedExposedS, transferS } from '../src/widgets/KvCacheTransfer';
import { expectedExtra, harmonic, idleGpuSecondsPerStep, pSlowStep, quantileExtra, stepStats, workerCdf, workersForProb } from '../src/widgets/StragglerTail';
import {
  algbw, buildTree, busbw, busFactor, hostsUnder, ringBytesPerHost, ringSteps, ringTime, sharpBytesPerHost, sharpHops, sharpTime, treeLevels,
} from '../src/widgets/SharpAggregation';

const model = (id: string) => MODELS.find((m) => m.id === id)!;
const link = (id: string) => LINKS.find((l) => l.id === id)!.GBps;

describe('KvCacheTransfer', () => {
  it('per-token KV from the published configs', () => {
    // Llama 3.1 70B: 2 × 80 layers × 8 KV heads × 128 × 2 B = 327 680 B = 320 KiB (the lessons' number)
    expect(kvBytesPerToken(model('l31-70b'), 2)).toBe(327_680);
    // 8B: 2 × 32 × 8 × 128 × 2 = 131 072 B = 128 KiB
    expect(kvBytesPerToken(model('l31-8b'), 2)).toBe(131_072);
    // 405B: 2 × 126 × 8 × 128 × 2 = 516 096 B = 504 KiB
    expect(kvBytesPerToken(model('l31-405b'), 2)).toBe(516_096);
    // Llama 2 7B is MHA: 2 × 32 × 32 × 128 × 2 = 524 288 B = 512 KiB, the same with or without the MHA formula
    expect(kvBytesPerToken(model('l2-7b'), 2)).toBe(524_288);
    expect(kvBytesPerTokenMHA(model('l2-7b'), 2)).toBe(524_288);
    // FP8 halves it
    expect(kvBytesPerToken(model('l31-70b'), 1)).toBe(163_840);
  });

  it('GQA vs MHA: 70B would need 8× more KV with one KV head per query head', () => {
    // 2 × 80 × 64 × 128 × 2 = 2 621 440 B = 8 × 327 680
    expect(kvBytesPerTokenMHA(model('l31-70b'), 2)).toBe(2_621_440);
    expect(kvBytesPerTokenMHA(model('l31-70b'), 2) / kvBytesPerToken(model('l31-70b'), 2)).toBe(8);
    // 405B: 128 query heads / 8 KV heads = 16×
    expect(kvBytesPerTokenMHA(model('l31-405b'), 2) / kvBytesPerToken(model('l31-405b'), 2)).toBe(16);
  });

  it('reproduces inference-networking: 8,192 tokens ≈ 2.7 GB, ≈ 54 ms on one 400G NIC, 27 ms at 800G', () => {
    const b = kvBytes(model('l31-70b'), 2, 8192);
    expect(b).toBe(2_684_354_560); // 327 680 × 8192
    expect(transferS(b, link('1x400'))).toBeCloseTo(0.05369, 5); // 2.684e9 / 50e9
    expect(transferS(b, link('1x800'))).toBeCloseTo(0.02684, 5); // / 100e9
    // 128 000 tokens: 327 680 × 128 000 = 41 943 040 000 B ≈ 42 GB
    expect(kvBytes(model('l31-70b'), 2, 128_000)).toBe(41_943_040_000);
  });

  it('reproduces inference-cluster-design step 1 and 5: 4,096 tokens = 1.34 GB, 3.4 ms on 8 × 400G, 27 ms on one', () => {
    const b = kvBytes(model('l31-70b'), 2, 4096);
    expect(b).toBe(1_342_177_280); // 327 680 × 4096
    expect(transferS(b, link('8x400'))).toBeCloseTo(0.003355, 6); // 1.342e9 / 400e9
    expect(transferS(b, link('1x400'))).toBeCloseTo(0.02684, 5); // / 50e9
    // 200 requests/s × 1.342 GB = 268.4 GB/s ≈ 2.15 Tb/s
    expect((200 * b * 8) / 1e12).toBeCloseTo(2.147, 3);
  });

  it('batch, efficiency and layer-wise streaming', () => {
    expect(kvBytes(model('l31-8b'), 2, 1000, 4)).toBe(524_288_000); // 131 072 × 1000 × 4
    // 80% efficiency: 2.684e9 / (50e9 × 0.8) = 67.1 ms
    expect(transferS(2_684_354_560, 50, 0.8)).toBeCloseTo(0.0671, 4);
    // streamed: one of 80 layers, 2.684e9 / 80 / 50e9 = 0.671 ms
    expect(streamedExposedS(2_684_354_560, 80, 50)).toBeCloseTo(0.000671, 6);
    // the 100G front-end is 4× slower than one 400G NIC
    expect(transferS(1e9, link('100g')) / transferS(1e9, link('1x400'))).toBe(4);
  });

  it('DistServe OPT-66B (MHA, 64 layers, 72 heads × 128): 512 tokens ≈ 1.13 GiB', () => {
    // 2 × 64 × 72 × 128 × 2 = 2 359 296 B/token; × 512 = 1 207 959 552 B = 1.125 GiB
    const b = kvBytes({ layers: 64, heads: 72, kvHeads: 72, headDim: 128 }, 2, 512);
    expect(b).toBe(1_207_959_552);
    expect(b / 2 ** 30).toBeCloseTo(1.125, 3);
  });
});

describe('StragglerTail', () => {
  it('P(step slow) = 1 − (1 − p)^N', () => {
    expect(pSlowStep(0.5, 2)).toBeCloseTo(0.75, 12); // 1 − 0.25
    // 1 − 0.999^1024 = 1 − e^(1024 × ln 0.999) = 1 − e^(−1.0245123) = 1 − 0.358971 = 0.641029
    expect(pSlowStep(1e-3, 1024)).toBeCloseTo(0.641029, 6);
    // no cancellation for tiny p: 1 − (1 − 1e−12)^1 = 1e−12
    expect(pSlowStep(1e-12, 1)).toBeCloseTo(1e-12, 20);
    expect(pSlowStep(0, 1e6)).toBe(0);
    expect(pSlowStep(1, 8)).toBe(1);
  });

  it('teaching claim: rare per worker becomes near-certain per step at scale', () => {
    // 1 in 10 000 per worker per step: 8 GPUs → 0.08%; 32 768 GPUs → 1 − e^(−3.2770) ≈ 96.2%
    expect(pSlowStep(1e-4, 8)).toBeLessThan(0.001);
    expect(pSlowStep(1e-4, 32768)).toBeGreaterThan(0.96);
    // 50% of steps hit from N = ceil(ln 0.5 / ln 0.999) = ceil(692.8) = 693; 99% from ceil(4602.9) = 4603
    expect(workersForProb(1e-3, 0.5)).toBe(693);
    expect(workersForProb(1e-3, 0.99)).toBe(4603);
    expect(pSlowStep(1e-3, 692)).toBeLessThan(0.5);
    expect(pSlowStep(1e-3, 693)).toBeGreaterThanOrEqual(0.5);
  });

  it('closed forms: jitter only (mu·H_N), slow events only (d·P), all slow (d + mu·H_N), one worker (mu + p·d)', () => {
    expect(harmonic(4)).toBeCloseTo(25 / 12, 12); // 1 + 1/2 + 1/3 + 1/4
    expect(expectedExtra(4, 2, 0, 100)).toBeCloseTo(2 * 25 / 12, 12);
    // no jitter: late by d exactly when any worker is slow: 100 × 0.641029 = 64.1029
    expect(expectedExtra(1024, 0, 1e-3, 100)).toBeCloseTo(64.1029, 4);
    // the numerical integral must reproduce exact cases
    // p = 1: every worker is late by d, so E = d + mu·H_N; H_8 = 761/280 = 2.717857
    expect(expectedExtra(8, 2, 1, 100)).toBeCloseTo(100 + 2 * 761 / 280, 6);
    // N = 1: E[J + d·B] = mu + p·d = 2 + 0.01 × 100 = 3
    expect(expectedExtra(1, 2, 0.01, 100)).toBeCloseTo(3, 6);
    // bounds for the mixed case: at least each part alone, at most their sum
    const mixed = expectedExtra(1024, 2, 1e-3, 100);
    expect(mixed).toBeGreaterThan(Math.max(2 * harmonic(1024), 100 * pSlowStep(1e-3, 1024)));
    expect(mixed).toBeLessThan(2 * harmonic(1024) + 100 * pSlowStep(1e-3, 1024) + 2);
    // independent fine-grid integral (reviewer check): 1024 workers, mu 2, p 1e-3, d 100 → 71.11767
    expect(mixed).toBeCloseTo(71.11767, 3);
    // tiny jitter next to a huge delay must still be resolved: ≈ d·P(slow) + small jitter part = 64 102.887
    expect(expectedExtra(1024, 0.01, 1e-3, 100000)).toBeCloseTo(64102.887, 1);
  });

  it('CDF and quantiles', () => {
    // one worker, p = 0: Exponential median = mu·ln 2
    expect(quantileExtra(0.5, 1, 2, 0, 100)).toBeCloseTo(2 * Math.LN2, 6);
    // max of N Exp(mu): F^N = q → x = −mu·ln(1 − q^(1/N)); N = 1024, q = 0.5, mu = 1
    expect(quantileExtra(0.5, 1024, 1, 0, 0)).toBeCloseTo(-Math.log(1 - 0.5 ** (1 / 1024)), 6);
    expect(workerCdf(150, 0, 0.1, 100)).toBe(1);
    expect(workerCdf(50, 0, 0.1, 100)).toBeCloseTo(0.9, 12);
  });

  it('teaching claim: per-worker averages look harmless while the job slows down', () => {
    // base 1000 ms, mean jitter 2 ms, p = 1e-3, slow event 100 ms, 4096 GPUs
    const s = stepStats(4096, 1000, 2, 1e-3, 100);
    // one worker averages 1000 + 2 + 0.1 = 1002.1 ms (0.21% above base)
    expect(s.workerMean).toBeCloseTo(1002.1, 10);
    // P(slow step) = 1 − 0.999^4096 = 1 − e^(−4.0981) ≈ 0.9834; E[step] ≥ 1000 + 98.3 = 1098.3 → > 9% slowdown
    expect(s.pSlow).toBeCloseTo(0.9834, 4);
    expect(s.slowdown).toBeGreaterThan(1.098);
    expect(s.lostPct).toBeGreaterThan(9);
    // a small job with the same parts barely notices: 8 workers, P = 0.8%
    expect(stepStats(8, 1000, 2, 1e-3, 100).slowdown).toBeLessThan(1.01);
    // one idle-waiting step with a single late worker: (4096 − 1) × 0.1 s = 409.5 GPU-seconds
    expect(idleGpuSecondsPerStep(4096, 0.1)).toBeCloseTo(409.5, 9);
  });
});

describe('SharpAggregation', () => {
  const MiB = 2 ** 20;
  it('per-host bytes: ring 2(N−1)/N · S vs in-network S', () => {
    expect(ringBytesPerHost(8, MiB)).toBe(1.75 * MiB); // 2 × 7/8
    expect(sharpBytesPerHost(8, MiB)).toBe(MiB);
    // N = 2: the ring already sends only S, so in-network reduction saves no bandwidth
    expect(ringBytesPerHost(2, MiB)).toBe(MiB);
    // large N: ratio → 2; N = 1024: 2 × 1023/1024 = 1.998
    expect(ringBytesPerHost(1024, MiB) / sharpBytesPerHost(1024, MiB)).toBeCloseTo(1.998, 3);
  });

  it('steps: ring 2(N−1) vs 2 × tree levels', () => {
    expect(ringSteps(8)).toBe(14);
    expect(treeLevels(4, 2)).toBe(2); // the lesson's 4 hosts under 2 leaves under one spine
    expect(treeLevels(16, 4)).toBe(2);
    expect(treeLevels(32, 32)).toBe(1); // one leaf switch is the root
    expect(treeLevels(256, 32)).toBe(2); // 32² = 1024 ≥ 256
    expect(treeLevels(2048, 32)).toBe(3); // 32² = 1024 < 2048 ≤ 32³
    expect(treeLevels(1, 32)).toBe(0);
    expect(sharpHops(256, 32)).toBe(4);
    // 256 hosts: 510 ring steps vs 4 hops
    expect(ringSteps(256)).toBe(510);
  });

  it('alpha-beta times for 256 hosts, 256 MiB, NDR 50 GB/s, α 5 µs, hop 1 µs', () => {
    const S = 256 * MiB; // 268 435 456 B
    // ring: 510 × 5 µs = 2.55 ms; 268 435 456 × 510/256 = 534 773 760 B / 50e9 = 10.6955 ms → 13.2455 ms
    expect(ringTime(256, S, 50e9, 5e-6)).toBeCloseTo(0.0132454752, 9);
    // in-network: 5 µs + 4 × 1 µs + 268 435 456 / 50e9 = 9 µs + 5.36871 ms = 5.37771 ms
    expect(sharpTime(256, 32, S, 50e9, 5e-6, 1e-6)).toBeCloseTo(0.00537770912, 9);
  });

  it('busbw uses the same factor for both, so in-network busbw can exceed the link rate', () => {
    expect(busFactor(8)).toBe(1.75);
    const S = 4 * 2 ** 30, B = 50e9;
    const tRing = ringTime(256, S, B, 5e-6), tSharp = sharpTime(256, 32, S, B, 5e-6, 1e-6);
    // ring busbw approaches B from below: 4 GiB × 510/256 / 50e9 = 171.1 ms of transfer + 2.55 ms of latency → 98.5% of B
    expect(busbw(256, S, tRing)).toBeLessThan(B);
    expect(busbw(256, S, tRing) / B).toBeCloseTo(0.9853, 4);
    // in-network algbw approaches B (85.9 ms + 9 µs), so busbw approaches 2(N−1)/N × B = 1.992 × B
    expect(algbw(S, tSharp)).toBeGreaterThan(0.999 * B);
    expect(busbw(256, S, tSharp)).toBeGreaterThan(1.98 * B);
  });

  it('small messages are latency-bound: in-network wins by far more than 2×', () => {
    // 1 KiB, 256 hosts: ring 2.55 ms + 1024 × 510/256 / 50e9 ≈ 2.55004 ms; in-network ≈ 9.02 µs → ~280×
    const ratio = ringTime(256, 1024, 50e9, 5e-6) / sharpTime(256, 32, 1024, 50e9, 5e-6, 1e-6);
    expect(ratio).toBeGreaterThan(250);
  });

  it('builds the drawing tree and tracks hosts under each switch', () => {
    const t = buildTree(4, 2);
    expect(t.map((l) => l.length)).toEqual([4, 2, 1]);
    expect(t[2][0].children).toEqual([0, 1]);
    expect(hostsUnder(t, 1, 1)).toEqual([2, 3]);
    expect(hostsUnder(t, 2, 0)).toEqual([0, 1, 2, 3]);
    expect(buildTree(16, 4).map((l) => l.length)).toEqual([16, 4, 1]);
    // levels drawn = treeLevels
    for (const [n, k] of [[4, 2], [8, 2], [8, 4], [16, 2], [16, 4]]) expect(buildTree(n, k).length - 1).toBe(treeLevels(n, k));
  });
});
