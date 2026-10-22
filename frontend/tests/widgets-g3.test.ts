// Hand-checked values for group g3 widgets: BGP path sim, EVPN route explorer, IB addressing,
// verbs flow, transport matrix, PFC deadlock builder.
import { describe, expect, it } from 'vitest';
import { diff, routers, simulate } from '../src/widgets/BgpPathSim';
import { ROUTE_TYPES, scenario } from '../src/widgets/EvpnRouteExplorer';
import { canTalk, computeLfts, defaultGid, hex, pkeyValue, trace } from '../src/widgets/IbAddressing';
import { buildSteps, packetCount, segment, segmentOpcodes } from '../src/widgets/VerbsFlow';
import { meets, qpCounts, remotePeers } from '../src/widgets/TransportMatrix';
import {
  computePath, cyclicNodes, dependencyEdges, FLOWS, newSim, step, waitCycle, type Remedies, type RouteCfg,
} from '../src/widgets/PfcDeadlock';

/* ---------------- BGP (RFC 7938 numbering, eBGP loop prevention, multipath) ---------------- */

describe('BgpPathSim', () => {
  const none = new Set<string>();

  it('numbers spines with one shared ASN and leaves uniquely (RFC 7938)', () => {
    const rs = routers(4);
    expect(rs.filter((r) => r.kind === 'spine').map((r) => r.asn)).toEqual([65000, 65000, 65000, 65000]);
    expect(rs.filter((r) => r.kind === 'leaf').map((r) => r.asn)).toEqual([65101, 65102, 65103, 65104]);
    expect(routers(3, true).filter((r) => r.kind === 'spine').map((r) => r.asn)).toEqual([65001, 65002, 65003]);
  });

  it('shared spine ASN: leaf1 has 4-way ECMP to leaf2 with AS_PATH [65000 65102]; spines drop leaf re-advertisements', () => {
    const ribs = simulate(4, none, false, false, 64);
    const e = ribs.L1[1];
    expect(e.paths.map((p) => p.asPath)).toEqual([[65000, 65102], [65000, 65102], [65000, 65102], [65000, 65102]]);
    expect(e.ecmp).toEqual(['S1', 'S2', 'S3', 'S4']); // identical AS_PATHs: multipath without relax
    // S1 hears leaf2's prefix directly ([65102]) and from L1, L3, L4 as [651xx 65000 65102] -> contains 65000 -> loop
    const s = ribs.S1[1];
    expect(s.paths.filter((p) => p.loop).length).toBe(3);
    expect(s.ecmp).toEqual(['L2']);
    expect(ribs.L1[0].local).toBe(true);
    expect(ribs.L1[0].ecmp).toEqual([]);
  });

  it('unique spine ASNs need multipath-relax; maximum-paths caps the set', () => {
    // paths [65001 65102], [65002 65102], ... are equal length but not identical
    expect(simulate(4, none, true, false, 64).L1[1].ecmp).toEqual(['S1']);
    expect(simulate(4, none, true, true, 64).L1[1].ecmp).toEqual(['S1', 'S2', 'S3', 'S4']);
    expect(simulate(4, none, false, true, 2).L1[1].ecmp).toEqual(['S1', 'S2']);
    expect(simulate(4, none, false, true, 1).L1[1].ecmp).toEqual(['S1']);
  });

  it('a failed S1-L2 link: withdrawal is final on S1 (no path hunting) and touches 7 (router, prefix) entries', () => {
    const before = simulate(4, none, false, true, 64);
    const after = simulate(4, new Set(['S1-L2']), false, true, 64);
    expect(after.S1[1].ecmp).toEqual([]); // every alternative contains AS 65000
    expect(after.L1[1].ecmp).toEqual(['S2', 'S3', 'S4']);
    expect(after.L2[0].ecmp).toEqual(['S2', 'S3', 'S4']);
    const ch = diff(before, after);
    // L2 loses S1 for prefixes 0, 2, 3 (3); L1, L3, L4 lose S1 for prefix 1 (3); S1 loses prefix 1 (1) = 7
    expect(ch.length).toBe(7);
    expect(ch.find((c) => c.router === 'S1')).toMatchObject({ prefix: 1, removed: ['L2'], lost: true });
  });

  it('unique spine ASNs allow path hunting: S1 keeps a longer valley path to leaf2', () => {
    const after = simulate(4, new Set(['S1-L2']), true, true, 64);
    // L1 best to leaf2 = via S2 [65002 65102]; it re-advertises [65101 65002 65102] to S1 (no 65001 in it)
    const viaL1 = after.S1[1].paths.find((p) => p.from === 'L1')!;
    expect(viaL1.asPath).toEqual([65101, 65002, 65102]);
    expect(viaL1.loop).toBe(false);
    expect(after.S1[1].ecmp).toEqual(['L1', 'L3', 'L4']); // 3 equal-length (3-hop) paths with relax
    expect(after.L3[1].ecmp).toEqual(['S2', 'S3', 'S4']); // S1's 4-hop path is longer, not multipath
  });

  it('isolating leaf1 withdraws its prefix everywhere', () => {
    const f = new Set(['S1-L1', 'S2-L1']);
    const r = simulate(2, f, false, true, 64);
    for (const id of ['S1', 'S2', 'L2', 'L3', 'L4']) expect(r[id][0].ecmp).toEqual([]);
    expect(r.L1[1].ecmp).toEqual([]);
  });
});

