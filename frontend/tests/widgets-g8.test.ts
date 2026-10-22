// Hand-checked numbers for group 8 widgets: P_Key membership matrix, cabling plan validator and
// packet spraying / reordering.
import { describe, expect, it } from 'vitest';
import {
  canTalk, forgedDelivery, hex4, pkeyMatch, pkeyTable, pkeyValue, PARTITIONS, PRESETS as PK_PRESETS, renderPartitionsConf, tenantsIsolated,
} from '../src/widgets/PkeyMembership';
import {
  applyFaults, lldpTable, planTable, report, summarize, validate, PRESETS as CV_PRESETS, type Fault, type FindingClass,
} from '../src/widgets/CablingValidator';
import {
  arrivalOrder, ecmpCompletion, goBackNPass, lastArrival, reorderBuffer, reorderStats, simulateGoBackN, slotNs, sprayArrivals, WIRE_BYTES,
} from '../src/widgets/SprayReorder';

const pk = (id: string) => PK_PRESETS.find((p) => p.id === id)!.assign;
const part = (id: string) => PARTITIONS.find((p) => p.id === id)!;

describe('PkeyMembership', () => {
  it('encodes membership in bit 15', () => {
    expect(pkeyValue(0x7fff, 'full')).toBe(0xffff); // default partition, full member
    expect(pkeyValue(0x7fff, 'limited')).toBe(0x7fff);
    expect(pkeyValue(0x0101, 'full')).toBe(0x8101); // 0x8000 | 0x0101
    expect(hex4(0x0102)).toBe('0x0102');
  });
  it('matches only same partition and not limited-limited', () => {
    expect(pkeyMatch(0xffff, 0x7fff)).toBe(true); // full + limited
    expect(pkeyMatch(0xffff, 0xffff)).toBe(true); // full + full
    expect(pkeyMatch(0x7fff, 0x7fff)).toBe(false); // limited + limited never matches
    expect(pkeyMatch(0x8101, 0x8102)).toBe(false); // different partition numbers
    expect(pkeyMatch(0x8000, 0x8000)).toBe(false); // partition 0 is not usable
  });
  it('limited-limited ports cannot talk, a full member reaches both', () => {
    const a = pk('tenants');
    const ab = canTalk(a, 'A1', 'B1');
    expect(ab.ok).toBe(false);
    expect(ab.bothLimited).toEqual(['Default']);
    expect(canTalk(a, 'A1', 'STOR').via).toEqual(['Default']); // A1 limited, STOR full
    expect(canTalk(a, 'A1', 'A2').via).toEqual(['tenant_a']); // full + full; Default is limited + limited
    expect(canTalk(a, 'B2', 'A2').reason).toMatch(/both are limited/);
    expect(tenantsIsolated(a)).toBe(true);
  });
  it('shared storage partition: tenants limited, storage full', () => {
    const a = pk('storage');
    for (const t of ['A1', 'A2', 'B1', 'B2']) expect(canTalk(a, t, 'STOR').via).toContain('storage');
    expect(canTalk(a, 'A1', 'B1').ok).toBe(false);
    expect(canTalk(a, 'A1', 'B1').bothLimited).toEqual(['Default', 'storage']);
    expect(tenantsIsolated(a)).toBe(true);
    // the mistake preset makes tenants full in storage: full + full matches, isolation is gone
    expect(canTalk(pk('mistake'), 'A1', 'B1').via).toEqual(['storage']);
    expect(tenantsIsolated(pk('mistake'))).toBe(false);
    expect(tenantsIsolated(pk('flat'))).toBe(false);
  });
  it('builds P_Key tables and an OpenSM partitions.conf', () => {
    expect(pkeyTable(pk('tenants'), 'A1').map(hex4)).toEqual(['0x7fff', '0x8101']);
    expect(pkeyTable(pk('tenants'), 'SM').map(hex4)).toEqual(['0xffff']);
    const conf = renderPartitionsConf(pk('tenants'));
    expect(conf).toContain('Default=0x7fff, ipoib : 0x00000000000a0001=limited');
    expect(conf).toContain('SELF=full ;');
    expect(conf).toContain('tenant_b=0x0102, ipoib : 0x00000000000b0001=full, 0x00000000000b0002=full ;');
    expect(conf).not.toContain('storage='); // no members -> no line
  });
  it('a forged key is stopped only by switch enforcement', () => {
    const a = pk('tenants');
    const off = forgedDelivery(a, 'B1', 'A1', part('tenant_a'), false);
    expect(off.forged).toBe(0x8101);
    expect(off.delivered).toBe(true); // A1 holds 0x8101 and cannot tell the key was forged
    expect(forgedDelivery(a, 'B1', 'A1', part('tenant_a'), true).delivered).toBe(false);
    expect(forgedDelivery(a, 'B1', 'A1', part('storage'), false).delivered).toBe(false); // A1 has no storage key
    const def = forgedDelivery(a, 'B1', 'A1', part('default'), false);
    expect(def.delivered).toBe(false); // B1 holds Default (limited): normal rule, both limited
    expect(def.forged).toBe(0x7fff); // B1's own key, not a forged one
    expect(def.where).toMatch(/Flipping the full bit \(0xffff\)/); // the limited-to-full case is flagged, not modelled
  });
});

