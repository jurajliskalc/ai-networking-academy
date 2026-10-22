// Hand-computed checks for group g1 widgets: EthernetFrame, SubnetCalculator, MtuCalculator,
// QueueLatency, CollectiveExplorer, ParallelismMap. Arithmetic is shown next to each expectation.
import { describe, expect, it } from 'vitest';
import { buildFrame } from '../src/widgets/EthernetFrame';
import { cidrInfo, ipToString, linkFor, parseCidr, parseIPv4, railPlan } from '../src/widgets/SubnetCalculator';
import { checkHop, hopSize, iboeActiveMtu, pingMaxPayload, rocePacketIpLen, tcpMss } from '../src/widgets/MtuCalculator';
import { fmtBytes, fmtTime, incast, packetsPerSecond, queueDelayS, serializationS } from '../src/widgets/QueueLatency';
import { buffers, busbwFactor, ioSize, sentPerRank } from '../src/widgets/CollectiveExplorer';
import { commKey, coords, MODELS, placement, trafficPerGpu } from '../src/widgets/ParallelismMap';

describe('EthernetFrame.buildFrame', () => {
  it('RoCEv2 over IPv4, 1024 B payload', () => {
    const r = buildFrame({ vlan: false, l3: 'ipv4', l4: 'udp', roce: true, payload: 1024 });
    // IP 20 + UDP 8 + BTH 12 + 1024 + ICRC 4 = 1068; frame 14 + 1068 + FCS 4 = 1086; wire +20 = 1106
    expect(r).toMatchObject({ l2Payload: 1068, frame: 1086, wire: 1106, pad: 0, ibPad: 0, etherType: 0x0800, isRoce: true });
    expect(r.efficiency).toBeCloseTo(1024 / 1106, 10);
  });
  it('pads an empty TCP segment to the 64 B minimum', () => {
    const r = buildFrame({ vlan: false, l3: 'ipv4', l4: 'tcp', roce: false, payload: 0 });
    // IP 20 + TCP 20 = 40; 14 + 40 + 4 = 58 -> pad 6 -> 64; wire 84
    expect(r).toMatchObject({ l2Payload: 40, pad: 6, frame: 64, wire: 84, isRoce: false });
  });
  it('a tagged frame needs only 42 B of L2 payload to reach 64 B', () => {
    const r = buildFrame({ vlan: true, l3: 'ipv4', l4: 'udp', roce: false, payload: 0 });
    // IP 20 + UDP 8 = 28; 18 + 28 + 4 = 50 -> pad 14 (28 + 14 = 42) -> 64
    expect(r).toMatchObject({ l2Payload: 28, pad: 14, frame: 64 });
  });
  it('RoCEv1 has no IP/UDP and pads an 18 B payload with 2 B of IB pad', () => {
    const r = buildFrame({ vlan: false, l3: 'rocev1', l4: 'udp', roce: false, payload: 18 });
    // GRH 40 + BTH 12 + 18 + IB pad 2 + ICRC 4 = 76; 14 + 76 + 4 = 94
    expect(r).toMatchObject({ l2Payload: 76, ibPad: 2, frame: 94, etherType: 0x8915, isRoce: true });
    expect(r.parts.map((p) => p.id)).toEqual(['pre', 'mac', 'etype', 'rocev1', 'bth', 'payload', 'ibpad', 'icrc', 'fcs', 'ifg']);
  });
  it('RoCEv2 over IPv6 with VLAN at 4096 B', () => {
    const r = buildFrame({ vlan: true, l3: 'ipv6', l4: 'udp', roce: true, payload: 4096 });
    // 40 + 8 + 12 + 4096 + 4 = 4160; 18 + 4160 + 4 = 4182
    expect(r).toMatchObject({ l2Payload: 4160, frame: 4182, wire: 4202, etherType: 0x86dd });
  });
});