/* ---------------- EVPN NLRI sizes (RFC 7432 sec. 7, RFC 9136 sec. 3) ---------------- */

/** Sum the min / max byte counts of a route type's fields ("1 + 0, 4 or 16" -> 1+0 .. 1+16). */
function nlriRange(type: number): [number, number] {
  let lo = 0, hi = 0;
  for (const f of ROUTE_TYPES.find((r) => r.type === type)!.fields) for (const part of f.bytes.split('+')) {
    const ns = part.match(/\d+/g)!.map(Number);
    lo += Math.min(...ns); hi += Math.max(...ns);
  }
  return [lo, hi];
}

describe('EvpnRouteExplorer', () => {
  it('route type field sizes add up to the RFC NLRI lengths', () => {
    expect(nlriRange(1)).toEqual([25, 25]); // RD 8 + ESI 10 + Eth Tag 4 + Label 3
    // MAC-only: 8 + 10 + 4 + 1 + 6 + 1 + 0 + 3 = 33; IPv6 + Label2: 8+10+4+1+6+1+16+3+3 = 52
    expect(nlriRange(2)).toEqual([33, 52]);
    expect(nlriRange(3)).toEqual([17, 29]); // 8 + 4 + 1 + 4 / 16
    expect(nlriRange(4)).toEqual([23, 35]); // 8 + 10 + 1 + 4 / 16
    // RFC 9136: 8 + 10 + 4 + 1 + 4 + 4 + 3 = 34 (IPv4); 8 + 10 + 4 + 1 + 16 + 16 + 3 = 58 (IPv6)
    expect(nlriRange(5)).toEqual([34, 58]);
  });

  it('single-homed bring-up sends type 3, 2, 2, 5', () => {
    const s = scenario(false);
    expect(s.flatMap((x) => x.routes.map((r) => r.type))).toEqual([3, 2, 2, 5]);
    expect(s[1].routes[0].nlri).toBe('[2]:[0]:[0]:[48]:[00:00:5e:00:53:01]');
  });

  it('dual-homed bring-up adds type 4 and both EAD flavours with MAX-ET for per-ES', () => {
    const s = scenario(true);
    expect(s.length).toBe(5);
    expect(s.flatMap((x) => x.routes.map((r) => r.type))).toEqual([4, 1, 1, 3, 2, 2, 5]);
    expect(s[0].routes[1].nlri.endsWith(`[${0xffffffff}]`)).toBe(true);
    expect(s[2].routes[0].nlri).toContain('[00:11:22:33:44:55:66:77:88:99]');
  });
});

