// InfiniBand variant of the Fabric Simulator: infiniband-diags style commands (ibstat, ibstatus, iblinkinfo,
// perfquery, sminfo, ibqueryerrors) and the opensm service. Output layouts follow the rdma-core sources
// (infiniband-diags, libibmad dump functions); values come from the model in fabric.ts. See docs/SIMULATOR.md.
import {
  IB_PC_FIELDS, LEAVES, NODES, SWITCH_ORDER, emptyIb, hcaGuid, ibActive, ibHcaLid, ibSmLid, ibSwitchLid, leafPortFor, linkUp,
  masterSm, smList, smStopped, type FabricState, type Host, type Nic, type Port, type Switch,
} from './fabric';

export { hcaGuid };

const lpad = (s: string | number, n: number) => String(s).padStart(n);
export const swGuid = (sw: string) => `900a8403006${SWITCH_ORDER.indexOf(sw).toString(16)}b1c0`;
// Quantum-2 switches report a node description like this by default; hosts use "<hostname> <device>" (rdma-ndd).
export const swDesc = (sw: string) => `MF0;${sw}:MQM9700/U1`;
const caDesc = (node: string, nic: Nic) => `${node} ${nic.dev}`;
const portNum = (p: Port) => Number(p.name.replace('swp', ''));

interface PortView { state: 'Down' | 'Initialize' | 'Active'; phys: 'LinkUp' | 'Polling' | 'Disabled'; lanes: number; lid: number }

function leafPort(s: FabricState, node: string, rail: number): Port {
  return s.switches[LEAVES[rail]].ports[leafPortFor(node)];
}

/** Logical and physical state of an HCA port, as the SMA reports it. */
export function hcaView(s: FabricState, node: string, nic: Nic, act = ibActive(s)): PortView {
  const p = leafPort(s, node, nic.rail);
  if (!nic.admin) return { state: 'Down', phys: 'Disabled', lanes: 4, lid: 0 };
  if (!linkUp(s, p)) return { state: 'Down', phys: 'Polling', lanes: 4, lid: 0 };
  const active = act.has(`${node}:${nic.rail}`);
  // Until an SM assigns one, the port reports the reserved LID 0xFFFF (ibstat: "Base lid: 65535").
  return { state: active ? 'Active' : 'Initialize', phys: 'LinkUp', lanes: p.lanes ?? 4, lid: active ? ibHcaLid(s, node, nic.rail, act) : 0xffff };
}

function swPortView(s: FabricState, sw: Switch, p: Port, act: Set<string>): PortView {
  if (!linkUp(s, p)) return { state: 'Down', phys: p.admin ? 'Polling' : 'Disabled', lanes: 4, lid: 0 };
  let lanes = p.lanes ?? 4;
  if (p.peer.kind === 'switch') lanes = Math.min(lanes, s.switches[p.peer.sw].ports[p.peer.port].lanes ?? 4);
  return { state: act.has(`${sw.name}:${p.name}`) ? 'Active' : 'Initialize', phys: 'LinkUp', lanes, lid: ibSwitchLid(s, sw.name, act) };
}

const SYSFS_STATE = { Down: '1: DOWN', Initialize: '2: INIT', Active: '4: ACTIVE' } as const;
const SYSFS_PHYS = { LinkUp: '5: LinkUp', Polling: '2: Polling', Disabled: '3: Disabled' } as const;
const IBSTAT_STATE = { Down: 'Down', Initialize: 'Initializing', Active: 'Active' } as const;

function capMask(s: FabricState, node: string, rail: number) {
  // Bit 1 (IsSM) is set on a port that runs an SM (master or standby).
  return smList(s).some((x) => x.running && x.node === node && x.rail === rail) ? '0xa751e84a' : '0xa751e848';
}

/** -C <ca> picks the local HCA, as in the infiniband-diags tools; -P <port> is accepted (every HCA has port 1). */
function caArg(h: Host, a: string[]): { nic?: Nic; bad?: string; rest: string[] } {
  const rest: string[] = [];
  let nic: Nic | undefined;
  let bad: string | undefined;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '-C' || a[i] === '--Ca') {
      const name = a[++i];
      nic = h.nics.find((n) => n.dev === name);
      if (!nic) bad = name ?? '';
    } else if (a[i] === '-P' || a[i] === '--Port') i++;
    else rest.push(a[i]);
  }
  return { nic, bad, rest };
}

