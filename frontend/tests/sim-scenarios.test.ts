// Symptoms of the congestion, watchdog, cross-rail and InfiniBand scenarios (sim-14 onward), plus the
// healthy InfiniBand baseline. sim-labs.test.ts already checks that every lab is broken before its fix and
// passes after it; these tests pin down the evidence each ticket relies on.
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { CHECKS, createFabric, evaluateAllReduce, type FabricState } from '../src/sim/fabric';
import { exec } from '../src/sim/shell';
import { labState, parseFixLine } from '../src/sim/lab';
import type { SimLab } from '../src/types';

const dir = path.resolve(__dirname, '../../content/labs/sim');
const labs = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'))
  .map((f) => yaml.load(fs.readFileSync(path.join(dir, f), 'utf8')) as SimLab & { fix: string[] });
const lab = (id: string) => labs.find((l) => l.id === id)!;
const sh = (s: FabricState, host: string, cmd: string) => exec({ state: s, host }, cmd).out;
const AR = 'all_reduce_perf -b 8 -e 8G -f 2 -g 1';
const num = (out: string, re: RegExp) => Number(out.match(re)?.[1] ?? NaN);
const applyFix = (s: FabricState, id: string) => {
  for (const line of lab(id).fix) {
    const { host, cmd } = parseFixLine(line);
    sh(s, host, cmd);
  }
};