/* ---------------- InfiniBand addressing ---------------- */

describe('IbAddressing', () => {
  it('forms the default GID from fe80::/64 and the port GUID', () => {
    expect(defaultGid(0x0002c90300b1a001n)).toBe('fe80:0000:0000:0000:0002:c903:00b1:a001');
    expect(hex(0xbfff, 4)).toBe('0xbfff');
  });

  it('P_Key: bit 15 = full membership; at least one full member needed', () => {
    expect(pkeyValue(0x0001, 'full')).toBe(0x8001);
    expect(pkeyValue(0x0001, 'limited')).toBe(0x0001);
    expect(pkeyValue(0xffff, 'limited')).toBe(0x7fff);
    expect(canTalk('full', 'limited')).toBe(true);
    expect(canTalk('limited', 'limited')).toBe(false);
    expect(canTalk('full', 'none')).toBe(false);
  });

  it('LFTs balance destinations across the two ISLs (LIDs processed in ascending order)', () => {
    const { lft, forbidden } = computeLfts(false, 'minhop');
    // SW1: A->1, self->0, B->2, SW2 {3,4} unused -> 3, C: use3=1 -> 4, D: tie -> 3
    expect(lft.SW1).toEqual({ 1: 1, 2: 0, 3: 2, 4: 3, 5: 4, 6: 3 });
    // SW2: A -> 3, SW1 -> 4, B -> tie -> 3, self -> 0, C -> 1, D -> 2
    expect(lft.SW2).toEqual({ 1: 3, 2: 4, 3: 3, 4: 0, 5: 1, 6: 2 });
    expect(forbidden).toBe(0);
    expect(computeLfts(false, 'updn')).toEqual({ lft, forbidden: 0 });
  });

  it('with SW1 p4 - SW2 p4 down every inter-switch destination uses port 3', () => {
    const { lft } = computeLfts(true, 'minhop');
    expect([lft.SW1[4], lft.SW1[5], lft.SW1[6], lft.SW2[1], lft.SW2[2], lft.SW2[3]]).toEqual([3, 3, 3, 3, 3, 3]);
  });

  it('traces B -> D by DLID 0x0006', () => {
    const { lft } = computeLfts(false, 'minhop');
    expect(trace('B', 'D', lft, false)).toEqual([
      { at: 'SW1', inPort: 2, outPort: 3, next: 'SW2' },
      { at: 'SW2', inPort: 3, outPort: 2, next: 'D' },
    ]);
  });
});

/* ---------------- Verbs RC packet flow ---------------- */