function pickNics(h: Host, name?: string): Nic[] | null {
  if (!name) return h.nics;
  const n = h.nics.find((x) => x.dev === name);
  return n ? [n] : null;
}

export function ibstat(s: FabricState, h: Host, a: string[]): string {
  if (a.includes('-l') || a.includes('--list_of_cas')) return h.nics.map((n) => n.dev).join('\n') + '\n';
  if (a.includes('-p') || a.includes('--port_list')) return h.nics.map((n) => `0x${hcaGuid(h.name, n.rail)}`).join('\n') + '\n';
  const pos = a.filter((x) => !x.startsWith('-'));
  const sel = pickNics(h, pos[0]);
  if (!sel) return `ibpanic: [${41000 + h.nics.length}] main: '${pos[0]}' IB device can't be found: No such file or directory\n`;
  const act = ibActive(s);
  const port = (n: Nic, alone: boolean) => {
    const v = hcaView(s, h.name, n, act);
    const pre = alone ? '' : '\t\t';
    const hdr = alone ? '' : '\t';
    return `${hdr}Port 1:
${pre}State: ${IBSTAT_STATE[v.state]}
${pre}Physical state: ${v.phys}
${pre}Rate: ${v.state === 'Down' ? 10 : v.lanes * 100}
${pre}Base lid: ${v.lid}
${pre}LMC: 0
${pre}SM lid: ${v.state === 'Active' ? ibSmLid(s) : 0}
${pre}Capability mask: ${capMask(s, h.name, n.rail)}
${pre}Port GUID: 0x${hcaGuid(h.name, n.rail)}
${pre}Link layer: InfiniBand
`;
  };
  // "ibstat <ca> <port>" prints a flat block that starts with "CA: '<ca>'".
  if (pos[0] && pos[1]) return `CA: '${sel[0].dev}'
` + port(sel[0], true);
  return sel.map((n) => `CA '${n.dev}'
\tCA type: MT4129
\tNumber of ports: 1
\tFirmware version: 28.43.1014
\tHardware version: 0
\tNode GUID: 0x${hcaGuid(h.name, n.rail)}
\tSystem image GUID: 0x${hcaGuid(h.name, n.rail)}
${port(n, false)}`).join('');
}

export function ibstatus(s: FabricState, h: Host, a: string[]): string {
  const want = a.filter((x) => !x.startsWith('-')).map((x) => x.split(':')[0]);
  const sel = want.length ? h.nics.filter((n) => want.includes(n.dev)) : h.nics;
  if (want.length && !sel.length) return `Fatal error:  device '${want[0]}': sys files not found (/sys/class/infiniband/${want[0]}/ports)\n`;
  const act = ibActive(s);
  return sel.map((n) => {
    const v = hcaView(s, h.name, n, act);
    const gid = `fe80:0000:0000:0000:${hcaGuid(h.name, n.rail).replace(/(\w{4})(?=\w)/g, '$1:')}`;
    const rate = v.state === 'Down' ? '10 Gb/sec (4X SDR)' : `${v.lanes * 100} Gb/sec (${v.lanes}X NDR)`;
    return `Infiniband device '${n.dev}' port 1 status:
\tdefault gid:\t ${gid}
\tbase lid:\t 0x${v.lid.toString(16)}
\tsm lid:\t\t 0x${(v.state === 'Active' ? ibSmLid(s) : 0).toString(16)}
\tstate:\t\t ${SYSFS_STATE[v.state]}
\tphys state:\t ${SYSFS_PHYS[v.phys]}
\trate:\t\t ${rate}
\tlink_layer:\t InfiniBand

`;
  }).join('');
}

/** Nodes reachable by directed-route discovery from this host's first HCA, or from `from` (no LIDs needed). */
function discover(s: FabricState, h: Host, from?: Nic): { switches: string[]; cas: [string, Nic][] } | null {
  const up = (n: Nic) => linkUp(s, leafPort(s, h.name, n.rail));
  const start = from ? (up(from) ? from : undefined) : h.nics.find(up);
  if (!start) return null;
  const seen = new Set<string>([LEAVES[start.rail]]);
  const queue = [LEAVES[start.rail]];
  const cas: [string, Nic][] = [];
  while (queue.length) {
    const sw = s.switches[queue.shift()!];
    for (const p of Object.values(sw.ports)) {
      if (!linkUp(s, p)) continue;
      if (p.peer.kind === 'host') cas.push([p.peer.node, s.hosts[p.peer.node].nics[p.peer.rail]]);
      else if (!seen.has(p.peer.sw)) { seen.add(p.peer.sw); queue.push(p.peer.sw); }
    }
  }
  const switches = SWITCH_ORDER.filter((x) => seen.has(x));
  cas.sort((x, y) => NODES.indexOf(x[0] as never) - NODES.indexOf(y[0] as never) || x[1].rail - y[1].rail);
  return { switches, cas };
}