describe('SubnetCalculator', () => {
  it('parses and formats IPv4', () => {
    expect(parseIPv4('10.0.3.77')).toBe(10 * 2 ** 24 + 3 * 256 + 77); // 167,773,005
    expect(ipToString(parseIPv4('255.255.255.255')!)).toBe('255.255.255.255');
    expect(parseIPv4('256.1.1.1')).toBeNull();
    expect(parseCidr('10.0.0.1/33')).toBeNull();
    expect(parseCidr('10.0.0.1')).toBeNull();
  });
  it('10.0.3.77/26: block of 64 starting at .64', () => {
    const p = parseCidr('10.0.3.77/26')!;
    const i = cidrInfo(p.addr, p.len);
    expect([i.network, i.broadcast!, i.first, i.last, i.mask, i.wildcard].map(ipToString))
      .toEqual(['10.0.3.64', '10.0.3.127', '10.0.3.65', '10.0.3.126', '255.255.255.192', '0.0.0.63']);
    expect(i.usable).toBe(62); // 64 - 2
  });
  it('/31 has two usable addresses and no broadcast; /32 one; /0 the whole space', () => {
    const a = cidrInfo(parseIPv4('10.0.0.10')!, 31);
    expect(a).toMatchObject({ broadcast: null, usable: 2, total: 2 });
    expect(ipToString(a.last)).toBe('10.0.0.11');
    expect(cidrInfo(parseIPv4('10.255.0.1')!, 32)).toMatchObject({ broadcast: null, usable: 1, total: 1 });
    const z = cidrInfo(0, 0);
    expect(z.total).toBe(2 ** 32);
    expect(ipToString(z.broadcast!)).toBe('255.255.255.255');
    const b = cidrInfo(parseIPv4('172.16.5.4')!, 12);
    expect(ipToString(b.network)).toBe('172.16.0.0');
    expect(ipToString(b.broadcast!)).toBe('172.31.255.255');
  });
  it('rail plan: 64 servers, 8 rails, 32 per leaf in 10.0.0.0/16', () => {
    const p = railPlan({ servers: 64, rails: 8, perLeaf: 32, base: parseIPv4('10.0.0.0')!, baseLen: 16 });
    // leaves/rail = 64/32 = 2; leaf block = 2*32 = 64 (/26); rail block = 2*64 = 128 (/25); used = 8*128 = 1024 -> /22
    expect(p).toMatchObject({ error: null, leavesPerRail: 2, leafBlock: 64, leafLen: 26, railBlock: 128, railLen: 25, used: 1024, minBaseLen: 22 });
    // server 33 (0-based) on rail 3: leaf 1, port 1 -> 3*128 + 64 + 2 = 450 = 10.0.1.194
    const l = linkFor(p, 32, 33, 3);
    expect(ipToString(l.leafIp)).toBe('10.0.1.194');
    expect(ipToString(l.hostIp)).toBe('10.0.1.195');
  });
  it('rail plan rounds non-powers of two up and reports overflow', () => {
    const p = railPlan({ servers: 50, rails: 3, perLeaf: 24, base: parseIPv4('10.0.0.0')!, baseLen: 24 });
    // leaves = ceil(50/24) = 3 -> 4 blocks; leaf block = nextPow2(48) = 64; rail = 256; used = 768 > 256 -> /22 needed
    expect(p).toMatchObject({ leavesPerRail: 3, leafBlock: 64, railBlock: 256, used: 768, available: 256, minBaseLen: 22 });
    expect(p.error).toMatch(/Overflow/);
  });
});