describe('CablingValidator', () => {
  const plan = planTable();
  const run = (faults: Fault[]) => validate(plan, lldpTable(applyFaults(faults).ph));
  const classes = (faults: Fault[]) => run(faults).map((f) => f.cls).sort();

  it('the clean build has 24 planned ports and no findings', () => {
    // 4 leaves × (4 host ports + 2 uplinks) = 24
    expect(Object.keys(plan)).toHaveLength(24);
    expect(plan['leaf-r3:swp2']).toEqual({ dev: 'node-02', port: 'nic3' });
    expect(plan['leaf-r1:swp32']).toEqual({ dev: 'spine-2', port: 'swp2' });
    expect(run([])).toEqual([]);
    const s = summarize(plan, lldpTable(applyFaults([]).ph), []);
    expect(s).toMatchObject({ planned: 24, ok: 24, pass: true });
  });

  const cases: [Fault, FindingClass[], string[]][] = [
    [{ kind: 'rail-swap', node: 1, a: 0, b: 1 }, ['rail-crossing', 'rail-crossing'], ['leaf-r0:swp2', 'leaf-r1:swp2']],
    [{ kind: 'pair-swap', rail: 3, a: 0, b: 1 }, ['port-mismatch', 'port-mismatch'], ['leaf-r3:swp1', 'leaf-r3:swp2']],
    [{ kind: 'wrong-leaf', node: 2, nic: 0, leaf: 2 }, ['missing', 'rail-crossing'], ['leaf-r0:swp3', 'leaf-r2:swp5']],
    [{ kind: 'wrong-port', node: 0, nic: 1 }, ['missing', 'port-mismatch'], ['leaf-r1:swp1', 'leaf-r1:swp5']],
    [{ kind: 'missing', node: 3, nic: 3 }, ['missing'], ['leaf-r3:swp4']],
    [{ kind: 'nic-down', node: 3, nic: 2 }, ['missing'], ['leaf-r2:swp4']],
    [{ kind: 'missing-uplink', leaf: 2, spine: 1 }, ['missing'], ['leaf-r2:swp32']],
    [{ kind: 'stray', leaf: 3 }, ['unexpected'], ['leaf-r3:swp5']],
  ];
  for (const [f, cls, ports] of cases) {
    it(`detects and classifies ${f.kind}`, () => {
      const fs = run([f]);
      expect(fs.map((x) => x.cls).sort()).toEqual(cls);
      expect(fs.map((x) => x.port).sort()).toEqual(ports);
    });
  }

  it('a rail swap shows the NIC of the other rail on each leaf', () => {
    const fs = run([{ kind: 'rail-swap', node: 1, a: 0, b: 1 }]);
    const r0 = fs.find((x) => x.port === 'leaf-r0:swp2')!;
    expect(r0.expected).toEqual({ dev: 'node-02', port: 'nic0' });
    expect(r0.observed).toEqual({ dev: 'node-02', port: 'nic1' });
    expect(r0.hint).toMatch(/rail-1 NIC on the rail-0 leaf; planned at leaf-r1:swp2/);
  });

  it('a missing cable and a NIC that is down look the same from the leaf', () => {
    expect(run([{ kind: 'missing', node: 0, nic: 0 }])).toEqual(run([{ kind: 'nic-down', node: 0, nic: 0 }]));
  });

  it('combined faults add up, conflicting faults are rejected', () => {
    // lesson preset: pair swap (2) + rail swap (2) + missing (1) = 5 findings, 24 - 5 = 19 OK
    const lesson = CV_PRESETS.find((p) => p.id === 'lesson')!.faults;
    expect(classes(lesson)).toEqual(['missing', 'port-mismatch', 'port-mismatch', 'rail-crossing', 'rail-crossing']);
    const obs = lldpTable(applyFaults(lesson).ph);
    const s = summarize(plan, obs, validate(plan, obs));
    expect(s.ok).toBe(19);
    expect(s.pass).toBe(false);
    expect(report(s, validate(plan, obs))).toMatch(/RESULT FAIL$/);
    // mixed: wrong leaf (2) + NIC down (1) + missing uplink (1) + stray (1) = 5; 3 missing planned ports -> 21 OK
    const mixed = CV_PRESETS.find((p) => p.id === 'mixed')!.faults;
    expect(classes(mixed)).toEqual(['missing', 'missing', 'missing', 'rail-crossing', 'unexpected']);
    // the same NIC in two faults: the second is rejected
    expect(applyFaults([{ kind: 'missing', node: 0, nic: 0 }, { kind: 'rail-swap', node: 0, a: 0, b: 1 }]).rejected).toEqual([1]);
    expect(applyFaults([{ kind: 'rail-swap', node: 0, a: 2, b: 2 }]).rejected).toEqual([0]);
  });
});