function linkStr(v: PortView) {
  if (v.state === 'Down') return `(              ${lpad(v.state, 6)}/${lpad(v.phys, 8)})`;
  return `(${lpad(`${v.lanes}X`, 3)} ${lpad('106.25 Gbps', 18)} ${lpad(v.state, 6)}/${lpad(v.phys, 8)})`;
}
const widthMsg = (v: PortView) => (v.state !== 'Down' && v.lanes < 4 ? 'Could be 4X' : '');

export function iblinkinfo(s: FabricState, h: Host, args: string[]): string {
  const { nic, bad, rest: a } = caArg(h, args);
  if (bad !== undefined) return `ibwarn: [41007] get_smi_gsi_pair: Can't open UMAD port (No such device) (${bad}:0)\nibwarn: [41007] mad_rpc_open_port2: can't open UMAD port (${bad}:0)\nFailed to open ${bad} port 0\n`;
  const d = discover(s, h, nic);
  if (!d) return nic
    ? `(simulator: ${nic.dev} has no link; directed-route discovery needs a port that is physically up)\n`
    : 'ibwarn: [41007] mad_rpc_open_port: can\'t open UMAD port ((null):0)\n(simulator: every IB port on this host is down)\n';
  const act = ibActive(s);
  const downOnly = a.includes('-d') || a.includes('--down');
  const swOnly = a.includes('--switches-only');
  const caOnly = a.includes('--cas-only');
  let out = '';
  if (!caOnly) {
    for (const name of d.switches) {
      const sw = s.switches[name];
      const lines: string[] = [];
      for (const p of Object.values(sw.ports).sort((x, y) => portNum(x) - portNum(y))) {
        const v = swPortView(s, sw, p, act);
        if (downOnly && v.state !== 'Down') continue;
        let remote = '           [  ] "" ( )';
        if (v.state !== 'Down') {
          if (p.peer.kind === 'host') {
            const n = s.hosts[p.peer.node].nics[p.peer.rail];
            const hv = hcaView(s, p.peer.node, n, act);
            remote = `${lpad(hv.lid, 6)} ${lpad(1, 4)}[  ] "${caDesc(p.peer.node, n)}" (${widthMsg(v)} )`;
          } else {
            remote = `${lpad(ibSwitchLid(s, p.peer.sw, act), 6)} ${lpad(Number(p.peer.port.replace('swp', '')), 4)}[  ] "${swDesc(p.peer.sw)}" (${widthMsg(v)} )`;
          }
        }
        lines.push(`      ${lpad(v.lid, 6)} ${lpad(portNum(p), 4)}[  ] ==${linkStr(v)}==>  ${remote}`);
      }
      if (lines.length) out += `Switch: 0x${swGuid(name)} ${swDesc(name)}:\n${lines.join('\n')}\n`;
    }
  }
  if (!swOnly) {
    for (const [node, n] of d.cas) {
      const v = hcaView(s, node, n, act);
      if (downOnly && v.state !== 'Down') continue;
      const p = leafPort(s, node, n.rail);
      const leaf = LEAVES[n.rail];
      const remote = `${lpad(ibSwitchLid(s, leaf, act), 6)} ${lpad(portNum(p), 4)}[  ] "${swDesc(leaf)}" (${widthMsg(v)} )`;
      out += `CA: ${caDesc(node, n)}:\n      0x${hcaGuid(node, n.rail)} ${lpad(v.lid, 6)} ${lpad(1, 4)}[  ] ==${linkStr(v)}==>  ${remote}\n`;
    }
  }
  return out + '(simulator: unused switch ports are not listed)\n';
}

type Target = { kind: 'hca'; node: string; nic: Nic; lid: number } | { kind: 'sw'; sw: Switch; lid: number };

function findLid(s: FabricState, lid: number, act: Set<string>): Target | null {
  for (const sw of SWITCH_ORDER) if (ibSwitchLid(s, sw, act) === lid && lid) return { kind: 'sw', sw: s.switches[sw], lid };
  for (const node of NODES) for (const nic of s.hosts[node].nics) if (lid && ibHcaLid(s, node, nic.rail, act) === lid) return { kind: 'hca', node, nic, lid };
  return null;
}

