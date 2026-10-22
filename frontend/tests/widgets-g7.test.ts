// Hand-checked numbers for group 7 widgets: perftest message-size explorer, kernel TCP/IP vs RDMA data path,
// and the InfiniBand diagnostic tools map.
import { describe, expect, it } from 'vitest';
import {
  bwBps, bwHeader, bwRow, gbpsToMib, LAT_HEADER, latUs, limitedBy, mibToGbps, nHalfPingPong, nHalfStream, packetCount,
  packetWireBytes, peakBps, SWEEP, verdict, wireBytes, type Model,
} from '../src/widgets/PerftestExplorer';
import { bypassed, LAYERS, RDMA_DATA_STEPS, RDMA_SETUP_STEPS, TCP_STEPS, TOOLS as HOST_TOOLS, toolsFor } from '../src/widgets/HostStackPaths';
import { LINKS, NODES, scopeOf, SYMPTOMS, TOOLS as IB_TOOLS, worksWithoutSm, type Scope } from '../src/widgets/IbToolsMap';

describe('PerftestExplorer', () => {
  const roce: Model = { t: 'roce4', mtu: 4096, gbps: 400, alphaUs: 1, mrM: 10 };

  it('sweeps 2 B .. 8 MiB like perftest -a', () => {
    expect(SWEEP).toHaveLength(23); // 2^1 .. 2^23
    expect(SWEEP[0]).toBe(2);
    expect(SWEEP[22]).toBe(8_388_608);
  });

  it('counts per-packet header bytes', () => {
    // RoCEv2/IPv4 first packet: preamble+SFD 8 + Eth 14 + IPv4 20 + UDP 8 + BTH 12 + RETH 16 + 4096 + ICRC 4 + FCS 4 + IFG 12 = 4194
    expect(packetWireBytes(4096, true, 'roce4')).toBe(4194);
    expect(packetWireBytes(4096, false, 'roce4')).toBe(4178); // no RETH
    expect(packetWireBytes(4096, true, 'roce6')).toBe(4214); // IPv6 header 40 instead of 20
    // InfiniBand: LRH 8 + BTH 12 + RETH 16 + 4096 + ICRC 4 + VCRC 2 = 4138
    expect(packetWireBytes(4096, true, 'ib')).toBe(4138);
    expect(packetWireBytes(4096, false, 'ib')).toBe(4122);
    // 2-byte payload padded to 4: frame 14 + 20 + 8 + (12 + 16 + 2 + 2 + 4) + 4 = 82, + 20 = 102
    expect(packetWireBytes(2, true, 'roce4')).toBe(102);
  });

  it('segments messages at the MTU', () => {
    expect(packetCount(65536, 4096)).toBe(16);
    expect(packetCount(2, 4096)).toBe(1);
    // 64 KiB RoCE: 4194 + 15 × 4178 = 66 864
    expect(wireBytes(65536, 4096, 'roce4')).toBe(66_864);
    // 10 000 B IB: 4138 + 4122 + (8 + 12 + 1808 + 4 + 2 = 1834) = 10 094
    expect(wireBytes(10_000, 4096, 'ib')).toBe(10_094);
  });

  it('converts perftest MiB/s (2^20 B) to Gb/s (10^9 bit)', () => {
    // 46 000 × 1 048 576 × 8 / 1e9 = 385.875968
    expect(mibToGbps(46_000)).toBeCloseTo(385.875968, 6);
    // 400e9 / 8 / 1 048 576 = 47 683.7158...
    expect(gbpsToMib(400)).toBeCloseTo(47_683.7158, 3);
    expect(mibToGbps(gbpsToMib(200))).toBeCloseTo(200, 9);
  });

  it('models bandwidth, latency and the half-bandwidth point', () => {
    // 2 B is message-rate limited: 2 × 8 × 10e6 = 1.6e8 bit/s
    expect(bwBps(2, roce)).toBeCloseTo(1.6e8, 0);
    expect(limitedBy(2, roce)).toBe('message rate');
    expect(limitedBy(1_048_576, roce)).toBe('link');
    // 8 MiB: 2048 packets, 4194 + 2047 × 4178 = 8 556 560 wire bytes -> 400e9 × 8 388 608 / 8 556 560
    expect(peakBps(roce)).toBeCloseTo((400e9 * 8_388_608) / 8_556_560, 0);
    // n½ = peak / 2 / (8 × 10e6) = 196.0742e9 / 8e7 = 2450.93 -> first whole size 2451 B
    expect(nHalfStream(roce)).toBe(2451);
    expect(bwBps(2451, roce)).toBeGreaterThanOrEqual(peakBps(roce) / 2);
    expect(bwBps(2450, roce)).toBeLessThan(peakBps(roce) / 2);
    // ping-pong n½ = α × r_inf = 1e-6 s × 50e9 B/s × (8 388 608 / 8 556 560) = 49 018.5 B
    expect(nHalfPingPong(roce)).toBeCloseTo((50e3 * 8_388_608) / 8_556_560, 3);
    // a faster message rate pulls n½ down: 100 M msgs/s -> 196.0742e9 / 8e8 = 245.09 -> 246 B
    expect(nHalfStream({ ...roce, mrM: 100 })).toBe(246);
    // 100G with a 100 M/s ceiling: the crossing is link-limited. One packet costs payload + pad + 98 B, so the
    // half-peak point needs s / (s + pad + 98) >= 0.4902: 95 B (pad 1) misses, 96 B (pad 0) makes it, 97 B (pad 3)
    // misses again. nHalfStream must return the smallest size, 96, despite the non-monotonic padding.
    const slow: Model = { ...roce, gbps: 100, mrM: 100 };
    expect(nHalfStream(slow)).toBe(96);
    expect(limitedBy(96, slow)).toBe('link');
    expect(bwBps(95, slow)).toBeLessThan(peakBps(slow) / 2);
    expect(bwBps(97, slow)).toBeLessThan(peakBps(slow) / 2);
    // latency: 1 µs + 102 × 8 / 400e9 = 1.00204 µs; 8 MiB: 1 + 8 556 560 × 8 / 400e9 = 172.1312 µs
    expect(latUs(2, roce)).toBeCloseTo(1.00204, 6);
    expect(latUs(8_388_608, roce)).toBeCloseTo(172.1312, 4);
  });

  it('reads results against nominal rate and prints perftest headers', () => {
    expect(verdict(96)).toBe('expected');
    expect(verdict(80)).toBe('below');
    expect(verdict(50)).toBe('wrong');
    expect(verdict(79)).toBe('wrong'); // the lesson calls 75 % "something is wrong"
    expect(verdict(Number.NaN)).toBe('wrong');
    // 46 000 MiB/s on 400G = 385.9 / 400 = 96.5 %
    expect(verdict((100 * mibToGbps(46_000)) / 400)).toBe('expected');
    expect(bwHeader(false)).toContain('BW average[MiB/sec]');
    expect(bwHeader(false, true)).toContain('BW average[MB/sec]');
    expect(bwHeader(true)).toContain('BW peak[Gb/sec]');
    expect(bwHeader(true)).toContain('MsgRate[Mpps]');
    for (const c of ['t_min[usec]', 't_max[usec]', 't_typical[usec]', 't_avg[usec]', 't_stdev[usec]', '99% percentile[usec]', '99.9% percentile[usec]'])
      expect(LAT_HEADER).toContain(c);
    expect(bwRow(65536, 5000, 391.85, 391.85, 0.747)).toMatch(/^ 65536 {6}5000 /);
  });
});

