// Hand-checked numbers for group g2 widgets: TrainingStepTimeline, PcieBandwidth, NvlinkGenerations,
// IbSpeeds, BerFec and OpticsPlanner.
import { describe, expect, it } from 'vitest';
import { allReduceMs, bucketSizes, latencySteps, simulateStep, type StepParams } from '../src/widgets/TrainingStepTimeline';
import { FLIT_TLP_SHARE, GENS as PCIE_GENS, laneMbps, linkGbps, usableGbps, verdict } from '../src/widgets/PcieBandwidth';
import { NV_GENS, nicGBs, perDir, ringBytes, xferMs } from '../src/widgets/NvlinkGenerations';
import { GENS as IB_GENS, PCIE, efficiency, linkData, linkSignal, pcieGbps } from '../src/widgets/IbSpeeds';
import { CW_PAYLOAD_BYTES, FECS, LINKS, compute, fmtDuration, log10BinomialTailAbove, log10SymbolErrorProb, sciFromLog } from '../src/widgets/BerFec';
import { candidates, recommended, rowPower } from '../src/widgets/OpticsPlanner';

const pg = (g: number) => PCIE_GENS.find((x) => x.gen === g)!;
const ib = (n: string) => IB_GENS.find((x) => x.name === n)!;
const link = (id: string) => LINKS.find((l) => l.id === id)!;
const fec = (id: string) => FECS.find((f) => f.id === id)!;

describe('TrainingStepTimeline', () => {
  it('latency steps: ring 2(n-1), tree 2*ceil(log2 n)', () => {
    expect(latencySteps(8, 'ring')).toBe(14); // 2 * 7
    expect(latencySteps(8, 'tree')).toBe(6); // 2 * 3
    expect(latencySteps(5, 'tree')).toBe(6); // 2 * ceil(2.32) = 2 * 3
  });

  it('all-reduce time = 2(n-1)/n * S / busbw + steps * alpha', () => {
    // 2*63/64 * 1e9 B / 50e9 B/s = 0.039375 s = 39.375 ms; latency 126 steps * 2 us = 0.252 ms
    expect(allReduceMs(1e9, 64, 50, 2, 'ring')).toBeCloseTo(39.627, 9);
    // n = 2: factor 1; 1e8 B / 10e9 B/s = 10 ms, alpha 0
    expect(allReduceMs(1e8, 2, 10, 0, 'ring')).toBeCloseTo(10, 12);
  });

  it('bucket split', () => {
    expect(bucketSizes(10, 4)).toEqual([4, 4, 2]);
    expect(bucketSizes(8, 4)).toEqual([4, 4]);
    expect(bucketSizes(0, 4)).toEqual([]);
  });

  // 0.1 GB = 1e8 B, 25 MiB buckets = 26,214,400 B -> 3 full buckets + 21,356,800 B.
  // n = 2, busbw 10 GB/s, alpha 0: a bucket of b bytes takes b / 1e7 ms (full 2.62144 ms, last 2.13568 ms).
  // 4 layers of 2.5e7 B over a 40 ms backward (10 ms each) after a 10 ms forward.
  const p: StepParams = { gradGB: 0.1, fwdMs: 10, bwdMs: 40, optMs: 5, layers: 4, bucketMiB: 25, n: 2, busbwGBs: 10, alphaUs: 0, latModel: 'ring', overlap: true, stragglerPct: 0 };

  it('overlapped buckets fire when the layer holding their last byte is done', () => {
    const r = simulateStep(p);
    // cumulative bytes 26.2M, 52.4M, 78.6M, 100M -> layers ceil(1.05)=2, ceil(2.10)=3, ceil(3.15)=4, 4
    expect(r.buckets.map((b) => b.ready)).toEqual([30, 40, 50, 50]);
    expect(r.buckets[0].end).toBeCloseTo(32.62144, 9);
    expect(r.buckets[3].start).toBeCloseTo(52.62144, 9); // waits for bucket 2 on the single comm stream
    expect(r.commEnd).toBeCloseTo(54.75712, 9); // 52.62144 + 2.13568
    expect(r.commTotal).toBeCloseTo(10, 9); // all bytes / 1e7
    expect(r.exposed).toBeCloseTo(4.75712, 9); // 54.75712 - 50
    expect(r.step).toBeCloseTo(59.75712, 9); // + 5 ms optimizer
  });

  it('no overlap: all 10 ms of comm is exposed after backward', () => {
    const r = simulateStep({ ...p, overlap: false });
    expect(r.commEnd).toBeCloseTo(60, 9);
    expect(r.exposed).toBeCloseTo(10, 9);
    expect(r.step).toBeCloseTo(65, 9);
  });

  it('a 50% straggler stretches compute and the comm stream follows it', () => {
    const r = simulateStep({ ...p, stragglerPct: 50 });
    // fwd 15, bwd 60 (15 per layer), ready = 15 + {2,3,4,4} * 15 = 45, 60, 75, 75
    expect(r.buckets.map((b) => b.ready)).toEqual([45, 60, 75, 75]);
    expect(r.bwdEnd).toBe(75);
    expect(r.step).toBeCloseTo(75 + 4.75712 + 7.5, 9); // optimizer 5 * 1.5
  });
});