describe('MtuCalculator', () => {
  it('RoCE active MTU = largest IB MTU <= netdev - 96', () => {
    expect(iboeActiveMtu(9000)).toBe(4096); // 8904
    expect(iboeActiveMtu(4192)).toBe(4096); // exactly 4096
    expect(iboeActiveMtu(4191)).toBe(2048);
    expect(iboeActiveMtu(1500)).toBe(1024); // 1404
    expect(iboeActiveMtu(352)).toBe(256);
    expect(iboeActiveMtu(351)).toBe(0);
  });
  it('RoCE packet, TCP MSS and ping sizes', () => {
    expect(rocePacketIpLen(4096, false)).toBe(4156); // 4096 + 20 + 8 + 12 + 16 + 4
    expect(rocePacketIpLen(4096, true)).toBe(4176);
    expect(tcpMss(9000, false)).toBe(8960);
    expect(tcpMss(9000, true)).toBe(8940);
    expect(pingMaxPayload(9000, false)).toBe(8972); // 9000 - 20 - 8
    expect(pingMaxPayload(1500, true)).toBe(1452); // 1500 - 40 - 8
    expect(hopSize(9000, 'l2', true)).toBe(9018); // + 14 + 4 tag
  });
  it('VXLAN over IPv4 at a 9000 B hop: RoCE fits, full-size host packets do not', () => {
    const v = checkHop(9000, 9000, 4156, 'vxlan4', 'l3', false);
    // RoCE 4156 + 50 = 4206 <= 9000; full 9000 + 50 = 9050 > 9000; inner limit 9000 - 50 = 8950
    expect(v).toMatchObject({ roceSize: 4206, fullSize: 9050, roceFits: true, fullFits: false, innerMtu: 8950 });
    expect(checkHop(9216, 9000, 4156, 'vxlan4', 'l3', false)).toMatchObject({ roceFits: true, fullFits: true, innerMtu: 9166 });
  });
  it('L2 convention counts the Ethernet header; a 1500 hop drops 4 KB RoCE', () => {
    expect(checkHop(9000, 9000, 4156, 'none', 'l2', false)).toMatchObject({ fullSize: 9014, fullFits: false, innerMtu: 8986 });
    expect(checkHop(1500, 9000, 4156, 'none', 'l3', false).roceFits).toBe(false);
  });
});

describe('QueueLatency', () => {
  it('serialization and packet rate include preamble + IPG', () => {
    expect(serializationS(4158, 400)).toBeCloseTo((4178 * 8) / 400e9, 15); // 83.56 ns
    expect(packetsPerSecond(64, 100) / 1e6).toBeCloseTo(148.81, 2); // 1e11 / (84 * 8)
    expect(queueDelayS(1e6, 400)).toBeCloseTo(20e-6, 12); // 8e6 / 4e11
    expect(queueDelayS(10e6, 100)).toBeCloseTo(800e-6, 12);
  });
  it('8:1 incast at 400G into 2 MB, tail drop', () => {
    const r = incast(8, 1e6, 2e6, 400, false);
    // R = 50 GB/s; fill = 2e6 / (7 * 5e10) = 5.714 us; burst = 1e6 / 5e10 = 20 us
    // arrivals 8 MB, unbounded peak 7 MB, drops 5 MB; end = (8 - 5) MB / R = 60 us; last byte waits 2 MB / R = 40 us
    expect(r.fillS).toBeCloseTo(2e6 / 3.5e11, 15);
    expect(r).toMatchObject({ peakUnbounded: 7e6, peak: 2e6, drops: 5e6 });
    expect(r.endS).toBeCloseTo(60e-6, 12);
    expect(r.maxDelayS).toBeCloseTo(40e-6, 12);
    expect(r.dropFrom).toBeCloseTo(r.fillS, 15);
    expect(r.dropTo).toBeCloseTo(20e-6, 12);
    expect(fmtTime(r.fillS)).toBe('5.71 µs');
  });
  it('same incast with idealised pause: no drops, queue empties at N*B / R', () => {
    const r = incast(8, 1e6, 2e6, 400, true);
    expect(r.drops).toBe(0);
    expect(r.endS).toBeCloseTo(160e-6, 12); // 8e6 / 5e10
    expect(r.points[2][0]).toBeCloseTo(120e-6, 12); // starts draining at 160 - 40 us
  });
  it('no overflow when (N-1)*B <= buffer, and N = 1 never fills', () => {
    const r = incast(2, 1e6, 2e6, 400, false);
    expect(r).toMatchObject({ peak: 1e6, drops: 0, dropFrom: null });
    expect(r.endS).toBeCloseTo(40e-6, 12); // 2e6 / 5e10
    const one = incast(1, 1e6, 2e6, 400, false);
    expect(one.fillS).toBe(Infinity);
    expect(one.peak).toBe(0);
    expect(fmtBytes(1.55e6)).toBe('1.55 MB');
  });
});