describe('SprayReorder', () => {
  it('slot length: 4 KB RoCEv2 packet at 400G', () => {
    // 4096 + 14 + 20 + 8 + 12 + 4 + 4 = 4158 B frame, + 20 B preamble/IPG = 4178 B; 33 424 bit / 400 Gb/s = 83.56 ns
    expect(WIRE_BYTES).toBe(4178);
    expect(slotNs(400)).toBeCloseTo(83.56, 2);
  });

  // K = 8 over 2 paths, delays [2, 5]: even PSN i arrives at i + 2, odd at i + 5
  // 0@2 1@6 2@4 3@8 4@6 5@10 6@8 7@12 -> sorted (ties by send time): 0 2 1 4 3 6 5 7
  const cfg8 = { k: 8, delays: [2, 5], congested: null, backlog: 0 };
  const order8 = [0, 2, 1, 4, 3, 6, 5, 7];
  it('computes arrival order and reordering', () => {
    const pk8 = sprayArrivals(cfg8);
    expect(pk8.map((p) => p.arrive)).toEqual([2, 6, 4, 8, 6, 10, 8, 12]);
    expect(arrivalOrder(pk8)).toEqual(order8);
    const st = reorderStats(order8);
    // RFC 4737: 1 (after 2), 3 (after 4), 5 (after 6) are reordered
    expect(st.reordered).toBe(3);
    expect(st.fraction).toBeCloseTo(0.375, 12);
    expect(st.maxDisplacement).toBe(1);
    expect(lastArrival(pk8)).toBe(12);
  });
  it('go-back-N receiver: one pass of a reordered message', () => {
    // e=0: 0 ok (e=1); 2 > 1 -> discard, NAK(1); 1 ok (e=2); 4 > 2 -> discard, NAK(2); 3, 6, 5, 7 discarded silently
    expect(goBackNPass(order8)).toEqual({ accepted: 2, discarded: 6, naks: [1, 2], ePsn: 2 });
    expect(goBackNPass([0, 1, 2, 3])).toEqual({ accepted: 4, discarded: 0, naks: [], ePsn: 4 });
  });
  it('reorder buffer peak', () => {
    // 0 deliver; 2 held (1); 1 -> deliver 1, 2 (0); 4 held (1); 3 -> 3, 4 (0); 6 held; 5 -> 5, 6; 7
    expect(reorderBuffer(order8)).toEqual({ peak: 1, occupancy: [0, 1, 0, 1, 0, 1, 0, 0] });
    // 3 2 1 0: 3, 2, 1 held (peak 3), 0 releases all
    expect(reorderBuffer([3, 2, 1, 0]).peak).toBe(3);
  });
  it('go-back-N simulation: hand trace with K = 4, delays [1, 3]', () => {
    // t0 send 0 (p0, arr 1); t1 rx 0, send 1 (p1, arr 4); t2 send 2 (p0, arr 3); t3 rx 2 -> discard, NAK(1) due t4; send 3 (p1, arr 6)
    // t4 rx 1 (e=2); NAK(1) rewinds to 1; send 1 (p0, arr 5); t5 rx 1 dup; send 2 (p1, arr 8)
    // t6 rx 3 -> discard, NAK(2) due t7; send 3 (p0, arr 7); t7 rx 3 discard (silent); NAK(2) rewinds; send 2 (p1, arr 10)
    // t8 rx 2 (e=3); send 3 (p0, arr 9); t9 rx 3 (e=4) done. Sent 4 + 3 + 2 = 9.
    const r = simulateGoBackN({ k: 4, delays: [1, 3], congested: null, backlog: 0 });
    expect(r).toEqual({ sent: 9, retransmitted: 5, naks: 2, discarded: 3, duplicates: 1, completion: 9, done: true });
    // in-order delivery costs nothing: one path, 8 packets, no NAKs
    expect(simulateGoBackN({ k: 8, delays: [4], congested: null, backlog: 0 })).toMatchObject({ sent: 8, naks: 0, completion: 11 });
  });
  it('go-back-N always finishes, and costs more than placement', () => {
    const cfg = { k: 64, delays: [4, 9, 6, 12, 5, 8, 7, 10], congested: 3, backlog: 16 };
    const r = simulateGoBackN(cfg);
    expect(r.done).toBe(true);
    expect(r.sent).toBeGreaterThan(64);
    expect(r.completion).toBeGreaterThan(lastArrival(sprayArrivals(cfg)));
  });
  it('congested path: FIFO backlog drains at one packet per slot', () => {
    // path 1 starts with 4 queued; its packets leave at slots 1 and 3 -> wait 4-1 = 3 then (5-3) = 2
    const p = sprayArrivals({ k: 4, delays: [2, 2], congested: 1, backlog: 4 });
    expect(p.map((x) => x.arrive)).toEqual([2, 6, 4, 7]); // 1+3+2, 3+2+2
  });
  it('per-flow ECMP: in order, a collision doubles the time', () => {
    const cfg = { k: 16, delays: [6, 6, 6, 6], congested: null, backlog: 0 };
    expect(ecmpCompletion(cfg, 0, false)).toBe(21); // last packet sent at 15, + 6
    // shared link: 2 slots of service per packet; packet i waits 2i - i = i, arrives i + i + (2 - 1) + 6 = 2i + 7 -> i = 15: 37
    expect(ecmpCompletion(cfg, 0, true)).toBe(37);
    expect(lastArrival(sprayArrivals(cfg))).toBe(21); // equal delays: spraying does not reorder
    expect(reorderStats(arrivalOrder(sprayArrivals(cfg))).reordered).toBe(0);
  });
});