describe('PcieBandwidth (kernel PCIE_SPEED2MBS_ENC, truncated per lane)', () => {
  it('per-lane Mb/s', () => {
    expect(laneMbps(pg(3))).toBe(7876); // floor(8000 * 128/130 = 7876.92)
    expect(laneMbps(pg(4))).toBe(15753); // floor(15753.8)
    expect(laneMbps(pg(5))).toBe(31507); // floor(31507.7)
    expect(laneMbps(pg(6))).toBe(64000); // 64000 * 1/1
  });

  it('x16 link rates', () => {
    expect(linkGbps(pg(4), 16)).toBeCloseTo(252.048, 9); // 15753 * 16 / 1000
    expect(linkGbps(pg(5), 16)).toBeCloseTo(504.112, 9); // 31507 * 16 / 1000
    expect(linkGbps(pg(6), 16)).toBeCloseTo(1024, 9);
  });

  it('Gen6 FLIT share is 236/256 (236 B TLP + 6 B DLP + 8 B CRC + 6 B FEC)', () => {
    expect(FLIT_TLP_SHARE).toBe(236 / 256);
    expect(usableGbps(pg(6), 16, 1)).toBeCloseTo(944, 9); // 1024 * 236/256
    expect(usableGbps(pg(5), 16, 1)).toBeCloseTo(504.112, 9); // no FLIT factor before Gen6
  });

  it('verdicts', () => {
    expect(verdict(pg(5), 16, 400, 0.85)).toBe('ok'); // 504.112 * 0.85 = 428.5 >= 400
    expect(verdict(pg(5), 16, 500, 0.85)).toBe('marginal'); // 428.5 < 500 <= 504.112
    expect(verdict(pg(5), 16, 800, 0.85)).toBe('short'); // 504.112 < 800
    expect(verdict(pg(6), 16, 800, 0.85)).toBe('ok'); // 944 * 0.85 = 802.4
    expect(verdict(pg(6), 16, 800, 0.84)).toBe('marginal'); // 944 * 0.84 = 792.96 < 800 <= 1024
  });
});

describe('NvlinkGenerations', () => {
  it('headline figures are bidirectional; per direction is half', () => {
    const h100 = NV_GENS.find((g) => g.id === 'h100')!;
    expect(h100.links).toBe(18);
    expect(perDir(h100.bidiGBs)).toBe(450); // 900 / 2
    expect(perDir(NV_GENS.find((g) => g.id === 'gb200')!.bidiGBs)).toBe(900); // 1800 / 2
    expect(NV_GENS.find((g) => g.id === 'a100')!.links).toBe(12);
  });

  it('NVLink vs NIC ratio on the same per-direction basis', () => {
    expect(nicGBs(400)).toBe(50);
    expect(perDir(900) / nicGBs(400)).toBe(9); // not 18 (bidirectional vs per-direction)
    expect(perDir(1800) / nicGBs(800)).toBe(9);
  });

  it('ring all-reduce of 1 GB over 72 GPUs (matches the scale-up lesson)', () => {
    const b = ringBytes(1, 72); // 2 * 71/72 = 1.97222 GB
    expect(b).toBeCloseTo(1.972222, 6);
    expect(xferMs(b, 900)).toBeCloseTo(2.1914, 4); // 1.97222 / 900 s
    expect(xferMs(b, 50)).toBeCloseTo(39.444, 3); // 1.97222 / 50 s
  });
});

