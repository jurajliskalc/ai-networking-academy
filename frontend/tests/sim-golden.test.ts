// Golden-format tests: the simulator's host-tool output is compared with real captures from two ConnectX-5 hosts
// (tests/fixtures/real/, see the README there). Both sides are reduced to a line skeleton (mask() below: numbers,
// GUIDs, GIDs, IPs, device and interface names, host names and dates become placeholders; tabs and single spaces are
// kept, runs of spaces become two) and the skeletons must match line by line: same field names, order, separators,
// headers and footers. The few intentional differences are listed per case in `allow`, each with its reason.
// How to add a capture: docs/SIMULATOR.md, "Golden-format tests".
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFabric, type FabricState } from '../src/sim/fabric';
import { exec } from '../src/sim/shell';
import { labState } from '../src/sim/lab';

const ROOT = path.resolve(__dirname, 'fixtures/real');

/** A capture file: `### cmd:` / optional `### note:` lines, `### ----`, the raw output, `### rc=N`. */
export function readCapture(rel: string): { cmd: string; out: string[] } {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const start = lines.indexOf('### ----');
  const end = lines.findIndex((l, i) => i > start && /^### rc=\d+$/.test(l));
  if (start < 0 || end < 0) throw new Error(`${rel}: missing "### ----" or "### rc=" line`);
  const cmd = (lines.find((l) => l.startsWith('### cmd: ')) ?? '').slice(9);
  return { cmd, out: lines.slice(start + 1, end) };
}

const HOSTS = /ESXI-\d-UbuntuServer-\d|r640-[ab]-data|node0\d/g;

/** Reduce one line to its skeleton. The order of the replacements matters (GIDs before hex, IPs before numbers). */
export function mask(line: string): string {
  return line
    .replace(/\d{4}-\d\d-\d\dT[\d:.+-]+/g, 'DATE')
    .replace(/\b[0-9a-f]{4}(?::[0-9a-f]{4}){3,7}\b/gi, 'GID')
    .replace(/\b(?:\d{1,3}:){15}\d{1,3}\b/g, 'PGID') // perftest prints the GID as 16 decimal bytes
    .replace(/0x[0-9a-f]+/gi, 'HEX')
    .replace(/\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{12,16}\b/gi, 'HEX') // bare GUIDs (ibv_devices)
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, 'IP')
    .replace(/\b(?:mlx5_\d+|rocep\d+s\d+f\d+)\b/g, 'DEV')
    .replace(/\b(?:en[ops]\w*?np\d+|ib[ps]\d+\w*)\b/g, 'NETDEV')
    .replace(HOSTS, 'HOST')
    .replace(/\b[A-Z]+_\d{10}\b/g, 'PSID') // board_id
    .replace(/\bMT\d{4}\b/g, 'MTxxxx') // CA type
    .replace(/(?<![A-Za-z_\d])\d+(?:\.\d+)*(?:E[-+]\d+)?/g, 'N')
    .replace(/N +\t/g, 'N\t') // printf padding between a value and a tab depends on the value's width
    .replace(/ {2,}/g, '  ');
}

/** Collapse a block of lines repeated back to back (one per device or GID) to a single copy. */
export function collapseRepeats(lines: string[]): string[] {
  const out = [...lines];
  for (let k = 1; k <= 24; k++) {
    for (let i = 0; i + 2 * k <= out.length; ) {
      let same = true;
      for (let j = 0; j < k && same; j++) same = out[i + j] === out[i + k + j];
      if (same) out.splice(i + k, k);
      else i++;
    }
  }
  return out;
}

/** An intentional difference: `re` is replaced by `to` in both masked outputs before they are compared. */
interface Allow { re: RegExp; to: string; why: string }
interface Case {
  fixture: string;
  /** The equivalent command in the simulator (run on `host`, default node01). */
  sim: string;
  host?: string;
  state?: () => FabricState;
  /** "host: command" lines run first, e.g. to bring the NIC to the captured configuration. */
  setup?: string[];
  /** exact (default): same skeleton line by line. subset: every simulated line appears in the capture, in order. */
  mode?: 'exact' | 'subset';
  collapse?: boolean;
  /** Pick the part of the simulated output that has a counterpart in the capture. */
  pick?: (lines: string[]) => string[];
  allow?: Allow[];
}