describe('CollectiveExplorer', () => {
  it('busbw factors match nccl-tests', () => {
    expect(busbwFactor('allreduce', 8)).toBe(1.75); // 2*7/8
    expect(busbwFactor('allgather', 4)).toBe(0.75);
    expect(busbwFactor('reducescatter', 4)).toBe(0.75);
    expect(busbwFactor('alltoall', 8)).toBe(0.875);
    expect(busbwFactor('broadcast', 8)).toBe(1);
    expect(busbwFactor('reduce', 8)).toBe(1);
    expect(sentPerRank('allreduce', 4)).toBe(1.5);
    // ideal all-reduce of 1024 MB over n = 8 at 50 GB/s busbw: 1024 * 1.75 / 50 = 35.84 ms
    expect((1024 * busbwFactor('allreduce', 8)) / 50).toBeCloseTo(35.84, 10);
  });
  it('all-gather and reduce-scatter buffers', () => {
    const ag = buffers('allgather', 4, 0);
    expect(ag.before[2].map((c) => c?.label ?? null)).toEqual([null, null, 'C', null]);
    expect(ag.after[2].map((c) => c!.kind)).toEqual(['recv', 'recv', 'own', 'recv']);
    const rs = buffers('reducescatter', 4, 0);
    expect(rs.after[3].map((c) => c?.label ?? null)).toEqual([null, null, null, 'Σ3']);
    expect(ioSize('allgather', 4, false)).toEqual({ in: 0.25, out: 1 });
    expect(ioSize('reduce', 4, false)).toEqual({ in: 1, out: 0 });
  });
  it('all-to-all transposes chunks; broadcast copies the root', () => {
    const a = buffers('alltoall', 3, 0);
    expect(a.after[1].map((c) => `${c!.label}:${c!.kind}`)).toEqual(['A1:recv', 'B1:own', 'C1:recv']);
    const b = buffers('broadcast', 3, 2);
    expect(b.before[0]).toEqual([null, null, null]);
    expect(b.after[0].map((c) => c!.label)).toEqual(['C0', 'C1', 'C2']);
    expect(b.after[2].every((c) => c!.kind === 'own')).toBe(true);
  });
});

describe('ParallelismMap (additional cases)', () => {
  const at = (N: number, TP: number, PP: number, EP: number, kind: 'tp' | 'dp' | 'ep') => {
    const DP = N / (TP * PP);
    return placement(coords(N, TP, PP, EP), (c) => commKey(c, kind, TP, DP, EP));
  };
  it('rank 43 of 128 with TP 8, PP 2, EP 4 (DP 8)', () => {
    // r = tp + 8*(dp + 8*pp): 43 = 3 + 8*5 -> tp 3, dp 5, pp 0; ep = 5 mod 4 = 1, group 1; rank 64 starts stage 1
    expect(coords(128, 8, 2, 4)[43]).toMatchObject({ tp: 3, dp: 5, pp: 0, ep: 1, epGroup: 1, server: 5 });
    expect(coords(128, 8, 2, 4)[64]).toMatchObject({ tp: 0, dp: 0, pp: 1 });
  });
  it('EP 2 with TP 8 crosses servers only; DP with TP 4 is hierarchical; TP 1 has no TP traffic', () => {
    expect(at(128, 8, 1, 2, 'ep')).toBe('rdma'); // dp 2k and 2k+1 are on adjacent servers
    expect(at(64, 4, 1, 1, 'dp')).toBe('hier'); // 2 DP peers per server, 8 servers
    expect(at(64, 1, 8, 1, 'tp')).toBe('none');
  });
  it('PP volume without TP and the MoE model expert count', () => {
    const t = trafficPerGpu({ TP: 1, PP: 2, DP: 32, EP: 1, model: MODELS[0], seq: 2048, micro: 1, mb: 4 });
    expect(t.pp).toBe(2 * 4 * 2048 * 4096 * 2); // 2 x micro-batches x b*s*h*2 B = 134,217,728
    expect(t.tp).toBe(0);
    expect(MODELS[2].experts).toBe(8);
  });
});