describe('IbSpeeds', () => {
  it('lane data rates from encoding', () => {
    expect(ib('QDR').laneData).toBeCloseTo(8, 12); // 10 * 8/10
    expect(linkSignal(ib('QDR'), 4)).toBe(40);
    expect(ib('FDR10').laneData).toBeCloseTo(10, 12); // 10.3125 * 64/66
    expect(linkData(ib('FDR'), 4)).toBeCloseTo(600 / 11, 12); // 14.0625 * 64/66 * 4 = 54.5454...
    expect(ib('EDR').laneData).toBeCloseTo(25, 12); // 25.78125 * 64/66
  });

  it('PAM4 generations: nominal data rate vs serial rate', () => {
    expect(linkData(ib('HDR'), 4)).toBe(200);
    expect(linkSignal(ib('NDR'), 4)).toBe(425); // 4 * 106.25
    expect(efficiency(ib('HDR'))).toBeCloseTo(0.941176, 6); // 50 / 53.125 = 256/257 * 514/544
    expect(50 * (257 / 256) * (544 / 514)).toBeCloseTo(53.125, 12);
  });

  it('PCIe slot numbers agree with the PcieBandwidth widget', () => {
    const p5 = PCIE.find((p) => p.gen === 5)!, p6 = PCIE.find((p) => p.gen === 6)!;
    expect(pcieGbps(p5, 16)).toBeCloseTo(linkGbps(pg(5), 16), 12); // 504.112
    expect(pcieGbps(p6, 16)).toBeCloseTo(usableGbps(pg(6), 16, 1), 12); // 944
    expect(pcieGbps(p6, 16)).toBeCloseTo(944, 9);
    expect(pcieGbps(PCIE.find((p) => p.gen === 4)!, 8)).toBeCloseTo(126.024, 9); // 15753 * 8 / 1000
  });
});