// Lines that are noise on one side only: DOCA's rdma-core warns about a missing provider on every verbs tool, and the
// simulator marks its own notes "(simulator ...)".
const REAL_NOISE = /^libibverbs: Warning: couldn't load driver /;
const SIM_NOISE = /^\(simulator/;

function simOutput(c: Case): string[] {
  const s = (c.state ?? createFabric)();
  for (const line of c.setup ?? []) {
    const [host, cmd] = line.split(/:\s(.+)/);
    exec({ state: s, host }, cmd);
  }
  const out = exec({ state: s, host: c.host ?? 'node01' }, c.sim).out.replace(/\n$/, '').split('\n');
  return (c.pick ? c.pick(out) : out).filter((l) => !SIM_NOISE.test(l));
}

/** Compare two outputs; returns a readable report of the first mismatch, or '' when they agree. */
export function compare(real: string[], sim: string[], c: Pick<Case, 'mode' | 'collapse' | 'allow'>): string {
  let r = real.filter((l) => !REAL_NOISE.test(l)).map(mask);
  let m = sim.map(mask);
  if (c.collapse) { r = collapseRepeats(r); m = collapseRepeats(m); }
  const norm = (l: string) => (c.allow ?? []).reduce((x, a) => x.replace(a.re, a.to), l);
  r = r.map(norm);
  m = m.map(norm);
  const ok = (a: string, b: string) => a === b;
  if (c.mode === 'subset') {
    let j = 0;
    for (const line of m) {
      while (j < r.length && !ok(r[j], line)) j++;
      if (j === r.length) return `simulated line not in the capture (or out of order): ${JSON.stringify(line)}`;
      j++;
    }
    return '';
  }
  for (let i = 0; i < Math.max(r.length, m.length); i++) {
    if (r[i] === undefined || m[i] === undefined || !ok(r[i], m[i]))
      return `line ${i + 1} differs\n  real: ${JSON.stringify(r[i])}\n  sim:  ${JSON.stringify(m[i])}`;
  }
  return '';
}

const ib = () => labState([{ type: 'ib_fabric' }]);
const ibNoSm = () => labState([{ type: 'ib_fabric' }, { type: 'sm_down' }]);
const NIC = 'enp24s0np0'; // node01 mlx5_0, the simulator's counterpart of the lab's ens64f0np0 / mlx5_0
// The factory state the "default" captures were taken in: trust pcp, PFC off, global pause on.
const FACTORY = [`node01: mlnx_qos -i ${NIC} --trust pcp`, `node01: ethtool -A ${NIC} rx on tx on`];
const first = (n: number) => (l: string[]) => l.slice(0, n);
/** The first CA blocks of iblinkinfo (the capture is two HCAs back to back, without switches). */
const caBlocks = (n: number) => (l: string[]) => {
  const i = l.findIndex((x) => x.startsWith('CA: '));
  return l.slice(i, i + 2 * n);
};

const SPEED_100G: Allow = { re: /^(Speed {2}: )N(?:GbE|G) $/, to: '$1SPEED ', why: '100GbE ConnectX-5 captured; the simulator models 400G (mlxlink prints the extended-speed form there)' };
const EXT_SPEED: Allow = { re: /^(Enabled Link Speed|Supported Cable Speed)(?: \(Ext\.\))? {2}: HEX \([^)]*\) $/, to: '$1  : HEX (SPEEDS) ', why: 'extended-speed devices (400G) label these "(Ext.)" and list other speed names' };
const IB_RATE: Allow = { re: /\(NX [EN]DR\)$/, to: '(NX RATE)', why: 'EDR (100G ConnectX-5) captured; the simulator models NDR (400G)' };
const B2B_PEER: Allow = { re: /"HOST DEV"|"MF0;leaf\d\d:MQM9700\/U1"/, to: '"PEER"', why: 'the capture is two HCAs back to back; in the simulator every HCA is cabled to a Quantum-2 leaf' };