describe('fabric variants', () => {
  it('uses ib_fabric only as the first fault of a lab', () => {
    for (const l of labs) l.faults.forEach((f, i) => { if (f.type === 'ib_fabric') expect(i).toBe(0); });
  });

  it('healthy RoCE collectives leave the spines idle', () => {
    const s = createFabric();
    sh(s, 'node01', AR);
    expect(sh(s, 'spine01', 'nv show interface swp3 counters')).toMatch(/RX packets\s+0\n/);
  });

  it('healthy InfiniBand variant: every port ACTIVE, an SM, ~372 GB/s over IB', () => {
    const s = labState([{ type: 'ib_fabric' }]);
    const r = evaluateAllReduce(s);
    expect(r.transport).toBe('IB');
    expect(r.busbw).toBeGreaterThan(360);
    expect(CHECKS.ib_ports_active(s, { node: 'all' })).toBe(true);
    expect(sh(s, 'node02', 'ibstat mlx5_3')).toMatch(/State: Active\n\t\tPhysical state: LinkUp\n\t\tRate: 400\n\t\tBase lid: 22\n/);
    expect(sh(s, 'node02', 'ibstat mlx5_3')).toMatch(/Link layer: InfiniBand/);
    expect(sh(s, 'node03', 'sminfo')).toMatch(/^sminfo: sm lid 11 sm guid 0x[0-9a-f]{16}, activity count \d+ priority 0 state 3 SMINFO_MASTER\n$/);
    expect(sh(s, 'node01', 'ibdev2netdev | grep -c Up')).toBe('8\n');
    expect(sh(s, 'node01', 'iblinkinfo | grep -c "4X        106.25 Gbps Active/  LinkUp"')).toBe('96\n');
    expect(sh(s, 'node01', 'ib_write_bw -d mlx5_2 --report_gbits node03')).toMatch(/Link type\s+: IB[\s\S]*391\.80/);
    expect(sh(s, 'node01', 'perfquery')).toMatch(/^# Port counters: Lid 11 port 1 \(CapMask: 0x5A00\)\nPortSelect:\.{22}1\n/);
    // RoCE-only tooling is not modelled in the IB variant, and switches are queried in-band.
    expect(sh(s, 'node01', 'mlnx_qos -i ibp24s0')).toMatch(/not modelled in the InfiniBand variant/);
    expect(exec({ state: s, host: 'node01' }, 'ssh leaf03').host).toBeUndefined();
  });

  it('infiniband-diags commands refuse to run on the RoCE cluster', () => {
    expect(sh(createFabric(), 'node01', 'ibstat')).toMatch(/runs RoCE/);
  });
});

describe('sim-14 ECN off, PFC on', () => {
  it('rail 4 shows no ECN marks or CNPs, millions of pauses, and point-to-point stays at line rate', () => {
    const s = labState(lab('sim-14-ecn-off-pause-storm').faults);
    expect(sh(s, 'node02', 'ib_write_bw -d mlx5_4 --report_gbits node03')).toMatch(/391\.80/);
    const bw = evaluateAllReduce(s).busbw;
    expect(bw).toBeGreaterThan(180);
    expect(bw).toBeLessThan(230);
    sh(s, 'node01', AR);
    const r4 = sh(s, 'node02', 'rdma statistic show link mlx5_4/1');
    // iproute2 6.x layout: "link <dev>/1 " then one indented counter per line.
    expect(r4).toMatch(/^link mlx5_4\/1 \n {4}rx_write_requests \d+ \n/);
    expect(r4).toMatch(/\n {4}rp_cnp_ignored 0 \n {4}rp_cnp_handled 0 \n {4}np_ecn_marked_roce_packets 0 \n {4}np_cnp_sent 0 \n$/);
    expect(num(sh(s, 'node02', 'rdma statistic show link mlx5_3/1'), /np_cnp_sent (\d+)/)).toBeGreaterThan(1000);
    expect(num(sh(s, 'node02', 'ethtool -S enp154s0np0'), /rx_prio3_pause: (\d+)/)).toBeGreaterThan(1_000_000);
    expect(sh(s, 'leaf05', 'nv show interface swp2 qos roce counters')).toMatch(/ecn-marked-packets\s+0\s/);
    expect(sh(s, 'leaf05', 'nv show qos congestion-control default-global')).toMatch(/\n {4}3 {14}disable/);
    expect(sh(s, 'leaf05', 'nv show qos roce')).toMatch(/enabled-tc {8}0 /);
    expect(sh(s, 'leaf04', 'nv show qos roce')).toMatch(/enabled-tc {8}0,3/);
  });

  it('turning PFC off as the ticket proposes makes it worse', () => {
    const s = labState(lab('sim-14-ecn-off-pause-storm').faults);
    const before = evaluateAllReduce(s).busbw;
    sh(s, 'leaf05', 'nv set qos roce mode lossy');
    sh(s, 'leaf05', 'nv config apply -y');
    expect(evaluateAllReduce(s).busbw).toBeLessThan(before);
  });
});

describe('sim-15 PFC watchdog and a stuck receiver', () => {
  const faults = () => lab('sim-15-pfc-watchdog-stuck-receiver').faults;

  it('pauses flow from node03 to leaf07, the watchdog is in DEADLOCK and drops, writes toward node03 crawl', () => {
    const s = labState(faults());
    expect(sh(s, 'leaf07', 'nv show interface swp3 qos pfc-watchdog')).toMatch(/\n {4}3 {14}DEADLOCK {2}\d+/);
    sh(s, 'node01', AR);
    expect(num(sh(s, 'node03', 'ethtool -S enp204s0np0'), /tx_prio3_pause: (\d+)/)).toBeGreaterThan(10_000_000);
    const c = sh(s, 'leaf07', 'nv show interface swp3 counters');
    expect(num(c, /RX PFC pause\s+(\d+)/)).toBeGreaterThan(10_000_000);
    expect(num(c, /TX PFC pause\s+(\d+)/)).toBeLessThan(1000);
    expect(num(c, /TX drops\s+(\d+)/)).toBeGreaterThan(1_000_000);
    expect(num(sh(s, 'node01', 'rdma statistic show link mlx5_6/1'), /packet_seq_err (\d+)/)).toBeGreaterThan(0);
    expect(num(sh(s, 'node03', 'rdma statistic show link mlx5_6/1'), /out_of_sequence (\d+)/)).toBeGreaterThan(0);
    expect(sh(s, 'node01', 'ib_write_bw -d mlx5_6 --report_gbits node03')).toMatch(/5000\s+[\d.]+\s+5\d\.\d\d/);
    expect(sh(s, 'node03', 'ib_write_bw -d mlx5_6 --report_gbits node01')).toMatch(/391\.80/);
  });

  it('disabling the watchdog spreads the storm across the rail and slows the job further', () => {
    const s = labState(faults());
    const before = evaluateAllReduce(s).busbw;
    sh(s, 'leaf07', 'nv unset interface swp3 qos pfc-watchdog');
    expect(sh(s, 'leaf07', 'nv config diff')).toMatch(/pfc-watchdog:\n\s+state: disabled/);
    sh(s, 'leaf07', 'nv config apply -y');
    expect(evaluateAllReduce(s).busbw).toBeLessThan(before / 2);
    sh(s, 'node01', AR);
    expect(num(sh(s, 'leaf07', 'nv show interface swp1 counters'), /TX PFC pause\s+(\d+)/)).toBeGreaterThan(1_000_000);
  });

  it('after the fix the watchdog status returns to OK', () => {
    const s = labState(faults());
    applyFix(s, 'sim-15-pfc-watchdog-stuck-receiver');
    expect(sh(s, 'leaf07', 'nv show interface swp3 qos pfc-watchdog')).not.toMatch(/DEADLOCK/);
  });
});

describe('sim-16 cross-rail traffic over the spines', () => {
  it('spines carry traffic and NCCL rings change NIC inside the node', () => {
    const s = labState(lab('sim-16-cross-rail-spines').faults);
    const r = evaluateAllReduce(s);
    expect(r.crossRail).toBe(true);
    expect(r.busbw).toBeGreaterThan(150);
    expect(r.busbw).toBeLessThan(190);
    sh(s, 'node01', "sed -i 's/NCCL_DEBUG=WARN/NCCL_DEBUG=INFO/' /etc/nccl.conf");
    const out = sh(s, 'node01', AR);
    expect(out).toMatch(/Channel 00\/0 : 31\[7\] -> 0\[0\] \[receive\] via NET\/IB\/0\/GDRDMA/);
    expect(out).toMatch(/Channel 00\/0 : 7\[7\] -> 8\[0\] \[send\] via NET\/IB\/7\/GDRDMA/);
    for (const sp of ['spine01', 'spine02']) expect(num(sh(s, sp, 'nv show interface swp3 counters'), /RX packets\s+(\d+)/)).toBeGreaterThan(10_000_000);
    expect(num(sh(s, 'leaf03', 'nv show interface swp31 counters'), /TX ECN marked\s+(\d+)/)).toBeGreaterThan(100_000);
  });

  it('healthy rings send and receive on the same NIC', () => {
    const s = createFabric();
    sh(s, 'node01', "sed -i 's/NCCL_DEBUG=WARN/NCCL_DEBUG=INFO/' /etc/nccl.conf");
    // GPU7 forwards to NIC0 through PXN, so NCCL names the proxy rank (0) next to the NIC index.
    expect(sh(s, 'node01', AR)).toMatch(/7\[7\] -> 8\[0\] \[send\] via NET\/IB\/0\(0\)\/GDRDMA/);
  });
});

describe('sim-17 InfiniBand without a subnet manager', () => {
  it('links train but ports stay INIT with LID 65535, perftest refuses, NCCL falls back to sockets', () => {
    const s = labState(lab('sim-17-ib-no-subnet-manager').faults);
    const st = sh(s, 'node02', 'ibstat mlx5_3');
    expect(st).toMatch(/State: Initializing\n\t\tPhysical state: LinkUp\n/);
    expect(st).toMatch(/Base lid: 65535\n\t\tLMC: 0\n\t\tSM lid: 0\n/);
    expect(sh(s, 'node02', 'ibstatus mlx5_3')).toMatch(/state:\t\t 2: INIT\n\tphys state:\t 5: LinkUp/);
    expect(sh(s, 'node02', 'ib_write_bw -d mlx5_3 --report_gbits node03')).toBe(" Port number 1 state is Init\n Couldn't set the link layer\n Couldn't get context for the device\n");
    expect(sh(s, 'node02', 'sminfo')).toMatch(/^ibwarn: \[\d+\] _do_madrpc: recv failed: Connection timed out\nibwarn: [\s\S]*\nsminfo: iberror: failed: query\n$/);
    expect(sh(s, 'node01', 'perfquery')).toMatch(/iberror: failed/);
    expect(sh(s, 'node01', 'iblinkinfo | grep -c "Initialize/  LinkUp"')).toBe('96\n');
    expect(sh(s, 'node01', 'ibdev2netdev | grep -c Down')).toBe('8\n');
    expect(sh(s, 'node01', 'systemctl status opensm')).toMatch(/disabled;[\s\S]*Active: inactive \(dead\)/);
    expect(sh(s, 'node02', 'systemctl status opensm')).toBe('Unit opensm.service could not be found.\n');
    sh(s, 'node01', "sed -i 's/NCCL_DEBUG=WARN/NCCL_DEBUG=INFO/' /etc/nccl.conf");
    expect(sh(s, 'node01', AR)).toMatch(/NET\/IB : No device found\.[\s\S]*Using network Socket/);
  });

  it('starting opensm without enabling it fixes the job but fails the persistence check', () => {
    const s = labState(lab('sim-17-ib-no-subnet-manager').faults);
    sh(s, 'node01', 'systemctl start opensm');
    expect(CHECKS.allreduce_min_busbw(s, { value: 360 })).toBe(true);
    expect(CHECKS.sm_enabled(s, {})).toBe(false);
    expect(sh(s, 'node03', 'sminfo')).toMatch(/SMINFO_MASTER/);
  });
});

describe('sim-18 InfiniBand link at 1X', () => {
  it('rate, width and errors point at one link; the red herrings stay static', () => {
    const s = labState(lab('sim-18-ib-degraded-link-width').faults);
    expect(evaluateAllReduce(s).busbw).toBeCloseTo(93, 0);
    expect(sh(s, 'node03', 'ibstat mlx5_2')).toMatch(/State: Active[\s\S]*Rate: 100\n/);
    expect(sh(s, 'node03', 'ibstatus mlx5_2')).toMatch(/rate:\t\t 100 Gb\/sec \(1X NDR\)/);
    expect(sh(s, 'node01', 'iblinkinfo | grep -c "Could be 4X"')).toBe('2\n');
    expect(sh(s, 'node01', 'ib_write_bw -d mlx5_2 --report_gbits node03')).toMatch(/5000\s+[\d.]+\s+9\d\.\d\d/);
    sh(s, 'node01', AR);
    const sym1 = num(sh(s, 'node01', 'perfquery 3 3'), /SymbolErrorCounter:\.+(\d+)/);
    expect(sh(s, 'node01', 'ibqueryerrors')).toMatch(/PortXmitWait == \d+/);
    const errs = sh(s, 'node01', 'ibqueryerrors -s PortXmitWait');
    expect(errs).toMatch(/4 ports have errors beyond threshold/);
    expect(errs).toMatch(/## Thresholds: \n## Suppressed: PortXmitWait\n$/);
    // The red-herring link-down is counted on both ends of that link.
    expect(errs).toMatch(/Errors for "node01 mlx5_5"\n {3}GUID 0x[0-9a-f]+ port 1: \[LinkDownedCounter == 1\]\n/);
    expect(errs).toMatch(/MF0;leaf06:MQM9700\/U1"\n {3}GUID 0x[0-9a-f]+ port 1: \[LinkDownedCounter == 1\]\n/);
    sh(s, 'node01', AR);
    expect(num(sh(s, 'node01', 'perfquery 3 3'), /SymbolErrorCounter:\.+(\d+)/)).toBeGreaterThan(sym1);
    expect(num(sh(s, 'node01', 'perfquery -C mlx5_5'), /LinkDownedCounter:\.+(\d+)/)).toBe(1);
  });
});

describe('ECMP: per-flow uplink hashing for cross-rail traffic', () => {
  const crossRail = (qps: number | null) => labState([{ type: 'nccl_conf', node: 'all', set: { NCCL_CROSS_NIC: 1, NCCL_IB_QPS_PER_CONNECTION: qps } }]);

  it('every QP is one flow with its own UDP source port in the dynamic range', () => {
    const plan = evaluateAllReduce(crossRail(4)).ecmp!;
    expect(plan.flows).toHaveLength(8 * 2 * 4 * 4); // 8 rails x 2 channels x 4 hops x 4 QPs
    for (const f of plan.flows) expect(f.sport).toBeGreaterThanOrEqual(0xc000);
    expect(new Set(plan.flows.map((f) => `${f.src}>${f.dst}:${f.sport}`)).size).toBe(plan.flows.length);
  });

  it('more QPs per connection spread the flows better and raise the cross-rail busbw', () => {
    const bw = [1, 2, 4, 8].map((q) => evaluateAllReduce(crossRail(q)).busbw);
    for (let i = 1; i < bw.length; i++) expect(bw[i]).toBeGreaterThan(bw[i - 1]);
    // Never above the 2:1 leaf-to-spine bound.
    expect(Math.max(...bw)).toBeLessThan(186);
    expect(CHECKS.ecmp_balanced(crossRail(1), { value: 0.8 })).toBe(false);
    expect(CHECKS.ecmp_balanced(crossRail(4), { value: 0.8 })).toBe(true);
  });

  it('rail-local runs never touch the uplinks, whatever the QP count', () => {
    const s = labState([{ type: 'nccl_conf', node: 'all', set: { NCCL_IB_QPS_PER_CONNECTION: null } }]);
    expect(evaluateAllReduce(s).busbw).toBeGreaterThan(360);
    expect(evaluateAllReduce(s).ecmp).toBeUndefined();
  });
});

describe('sim-19 low ECMP entropy in a spine burn-in', () => {
  it('one QP per connection: lopsided uplinks, an idle uplink on leaf04, clean links, ~90 GB/s', () => {
    const s = labState(lab('sim-19-ecmp-low-entropy').faults);
    const r = evaluateAllReduce(s);
    expect(r.limiting?.kind).toBe('ecmp');
    expect(r.busbw).toBeGreaterThan(80);
    expect(r.busbw).toBeLessThan(100);
    expect(sh(s, 'node01', 'cat /etc/nccl.conf')).not.toMatch(/QPS_PER_CONNECTION/);
    sh(s, 'node01', AR);
    const tx = (sw: string, p: string) => num(sh(s, sw, `nv show interface ${p} counters`), /TX packets\s+(\d+)/);
    const ecn = (sw: string, p: string) => num(sh(s, sw, `nv show interface ${p} counters`), /TX ECN marked\s+(\d+)/);
    expect(tx('leaf04', 'swp31')).toBe(0);
    expect(tx('leaf04', 'swp32')).toBeGreaterThan(80_000_000);
    expect(tx('leaf01', 'swp31')).toBe(3 * tx('leaf01', 'swp32'));
    expect(tx('leaf02', 'swp31')).toBe(3 * tx('leaf02', 'swp32'));
    expect(ecn('leaf01', 'swp31')).toBeGreaterThan(10 * ecn('leaf01', 'swp32'));
    // The busy uplink points at spine01 on some leaves and at spine02 on others; both spines carry similar totals.
    const spineTx = (sp: string) => [1, 2, 3, 4, 5, 6, 7, 8].reduce((acc, p) => acc + tx(sp, `swp${p}`), 0);
    expect(spineTx('spine01') / spineTx('spine02')).toBeGreaterThan(0.8);
    expect(spineTx('spine01') / spineTx('spine02')).toBeLessThan(1.25);
    for (const l of ['leaf01', 'leaf04']) for (const p of ['swp31', 'swp32']) {
      const c = sh(s, l, `nv show interface ${p} counters`);
      expect(c).toMatch(/RX errors\s+0\n/);
      expect(c).toMatch(/TX drops\s+0\n/);
    }
    expect(sh(s, 'leaf04', 'nv show interface swp32 qos pfc-watchdog')).not.toMatch(/DEADLOCK/);
  });

  it('two QPs are not enough here; four meet the pass mark and eight do a little better', () => {
    const run = (q: number) => {
      const s = labState(lab('sim-19-ecmp-low-entropy').faults);
      for (const n of ['node01', 'node02', 'node03', 'node04']) sh(s, n, `echo "NCCL_IB_QPS_PER_CONNECTION=${q}" >> /etc/nccl.conf`);
      return evaluateAllReduce(s).busbw;
    };
    expect(run(2)).toBeLessThan(145);
    expect(run(4)).toBeGreaterThan(145);
    expect(run(8)).toBeGreaterThan(run(4));
  });

  it('dropping the burn-in (NCCL_CROSS_NIC) restores rail-local speed but fails the lab', () => {
    const s = labState(lab('sim-19-ecmp-low-entropy').faults);
    for (const n of ['node01', 'node02', 'node03', 'node04']) sh(s, n, "sed -i '/NCCL_CROSS_NIC/d' /etc/nccl.conf");
    expect(evaluateAllReduce(s).busbw).toBeGreaterThan(360);
    expect(CHECKS.nccl_conf(s, { node: 'all', key: 'NCCL_CROSS_NIC', value: 1 })).toBe(false);
  });
});

describe('InfiniBand subnet managers: retained port state, election and failover', () => {
  const twoSms = () => labState([{ type: 'ib_fabric' }, { type: 'ib_sm', node: 'node01', priority: 14 }, { type: 'ib_sm', node: 'node02', priority: 13 }]);

  it('stopping the only SM leaves ACTIVE ports ACTIVE (traffic unaffected), sminfo fails', () => {
    const s = labState([{ type: 'ib_fabric' }]);
    sh(s, 'node01', 'systemctl stop opensm');
    expect(CHECKS.ib_ports_active(s, { node: 'all' })).toBe(true);
    expect(evaluateAllReduce(s).busbw).toBeGreaterThan(360);
    expect(sh(s, 'node02', 'sminfo')).toMatch(/dport \(Lid 11\)\nsminfo: iberror: failed: query\n$/);
    expect(sh(s, 'node02', 'ibstat mlx5_0 1')).toMatch(/State: Active\n[\s\S]*SM lid: 11\n/);
    // A link that retrains now stays in INIT: nobody configures it.
    sh(s, 'node01', 'replace-cable leaf03 swp2');
    expect(sh(s, 'node02', 'ibstat mlx5_2 1')).toMatch(/State: Initializing\n[\s\S]*Base lid: 65535\n/);
    sh(s, 'node01', 'systemctl start opensm');
    expect(sh(s, 'node02', 'ibstat mlx5_2 1')).toMatch(/State: Active\n/);
  });

  it('the higher priority wins; sminfo <lid> shows the standby in state 2', () => {
    const s = twoSms();
    expect(sh(s, 'node03', 'sminfo')).toMatch(/^sminfo: sm lid 11 sm guid 0x[0-9a-f]{16}, activity count \d+ priority 14 state 3 SMINFO_MASTER\n$/);
    expect(sh(s, 'node03', 'sminfo 19')).toMatch(/^sminfo: sm lid 19 sm guid 0x[0-9a-f]{16}, activity count \d+ priority 13 state 2 SMINFO_STANDBY\n$/);
    expect(sh(s, 'node03', 'sminfo 20')).toMatch(/dport \(Lid 20\)\nsminfo: iberror: failed: query\n$/);
    // Both SM ports advertise IsSM in the capability mask.
    expect(sh(s, 'node02', 'ibstat mlx5_0 1')).toMatch(/Capability mask: 0xa751e84a\n/);
    expect(sh(s, 'node02', 'ibstat mlx5_1 1')).toMatch(/Capability mask: 0xa751e848\n/);
  });

  it('the standby takes over about 50 s after the master dies, keeps the LIDs and becomes the SM lid', () => {
    const s = twoSms();
    sh(s, 'node01', 'systemctl stop opensm');
    expect(sh(s, 'node03', 'sminfo')).toMatch(/iberror: failed: query/);
    expect(sh(s, 'node03', 'sminfo 19')).toMatch(/state 2 SMINFO_STANDBY/);
    sh(s, 'node03', 'sleep 40');
    expect(sh(s, 'node03', 'sminfo')).toMatch(/iberror: failed: query/);
    sh(s, 'node03', 'sleep 12');
    expect(sh(s, 'node03', 'sminfo')).toMatch(/^sminfo: sm lid 19 .* priority 13 state 3 SMINFO_MASTER\n$/);
    expect(sh(s, 'node03', 'ibstat mlx5_1 1')).toMatch(/Base lid: 28\nLMC: 0\nSM lid: 19\n/);
    // The returning higher-priority SM takes the master role back (in this model at once).
    sh(s, 'node01', 'systemctl start opensm');
    expect(CHECKS.sm_master(s, { node: 'node01' })).toBe(true);
    expect(sh(s, 'node03', 'sminfo 19')).toMatch(/state 2 SMINFO_STANDBY/);
  });

  it('the sandbox InfiniBand fabric (two SMs) is healthy', () => {
    const s = twoSms();
    expect(evaluateAllReduce(s).busbw).toBeGreaterThan(360);
    expect(CHECKS.sm_count(s, { value: 2 })).toBe(true);
  });
});

describe('sim-20 InfiniBand SM failover that never happened', () => {
  it('rail 4 is INIT after the leaf reboot, the rest stays ACTIVE, no SM answers', () => {
    const s = labState(lab('sim-20-ib-sm-failover').faults);
    expect(evaluateAllReduce(s).busbw).toBeCloseTo(325.5, 1);
    expect(sh(s, 'node02', 'ibstat mlx5_4 1')).toMatch(/\nState: Initializing\nPhysical state: LinkUp\nRate: 400\nBase lid: 65535\nLMC: 0\nSM lid: 0\n/);
    expect(sh(s, 'node02', 'ibstat mlx5_3 1')).toMatch(/\nState: Active\n[\s\S]*\nSM lid: 11\n/);
    expect(sh(s, 'node02', 'ib_write_bw -d mlx5_4 --report_gbits node03')).toMatch(/^ Port number 1 state is Init\n/);
    expect(sh(s, 'node03', 'sminfo')).toMatch(/dport \(Lid 11\)\nsminfo: iberror: failed: query\n$/);
    expect(sh(s, 'node03', 'sminfo 19')).toMatch(/dport \(Lid 19\)\nsminfo: iberror: failed: query\n$/);
    expect(sh(s, 'node01', 'systemctl status opensm')).toMatch(/^× [\s\S]*; enabled;[\s\S]*Active: failed \(Result: core-dump\)[\s\S]*-p 14 \(code=dumped, signal=SEGV\)/);
    expect(sh(s, 'node01', 'systemctl is-active opensm')).toBe('failed\n');
    expect(sh(s, 'node02', 'systemctl status opensm')).toMatch(/disabled;[\s\S]*Active: inactive \(dead\)/);
    // leaf05: 4 host ports and 2 uplinks, the 2 spine ports facing it, and the 4 HCAs.
    expect(sh(s, 'node01', 'iblinkinfo | grep -c "Initialize/  LinkUp"')).toBe('12\n');
    sh(s, 'node01', "sed -i 's/NCCL_DEBUG=WARN/NCCL_DEBUG=INFO/' /etc/nccl.conf");
    const out = sh(s, 'node01', AR);
    expect(out).toMatch(/NET\/IB : Using \[0\]mlx5_0:1\/IB/);
    expect(out).not.toMatch(/mlx5_4:1/);
  });

  it('starting only the standby fixes the rail but not the redundancy; after the fix node01 is master', () => {
    const s = labState(lab('sim-20-ib-sm-failover').faults);
    sh(s, 'node02', 'systemctl enable --now opensm');
    expect(CHECKS.allreduce_min_busbw(s, { value: 360 })).toBe(true);
    expect(CHECKS.sm_count(s, { value: 2 })).toBe(false);
    expect(sh(s, 'node03', 'sminfo')).toMatch(/sm lid 19 .* priority 13 state 3 SMINFO_MASTER/);
    const t = labState(lab('sim-20-ib-sm-failover').faults);
    applyFix(t, 'sim-20-ib-sm-failover');
    expect(sh(t, 'node03', 'sminfo')).toMatch(/sm lid 11 .* priority 14 state 3 SMINFO_MASTER/);
    expect(sh(t, 'node03', 'sminfo 19')).toMatch(/priority 13 state 2 SMINFO_STANDBY/);
  });
});

describe('sim-21 InfiniBand leaf cut off from the SM', () => {
  it('leaf06 is missing from discovery, spine02 is off, spine01 port 6 is down with history', () => {
    const s = labState(lab('sim-21-ib-spine-down-leaf-isolated').faults);
    expect(evaluateAllReduce(s).busbw).toBeCloseTo(325.5, 1);
    expect(sh(s, 'node03', 'ibstat mlx5_5 1')).toMatch(/\nState: Initializing\nPhysical state: LinkUp\n[\s\S]*Base lid: 65535\n/);
    expect(sh(s, 'node03', 'sminfo')).toMatch(/priority 0 state 3 SMINFO_MASTER/);
    const links = sh(s, 'node01', 'iblinkinfo --switches-only');
    expect(links).not.toMatch(/leaf06|spine02:MQM9700\/U1:/);
    expect(links.match(/^Switch: /gm)).toHaveLength(8);
    expect(sh(s, 'node01', 'iblinkinfo --switches-only -d | grep -c "Down/ Polling"')).toBe('8\n');
    expect(links).toMatch(/spine01:MQM9700\/U1:\n(.*\n)*? {11}0 {4}6\[ {2}\] ==\( {16}Down\/ Polling\)==>/);
    const fromRail5 = sh(s, 'node01', 'iblinkinfo -C mlx5_5');
    expect(fromRail5.match(/^Switch: /gm)).toHaveLength(1);
    expect(fromRail5).toMatch(/leaf06:MQM9700\/U1:\n/);
    expect(fromRail5.match(/Initialize\/ {2}LinkUp/g)).toHaveLength(8); // 4 switch ports + 4 HCAs
    expect(fromRail5.match(/Down\/ Polling/g)).toHaveLength(2);
    const pq = sh(s, 'node01', 'perfquery 9 6');
    expect(pq).toMatch(/^# Port counters: Lid 9 port 6 /);
    expect(num(pq, /LinkDownedCounter:\.+(\d+)/)).toBe(1);
    expect(num(pq, /SymbolErrorCounter:\.+(\d+)/)).toBeGreaterThan(1000);
    expect(sh(s, 'node01', 'ssh spine02')).toMatch(/No route to host/);
    expect(CHECKS.ib_switch_reachable(s, { switch: 'leaf06' })).toBe(false);
  });

  it('the rail kept working until leaf06 rebooted', () => {
    const faults = lab('sim-21-ib-spine-down-leaf-isolated').faults.filter((f) => f.type !== 'ib_port_reset');
    const s = labState(faults);
    expect(CHECKS.ib_ports_active(s, { node: 'all', rail: 5 })).toBe(true);
    expect(CHECKS.ib_switch_reachable(s, { switch: 'leaf06' })).toBe(false);
  });

  it('replacing the cable from either end restores the path through spine01', () => {
    for (const end of ['leaf06 31', 'spine01 6']) {
      const s = labState(lab('sim-21-ib-spine-down-leaf-isolated').faults);
      sh(s, 'node01', `replace-cable ${end}`);
      expect(CHECKS.ib_ports_active(s, { node: 'all', rail: 5 })).toBe(true);
      expect(evaluateAllReduce(s).busbw).toBeGreaterThan(360);
    }
  });
});