describe('VerbsFlow', () => {
  it('counts packets as ceil(bytes / MTU), minimum 1', () => {
    expect(packetCount(10000, 4096)).toBe(3); // 4096 + 4096 + 1808
    expect(packetCount(0, 4096)).toBe(1);
    expect(packetCount(1048576, 1024)).toBe(1024);
    expect(segmentOpcodes('SEND', 1)).toEqual(['SEND_ONLY']);
  });

  it('RDMA WRITE: RETH only on FIRST, consecutive PSNs, last packet carries the remainder', () => {
    const pk = segment('write', 10000, 4096);
    expect(pk.map((p) => p.opcode)).toEqual(['RDMA_WRITE_FIRST', 'RDMA_WRITE_MIDDLE', 'RDMA_WRITE_LAST']);
    expect(pk.map((p) => p.headers)).toEqual(['BTH + RETH', 'BTH', 'BTH']);
    expect(pk.map((p) => p.bytes)).toEqual([4096, 4096, 1808]); // 10000 - 2*4096
    expect(pk.map((p) => p.psn)).toEqual([1000, 1001, 1002]);
    expect(segment('write', 64, 4096)[0]).toMatchObject({ opcode: 'RDMA_WRITE_ONLY', headers: 'BTH + RETH' });
  });

  it('READ responses: AETH on FIRST/LAST/ONLY, not MIDDLE; flow B -> A', () => {
    const pk = segment('read', 10000, 4096);
    expect(pk.map((p) => p.headers)).toEqual(['BTH + AETH', 'BTH', 'BTH + AETH']);
    expect(pk.every((p) => p.dir === 'B→A')).toBe(true);
    expect(segment('read', 64, 4096)[0]).toMatchObject({ opcode: 'RDMA_READ_RESPONSE_ONLY', headers: 'BTH + AETH' });
    expect(segment('send', 10000, 4096).every((p) => p.headers === 'BTH')).toBe(true);
  });

  it('step sequences: READ has no ACK step, SEND adds receive-side steps, bad rkey ends in an error poll', () => {
    const w = buildSteps('write', 10000, 4096, false, false);
    const sd = buildSteps('send', 10000, 4096, false, false);
    const r = buildSteps('read', 10000, 4096, false, false);
    expect(w.length).toBe(10);
    expect(sd.length).toBe(12);
    expect(r.length).toBe(10);
    expect(r.some((s) => s.title === 'ACK comes back')).toBe(false);
    expect(w.some((s) => s.title === 'ACK comes back')).toBe(true);
    const bad = buildSteps('write', 10000, 4096, false, true);
    expect(bad[bad.length - 1].tone).toBe('danger');
    expect(bad.some((s) => s.detail.includes('IBV_WC_REM_ACCESS_ERR'))).toBe(true);
  });
});

/* ---------------- Transport capability matrix and QP counts ---------------- */

describe('TransportMatrix', () => {
  it('peer count = (N-1)*P (+ P-1 with intra-node RDMA)', () => {
    expect(remotePeers(128, 8, false)).toBe(1016); // 127 * 8
    expect(remotePeers(128, 8, true)).toBe(1023); // + 7
    expect(remotePeers(2, 1, true)).toBe(1);
  });

  it('QP counts for N=128, P=8', () => {
    // RC: 1016 per process, 8 * 1016 = 8128 per node, 1024 processes * 1016 = 1,040,384
    expect(qpCounts('RC', 128, 8, false, 1, 4)).toMatchObject({ perProcess: 1016, perNode: 8128, cluster: 1040384 });
    expect(qpCounts('RC', 128, 8, false, 2, 4).perProcess).toBe(2032);
    // XRC: 127 INI per process; 8*127 = 1016 TGT per node; node = 8*127 + 1016 = 2032; cluster = 2032 * 128 = 260,096
    expect(qpCounts('XRC', 128, 8, false, 1, 4)).toMatchObject({ perProcess: 127, perNode: 2032, cluster: 260096 });
    // DC: 4 DCIs + 1 DCT = 5 per process, 40 per node, 5120 cluster
    expect(qpCounts('DC', 128, 8, false, 1, 4)).toMatchObject({ perProcess: 5, perNode: 40, cluster: 5120 });
    expect(qpCounts('UD', 128, 8, false, 1, 4)).toMatchObject({ perProcess: 1, perNode: 8, cluster: 1024 });
  });

  it('capabilities: UC no READ/atomics, UD SEND only and <= MTU, DC not vendor-neutral', () => {
    expect(meets('UC', 'write')).toBe(true);
    expect(meets('UC', 'read')).toBe(false);
    expect(meets('UC', 'atomic')).toBe(false);
    expect(meets('UD', 'write')).toBe(false);
    expect(meets('UD', 'big')).toBe(false);
    expect(meets('UD', 'rel')).toBe(false);
    expect(meets('XRC', 'atomic')).toBe(true);
    expect(meets('DC', 'portable')).toBe(false);
    expect(meets('DC', 'read')).toBe(true);
  });
});

/* ---------------- PFC deadlock (cyclic buffer dependency) ---------------- */