export const CASES: Case[] = [
  // ---- RoCE, DOCA-OFED 3.4 (device names mlx5_N, as in the simulator)
  { fixture: 'doca-roce/ibv_devices.txt', sim: 'ibv_devices', collapse: true },
  { fixture: 'doca-roce/ibv_devinfo-d.txt', sim: 'ibv_devinfo -d mlx5_0' },
  { fixture: 'doca-roce/rdma_link.txt', sim: 'rdma link show', collapse: true },
  { fixture: 'doca-roce/rdma_statistic.txt', sim: 'rdma statistic show link mlx5_0/1', mode: 'subset' },
  { fixture: 'doca-roce/show_gids.txt', sim: 'show_gids', collapse: true },
  { fixture: 'doca-roce/show_gids-dev.txt', sim: 'show_gids mlx5_0' },
  { fixture: 'doca-roce/ibdev2netdev.txt', sim: 'ibdev2netdev', collapse: true },
  { fixture: 'doca-roce/ethtool-a-default.txt', sim: `ethtool -a ${NIC}`, setup: FACTORY },
  { fixture: 'doca-roce/ethtool-a-pfc.txt', sim: `ethtool -a ${NIC}` },
  { fixture: 'doca-roce/ethtool-S-prio-default.txt', sim: `ethtool -S ${NIC} | grep -E 'prio[0-7]_(bytes|pause)|discards_phy|out_of_buffer'`, setup: FACTORY },
  { fixture: 'doca-roce/ethtool-S-hw02-default.txt', sim: `ethtool -S ${NIC} | grep -E 'vport_rdma_unicast|discard|pause' | head -20`, setup: FACTORY },
  { fixture: 'doca-roce/ethtool-S-hw05.txt', sim: `ethtool -S ${NIC} | grep -E 'crc_errors_phy|symbol_err_phy|link_down_events_phy|corrected_bits_phy|discards_phy'` },
  { fixture: 'doca-roce/mlnx_qos-default.txt', sim: `mlnx_qos -i ${NIC}`, setup: FACTORY },
  { fixture: 'doca-roce/mlnx_qos-trust-dscp.txt', sim: `mlnx_qos -i ${NIC} --trust dscp`, setup: FACTORY },
  { fixture: 'doca-roce/mlnx_qos-pfc.txt', sim: `mlnx_qos -i ${NIC} --pfc 0,0,0,1,0,0,0,0`, setup: [...FACTORY, `node01: mlnx_qos -i ${NIC} --trust dscp`] },
  { fixture: 'doca-roce/mlnx_qos-dscp-pfc.txt', sim: `mlnx_qos -i ${NIC}` },
  { fixture: 'doca-roce/mlnx_qos-ets.txt', sim: `mlnx_qos -i ${NIC} --tsa ets,ets,ets,ets,ets,ets,strict,ets --tcbw 10,5,5,60,5,5,0,10` },
  { fixture: 'doca-roce/mlnx_qos-grep.txt', sim: `mlnx_qos -i ${NIC} | grep -iE 'trust|enabled'` },
  { fixture: 'doca-roce/mlnx_qos-pfc-bad.txt', sim: `mlnx_qos -i ${NIC} --pfc 0,0,0,1` },
  { fixture: 'doca-roce/mlnx_qos-trust-bad.txt', sim: `mlnx_qos -i ${NIC} --trust foo` },
  { fixture: 'doca-roce/mlnx_qos-ets-bad.txt', sim: `mlnx_qos -i ${NIC} --tsa ets,ets,ets,ets,ets,ets,ets,ets --tcbw 10,10,10,10,10,10,10,10` },
  { fixture: 'doca-roce/ib_write_bw.txt', sim: 'ib_write_bw -d mlx5_0 -x 3 -F --report_gbits node02' },
  { fixture: 'doca-roce/ib_write_bw-D.txt', sim: 'ib_write_bw -d mlx5_0 -x 3 -D 5 -F --report_gbits node02' },
  { fixture: 'doca-roce/ib_write_bw-q8.txt', sim: 'ib_write_bw -d mlx5_0 -x 3 -q 8 -F --report_gbits node02' },
  { fixture: 'doca-roce/ib_write_bw-m1024.txt', sim: 'ib_write_bw -d mlx5_0 -x 3 -m 1024 -F --report_gbits node02' },
  { fixture: 'doca-roce/ib_write_bw-mib.txt', sim: 'ib_write_bw -d mlx5_0 -x 3 -F node02' },
  { fixture: 'doca-roce/ib_write_bw-nopeer.txt', sim: 'ib_write_bw -d mlx5_0 -x 3 -F --report_gbits 10.9.9.9' },
  { fixture: 'doca-roce/ping.txt', sim: 'ping -c 3 10.0.2.1' },
  { fixture: 'doca-roce/ping-df.txt', sim: 'ping -M do -s 8972 -c 3 10.0.2.1' },
  { fixture: 'doca-roce/ping-df-toobig.txt', sim: 'ping -M do -s 8973 -c 1 10.0.2.1' },
  { fixture: 'doca-roce/ping-df-I.txt', sim: 'ping -M do -s 8972 -c 3 -I 10.0.1.1 10.0.2.1' },
  // The capture pinged an unused address; in the simulator the peer drops the packet (its MTU is smaller): no reply either way.
  { fixture: 'doca-roce/ping-unreach.txt', sim: 'ping -c 2 -s 2000 10.0.2.1', setup: [`node02: ip link set dev ${NIC} mtu 1500`] },
  { fixture: 'doca-roce/mlxlink.txt', sim: 'mlxlink -d mlx5_0', allow: [SPEED_100G, EXT_SPEED] },
  { fixture: 'doca-roce/mlxlink-c.txt', sim: 'mlxlink -d mlx5_0 -c', allow: [SPEED_100G, EXT_SPEED] },

  // ---- RoCE, distribution stack (rdma-core names devices rocep<bus>s<slot>f<fn>; masked to the same skeleton)
  { fixture: 'inbox-roce/ibv_devices.txt', sim: 'ibv_devices', collapse: true },
  { fixture: 'inbox-roce/rdma_link.txt', sim: 'rdma link', collapse: true },
  { fixture: 'inbox-roce/ibv_devinfo-missing.txt', sim: 'ibv_devinfo -d mlx5_9' },
  { fixture: 'inbox-roce/ib_write_bw-baddev.txt', sim: 'ib_write_bw -d mlx5_9 -x 3 -F --report_gbits node02' },
  { fixture: 'inbox-roce/ethtool-S-pause-pfc.txt', sim: `ethtool -S ${NIC} | grep -E 'prio3_pause|pause_storm|global_pause'` },
  { fixture: 'inbox-roce/ethtool-a-pfc.txt', sim: `ethtool -a ${NIC}` },

  // ---- InfiniBand (ConnectX-5 port 2 in IB mode, EDR, back to back), OpenSM running
  { fixture: 'doca-ib-sm/ibstat-ca.txt', sim: 'ibstat mlx5_0', state: ib },
  { fixture: 'doca-ib-sm/ibstat-ca-port.txt', sim: 'ibstat mlx5_0 1', state: ib },
  { fixture: 'doca-ib-sm/ibstatus.txt', sim: 'ibstatus mlx5_0', state: ib, allow: [IB_RATE] },
  { fixture: 'doca-ib-sm/rdma_link.txt', sim: 'rdma link', state: ib, pick: first(1) },
  { fixture: 'doca-ib-sm/ibv_devinfo-d.txt', sim: 'ibv_devinfo -d mlx5_0', state: ib },
  { fixture: 'doca-ib-sm/perfquery.txt', sim: 'perfquery -C mlx5_0 -P 1', state: ib },
  { fixture: 'doca-ib-sm/perfquery-x.txt', sim: 'perfquery -x -C mlx5_0 -P 1', state: ib },
  { fixture: 'doca-ib-sm/sminfo.txt', sim: 'sminfo -C mlx5_0 -P 1', state: ib },
  { fixture: 'doca-ib-sm/iblinkinfo.txt', sim: 'iblinkinfo -C mlx5_0 -P 1', state: ib, pick: caBlocks(2), allow: [B2B_PEER] },
  { fixture: 'doca-ib-sm/ib_write_bw.txt', sim: 'ib_write_bw -d mlx5_0 -F --report_gbits node02', state: ib },
  // Two HCA ports with the counters the capture shows (the capture lists the peer first, so node01 takes its counters).
  { fixture: 'doca-ib-sm/ibqueryerrors.txt', sim: 'ibqueryerrors', state: () => labState([{ type: 'ib_fabric' },
    { type: 'ib_counters', node: 'node01', rail: 0, counters: { PortRcvErrors: 3, PortRcvSwitchRelayErrors: 3 } },
    { type: 'ib_counters', node: 'node02', rail: 0, counters: { PortXmitDiscards: 11, PortXmitWait: 65571 } }]),
  allow: [{ re: / \(N\)\]/g, to: ']',
    why: 'the "(3.000)" suffix the capture prints after these two counters is not modelled (its source in ibqueryerrors was not verified)' }] },

  // ---- InfiniBand without a subnet manager (link trained, ports INIT, LID 65535)
  { fixture: 'doca-ib-nosm/ibstat-ca.txt', sim: 'ibstat mlx5_0', state: ibNoSm },
  { fixture: 'doca-ib-nosm/ibstat-ca-port.txt', sim: 'ibstat mlx5_0 1', state: ibNoSm },
  { fixture: 'doca-ib-nosm/ibstatus.txt', sim: 'ibstatus mlx5_0', state: ibNoSm, allow: [IB_RATE] },
  { fixture: 'doca-ib-nosm/rdma_link.txt', sim: 'rdma link', state: ibNoSm, pick: first(1) },
  { fixture: 'doca-ib-nosm/ibv_devinfo-d.txt', sim: 'ibv_devinfo -d mlx5_0', state: ibNoSm },
  { fixture: 'doca-ib-nosm/perfquery.txt', sim: 'perfquery -C mlx5_0 -P 1', state: ibNoSm },
  { fixture: 'doca-ib-nosm/sminfo.txt', sim: 'sminfo -C mlx5_0 -P 1', state: ibNoSm },
  { fixture: 'doca-ib-nosm/iblinkinfo.txt', sim: 'iblinkinfo -C mlx5_0 -P 1', state: ibNoSm, pick: caBlocks(2), allow: [B2B_PEER] },
  { fixture: 'doca-ib-nosm/ib_write_bw.txt', sim: 'ib_write_bw -d mlx5_0 -F --report_gbits node02', state: ibNoSm },
  { fixture: 'doca-ib-nosm/ibqueryerrors.txt', sim: 'ibqueryerrors', state: ibNoSm },
];