describe('BerFec', () => {
  it('symbol error probability 1-(1-BER)^10', () => {
    expect(log10SymbolErrorProb(1e-6)).toBeCloseTo(Math.log10(1e-5 - 45e-12), 9); // 10p - C(10,2)p^2
    expect(log10SymbolErrorProb(0.1)).toBeCloseTo(Math.log10(1 - 0.9 ** 10), 12);
  });

  it('binomial tail', () => {
    // n=3, t=1, p=0.1: P(X>=2) = 3*0.01*0.9 + 0.001 = 0.028
    expect(log10BinomialTailAbove(3, 1, 0.1)).toBeCloseTo(Math.log10(0.028), 12);
    expect(log10BinomialTailAbove(10, 0, 0.5)).toBeCloseTo(Math.log10(1 - 2 ** -10), 12);
    expect(log10BinomialTailAbove(10, 3, 0)).toBe(-Infinity);
  });

  it('RS codes: t = (n-k)/2 and 640 B of MAC data per codeword', () => {
    for (const f of FECS.filter((x) => x.id !== 'none')) expect(f.t).toBe((f.n - f.k) / 2);
    expect(CW_PAYLOAD_BYTES).toBe((514 * 10 * 256) / 257 / 8); // 5140 bits = 20 x 257b -> 5120 bits
    // Line rates: MAC rate x 257/256 x n/514
    expect(100 * (257 / 256) * (528 / 514)).toBeCloseTo(4 * link('100g-4x25').laneGbps, 9); // 103.125
    expect(400 * (257 / 256) * (544 / 514)).toBeCloseTo(4 * link('400g-4x100').laneGbps, 9); // 425
  });

  it('400G 4x100G KP4: P(uncorrectable) vs BER (independently summed exactly)', () => {
    const at = (ber: number) => compute(link('400g-4x100'), fec('kp4'), ber, 4158);
    const r = at(2.4e-4);
    expect(r.cwPerSec).toBeCloseTo(425e9 / 5440, 3); // 7.8125e7
    expect(r.log10Pcw).toBeCloseTo(-12.0888, 3); // sum_{i=16}^{544} C(544,i) ps^i (1-ps)^(544-i)
    expect(1 / 10 ** r.log10UncPerSec).toBeGreaterThan(3600); // ~4.4 h between uncorrectables at the quoted limit
    expect(at(1e-5).log10Pcw).toBeCloseTo(-33.6697, 3);
    expect(10 ** at(5e-4).log10UncPerSec).toBeCloseTo(2.18, 1); // ~2 per second at ~2x the limit
    expect(r.marginDecades).toBeCloseTo(0, 12);
    expect(at(1e-5).marginDecades).toBeCloseTo(Math.log10(24), 12);
  });

  it('100G KR4 at 5e-5 and codewords per frame (worst-case alignment)', () => {
    const r = compute(link('100g-4x25'), fec('kr4'), 5e-5, 1518);
    expect(r.log10Pcw).toBeCloseTo(-9.3568, 3);
    expect(r.cwPerFrame).toBe(4); // ceil(1517/640) + 1
    expect(compute(link('100g-4x25'), fec('kr4'), 5e-5, 640).cwPerFrame).toBe(2);
    expect(compute(link('100g-4x25'), fec('kr4'), 5e-5, 641).cwPerFrame).toBe(2); // 1 B + 640 B at worst
    expect(compute(link('100g-4x25'), fec('kr4'), 5e-5, 9018).cwPerFrame).toBe(16); // ceil(9017/640) + 1
  });

  it('no FEC: every bit error reaches the MAC', () => {
    const r = compute(link('100g-4x25'), fec('none'), 1e-9, 1518);
    expect(r.bitErrPerSec).toBeCloseTo(103.125, 9); // 103.125e9 * 1e-9
    expect(10 ** r.log10Flr).toBeCloseTo(1 - (1 - 1e-9) ** 12144, 12); // ~1.214e-5
    expect(r.marginDecades).toBeNull();
  });

  it('formatting', () => {
    expect(sciFromLog(-14.3)).toBe('5.0×10⁻¹⁵'); // 10^0.7 = 5.01
    expect(sciFromLog(-Infinity)).toBe('0');
    expect(fmtDuration(90)).toBe('1.50 min');
    expect(fmtDuration(Infinity)).toBe('∞');
  });
});

describe('OpticsPlanner', () => {
  it('passive DAC wins where it reaches, then the next-lowest power medium', () => {
    expect(recommended(candidates(400, 2))!.m.id).toBe('dac'); // 3 m reach at 400G
    expect(recommended(candidates(400, 5))!.m.id).toBe('acc'); // 5 m, 1.5 W
    expect(recommended(candidates(400, 50))!.m.id).toBe('sr'); // AOC only ~30 m at 400G
    expect(recommended(candidates(400, 300))!.m.id).toBe('dr');
    expect(recommended(candidates(1600, 20000))).toBeNull(); // nothing reaches 20 km
  });

  it('link power counts both ends', () => {
    const dr = candidates(800, 100).find((c) => c.m.id === 'dr')!;
    expect(dr.linkW).toBe(30); // 2 * 15 W
  });

  it('row power: twin-port modules halve the module count', () => {
    // 1,024 links x 2 ends / 2 ports per module = 1,024 modules of the 800G class (15 W) = 15.36 kW
    const r = rowPower({ name: 'x', links: 1024, speed: 400, media: 'dr', perModule: 2, wOverride: null });
    expect(r.ends).toBe(1024);
    expect(r.modSpeed).toBe(800);
    expect(r.kw).toBeCloseTo(15.36, 9);
    // DAC: no powered ends
    expect(rowPower({ name: 'y', links: 100, speed: 400, media: 'dac', perModule: 1, wOverride: null }).kw).toBe(0);
    // 2 x 1.6T has no module class in the table
    expect(rowPower({ name: 'z', links: 10, speed: 1600, media: 'dr', perModule: 2, wOverride: null }).kw).toBeNull();
    // override: 10 links x 2 / 1 = 20 modules x 12 W = 0.24 kW
    expect(rowPower({ name: 'o', links: 10, speed: 400, media: 'sr', perModule: 1, wOverride: 12 }).kw).toBeCloseTo(0.24, 12);
  });
});