describe('HostStackPaths', () => {
  const band = (id: string) => LAYERS.find((l) => l.id === id)!.band;
  it('has a complete, consistent layer model', () => {
    for (const l of LAYERS) {
      expect(l.detail.length).toBeGreaterThan(20);
      expect(l.blind.length).toBeGreaterThan(20);
    }
    for (const t of HOST_TOOLS) for (const id of t.layers) expect(LAYERS.some((l) => l.id === id)).toBe(true);
    for (const s of [...TCP_STEPS, ...RDMA_DATA_STEPS, ...RDMA_SETUP_STEPS]) for (const id of s.layers) expect(LAYERS.some((l) => l.id === id)).toBe(true);
  });
  it('the RDMA data path never enters the kernel; setup does', () => {
    expect(RDMA_DATA_STEPS.flatMap((s) => s.layers).every((id) => band(id) !== 'kernel')).toBe(true);
    expect(bypassed('data')).toEqual(['r-uverbs', 'r-core', 'r-drv']);
    expect(RDMA_SETUP_STEPS.some((s) => s.layers.includes('r-uverbs'))).toBe(true);
    expect(bypassed('setup')).toEqual([]);
    // the TCP send walks user -> kernel -> hardware
    expect(TCP_STEPS.map((s) => band(s.layers[0]))).toEqual(['user', 'kernel', 'kernel', 'kernel', 'kernel', 'kernel', 'hw']);
  });
  it('states which tools miss RDMA traffic', () => {
    const t = (id: string) => HOST_TOOLS.find((x) => x.id === id)!;
    for (const id of ['ss', 'tcpdump', 'tc', 'iplink', 'nstat']) expect(t(id).rdma).toBe('no');
    expect(t('strace').rdma).toBe('setup');
    expect(t('rdmastat').layers).toContain('r-nic');
    expect(toolsFor('r-nic').map((x) => x.id)).toEqual(expect.arrayContaining(['ethtool', 'rdmastat', 'capture']));
    expect(toolsFor('r-nic').some((x) => x.id === 'ss' || x.id === 'tcpdump')).toBe(false);
    for (const x of HOST_TOOLS) expect(x.short.length).toBeGreaterThan(0);
  });
  it('does not claim the kernel maps the queue buffers (mlx5 allocates them in user space)', () => {
    const setup = RDMA_SETUP_STEPS.map((s) => s.text).join(' ');
    expect(setup).not.toMatch(/page and queues into the process/);
  });
});