describe('simulator output has the skeleton of real captures (tests/fixtures/real)', () => {
  for (const c of CASES) {
    it(`${c.fixture}  <->  ${c.sim}`, () => {
      const real = readCapture(c.fixture).out;
      expect(real.length, 'capture has output').toBeGreaterThan(0);
      const sim = simOutput(c);
      expect(compare(real, sim, c)).toBe('');
      // An allow-list entry that no longer matches anything is stale: remove it.
      for (const a of c.allow ?? []) expect([...real, ...sim].map(mask).some((l) => new RegExp(a.re.source).test(l)), a.why).toBe(true);
    });
  }

  it('every fixture is used by a case, and every allow-list entry gives its reason', () => {
    const files = fs.readdirSync(ROOT, { recursive: true }).map(String).filter((f) => f.endsWith('.txt')).map((f) => f.replace(/\\/g, '/'));
    expect(files.sort()).toEqual(CASES.map((c) => c.fixture).sort());
    for (const c of CASES) for (const a of c.allow ?? []) expect(a.why.length).toBeGreaterThan(10);
  });

  it('fixtures carry no serial numbers', () => {
    for (const c of CASES) expect(fs.readFileSync(path.join(ROOT, c.fixture), 'utf8')).not.toMatch(/serial|S\/N|\bMT\d{4}[A-Z]{2}\w+/i);
  });
});