const capped = (v: number, bits: number) => Math.min(v, 2 ** bits - 1);
const dots = (name: string) => `${name}:${'.'.repeat(Math.max(0, 32 - name.length))}`;

export function perfquery(s: FabricState, h: Host, a: string[]): string {
  let ca = 'mlx5_0', extended = false, reset = false;
  const pos: string[] = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '-C') ca = a[++i];
    else if (a[i] === '-P') i++;
    else if (a[i] === '-x' || a[i] === '--extended') extended = true;
    else if (a[i] === '-r' || a[i] === '--reset_after_read') reset = true;
    else if (!a[i].startsWith('-')) pos.push(a[i]);
  }
  const local = h.nics.find((n) => n.dev === ca);
  if (!local) return `perfquery: iberror: failed: Failed to open '${ca}' port '0'\n`;
  const act = ibActive(s);
  const lv = hcaView(s, h.name, local, act);
  // PerfMgt MADs are LID-routed: without an SM (LID 0) nothing answers.
  if (lv.state !== 'Active')
    return `ibwarn: [41013] _do_madrpc: recv failed: Connection timed out\nibwarn: [41013] mad_rpc: _do_madrpc failed; dport (Lid ${lv.lid})\nperfquery: iberror: failed: classportinfo query\n`;
  let target: Target | null;
  let portN = 1;
  if (pos.length) {
    target = findLid(s, Number(pos[0]), act);
    if (pos[1]) portN = Number(pos[1]);
  } else target = { kind: 'hca', node: h.name, nic: local, lid: lv.lid };
  if (!target) return 'perfquery: iberror: failed: classportinfo query\n';
  let pc: Record<string, number> | undefined;
  if (target.kind === 'hca') {
    if (portN !== 1) return `perfquery: iberror: failed: perfquery\n`;
    pc = target.nic.ib;
  } else {
    const p = Object.values(target.sw.ports).find((x) => portNum(x) === portN);
    pc = p?.ib ?? (portN >= 1 && portN <= 64 ? emptyIb() : undefined);
    if (!pc) return `perfquery: iberror: failed: perfquery\n`;
  }
  pc = pc ?? emptyIb();
  let out: string;
  if (extended) {
    const rows: [string, string | number][] = [
      ['PortSelect', portN], ['CounterSelect', '0x0000'], ['PortXmitData', pc.PortXmitData], ['PortRcvData', pc.PortRcvData],
      ['PortXmitPkts', pc.PortXmitPkts], ['PortRcvPkts', pc.PortRcvPkts], ['PortUnicastXmitPkts', pc.PortXmitPkts],
      ['PortUnicastRcvPkts', pc.PortRcvPkts], ['PortMulticastXmitPkts', 0], ['PortMulticastRcvPkts', 0],
    ];
    out = `# Port extended counters: Lid ${target.lid} port ${portN} (CapMask: 0x5A00 CapMask2: 0x0000000)\n` + rows.map(([k, v]) => dots(k) + v).join('\n') + '\n';
  } else {
    const rows: string[] = [dots('PortSelect') + portN, dots('CounterSelect') + '0x0000'];
    const order = IB_PC_FIELDS.map(([k]) => k);
    const bits = Object.fromEntries(IB_PC_FIELDS);
    for (const k of order) {
      if (k === 'QP1Dropped' || k === 'VL15Dropped' || k.startsWith('PortXmitData') || k.startsWith('PortRcvData') || k.endsWith('Pkts') || k === 'PortXmitWait') continue;
      rows.push(dots(k) + capped(pc[k] ?? 0, bits[k]));
      if (k === 'PortRcvConstraintErrors') rows.push(dots('CounterSelect2') + '0x00');
    }
    for (const k of ['QP1Dropped', 'VL15Dropped', 'PortXmitData', 'PortRcvData', 'PortXmitPkts', 'PortRcvPkts', 'PortXmitWait'])
      rows.push(dots(k) + capped(pc[k] ?? 0, bits[k]));
    out = `# Port counters: Lid ${target.lid} port ${portN} (CapMask: 0x5A00)\n` + rows.join('\n') + '\n';
  }
  if (reset) for (const k of Object.keys(pc)) pc[k] = 0;
  return out;
}

const SM_STATES = ['SMINFO_NOTACT', 'SMINFO_DISCOVER', 'SMINFO_STANDBY', 'SMINFO_MASTER'];