describe('PfcDeadlock', () => {
  const cfg: RouteCfg = { failed: ['S1-L4', 'S2-L3'], valley: true, loop: false };
  const none: Remedies = { watchdog: false, updown: false, tagger: false, lossy: false };
  const q = (p: ReturnType<typeof computePath>) => p.hops.map((h) => `${h.q}/${h.cls}`);

  it('valley routing after two link failures bounces F1 and F2 once each', () => {
    // F1 H1->H4 hashes to S1, which lost L4: S1 -> L2 -> S2 -> L4 (one bounce at L2)
    expect(q(computePath(FLOWS[0], cfg))).toEqual(['H1>L1/0', 'L1>S1/0', 'S1>L2/0', 'L2>S2/1', 'S2>L4/1']);
    // F2 H2->H3 hashes to S2, which lost L3: S2 -> L1 -> S1 -> L3
    expect(q(computePath(FLOWS[1], cfg))).toEqual(['H2>L2/0', 'L2>S2/0', 'S2>L1/0', 'L1>S1/1', 'S1>L3/1']);
  });

  it('the two bounces close a 4-buffer cycle; a priority per bounce or lossy removes it', () => {
    const paths = [computePath(FLOWS[0], cfg), computePath(FLOWS[1], cfg)];
    expect([...cyclicNodes(dependencyEdges(paths, none))].sort()).toEqual(['L1>S1#0', 'L2>S2#0', 'S1>L2#0', 'S2>L1#0']);
    expect(cyclicNodes(dependencyEdges(paths, { ...none, tagger: true })).size).toBe(0);
    expect(dependencyEdges(paths, { ...none, lossy: true })).toEqual([]);
  });

  it('up-down routing (no valley) avoids the failed spines entirely', () => {
    const ud = { ...cfg, valley: false };
    expect(q(computePath(FLOWS[0], ud))).toEqual(['H1>L1/0', 'L1>S2/0', 'S2>L4/0']);
    expect(q(computePath(FLOWS[1], ud))).toEqual(['H2>L2/0', 'L2>S1/0', 'S1>L3/0']);
    const paths = [computePath(FLOWS[0], ud), computePath(FLOWS[1], ud)];
    expect(cyclicNodes(dependencyEdges(paths, none)).size).toBe(0);
  });

  it('a micro-loop L2 <-> S1 for L3 runs until the hop limit', () => {
    const p = computePath(FLOWS[1], { failed: [], valley: false, loop: true });
    expect(p.outcome).toBe('ttl');
    expect(p.hops.length).toBe(14);
  });

  it('simulation: the burst locks the cycle, and it stays locked with senders stopped', () => {
    const paths = [computePath(FLOWS[0], cfg), computePath(FLOWS[1], cfg), null, null];
    let s = newSim();
    for (let i = 0; i < 60; i++) s = step(s, paths, none, { stall: s.t >= 4 && s.t < 30, senders: true });
    expect(waitCycle(s, paths, none).length).toBe(4);
    const d0 = s.delivered.reduce((a, b) => a + b, 0);
    for (let i = 0; i < 40; i++) s = step(s, paths, none, { stall: false, senders: false });
    expect(waitCycle(s, paths, none).length).toBe(4);
    expect(s.delivered.reduce((a, b) => a + b, 0)).toBe(d0); // nothing moves on a deadlocked cycle
  });

  it('simulation: the watchdog drops packets and breaks the lock once senders stop', () => {
    const paths = [computePath(FLOWS[0], cfg), computePath(FLOWS[1], cfg), null, null];
    const wd = { ...none, watchdog: true };
    let s = newSim();
    for (let i = 0; i < 60; i++) s = step(s, paths, wd, { stall: s.t >= 4 && s.t < 30, senders: true });
    for (let i = 0; i < 80; i++) s = step(s, paths, wd, { stall: false, senders: false });
    expect(s.drops.wd).toBeGreaterThan(0);
    expect(waitCycle(s, paths, wd)).toEqual([]);
  });
});