describe('the harness itself', () => {
  it('masks values but keeps names, separators and layout', () => {
    expect(mask('\t\tBase lid: 65535')).toBe('\t\tBase lid: N');
    expect(mask('    mlx5_0          \t248a0703000011ee')).toBe('  DEV  \tHEX');
    expect(mask(' GID: 00:00:00:00:00:00:00:00:00:00:255:255:10:10:10:01')).toBe(' GID: PGID');
    expect(mask('link rocep3s0f0/1 state ACTIVE physical_state LINK_UP netdev ens64f0np0 ')).toBe('link DEV/N state ACTIVE physical_state LINK_UP netdev NETDEV ');
    expect(mask('     rx_prio3_pause: 696')).toBe('  rx_prio3_pause: N');
    expect(mask('Raw Physical BER                   : 15E-255')).toBe('Raw Physical BER  : N');
  });
  it('detects a changed separator, a missing field and reordered counters', () => {
    expect(compare(['RX:\t\ton'], ['RX:\ton'], {})).toMatch(/line 1 differs/);
    expect(compare(['a: 1', 'b: 2'], ['a: 1'], {})).toMatch(/line 2 differs/);
    expect(compare(['    x 1 ', '    y 2 '], ['    y 2 ', '    x 1 '], { mode: 'subset' })).toMatch(/not in the capture/);
    expect(compare(['    x 1 ', '    y 2 ', '    z 3 '], ['    x 1 ', '    z 3 '], { mode: 'subset' })).toBe('');
  });
  it('collapses repeated per-device blocks', () => {
    expect(collapseRepeats(['h', 'a', 'b', 'a', 'b', 'a', 'b', 'f'])).toEqual(['h', 'a', 'b', 'f']);
  });
});