/** sminfo [-C <ca> -P <port>] [<sm_lid>]: asks an SM for its SMInfo (by default the SM LID the local port reports). */
export function sminfo(s: FabricState, h: Host, args: string[] = []): string {
  const { nic, bad, rest } = caArg(h, args);
  if (bad !== undefined) return `ibwarn: [41011] mad_rpc_open_port2: can't open UMAD port (${bad}:0)\nsminfo: iberror: failed: Failed to open '${bad}' port '0'\n`;
  const act = ibActive(s);
  const local = nic ?? h.nics.find((n) => hcaView(s, h.name, n, act).state !== 'Down');
  const lidArg = rest.find((x) => /^\d+$/.test(x));
  const active = !!local && hcaView(s, h.name, local, act).state === 'Active';
  const lid = lidArg ? Number(lidArg) : active ? ibSmLid(s) : 0;
  if (!active || !lid)
    return 'ibwarn: [41011] _do_madrpc: recv failed: Connection timed out\nibwarn: [41011] mad_rpc: _do_madrpc failed; dport (DR path slid 0; dlid 0; 0)\nsminfo: iberror: failed: query\n';
  // Only a running SM answers SMInfo; a port without one (or whose SM died) leaves the query to time out.
  const sm = smList(s).find((x) => x.running && ibHcaLid(s, x.node, x.rail, act) === lid);
  if (!sm) return `ibwarn: [41011] _do_madrpc: recv failed: Connection timed out\nibwarn: [41011] mad_rpc: _do_madrpc failed; dport (Lid ${lid})\nsminfo: iberror: failed: query\n`;
  // infiniband-diags numbers the states 0 NOTACT, 1 DISCOVER, 2 STANDBY, 3 MASTER.
  const st = masterSm(s) === sm ? 3 : 2;
  const count = st === 3 ? 48213 + s.actions.length * 17 + (s.clock ?? 0) * 3 : 1207 + smList(s).indexOf(sm) * 31;
  return `sminfo: sm lid ${lid} sm guid 0x${hcaGuid(sm.node, sm.rail)}, activity count ${count} priority ${sm.priority ?? 0} state ${st} ${SM_STATES[st]}\n`;
}

const ERR_FIELDS = IB_PC_FIELDS.map(([k]) => k).filter((k) => !/^Port(Xmit|Rcv)(Data|Pkts)$/.test(k) && k !== 'QP1Dropped');

export function ibqueryerrors(s: FabricState, h: Host, a: string[]): string {
  const d = discover(s, h);
  if (!d) return 'ibwarn: [41007] mad_rpc_open_port: can\'t open UMAD port ((null):0)\n';
  const suppressed: string[] = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '-s' || a[i] === '--suppress') suppressed.push(...(a[++i] ?? '').split(','));
    else if (a[i].startsWith('--suppress=')) suppressed.push(...a[i].slice(11).split(','));
    else if (a[i] === '-c' || a[i] === '--suppress-common') suppressed.push('PortRcvSwitchRelayErrors');
  }
  const fields = ERR_FIELDS.filter((k) => !suppressed.includes(k));
  const act = ibActive(s);
  const bits = Object.fromEntries(IB_PC_FIELDS);
  let out = '';
  let nodes = 0, badNodes = 0, ports = 0, badPorts = 0, failures = 0;
  const check = (pc: Record<string, number> | undefined) =>
    fields.filter((k) => (pc?.[k] ?? 0) > 0).map((k) => ` [${k} == ${capped(pc![k], bits[k])}]`).join('');
  for (const name of d.switches) {
    nodes++;
    const sw = s.switches[name];
    let header = false;
    for (const p of Object.values(sw.ports).sort((x, y) => portNum(x) - portNum(y))) {
      if (!linkUp(s, p)) continue;
      ports++;
      if (!act.has(name)) { failures++; continue; }
      const str = check(p.ib);
      if (!str) continue;
      if (!header) { out += `Errors for 0x${swGuid(name)} "${swDesc(name)}"\n`; header = true; badNodes++; }
      out += `   GUID 0x${swGuid(name)} port ${portNum(p)}:${str}\n`;
      badPorts++;
    }
  }
  for (const [node, n] of d.cas) {
    nodes++;
    ports++;
    if (!act.has(`${node}:${n.rail}`)) { failures++; continue; }
    const str = check(n.ib);
    if (!str) continue;
    out += `Errors for "${caDesc(node, n)}"\n   GUID 0x${hcaGuid(node, n.rail)} port 1:${str}\n`;
    badNodes++;
    badPorts++;
  }
  if (failures) out = `(simulator: ${failures} "ibwarn: ... query failed" lines trimmed; PMA queries need LIDs, which only an SM assigns)\n` + out;
  // The packaged /etc/infiniband-diags/error_thresholds has every line commented out: threshold 0 everywhere.
  out += `\n## Summary: ${nodes} nodes checked, ${badNodes} bad nodes found\n##          ${ports} ports checked, ${badPorts} ports have errors beyond threshold\n## Thresholds: \n`;
  if (failures) out += `##          ${failures} PMA query failures\n`;
  out += `## Suppressed:${suppressed.map((x) => ` ${x}`).join('')}\n`;
  return out;
}