describe('IbToolsMap', () => {
  const tool = (id: string) => IB_TOOLS.find((t) => t.id === id)!;
  it('covers every tool with the required fields', () => {
    const want = ['ibstat', 'ibstatus', 'ibv_devinfo', 'sminfo', 'iblinkinfo', 'ibnetdiscover', 'ibhosts', 'ibswitches', 'perfquery',
      'ibqueryerrors', 'saquery', 'ibtracert', 'ibroute', 'ibping', 'ibdiagnet'];
    expect(IB_TOOLS.map((t) => t.id).sort()).toEqual([...want].sort());
    for (const t of IB_TOOLS) {
      for (const f of [t.name, t.cmd, t.pkg, t.answers, t.reads, t.smDown, t.output, t.symptom]) expect(f.length).toBeGreaterThan(0);
      expect(t.mech.length).toBeGreaterThan(0);
      // every tool's symptom is one of the listed symptoms, and that symptom suggests the tool
      const s = SYMPTOMS.find((x) => x.text === t.symptom);
      expect(s, t.id).toBeDefined();
      expect(s!.tools).toContain(t.id);
    }
    for (const s of SYMPTOMS) for (const id of s.tools) expect(IB_TOOLS.some((t) => t.id === id)).toBe(true);
  });
  it('gets mechanisms, root and SM dependence right', () => {
    expect(tool('perfquery').mech).toContain('pma');
    expect(tool('saquery').mech).toEqual(['sa']);
    expect(tool('ibnetdiscover').mech).toEqual(['smp-dr']);
    expect(tool('ibping').mech).toEqual(['vendor']);
    expect(tool('ibstat').mech).toEqual(['sysfs']);
    // only local, non-MAD tools run without umad (root)
    expect(IB_TOOLS.filter((t) => t.root === 'no').map((t) => t.id).sort()).toEqual(['ibstat', 'ibstatus', 'ibv_devinfo']);
    expect(IB_TOOLS.filter((t) => t.root === 'no').every((t) => t.mech.every((m) => m === 'sysfs' || m === 'verbs'))).toBe(true);
    // directed-route and local tools work before an SM assigns LIDs; LID-routed, PMA and SA tools do not
    for (const id of ['ibstat', 'ibstatus', 'ibv_devinfo', 'iblinkinfo', 'ibnetdiscover', 'ibhosts', 'ibswitches']) expect(worksWithoutSm(tool(id))).toBe(true);
    for (const id of ['sminfo', 'perfquery', 'saquery', 'ibtracert', 'ibping']) expect(tool(id).needsSm).toBe('yes');
    expect(tool('ibqueryerrors').needsSm).toBe('partly');
    // ibtracert queries endpoints by LID and walks the path by directed route
    expect(tool('ibtracert').mech).toEqual(['smp-lid', 'smp-dr']);
    // tools that work without an SM show the SM-down state (LID 0 / INIT), not the healthy output
    for (const id of ['ibstat', 'ibstatus', 'ibv_devinfo', 'iblinkinfo', 'ibnetdiscover', 'ibswitches']) {
      expect(tool(id).outputSmDown, id).toBeDefined();
      expect(tool(id).outputSmDown, id).not.toMatch(/Active|ACTIVE|lid 12|lid 4 /);
    }
    for (const t of IB_TOOLS) if (t.mech.every((m) => m === 'pma' || m === 'sa' || m === 'smp-lid' || m === 'vendor')) expect(worksWithoutSm(t)).toBe(false);
  });
  it('draws each scope on real nodes and links', () => {
    const ids = new Set(NODES.map((n) => n.id));
    const linkOk = (k: string) => LINKS.some(([a, b]) => k === `${a}-${b}` || k === `${b}-${a}`);
    for (const s of ['local', 'sm', 'fabric', 'cas', 'switches', 'port', 'path', 'switch'] as Scope[]) {
      const sc = scopeOf(s);
      expect(sc.nodes.every((n) => ids.has(n))).toBe(true);
      expect(sc.links.every(linkOk)).toBe(true);
    }
    expect(scopeOf('local').links).toEqual([]);
    expect(scopeOf('path').nodes[0]).toBe('node01');
    expect(scopeOf('path').nodes.at(-1)).toBe('node03');
    expect(scopeOf('fabric').links).toHaveLength(LINKS.length);
  });
});