/** systemctl for the opensm unit on an SM host. Unit text is illustrative: names and paths vary by distribution. */
export function systemctl(s: FabricState, h: Host, a: string[]): { out: string; changed?: boolean } {
  const verb = a.find((x) => !x.startsWith('-'));
  const unit = a.filter((x) => !x.startsWith('-'))[1]?.replace(/\.service$/, '');
  if (!verb) return { out: 'usage: systemctl status|start|stop|restart|enable|disable|is-active|is-enabled opensm\n' };
  if (unit !== 'opensm') return { out: unit ? `Unit ${unit}.service could not be found.\n` : `Too few arguments.\n` };
  const sm = s.mode === 'ib' ? smList(s).find((x) => x.node === h.name) : undefined;
  if (!sm) return { out: 'Unit opensm.service could not be found.\n' };
  const now = a.includes('--now');
  const before = masterSm(s);
  const start = () => {
    sm.running = true;
    sm.failed = false;
    // A starting SM sweeps at once and the election settles (simplification: no handover delay).
    delete s.smLostAt;
  };
  const stop = () => {
    sm.running = false;
    sm.failed = false;
    smStopped(s, sm, before);
  };
  const cmdline = `/usr/sbin/opensm -g 0x${hcaGuid(sm.node, sm.rail)}${sm.priority ? ` -p ${sm.priority}` : ''}`;
  switch (verb) {
    case 'status': {
      const dot = sm.running ? '●' : sm.failed ? '×' : '○';
      const active = sm.running ? 'active (running) since Thu 2026-10-22 06:02:11 UTC; 3min ago'
        : sm.failed ? 'failed (Result: core-dump) since Thu 2026-10-22 02:13:48 UTC; 4h 51min ago' : 'inactive (dead)';
      const tail = sm.running
        ? `   Main PID: 2214 (opensm)\n     CGroup: /system.slice/opensm.service\n             └─2214 ${cmdline}\n`
        : sm.failed ? `    Process: 2214 ExecStart=${cmdline} (code=dumped, signal=SEGV)\n   Main PID: 2214 (code=dumped, signal=SEGV)\n` : '';
      return { out: `${dot} opensm.service - InfiniBand subnet manager (OpenSM)
     Loaded: loaded (/lib/systemd/system/opensm.service; ${sm.enabled ? 'enabled' : 'disabled'}; vendor preset: enabled)
     Active: ${active}
${tail}(simulated unit: description, paths and options vary by distribution)
` };
    }
    case 'is-active': return { out: sm.running ? 'active\n' : sm.failed ? 'failed\n' : 'inactive\n' };
    case 'is-enabled': return { out: sm.enabled ? 'enabled\n' : 'disabled\n' };
    case 'start': case 'restart': start(); return { out: '', changed: true };
    case 'stop': stop(); return { out: '', changed: true };
    case 'enable':
      sm.enabled = true;
      if (now) start();
      return { out: 'Created symlink /etc/systemd/system/multi-user.target.wants/opensm.service → /lib/systemd/system/opensm.service.\n', changed: true };
    case 'disable':
      sm.enabled = false;
      if (now) stop();
      return { out: 'Removed /etc/systemd/system/multi-user.target.wants/opensm.service.\n', changed: true };
    default: return { out: `Unknown command verb ${verb}.\n` };
  }
}

export const IB_SWITCH_NOTE = (sw: string) =>
  `(simulator) ${sw} is a Quantum-2 InfiniBand switch in this lab and is not reachable over SSH. Query it in-band from a GPU node:\n` +
  `  iblinkinfo | perfquery <lid> <port> | ibqueryerrors     (${sw} has LID ${SWITCH_ORDER.indexOf(sw) + 1} once an SM is running)\n`;
