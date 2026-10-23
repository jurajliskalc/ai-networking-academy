// Command interpreter for the Fabric Simulator. Output formats follow the real tools closely enough to
// practise reading them, but every output is generated from the model in fabric.ts (see docs/SIMULATOR.md).
import {
  CHECKS, LEAVES, NETDEVS, NODES, RAILS, ROCE_PRIO, SPINES, accrueTraffic, evaluateAllReduce, evaluatePair,
  hostIp, ibActive, ibHcaLid, ibSettle, ibSmLid, leafIp, leafPortFor, linkKeys, nicIssues, parseConf, roceMtu, unconfigure,
  type FabricState, type Host, type Nic, type Port, type Switch,
} from './fabric';
import { IB_SWITCH_NOTE, hcaGuid, hcaView, ibqueryerrors, iblinkinfo, ibstat, ibstatus, perfquery, sminfo, systemctl } from './ib';

export interface ShellCtx { state: FabricState; host: string; cwd?: string }
export interface ExecResult { out: string; host?: string; clear?: boolean; changed?: boolean }

const isSwitch = (h: string) => LEAVES.includes(h) || SPINES.includes(h);
const pad = (s: string | number, n: number) => String(s).padEnd(n);
const lpad = (s: string | number, n: number) => String(s).padStart(n);
const fmtNum = (n: number) => String(n);

export function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q: string | null = null;
  let has = false;
  for (const ch of line) {
    if (q) {
      if (ch === q) q = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
    } else cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

function splitPipes(line: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let q: string | null = null;
  for (const ch of line) {
    if (q) {
      if (ch === q) q = null;
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      cur += ch;
    } else if (ch === '|') {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim());
}

function filter(text: string, stage: string): string {
  const t = tokenize(stage);
  const cmd = t[0];
  const lines = text.replace(/\n$/, '').split('\n');
  if (cmd === 'grep' || cmd === 'egrep') {
    let i = 1;
    let ci = false, inv = false, ext = cmd === 'egrep', count = false;
    while (t[i]?.startsWith('-') && t[i].length > 1) {
      for (const f of t[i].slice(1)) {
        if (f === 'i') ci = true;
        else if (f === 'v') inv = true;
        else if (f === 'E') ext = true;
        else if (f === 'c') count = true;
      }
      i++;
    }
    const pat = t[i] ?? '';
    let re: RegExp;
    try {
      re = new RegExp(ext ? pat : pat.replace(/\\\|/g, '|'), ci ? 'i' : '');
    } catch {
      return `grep: invalid pattern: ${pat}\n`;
    }
    const kept = lines.filter((l) => re.test(l) !== inv);
    return count ? `${kept.length}\n` : kept.length ? kept.join('\n') + '\n' : '';
  }
  if (cmd === 'head' || cmd === 'tail') {
    const n = Number(t.find((x) => /^-?\d+$/.test(x))?.replace('-', '') ?? (t[1] === '-n' ? t[2] : 10)) || 10;
    const sel = cmd === 'head' ? lines.slice(0, n) : lines.slice(-n);
    return sel.join('\n') + '\n';
  }
  if (cmd === 'wc' && t[1] === '-l') return `${lines.filter((l, i) => l || i < lines.length - 1).length}\n`;
  if (cmd === 'sort') return [...lines].sort().join('\n') + '\n';
  if (cmd === 'less' || cmd === 'more' || cmd === 'cat') return text;
  return `${cmd}: not available in the simulator (pipes support grep, head, tail, wc -l, sort)\n`;
}

export function exec(ctx: ShellCtx, rawLine: string): ExecResult {
  const line = rawLine.trim();
  if (!line) return { out: '' };
  if (line.startsWith('#')) return { out: '' };
  const stages = splitPipes(line);
  let res = execOne(ctx, stages[0]);
  for (const st of stages.slice(1)) res = { ...res, out: filter(res.out, st) };
  // Simulated time moves on (1 s per command; sleep and long tests add more) and the IB port state is recorded.
  ctx.state.clock = (ctx.state.clock ?? 0) + 1;
  ibSettle(ctx.state);
  return res;
}

const HELP_HOST = `Fabric Simulator - GPU node commands (simulated; see the Help panel for details)
  ssh <host>                     node01-node04, leaf01-leaf08, spine01-spine02
  hostname | exit | clear | history
  ip -br link | ip -br addr | ip link show <if> | ip link set dev <if> mtu <n> | ip link set dev <if> up|down
  ibdev2netdev | ibv_devices | ibv_devinfo [-d <dev>] | rdma link | show_gids [<dev>]
  rdma statistic show link <dev>/1
  ethtool <if> | ethtool -S <if> | ethtool -m <if>
  mlnx_qos -i <if> [--trust dscp|pcp] [--pfc 0,0,0,1,0,0,0,0]
  lspci | lspci -vv -s <bdf> | nvidia-smi topo -m | dmesg | mlxlink -d <dev> [-c]
  cat <file> | echo "K=V" >> /etc/nccl.conf | sed -i 's/old/new/' /etc/nccl.conf
  ping [-c N] [-M do] [-s size] [-I <if>] <ip>
  ib_write_bw -d <dev> [-x <gid>] [--report_gbits] <peer-host>[:<dev>]
  all_reduce_perf -b 8 -e 8G -f 2 -g 1    (also via mpirun ... all_reduce_perf ...)
  Pipes: | grep [-i -v -E -c] | head | tail | wc -l
Lab actions (physical work, simulated): replace-cable <switch> <port> | reseat-nic <node> <dev>`;

const HELP_IB = `Fabric Simulator - GPU node commands, InfiniBand variant (simulated; see the Help panel for details)
  ssh <host>                     node01-node04 (switches are queried in-band, not over SSH)
  hostname | exit | clear | history
  ibstat [-l] [<ca> [<port>]] | ibstatus [<ca>[:port]] | ibv_devinfo [-d <dev>] | ibdev2netdev | rdma link
  iblinkinfo [-C <ca>] [--switches-only|--cas-only|-d] | perfquery [-x] [-r] [-C <ca>] [<lid> [<port>]]
  ibqueryerrors [-s <Counter,...>] [-c]
  sminfo [-C <ca>] [<sm_lid>] | systemctl status|start|stop|restart|enable [--now]|disable|is-active|is-enabled opensm
  sleep <seconds>                (simulated time: a standby SM takes over about 50 s after the master dies)
  rdma statistic show link <dev>/1 | lspci [-vv -s <bdf>] | nvidia-smi topo -m | dmesg
  cat <file> | echo "K=V" >> /etc/nccl.conf | sed -i 's/old/new/' /etc/nccl.conf
  ib_write_bw -d <dev> [--report_gbits] <peer-host>[:<dev>]
  all_reduce_perf -b 8 -e 8G -f 2 -g 1    (also via mpirun ... all_reduce_perf ...)
  Pipes: | grep [-i -v -E -c] | head | tail | wc -l
Lab actions (physical work, simulated): replace-cable <switch> <port> | reseat-nic <node> <dev>`;

const HELP_SWITCH = `Fabric Simulator - switch commands (NVUE subset, simulated)
  nv show interface | nv show interface <swpN> | nv show interface <swpN> counters
  nv show qos roce | nv show interface <swpN> qos roce counters
  nv show qos congestion-control default-global [traffic-class <tc>]
  nv show qos pfc-watchdog | nv show interface <swpN> qos pfc-watchdog
  nv set interface <swpN> link mtu <n> | nv set interface <swpN> link state up|down
  nv set qos roce | nv set qos roce mode lossless|lossy | nv unset qos roce
  nv set qos congestion-control default-global traffic-class <tc> ecn enable|disable
  nv set|unset interface <swpN> qos pfc-watchdog | nv action clear interface <swpN> qos pfc-watchdog deadlock-count
  nv config diff | nv config apply [-y]
  hostname | exit | clear | ssh <host>
Lab actions (physical work, simulated): replace-cable <switch> <port>`;

function execOne(ctx: ShellCtx, stage: string): ExecResult {
  // Output redirection: echo "X=Y" >> file  /  echo "..." > file
  const redir = stage.match(/^(.*?)\s*(>>|>)\s*(\S+)$/);
  if (redir && /^echo\b/.test(redir[1])) return echoTo(ctx, redir[1], redir[2] === '>>', redir[3]);
  const t = tokenize(stage);
  const [cmd, ...args] = t;
  const s = ctx.state;
  const host = ctx.host;
  switch (cmd) {
    case 'help':
    case '?':
      return { out: (isSwitch(host) ? HELP_SWITCH : s.mode === 'ib' ? HELP_IB : HELP_HOST) + '\n' };
    case 'clear':
      return { out: '', clear: true };
    case 'sleep': {
      const sec = Number(args[0]);
      if (!(sec >= 0)) return { out: 'usage: sleep <seconds>\n' };
      s.clock = (s.clock ?? 0) + Math.min(sec, 86400);
      return { out: '', changed: true };
    }
    case 'hostname':
      return { out: `${host}\n` };
    case 'whoami':
      return { out: isSwitch(host) ? 'cumulus\n' : 'root\n' };
    case 'exit':
    case 'logout':
      return host === 'node01' ? { out: 'logout (already on the jump host node01)\n' } : { out: 'Connection closed.\n', host: 'node01' };
    case 'ssh': {
      const target = args.find((a) => !a.startsWith('-'))?.replace(/^.*@/, '');
      if (!target) return { out: 'usage: ssh <host>\n' };
      if (!NODES.includes(target as never) && !isSwitch(target)) return { out: `ssh: Could not resolve hostname ${target}: Name or service not known\n` };
      if (isSwitch(target) && s.switches[target].off) return { out: `ssh: connect to host ${target} port 22: No route to host\n(simulator: ${target} is powered off)\n` };
      if (isSwitch(target) && s.mode === 'ib') return { out: IB_SWITCH_NOTE(target) };
      return { out: isSwitch(target) ? `Welcome to NVIDIA Cumulus Linux (simulated)\n` : '', host: target };
    }
    case 'replace-cable': {
      const [sw, port] = args;
      // IB switch ports are numbered: "replace-cable leaf03 3" is the same port as swp3.
      const p = s.switches[sw]?.ports[/^\d+$/.test(port ?? '') ? `swp${port}` : port];
      if (!p) return { out: 'usage: replace-cable <switch> <port>   e.g. replace-cable leaf05 swp3\n' };
      // One cable, two ends: a switch-to-switch link is repaired on both ports. The link retrains (IB: back to INIT
      // until an SM configures it).
      const q = p.peer.kind === 'switch' ? s.switches[p.peer.sw].ports[p.peer.port] : null;
      for (const x of q ? [p, q] : [p]) {
        x.ber = 1e-15;
        x.cable = 'ok';
        x.lanes = 4;
      }
      unconfigure(s, linkKeys(sw, p));
      s.actions.push(`replace-cable ${sw} ${port}`);
      return { out: `[lab action] Field technician replaced the cable/transceiver on ${sw} ${port}. Link retrained.\n`, changed: true };
    }
    case 'reseat-nic': {
      const [node, dev] = args;
      const nic = s.hosts[node]?.nics.find((n) => n.dev === dev);
      if (!nic) return { out: 'usage: reseat-nic <node> <dev>   e.g. reseat-nic node04 mlx5_6\n' };
      nic.pcieWidth = 16;
      nic.pcieSpeed = 32;
      // A cold reset also clears a hung receive path; with the storm gone the watchdog restores the queue.
      if (nic.stalled) {
        nic.stalled = false;
        const lp = s.switches[LEAVES[nic.rail]].ports[leafPortFor(node)];
        if (lp.wd) lp.wd.status = lp.wd.status.map(() => 'OK');
      }
      s.actions.push(`reseat-nic ${node} ${dev}`);
      // The node rebooted: its HCA ports retrain and need an SM again.
      unconfigure(s, s.hosts[node].nics.map((n) => `${node}:${n.rail}`));
      s.hosts[node].dmesg = s.hosts[node].dmesg.filter((l) => !l.includes(nic.bdf));
      return { out: `[lab action] ${node} drained, powered off, ${dev} reseated, node rebooted and returned to service.\n`, changed: true };
    }
  }
  if (isSwitch(host)) return switchCmd(s.switches[host], t);
  return hostCmd(ctx, s.hosts[host], t);
}

function echoTo(ctx: ShellCtx, echoPart: string, append: boolean, file: string): ExecResult {
  if (isSwitch(ctx.host)) return { out: 'bash: permission denied (use NVUE)\n' };
  const text = tokenize(echoPart).slice(1).join(' ');
  const h = ctx.state.hosts[ctx.host];
  if (file !== '/etc/nccl.conf') return { out: `bash: ${file}: only /etc/nccl.conf is writable in the simulator\n` };
  const cur = h.files[file] ?? '';
  h.files[file] = append ? (cur.endsWith('\n') || !cur ? cur : cur + '\n') + text + '\n' : text + '\n';
  return { out: '', changed: true };
}

function findNic(h: Host, name?: string): Nic | undefined {
  if (!name) return undefined;
  const n = name.replace(/^0000:/, '');
  return h.nics.find((x) => x.netdev === n || x.dev === n || x.bdf === n);
}

function operUp(s: FabricState, node: string, nic: Nic) {
  // IB variant: the IPoIB netdev only gets carrier once the SM has made the port ACTIVE.
  if (s.mode === 'ib') return hcaView(s, node, nic).state === 'Active';
  const port = s.switches[LEAVES[nic.rail]].ports[leafPortFor(node)];
  return nic.admin && port.admin && port.cable === 'ok';
}

const IB_ONLY = new Set(['ibstat', 'ibstatus', 'iblinkinfo', 'perfquery', 'sminfo', 'ibqueryerrors', 'ibnetdiscover', 'ibdiagnet', 'opensm']);
const ROCE_ONLY = new Set(['ethtool', 'mlnx_qos', 'mlxlink', 'show_gids', 'ping']);

function hostCmd(ctx: ShellCtx, h: Host, t: string[]): ExecResult {
  const s = ctx.state;
  const [cmd, ...a] = t;
  const node = h.name;
  const ib = s.mode === 'ib';
  if (!ib && IB_ONLY.has(cmd))
    return { out: `${cmd}: this cluster runs RoCE (Ethernet link layer); infiniband-diags tools need an InfiniBand subnet. Use ibv_devinfo, rdma, ethtool and the switch CLI.\n` };
  if (ib && ROCE_ONLY.has(cmd))
    return { out: `${cmd}: not modelled in the InfiniBand variant of the simulator; use ibstat, iblinkinfo, perfquery and ibqueryerrors.\n` };
  switch (cmd) {
    case 'ibstat':
      return { out: ibstat(s, h, a) };
    case 'ibstatus':
      return { out: ibstatus(s, h, a) };
    case 'iblinkinfo':
      return { out: iblinkinfo(s, h, a) };
    case 'perfquery': {
      const out = perfquery(s, h, a);
      return { out, changed: a.includes('-r') };
    }
    case 'sminfo':
      return { out: sminfo(s, h, a) };
    case 'ibqueryerrors':
      return { out: ibqueryerrors(s, h, a) };
    case 'ibnetdiscover':
      return { out: 'ibnetdiscover: not modelled in the simulator; iblinkinfo shows the same discovered topology with link state.\n' };
    case 'ibdiagnet':
      return { out: 'ibdiagnet: not available in the simulator (it ships with NVIDIA MLNX_OFED/DOCA and UFM). Use the infiniband-diags tools: iblinkinfo, ibqueryerrors, perfquery, sminfo.\n' };
    case 'opensm':
      return { out: 'opensm: run it as a service here: systemctl status|start|enable opensm\n' };
    case 'systemctl':
      return systemctl(s, h, a);
    case 'history':
      return { out: '(history is shown with the up arrow)\n' };
    case 'cat': {
      const f = a[0];
      if (!f) return { out: 'usage: cat <file>\n' };
      if (h.files[f] !== undefined) return { out: h.files[f].endsWith('\n') ? h.files[f] : h.files[f] + '\n' };
      const m = f.match(/^\/sys\/class\/infiniband\/(mlx5_\d)\/ports\/1\/hw_counters\/(\w+)$/);
      if (m) {
        const nic = findNic(h, m[1]);
        if (nic && m[2] in nic.hw) return { out: `${nic.hw[m[2]]}\n` };
      }
      const m2 = f.match(/^\/sys\/class\/net\/(\w+)\/mtu$/);
      if (m2 && findNic(h, m2[1])) return { out: `${findNic(h, m2[1])!.mtu}\n` };
      return { out: `cat: ${f}: No such file or directory\n` };
    }
    case 'sed': {
      if (a[0] !== '-i' || a.length < 3) return { out: "usage: sed -i 's/old/new/' /etc/nccl.conf\n" };
      const expr = a[1];
      const file = a[2];
      const del = expr.match(/^\/(.+)\/d$/);
      if (del && h.files[file] !== undefined) {
        let re: RegExp;
        try {
          re = new RegExp(del[1]);
        } catch {
          return { out: 'sed: invalid regular expression\n' };
        }
        h.files[file] = h.files[file].split('\n').filter((l) => !re.test(l)).join('\n');
        return { out: '', changed: true };
      }
      const m = expr.match(/^s(.)(.*?)\1(.*?)\1(g?)$/);
      if (!m) return { out: `sed: -e expression #1: unknown command\n` };
      if (h.files[file] === undefined) return { out: `sed: can't read ${file}: No such file or directory\n` };
      let re: RegExp;
      try {
        re = new RegExp(m[2], m[4] ? 'gm' : 'm');
      } catch {
        return { out: 'sed: invalid regular expression\n' };
      }
      h.files[file] = h.files[file].replace(re, m[3].replace(/\\\//g, '/'));
      return { out: '', changed: true };
    }
    case 'ip':
      return ipCmd(s, h, a);
    case 'ibdev2netdev':
      return { out: h.nics.map((n) => `${n.dev} port 1 ==> ${n.netdev} (${operUp(s, node, n) ? 'Up' : 'Down'})`).join('\n') + '\n' };
    case 'ibv_devices':
      return { out: '    device          \t   node GUID\n    ------          \t----------------\n' + h.nics.map((n) => `    ${pad(n.dev, 16)}\t${guid(node, n.rail)}`).join('\n') + '\n' };
    case 'ibv_devinfo': {
      const di = a.indexOf('-d');
      const sel = di >= 0 ? h.nics.filter((n) => n.dev === a[di + 1]) : h.nics;
      if (di >= 0 && !sel.length) return { out: `IB device '${a[di + 1]}' wasn't found\n` };
      return { out: sel.map((n) => devinfo(s, node, n)).join('\n') };
    }
    case 'show_gids': {
      const sel = a[0] ? h.nics.filter((n) => n.dev === a[0]) : h.nics;
      let out = 'DEV\tPORT\tINDEX\tGID\t\t\t\t\tIPv4  \t\tVER\tDEV\n---\t----\t-----\t---\t\t\t\t\t------------  \t---\t---\n';
      for (const n of sel) {
        const ip = hostIp(node, n.rail);
        const hex = ip.split('.').map((o) => Number(o).toString(16).padStart(2, '0'));
        const v4 = `0000:0000:0000:0000:0000:ffff:${hex[0]}${hex[1]}:${hex[2]}${hex[3]}`;
        const ll = `fe80:0000:0000:0000:${guid(node, n.rail).replace(/(\w{4})(?=\w)/g, '$1:')}`;
        out += `${n.dev}\t1\t0\t${ll}\t\t\tv1\t${n.netdev}\n${n.dev}\t1\t1\t${ll}\t\t\tv2\t${n.netdev}\n`;
        out += `${n.dev}\t1\t2\t${v4}\t${ip}  \tv1\t${n.netdev}\n${n.dev}\t1\t3\t${v4}\t${ip}  \tv2\t${n.netdev}\n`;
      }
      return { out: out + `n_gids_found=${sel.length * 4}\n` };
    }
    case 'rdma': {
      if (a[0] === 'link' && ib) {
        const act = ibActive(s);
        return { out: h.nics.map((n) => {
          const v = hcaView(s, node, n, act);
          const st = { Down: 'DOWN', Initialize: 'INIT', Active: 'ACTIVE' }[v.state];
          const ph = { LinkUp: 'LINK_UP', Polling: 'POLLING', Disabled: 'DISABLED' }[v.phys];
          return `link ${n.dev}/1 subnet_prefix fe80:0000:0000:0000 lid ${v.lid} sm_lid ${v.state === 'Active' ? ibSmLid(s) : 0} lmc 0 state ${st} physical_state ${ph} `; // IB-mode rdma link prints no netdev
        }).join('\n') + '\n' };
      }
      if (a[0] === 'link') return { out: h.nics.map((n) => `link ${n.dev}/1 state ${operUp(s, node, n) ? 'ACTIVE' : 'DOWN'} physical_state ${operUp(s, node, n) ? 'LINK_UP' : 'DISABLED'} netdev ${n.netdev}`).join('\n') + '\n' };
      if (a[0] === 'statistic' || a[0] === 'stat') {
        const target = a.find((x) => x.includes('/')) ?? '';
        const nic = findNic(h, target.split('/')[0]);
        const sel = nic ? [nic] : h.nics;
        // iproute2 6.x prints one counter per indented line (older releases put them all on one line).
        return { out: sel.map((n) => `link ${n.dev}/1 \n` + Object.entries(n.hw).map(([k, v]) => `    ${k} ${v} `).join('\n')).join('\n') + '\n' };
      }
      return { out: 'usage: rdma link | rdma statistic show link <dev>/1\n' };
    }
    case 'ethtool':
      return ethtool(s, h, a);
    case 'mlnx_qos':
      return mlnxQos(h, a);
    case 'lspci':
      return lspci(h, a);
    case 'dmesg':
      return { out: (h.dmesg.length ? h.dmesg.join('\n') : '[Tue Oct 20 00:00:38 2026] mlx5_core 0000:18:00.0: firmware version: 28.43.1014') + '\n' };
    case 'nvidia-smi':
      if (a[0] === 'topo' && a[1] === '-m') return { out: topoMatrix() };
      return { out: 'nvidia-smi: the simulator supports "nvidia-smi topo -m" only\n' };
    case 'mlxlink':
      return mlxlink(s, h, a);
    case 'ping':
      return ping(s, h, a);
    case 'ib_write_bw':
      return ibWriteBw(s, h, a);
    case 'mpirun':
    case 'all_reduce_perf':
    case './all_reduce_perf':
    case './build/all_reduce_perf': {
      const i = t.findIndex((x) => /all_reduce_perf$/.test(x));
      if (i < 0) return { out: 'mpirun: the simulator only launches nccl-tests all_reduce_perf\n' };
      return allReducePerf(s, t.slice(i + 1));
    }
    case 'nccl-check':
      return { out: JSON.stringify(parseConf(h.files['/etc/nccl.conf'] ?? ''), null, 2) + '\n' };
    case 'checks':
      return { out: Object.keys(CHECKS).join('\n') + '\n' };
    case 'vi':
    case 'vim':
    case 'nano':
      return { out: `${cmd}: editors are not available in the simulator; use sed -i or echo >>\n` };
    case 'sudo':
      return hostCmd(ctx, h, a);
    default:
      return { out: `${cmd}: command not found (type "help")\n` };
  }
}

const guid = hcaGuid;

function ipCmd(s: FabricState, h: Host, a: string[]): ExecResult {
  const brief = a.includes('-br');
  const rest = a.filter((x) => x !== '-br' && x !== '-s' && x !== '-d');
  const obj = rest[0];
  if ((obj === 'link' || obj === 'l') && rest[1] === 'set') {
    const di = rest.indexOf('dev');
    const nic = findNic(h, di >= 0 ? rest[di + 1] : rest[2]);
    if (!nic) return { out: 'Cannot find device\n' };
    const mi = rest.indexOf('mtu');
    if (mi >= 0) {
      const mtu = Number(rest[mi + 1]);
      if (!(mtu >= 68 && mtu <= 9978)) return { out: `Error: mtu greater than device maximum.\n` };
      nic.mtu = mtu;
    }
    if (rest.includes('up')) nic.admin = true;
    if (rest.includes('down')) nic.admin = false;
    return { out: '', changed: true };
  }
  if (obj === 'link' || obj === 'l' || obj === 'addr' || obj === 'a' || obj === 'address') {
    const showAddr = obj !== 'link' && obj !== 'l';
    const want = rest[1] === 'show' ? rest[2] : rest[1];
    const nics = want ? h.nics.filter((n) => n.netdev === want) : h.nics;
    if (want && !nics.length && want !== 'eno1' && want !== 'lo') return { out: `Device "${want}" does not exist.\n` };
    const rows: string[] = [];
    if (!want || want === 'lo') rows.push(brief ? (showAddr ? 'lo               UNKNOWN        127.0.0.1/8 ::1/128' : 'lo               UNKNOWN        00:00:00:00:00:00 <LOOPBACK,UP,LOWER_UP>') : '1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN mode DEFAULT group default qlen 1000');
    if (!want || want === 'eno1') rows.push(brief ? (showAddr ? 'eno1             UP             172.20.0.' + (NODES.indexOf(h.name as never) + 11) + '/24' : 'eno1             UP             3c:ec:ef:10:00:0' + (NODES.indexOf(h.name as never) + 1) + ' <BROADCAST,MULTICAST,UP,LOWER_UP>') : `2: eno1: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc mq state UP mode DEFAULT group default qlen 1000`);
    nics.forEach((n, i) => {
      const up = operUp(s, h.name, n);
      const state = !n.admin ? 'DOWN' : up ? 'UP' : 'DOWN';
      const flags = n.admin ? (up ? '<BROADCAST,MULTICAST,UP,LOWER_UP>' : '<NO-CARRIER,BROADCAST,MULTICAST,UP>') : '<BROADCAST,MULTICAST>';
      const mac = `94:6d:ae:${(0x30 + n.rail).toString(16)}:0${NODES.indexOf(h.name as never)}:1${n.rail}`;
      if (brief) rows.push(`${pad(n.netdev, 17)}${pad(state, 15)}${showAddr ? `${hostIp(h.name, n.rail)}/31` : `${mac} ${flags}`}`);
      else {
        rows.push(`${i + 3}: ${n.netdev}: ${flags} mtu ${n.mtu} qdisc mq state ${state} mode DEFAULT group default qlen 1000`);
        rows.push(`    link/ether ${mac} brd ff:ff:ff:ff:ff:ff`);
        if (showAddr) rows.push(`    inet ${hostIp(h.name, n.rail)}/31 scope global ${n.netdev}`);
      }
    });
    return { out: rows.join('\n') + '\n' };
  }
  if (obj === 'route' || obj === 'r') {
    return { out: `default via 172.20.0.1 dev eno1 proto static\n10.0.0.0/8 proto bgp metric 20\n` + h.nics.map((n) => `\tnexthop via ${leafIp(h.name, n.rail)} dev ${n.netdev} weight 1`).join('\n') + '\n' + h.nics.map((n) => `${hostIp(h.name, n.rail).replace(/\.1$/, '.0')}/31 dev ${n.netdev} proto kernel scope link src ${hostIp(h.name, n.rail)}`).join('\n') + '\n' };
  }
  return { out: 'usage: ip -br link | ip -br addr | ip link show <if> | ip link set dev <if> mtu <n>|up|down | ip route\n' };
}

function devinfo(s: FabricState, node: string, n: Nic): string {
  const up = operUp(s, node, n);
  const am = s.mode === 'ib' ? 4096 : roceMtu(n.mtu);
  const code: Record<number, number> = { 256: 1, 512: 2, 1024: 3, 2048: 4, 4096: 5 };
  const v = s.mode === 'ib' ? hcaView(s, node, n) : null;
  const state = v ? { Down: 'PORT_DOWN (1)', Initialize: 'PORT_INIT (2)', Active: 'PORT_ACTIVE (4)' }[v.state] : up ? 'PORT_ACTIVE (4)' : 'PORT_DOWN (1)';
  return `hca_id:\t${n.dev}
\ttransport:\t\t\tInfiniBand (0)
\tfw_ver:\t\t\t\t28.43.1014
\tnode_guid:\t\t\t${guid(node, n.rail).replace(/(\w{4})(?=\w)/g, '$1:')}
\tsys_image_guid:\t\t\t${guid(node, n.rail).replace(/(\w{4})(?=\w)/g, '$1:')}
\tvendor_id:\t\t\t0x02c9
\tvendor_part_id:\t\t\t4129
\thw_ver:\t\t\t\t0x0
\tboard_id:\t\t\tSIM_0000000838
\tphys_port_cnt:\t\t\t1
\t\tport:\t1
\t\t\tstate:\t\t\t${state}
\t\t\tmax_mtu:\t\t4096 (5)
\t\t\tactive_mtu:\t\t${am} (${code[am]})
\t\t\tsm_lid:\t\t\t${v && v.state === 'Active' ? ibSmLid(s) : 0}
\t\t\tport_lid:\t\t${v ? v.lid : 0}
\t\t\tport_lmc:\t\t0x00
\t\t\tlink_layer:\t\t${v ? 'InfiniBand' : 'Ethernet'}
`;
}

function ethtool(s: FabricState, h: Host, a: string[]): ExecResult {
  const flag = a[0]?.startsWith('-') ? a[0] : null;
  const nic = findNic(h, flag ? a[1] : a[0]);
  if (!nic) return { out: `netlink error: no device matches name\n` };
  const port = s.switches[LEAVES[nic.rail]].ports[leafPortFor(h.name)];
  const up = operUp(s, h.name, nic);
  if (!flag) {
    return { out: `Settings for ${nic.netdev}:
\tSupported ports: [ FIBRE ]
\tSupported link modes:   400000baseCR4/Full 400000baseSR4/Full 400000baseDR4/Full
\tSupports auto-negotiation: Yes
\tAdvertised FEC modes: RS
\tSpeed: ${up ? '400000Mb/s' : 'Unknown!'}
\tLanes: 4
\tDuplex: ${up ? 'Full' : 'Unknown! (255)'}
\tAuto-negotiation: on
\tPort: FIBRE
\tLink detected: ${up ? 'yes' : 'no'}
` };
  }
  if (flag === '-S') {
    // mlx5 exposes rx/tx_prio<p>_pause* only for priorities with PFC enabled (kernel mlx5 counters.rst).
    const shown = Object.entries(nic.counters).filter(([k]) => {
      const m = k.match(/^[rt]x_prio(\d)_pause/);
      return !m || nic.pfc[Number(m[1])];
    });
    return { out: 'NIC statistics:\n' + shown.map(([k, v]) => `     ${k}: ${fmtNum(v)}`).join('\n') + '\n' };
  }
  if (flag === '-m') {
    const bad = port.ber > 1e-8;
    return { out: `\tIdentifier                                : 0x19 (OSFP 8X Pluggable Transceiver)
\tVendor name                               : SIMOPTICS
\tVendor PN                                 : SIM-OSFP-2x400G-DR4
\tModule temperature                        : ${bad ? '71.25 degrees C / 160.25' : '48.50 degrees C / 119.30'} degrees F
\tModule voltage                            : 3.2950 V
\tLaser tx bias current (Channel 1)         : 6.810 mA
\tRcvr signal avg optical power (Channel 1) : ${bad ? '0.0812 mW / -10.90 dBm' : '0.7943 mW / -1.00 dBm'}
\tRcvr signal avg optical power (Channel 2) : ${bad ? '0.6310 mW / -2.00 dBm' : '0.7762 mW / -1.10 dBm'}
\tRcvr signal avg optical power (Channel 3) : 0.8128 mW / -0.90 dBm
\tRcvr signal avg optical power (Channel 4) : 0.7586 mW / -1.20 dBm
\tLaser rx power low alarm threshold        : 0.0447 mW / -13.50 dBm
\tLaser rx power low warning threshold      : 0.1122 mW / -9.50 dBm
` };
  }
  if (flag === '-a' || flag === '--show-pause') return { out: `Pause parameters for ${nic.netdev}:\nAutonegotiate:\toff\nRX:\t\toff\nTX:\t\toff\n(simulator note: global 802.3x pause is off; PFC is configured per priority, see mlnx_qos)\n` };
  return { out: `ethtool: the simulator supports ethtool <if>, -S, -m, -a\n` };
}

function mlnxQos(h: Host, a: string[]): ExecResult {
  const ii = a.indexOf('-i');
  const nic = findNic(h, ii >= 0 ? a[ii + 1] : undefined);
  if (!nic) return { out: 'usage: mlnx_qos -i <interface> [--trust dscp|pcp] [--pfc 0,0,0,1,0,0,0,0]\n' };
  let changed = false;
  // Error texts and layout follow mlnx_qos from mlnx-tools 2604 (DOCA 3.4) on a ConnectX-5.
  const ti = a.findIndex((x) => x === '--trust' || x.startsWith('--trust='));
  if (ti >= 0) {
    const v = a[ti].includes('=') ? a[ti].split('=')[1] : a[ti + 1];
    if (v !== 'dscp' && v !== 'pcp') return { out: 'Invalid trust state command. Refer to the help.\n' };
    nic.trust = v;
    changed = true;
  }
  const pi = a.findIndex((x) => x === '--pfc' || x.startsWith('--pfc='));
  if (pi >= 0) {
    const v = a[pi].includes('=') ? a[pi].split('=')[1] : a[pi + 1];
    const bits = (v ?? '').split(',').map(Number);
    if (bits.length !== 8) return { out: 'pfc list must have 8 items\n' };
    if (bits.some((b) => b !== 0 && b !== 1)) return { out: '(simulator: each PFC value must be 0 or 1)\n' };
    nic.pfc = bits.map((b) => b === 1);
    changed = true;
  }
  const dscpRows = Array.from({ length: 8 }, (_, p) => `\tprio:${p} dscp:${Array.from({ length: 8 }, (_, j) => String(p * 8 + 7 - j).padStart(2, '0')).join(',')},`).join('\n');
  // The receive buffer is one 262016-byte pool until a lossless priority needs its own buffer.
  const lossless = nic.pfc.some(Boolean);
  const out = `DCBX mode: OS controlled
Priority trust state: ${nic.trust}
${nic.trust === 'dscp' ? `dscp2prio mapping:\n${dscpRows}\n` : ''}Receive buffer size (bytes): ${lossless ? '130944,130944' : '262016,0'},0,0,0,0,0,0,max_buffer_size=262016
Cable len: 7
PFC configuration:
\tpriority    0   1   2   3   4   5   6   7
\tenabled     ${nic.pfc.map((b) => (b ? 1 : 0)).join('   ')}${'   '}
\tbuffer      ${nic.pfc.map((b) => (b ? 1 : 0)).join('   ')}${'   '}
tc: 0 ratelimit: unlimited, tsa: vendor
\t priority:  1
tc: 1 ratelimit: unlimited, tsa: vendor
\t priority:  0
${[2, 3, 4, 5, 6, 7].map((p) => `tc: ${p} ratelimit: unlimited, tsa: vendor\n\t priority:  ${p}`).join('\n')}
`;
  return { out, changed };
}

function lspci(h: Host, a: string[]): ExecResult {
  const si = a.indexOf('-s');
  if (si < 0) {
    return { out: h.nics.map((n) => `${n.bdf} Ethernet controller: Mellanox Technologies MT2910 Family [ConnectX-7]`).join('\n') + '\n' +
      '1b:00.0 3D controller: NVIDIA Corporation Device 2330 (rev a1)\n(8 GPUs total; GPU lines trimmed)\n' };
  }
  const nic = findNic(h, a[si + 1]);
  if (!nic) return { out: '' };
  const down = nic.pcieWidth < 16 || nic.pcieSpeed < 32;
  return { out: `${nic.bdf} Ethernet controller: Mellanox Technologies MT2910 Family [ConnectX-7]
\tSubsystem: Mellanox Technologies Device 0026
\tNUMA node: ${nic.rail < 4 ? 0 : 1}
\tCapabilities: [60] Express (v2) Endpoint, MSI 00
\t\tLnkCap:\tPort #0, Speed 32GT/s, Width x16, ASPM not supported
\t\tLnkSta:\tSpeed ${nic.pcieSpeed}GT/s${nic.pcieSpeed < 32 ? ' (downgraded)' : ''}, Width x${nic.pcieWidth}${nic.pcieWidth < 16 ? ' (downgraded)' : ''}
\t\tLnkCtl2: Target Link Speed: 32GT/s
\tKernel driver in use: mlx5_core
${down ? '' : ''}` };
}

function topoMatrix(): string {
  const cols = [...Array.from({ length: 8 }, (_, i) => `GPU${i}`), ...Array.from({ length: 8 }, (_, i) => `NIC${i}`)];
  const rel = (a: number, b: number) => {
    if (a === b) return ' X ';
    const ga = a < 8, gb = b < 8;
    const ia = a % 8, ib = b % 8;
    if (ga && gb) return 'NV18';
    if (ia === ib) return 'PIX';
    return Math.floor(ia / 4) === Math.floor(ib / 4) ? 'NODE' : 'SYS';
  };
  let out = '        ' + cols.map((c) => pad(c, 6)).join('') + 'CPU Affinity    NUMA Affinity\n';
  for (let r = 0; r < 16; r++) {
    out += pad(cols[r], 8) + Array.from({ length: 16 }, (_, c) => pad(rel(r, c), 6)).join('') + (r < 8 ? (r < 4 ? '0-55,112-167    0' : '56-111,168-223  1') : '') + '\n';
  }
  out += '\nLegend:\n\n  X    = Self\n  SYS  = Connection traversing PCIe as well as the SMP interconnect between NUMA nodes (e.g., QPI/UPI)\n  NODE = Connection traversing PCIe as well as the interconnect between PCIe Host Bridges within a NUMA node\n  PHB  = Connection traversing PCIe as well as a PCIe Host Bridge (typically the CPU)\n  PXB  = Connection traversing multiple PCIe bridges (without traversing the PCIe Host Bridge)\n  PIX  = Connection traversing at most a single PCIe bridge\n  NV#  = Connection traversing a bonded set of # NVLinks\n\nNIC Legend:\n\n' + NETDEVS.map((_, i) => `  NIC${i}: mlx5_${i}`).join('\n') + '\n';
  return out;
}

function mlxlink(s: FabricState, h: Host, a: string[]): ExecResult {
  const di = a.indexOf('-d');
  const nic = findNic(h, di >= 0 ? a[di + 1] : undefined);
  if (!nic) return { out: 'usage: mlxlink -d <mlx5_N | bdf> [-c]\n' };
  const port = s.switches[LEAVES[nic.rail]].ports[leafPortFor(h.name)];
  const up = operUp(s, h.name, nic);
  const bad = port.ber > 1e-8;
  // A bad link sits above the ~2.4E-4 pre-FEC limit of RS(544,514), so FEC no longer corrects everything.
  const rawBer = bad ? '3E-04' : '2E-08';
  const effBer = bad ? '1E-09' : '15E-255';
  // Layout of MFT 4.3x mlxlink (labels padded to 35 columns), verified on a 100G ConnectX-5. For 400G, Speed uses
  // the extended-speed form (a published ConnectX-6 sample shows "200G") and FEC follows the verified 100G
  // pattern ("Standard RS-FEC - RS(528,514)"); neither 400G string has been captured on hardware yet.
  const f = (label: string, value: string | number) => `${pad(label, 35)}: ${value}`;
  return { out: `
Operational Info
----------------
${f('State', up ? 'Active' : 'Polling')}
${f('Physical state', up ? 'LinkUp' : 'ETH_AN_FSM_ENABLE')}
${f('Speed', up ? '400G' : 'N/A')}
${f('Width', up ? '4x' : 'N/A')}
${f('FEC', up ? 'Standard RS-FEC - RS(544,514)' : 'N/A')}
${f('Loopback Mode', 'No Loopback')}
${f('Auto Negotiation', 'ON')}

Supported Info
--------------
${f('Enabled Link Speed (Ext.)', '0x00010000 (400G_4X)')}

Troubleshooting Info
--------------------
${f('Status Opcode', 0)}
${f('Group Opcode', 'N/A')}
${f('Recommendation', 'No issue was observed')}

Tool Information
----------------
${f('Firmware Version', '28.43.1014')}

${a.includes('-c') ? `Physical Counters and BER Info
------------------------------
${f('Time Since Last Clear [Min]', '1440.0')}
${f('Effective Physical Errors', bad ? 34560112 : 0)}
${f('Raw Physical Errors Per Lane', bad ? '10365419021170,12884100220,10938714550,13120937610' : '173211552,169872310,174930118,172201845')}
${f('Effective Physical BER', effBer)}
${f('Raw Physical BER', rawBer)}
${f('Link Down Counter', nic.counters.link_down_events_phy)}
${f('Link Error Recovery Counter', bad ? 41 : 0)}
` : '(simulator: add -c for the BER counters)\n'}` };
}

function ping(s: FabricState, h: Host, a: string[]): ExecResult {
  let count = 3, size = 56, df = false, iface: string | undefined, target: string | undefined;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '-c') count = Math.min(10, Number(a[++i]) || 3);
    else if (a[i] === '-s') size = Number(a[++i]);
    else if (a[i] === '-M') df = a[++i] === 'do';
    else if (a[i] === '-I') iface = a[++i];
    else if (!a[i].startsWith('-')) target = a[i];
  }
  if (!target) return { out: 'usage: ping [-c N] [-M do] [-s size] [-I if] <ip>\n' };
  const m = target.match(/^10\.(\d)\.(\d)\.([01])$/);
  if (!m) return { out: `ping: ${target}: the simulator routes 10.<rail>.<node>.<0|1> fabric addresses only\n` };
  const rail = Number(m[1]);
  const dstNode = NODES[Number(m[2]) - 1];
  if (!dstNode || rail >= RAILS) return { out: `ping: connect: Network is unreachable\n` };
  const src = iface ? findNic(h, iface) : h.nics[rail];
  if (!src) return { out: `ping: SO_BINDTODEVICE ${iface}: No such device\n` };
  const toLeaf = m[3] === '0';
  const lines = [`PING ${target} (${target}) ${size}(${size + 28}) bytes of data.`];
  const ipLen = size + 28;
  const fail = (msg: string) => ({ out: lines.concat(msg.split('\n')).join('\n') + '\n' });
  // iputils: a DF packet larger than the local interface MTU fails in sendmsg(), once per attempt.
  if (df && ipLen > src.mtu) return fail(`${'ping: sendmsg: Message too long\n'.repeat(count)}\n--- ${target} ping statistics ---\n${count} packets transmitted, 0 received, +${count} errors, 100% packet loss, time ${count * 1000 - 1000}ms\n`);
  const issues = nicIssues(s, h.name, src.rail).filter((i) => i.fatal);
  const path = [s.switches[LEAVES[src.rail]].ports[leafPortFor(h.name)]];
  if (!toLeaf) {
    if (dstNode === h.name && rail === src.rail) return fail('(pinging your own address)');
    if (rail !== src.rail) {
      const pr = evaluatePair(s, h.name, src.rail, dstNode, rail);
      if (pr.error === 'no route to host') return fail(`From ${hostIp(h.name, src.rail)} icmp_seq=1 Destination Host Unreachable`);
    }
    path.push(s.switches[LEAVES[rail]].ports[leafPortFor(dstNode)]);
    issues.push(...nicIssues(s, dstNode, rail).filter((i) => i.fatal));
    const dn = s.hosts[dstNode].nics[rail];
    if (ipLen > dn.mtu) return fail(`\n--- ${target} ping statistics ---\n${count} packets transmitted, 0 received, 100% packet loss, time ${count * 1000 - 1000}ms`);
  }
  if (issues.length) return fail(`From ${hostIp(h.name, src.rail)} icmp_seq=1 Destination Host Unreachable\n\n--- ${target} ping statistics ---\n${count} packets transmitted, 0 received, +${count} errors, 100% packet loss`);
  const small = path.find((p) => ipLen > p.mtu);
  if (small) return fail(`\n--- ${target} ping statistics ---\n${count} packets transmitted, 0 received, 100% packet loss, time ${count * 1000 - 1000}ms`);
  for (let i = 1; i <= count; i++) lines.push(`${size + 8} bytes from ${target}: icmp_seq=${i} ttl=${toLeaf ? 64 : 63} time=0.0${(17 + i * 3) % 40 + 10} ms`);
  lines.push('', `--- ${target} ping statistics ---`, `${count} packets transmitted, ${count} received, 0% packet loss, time ${count * 1000 - 1000}ms`);
  return { out: lines.join('\n') + '\n' };
}

function ibWriteBw(s: FabricState, h: Host, a: string[]): ExecResult {
  let dev = 'mlx5_0', gid: number | null = null, qps = 1, gbits = false, peer: string | undefined, dur = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '-d') dev = a[++i];
    else if (a[i] === '-x') gid = Number(a[++i]);
    else if (a[i] === '-q') qps = Math.min(16, Number(a[++i]) || 1);
    else if (a[i] === '-D') dur = Number(a[++i]) || 0;
    else if (a[i] === '--report_gbits') gbits = true;
    else if (['-s', '-n', '-p', '-m', '-i', '-c'].includes(a[i])) i++;
    else if (!a[i].startsWith('-')) peer = a[i];
  }
  const nic = findNic(h, dev);
  if (!nic) return { out: `IB device ${dev} not found\n Unable to find the Infiniband/RoCE device\n` };
  const ib = s.mode === 'ib';
  if (ib) {
    // perftest checks the local port before anything else (perftest_parameters.c: set_link_layer).
    const v = hcaView(s, h.name, nic);
    if (v.state !== 'Active')
      return { out: ` Port number 1 state is ${v.state === 'Down' ? 'Down' : 'Init'}\n Couldn't set the link layer\n Couldn't get context for the device\n` };
  }
  if (!peer) return { out: `\n************************************\n* Waiting for client to connect... *\n************************************\n(simulator: run the client side instead, e.g. ib_write_bw -d mlx5_0 -x 3 --report_gbits node02)\n` };
  let [peerHost, peerDev] = peer.split(':');
  const ipm = peerHost.match(/^10\.(\d)\.(\d)\.1$/);
  let peerRail = nic.rail;
  if (ipm) {
    peerRail = Number(ipm[1]);
    peerHost = NODES[Number(ipm[2]) - 1];
  }
  if (peerDev) peerRail = Number(peerDev.replace('mlx5_', ''));
  const noServer = (to: string) => `Couldn't connect to ${to}:18515\nUnable to open file descriptor for socket connection\n Unable to init the socket connection\n`;
  if (!NODES.includes(peerHost as never)) return { out: noServer(peer) };
  if (peerHost === h.name && peerRail === nic.rail) return { out: 'Use a different host or device as the server.\n' };
  const g = gid ?? 3;
  const r = evaluatePair(s, h.name, nic.rail, peerHost, peerRail, g);
  const lidHex = (n: number) => `0x${n.toString(16).padStart(2, '0')}`;
  const gidOf = (host: string, rail: number) => ` GID: 00:00:00:00:00:00:00:00:00:00:255:255:${hostIp(host, rail).split('.').map((o) => o.padStart(2, '0')).join(':')}\n`;
  // One local and one remote address line per QP, like perftest; QPNs count up per QP.
  const qpLine = (side: 'local' | 'remote', q: number) => {
    const [host, rail, base] = side === 'local' ? [h.name, nic.rail, 0x127] : [peerHost, peerRail, 0x1a9];
    const lid = ib ? lidHex(ibHcaLid(s, host, rail)) : '0000';
    const qpn = `0x${(base + q).toString(16).padStart(4, '0')}`;
    const va = `0x007f${side === 'local' ? '3a5c4' : '91b86'}${(q * 16).toString(16).padStart(2, '0')}000`;
    return ` ${side} address: LID ${lid} QPN ${qpn} PSN 0x${((0x3a1f2c + q * 0x51f3d) & 0xffffff).toString(16)} RKey ${side === 'local' ? '0x1fd8bc' : '0x1fe0a4'} VAddr ${va}\n${ib ? '' : gidOf(host, rail)}`;
  };
  const addr = [...Array.from({ length: qps }, (_, q) => qpLine('local', q)), ...Array.from({ length: qps }, (_, q) => qpLine('remote', q))].join('');
  // Header layout of perftest 6.29 (DOCA 3.4); older perftest builds show "Using DDP" and no "CQE Poll Batch" / "NUMA node".
  const head = `${dur ? " WARNING: BW peak won't be measured in this run.\n" : ''}---------------------------------------------------------------------------------------
                    RDMA_Write BW Test
 Dual-port       : OFF\t\tDevice         : ${dev}
 Number of qps   : ${qps}\t\tTransport type : IB
 Connection type : RC\t\tUsing SRQ      : OFF
 PCIe relax order: ON\t\tLock-free      : OFF
 ibv_wr* API     : ON\t\tUsing Enhanced Reorder      : OFF
 TX depth        : 128
 CQ Moderation   : 1
 CQE Poll Batch  : Dynamic
 Mtu             : ${r.mtu}[B]
 Link type       : ${ib ? 'IB' : 'Ethernet'}
${ib ? '' : ` GID index       : ${g}\n`} Max inline data : 0[B]
 rdma_cm QPs\t : OFF
 Data ex. method : Ethernet
 NUMA node       : ${nic.rail < 4 ? 0 : 1}
---------------------------------------------------------------------------------------
${addr}---------------------------------------------------------------------------------------
`;
  const unit = gbits ? 'Gb/sec' : 'MiB/sec';
  const cols = ` #bytes     #iterations    BW peak[${unit}]    BW average[${unit}]   MsgRate[Mpps]\n`;
  if (!r.ok) {
    if (r.error === 'no route to host' || (r.error && r.error !== 'mtu' && r.error !== 'gid'))
      return { out: noServer(peerHost) + `(simulator: the RDMA path is down - ${r.error})\n` };
    nic.hw.local_ack_timeout_err += 7;
    return { out: head + cols + ` Completion with error at client\n Failed status-transport retry counter exceeded (12): wr_id 0 syndrom 0x81\n scnt=128, ccnt=0\n Failed to complete run_iter_bw function successfully\n`, changed: true };
  }
  accrueTraffic(s, 'pair', { nodes: [h.name, peerHost], rails: [...new Set([nic.rail, peerRail])] });
  const bw = r.gbps * (qps > 1 ? 1.002 : 1);
  const v = gbits ? bw : (bw * 1e9) / 8 / 1048576;
  const mpps = (bw * 1e9) / 8 / 65536 / 1e6;
  // perftest REPORT_FMT (" %-7lu    %-10lu       %-7.2lf            %-7.2lf\t\t     %-7.6lf", same as the
  // PerftestExplorer widget), checked against real output; -D runs do not measure the peak.
  const iters = dur ? Math.round(mpps * 1e6 * dur) : 5000;
  const peak = dur ? '0.00' : (v * 1.0006).toFixed(2);
  return {
    out: head + cols + ` ${pad(65536, 7)}    ${pad(iters, 10)}       ${pad(peak, 7)}            ${pad(v.toFixed(2), 7)}\t\t     ${mpps.toFixed(6)}\n---------------------------------------------------------------------------------------\n`,
    changed: true,
  };
}

function parseSize(v: string | undefined, d: number): number {
  if (!v) return d;
  const m = v.match(/^(\d+)([KMG]?)$/i);
  if (!m) return d;
  return Number(m[1]) * ({ '': 1, K: 1024, M: 1048576, G: 1073741824 } as Record<string, number>)[m[2].toUpperCase()];
}

function allReducePerf(s: FabricState, a: string[]): ExecResult {
  const get = (f: string) => {
    const i = a.indexOf(f);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const minB = parseSize(get('-b'), 8);
  const maxB = Math.min(parseSize(get('-e'), 8 * 2 ** 20), 16 * 2 ** 30);
  const factor = Math.max(2, Number(get('-f') ?? 2));
  const res = evaluateAllReduce(s);
  s.clock = (s.clock ?? 0) + 20;
  const debug = res.conf.NCCL_DEBUG === 'INFO';
  const ranks = 32;
  let out = `# nThread 1 nGpus 1 minBytes ${minB} maxBytes ${maxB} step: ${factor}(factor) warmup iters: 5 iters: 20 agg iters: 1 validation: 1 graph: 0\n#\n# Using devices\n`;
  for (let r = 0; r < ranks; r++) if (r < 2 || r === ranks - 1) out += `#  Rank ${lpad(r, 2)} Group  0 Pid ${41200 + r} on     ${NODES[Math.floor(r / 8)]} device  ${r % 8} [0x${(0x1b + (r % 8) * 0x20).toString(16)}] NVIDIA H100 80GB HBM3\n`;
    else if (r === 2) out += '#  ... (ranks 2-30 trimmed)\n';
  if (debug) {
    out += `node01:41200:41200 [0] NCCL INFO Bootstrap : Using eno1:172.20.0.11<0>\n`;
    if (res.transport === 'Socket') out += res.warnings.map((w) => `node01:41200:41200 [0] NCCL INFO ${w}\n`).join('') + `node01:41200:41200 [0] NCCL INFO NET/Socket : Using [0]eno1:172.20.0.11<0>\nnode01:41200:41200 [0] NCCL INFO Using network Socket\n`;
    else if (res.ok || res.rails.length) out += `node01:41200:41200 [0] NCCL INFO NET/IB : Using ${res.rails.map((r) => `[${r}]mlx5_${r}:1/${s.mode === 'ib' ? 'IB' : 'RoCE'}`).join(' ')} [RO]; OOB eno1:172.20.0.11<0>\nnode01:41200:41200 [0] NCCL INFO Using network IB\n`;
    out += `node01:41200:41207 [0] NCCL INFO Channel 00/${lpad(res.rails.length * 2 || 2, 2)} : 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31\n`;
    if (res.ok && res.transport === 'IB' && res.rails.length > 1) {
      // Where each ring enters and leaves node01. A ring enters on GPU c and leaves from the last GPU it
      // visits. Rail-aligned rings send on NIC c again (the same rail the next node receives on); with
      // NCCL_CROSS_NIC=1 the last GPU may use its own NIC, so the hop to the next node changes rail.
      // Rail-aligned sends from a GPU that is not next to NIC c go through PXN: NCCL's net.cc then logs
      // "NET/IB/<dev>(<proxy rank>)", the proxy being the local rank whose GPU sits next to that NIC.
      const rl = res.rails;
      for (const [i, c] of rl.slice(0, 4).entries()) {
        const last = rl[(i + rl.length - 1) % rl.length];
        const nicOut = res.crossRail || last === c ? `${last}` : `${c}(${c})`;
        const ch = String(i).padStart(2, '0');
        out += `node01:41200:${41230 + i} [${c}] NCCL INFO Channel ${ch}/0 : ${24 + last}[${last}] -> ${c}[${c}] [receive] via NET/IB/${c}/GDRDMA\n`;
        out += `node01:41200:${41230 + i} [${last}] NCCL INFO Channel ${ch}/0 : ${last}[${last}] -> ${8 + c}[${c}] [send] via NET/IB/${nicOut}/GDRDMA\n`;
      }
      out += `node01:41200:41207 [0] NCCL INFO (channel lines for the other channels trimmed)\n`;
    }
  }
  if (!res.ok) {
    accrueTraffic(s, 'collective', undefined, res);
    const who = res.errorNode ?? 'node01';
    const src = res.errorSrc === 'transport/net_ib.cc' ? 'transport/net_ib.cc:1696 ' : '';
    out += `\n${who}:41${who.slice(-1)}00:41${who.slice(-1)}12 [0] ${src}NCCL WARN ${res.error}\n${who}:41${who.slice(-1)}00:41${who.slice(-1)}12 [0] NCCL INFO transport/net.cc:1134 -> 6\n${who}: Test NCCL failure common.cu:1005 'remote process exited or there was a network error / '\n .. ${who} pid 41${who.slice(-1)}00: Test failure common.cu:891\n--------------------------------------------------------------------------\nPrimary job  terminated normally, but 1 process returned\na non-zero exit code.\n--------------------------------------------------------------------------\n`;
    return { out, changed: true };
  }
  accrueTraffic(s, 'collective', undefined, res);
  out += `#\n#                                                              out-of-place                       in-place          \n#       size         count      type   redop    root     time   algbw   busbw #wrong     time   algbw   busbw #wrong\n#        (B)    (elements)                               (us)  (GB/s)  (GB/s)            (us)  (GB/s)  (GB/s)       \n`;
  const peak = res.busbw;
  const busFactor = (2 * (ranks - 1)) / ranks;
  let sum = 0, n = 0;
  for (let size = minB; size <= maxB; size *= factor) {
    const lat = res.transport === 'Socket' ? 180 : 38;
    const t = lat + (size * busFactor) / (peak * 1e3);
    const algbw = size / (t * 1e3);
    const busbw = algbw * busFactor;
    const count = Math.max(1, Math.floor(size / 4));
    const row = (tt: number) => `${lpad(tt.toFixed(tt < 1000 ? 2 : 0), 9)} ${lpad(algbw.toFixed(2), 7)} ${lpad(busbw.toFixed(2), 7)} ${lpad(0, 6)}`;
    out += `${lpad(size, 12)} ${lpad(count, 13)} ${lpad('float', 9)} ${lpad('sum', 7)} ${lpad(-1, 7)} ${row(t)} ${row(t * 0.997)}\n`;
    sum += busbw;
    n++;
  }
  out += `# Out of bounds values : 0 OK\n# Avg bus bandwidth    : ${(sum / Math.max(1, n)).toFixed(4)} \n#\n`;
  if (maxB < 2 ** 30) out += `# (tip: peak bus bandwidth needs large messages; try -e 8G)\n`;
  return { out, changed: true };
}

// ---------------------------------------------------------------- switch (NVUE subset)

function switchCmd(sw: Switch, t: string[]): ExecResult {
  const [cmd, verb, ...rest] = t;
  if (cmd !== 'nv') {
    if (cmd === 'net') return { out: 'NCLU (net) was removed in Cumulus Linux 5.x; use NVUE (nv)\n' };
    if (cmd === 'sudo') return switchCmd(sw, t.slice(1));
    return { out: `${cmd}: command not found (type "help")\n` };
  }
  const cfg = sw.pending ?? sw.cfg;
  const stage = () => {
    if (!sw.pending) sw.pending = structuredClone(sw.cfg);
    return sw.pending;
  };
  if (verb === 'show') {
    if (rest[0] === 'interface' && !rest[1]) {
      let out = 'Interface  MTU   Speed  State  Remote Host  Remote Port  Type      Summary\n---------  ----  -----  -----  -----------  -----------  --------  -------\n';
      out += `eth0       1500  1G     up     oob-mgmt-sw  swp${10 + Number(sw.name.slice(-1))}        eth       IP Address: 192.168.200.${20 + Number(sw.name.slice(-1))}/24\nlo         65536        up                                loopback  IP Address: 10.255.0.${sw.role === 'leaf' ? Number(sw.name.slice(-2)) : 100 + Number(sw.name.slice(-2))}/32\n`;
      for (const p of Object.values(sw.ports)) {
        const up = p.admin && p.cable === 'ok';
        const [rh, rp] = p.peer.kind === 'host' ? [p.peer.node, NETDEVS[p.peer.rail]] : [p.peer.sw, p.peer.port];
        out += `${pad(p.name, 11)}${pad(p.mtu, 6)}${pad(up ? '400G' : '', 7)}${pad(up ? 'up' : 'down', 7)}${pad(up ? rh : '', 13)}${pad(up ? rp : '', 13)}swp       ${p.admin ? '' : 'Admin down'}\n`;
      }
      return { out };
    }
    if (rest[0] === 'interface' && rest[1]) {
      const p = sw.ports[rest[1]];
      if (!p) return { out: `Error: The requested item does not exist.\n` };
      const up = p.admin && p.cable === 'ok';
      if (rest[2] === 'qos' && rest[3] === 'pfc-watchdog') return { out: showPfcwd(sw, p) };
      if (rest[2] === 'qos' && rest[3] === 'roce' && rest[4] === 'counters') return { out: showRoceCounters(p) };
      if (rest[2] === 'qos') return { out: 'Supported: nv show interface <swpN> qos pfc-watchdog | nv show interface <swpN> qos roce counters\n' };
      if (rest[2] === 'counters') {
        const c = p.counters;
        return { out: `Statistic          Value\n-----------------  ------------\nRX packets         ${c.rx_packets}\nTX packets         ${c.tx_packets}\nRX errors          ${c.rx_errors}\nRX FCS/CRC errors  ${c.rx_crc}\nRX drops           ${c.rx_drops}\nTX drops           ${c.tx_drops}\nRX PFC pause       ${c.rx_pfc_pause}  (priority ${ROCE_PRIO})\nTX PFC pause       ${c.tx_pfc_pause}  (priority ${ROCE_PRIO})\nTX ECN marked      ${c.ecn_marked}\nCarrier transitions ${c.link_flaps * 2}\n` };
      }
      return { out: `                         operational  applied\n-----------------------  -----------  -------\ntype                     swp          swp\n[acl]\nlink\n  admin-status           ${p.admin ? 'up' : 'down'}           \n  oper-status            ${up ? 'up' : 'down'}\n  state                  ${up ? 'up' : 'down'}           ${sw.cfg.ports[p.name].admin ? 'up' : 'down'}\n  mtu                    ${p.mtu}         ${sw.cfg.ports[p.name].mtu}\n  speed                  ${up ? '400G' : ''}\n  fec                    rs\n  lanes                  4\n  carrier-transitions    ${p.counters.link_flaps * 2}\n  ${p.peer.kind === 'host' ? `lldp neighbor           ${up ? `${p.peer.node} ${NETDEVS[p.peer.rail]}` : ''}` : `lldp neighbor           ${up ? `${p.peer.sw} ${p.peer.port}` : ''}`}\n` };
    }
    if (rest[0] === 'qos' && rest[1] === 'pfc-watchdog') {
      return { out: `                  operational  applied\n----------------  -----------  --------------\npolling-interval               0:00:00.100000\nrobustness                     3\n` };
    }
    if (rest[0] === 'qos' && rest[1] === 'congestion-control') {
      if (rest[2] !== 'default-global') return { out: 'Supported: nv show qos congestion-control default-global [traffic-class <tc>]\n' };
      const off = sw.cfg.ecnOff ?? [];
      const tcs = [0, ROCE_PRIO];
      if (rest[3] === 'traffic-class' && rest[4]) {
        const tc = Number(rest[4]);
        if (!tcs.includes(tc)) return { out: `Error: The requested item does not exist.\n` };
        const e = off.includes(tc) ? 'disable' : 'enable';
        return { out: `               operational  applied    description
-------------  -----------  ---------  -----------------------------------
ecn            ${pad(e, 13)}${pad(e, 11)}Early Congestion Notification State
max-threshold  1500000 B    1500000 B  Maximum Threshold (in bytes)
min-threshold  150000 B     150000 B   Minimum Threshold (in bytes)
probability    100          100        Probability
red            disable      disable    Random Early Detection State
` };
      }
      return { out: `    operational  applied  description
--  -----------  -------  -----------

ECN Configurations
=====================
    traffic-class  ECN      RED      Min Th    Max Th     Probability
    -------------  -------  -------  --------  ---------  -----------
${tcs.map((tc) => `    ${pad(tc, 15)}${pad(off.includes(tc) ? 'disable' : 'enable', 9)}disable  150000 B  1500000 B  100`).join('\n')}
` };
    }
    if (rest[0] === 'qos' && rest[1] === 'roce') {
      const r = sw.cfg.roce;
      const ecnTcs = [0, ROCE_PRIO].filter((tc) => !(sw.cfg.ecnOff ?? []).includes(tc)).join(',') || '-';
      if (r === 'off') return { out: '                    operational  applied\n------------------  -----------  -------\nenable              off          off\n' };
      return { out: `                    operational  applied
------------------  -----------  --------
enable              on           on
mode                ${pad(r, 13)}${r}
cable-length        100          100
congestion-control
  congestion-mode   ECN          ECN
  enabled-tc        ${pad(ecnTcs, 13)}${ecnTcs}
  max-threshold     1.43 MB      1.43 MB
  min-threshold     146.48 KB    146.48 KB
  probability       100
lldp-app-tlv
  priority          3
  protocol-id       4791
  selector          UDP
pfc
  pfc-priority      ${r === 'lossless' ? '3' : '-'}            ${r === 'lossless' ? '3' : '-'}
  rx-enabled        ${r === 'lossless' ? 'enabled' : 'disabled'}
  tx-enabled        ${r === 'lossless' ? 'enabled' : 'disabled'}
trust
  trust-mode        pcp,dscp     pcp,dscp
RoCE PCP/DSCP->SP mapping configurations
  pcp  dscp                     switch-prio
  3    24,25,26,27,28,29,30,31  3
  6    48,49,50,51,52,53,54,55  6
RoCE SP->TC mapping and ETS configurations
  switch-prio  traffic-class  scheduler-weight
  3            3              DWRR-50%
  6            6              strict-priority
(values illustrative; check "nv show qos roce" on your release)
` };
    }
    return { out: 'Supported: nv show interface [<swpN> [counters | qos pfc-watchdog | qos roce counters]] | nv show qos roce | nv show qos pfc-watchdog | nv show qos congestion-control default-global\n' };
  }
  if (verb === 'action') {
    // nv action clear interface <swp> qos pfc-watchdog deadlock-count
    if (rest[0] === 'clear' && rest[1] === 'interface' && rest[3] === 'qos' && rest[4] === 'pfc-watchdog' && rest[5] === 'deadlock-count') {
      const p = sw.ports[rest[2]];
      if (!p) return { out: `Error: Invalid interface ${rest[2]}\n` };
      if (p.wd) p.wd.deadlocks = p.wd.deadlocks.map(() => 0);
      return { out: 'Action succeeded\n', changed: true };
    }
    return { out: 'Supported: nv action clear interface <swpN> qos pfc-watchdog deadlock-count\n' };
  }
  if (verb === 'set' || verb === 'unset') {
    if (rest[0] === 'qos' && rest[1] === 'congestion-control') {
      // nv set qos congestion-control default-global traffic-class <tc[,tc]> ecn enable|disable
      if (rest[2] !== 'default-global' || rest[3] !== 'traffic-class' || !rest[4] || rest[5] !== 'ecn')
        return { out: 'Supported: nv set|unset qos congestion-control default-global traffic-class <tc> ecn [enable|disable] (thresholds are not modelled)\n' };
      const tcs = rest[4].split(',').map(Number);
      if (tcs.some((x) => !(x >= 0 && x <= 7))) return { out: `Error: Invalid value for traffic-class: ${rest[4]}\n` };
      const v = verb === 'unset' ? 'enable' : rest[6];
      if (v !== 'enable' && v !== 'disable') return { out: `Error: Invalid value for ecn: ${rest[6] ?? ''} (enable, disable)\n` };
      const p = stage();
      const off = new Set(p.ecnOff ?? []);
      for (const x of tcs) {
        if (v === 'disable') off.add(x);
        else off.delete(x);
      }
      p.ecnOff = [...off].sort();
      return { out: '', changed: true };
    }
    if (rest[0] === 'interface' && rest[1] && rest[2] === 'qos' && rest[3] === 'pfc-watchdog') {
      const p = stage();
      const port = p.ports[rest[1]];
      if (!port) return { out: `Error: Invalid interface ${rest[1]}\n` };
      if (verb === 'unset') port.pfcwd = false;
      else if (rest[4] === 'state') {
        if (rest[5] !== 'enabled' && rest[5] !== 'disabled') return { out: `Error: Invalid value for state: ${rest[5] ?? ''} (enabled, disabled)\n` };
        port.pfcwd = rest[5] === 'enabled';
      } else port.pfcwd = true;
      return { out: '', changed: true };
    }
    if (rest[0] === 'qos' && rest[1] === 'roce') {
      const p = stage();
      if (verb === 'unset') p.roce = 'off';
      else if (rest[2] === 'mode') {
        if (rest[3] !== 'lossless' && rest[3] !== 'lossy') return { out: `Error: Invalid value for mode: ${rest[3] ?? ''}\n` };
        p.roce = rest[3];
      } else p.roce = 'lossless';
      return { out: '', changed: true };
    }
    if (rest[0] === 'interface' && rest[1] && rest[2] === 'link') {
      const p = stage();
      const port = p.ports[rest[1]];
      if (!port) return { out: `Error: Invalid interface ${rest[1]}\n` };
      if (rest[3] === 'mtu') {
        const v = Number(rest[4]);
        if (!(v >= 552 && v <= 9216)) return { out: `Error: Invalid value for mtu: ${rest[4] ?? ''} (552-9216)\n` };
        port.mtu = verb === 'unset' ? 9216 : v;
        return { out: '', changed: true };
      }
      if (rest[3] === 'state') {
        port.admin = verb === 'unset' ? true : rest[4] === 'up';
        return { out: '', changed: true };
      }
    }
    return { out: 'Supported: nv set|unset interface <swpN> link mtu <n> | link state up|down | qos pfc-watchdog; nv set|unset qos roce [mode lossless|lossy]; nv set qos congestion-control default-global traffic-class <tc> ecn enable|disable\n' };
  }
  if (verb === 'config') {
    if (rest[0] === 'diff') {
      if (!sw.pending) return { out: '' };
      const lines: string[] = [];
      const offOld = sw.cfg.ecnOff ?? [];
      const offNew = sw.pending.ecnOff ?? [];
      for (const tc of [...new Set([...offOld, ...offNew])].sort())
        if (offOld.includes(tc) !== offNew.includes(tc))
          lines.push(`- set:\n    qos:\n      congestion-control:\n        default-global:\n          traffic-class:\n            '${tc}':\n              ecn: ${offNew.includes(tc) ? 'disable' : 'enable'}`);
      if (sw.pending.roce !== sw.cfg.roce) lines.push(sw.pending.roce === 'off' ? `- unset:\n    qos:\n      roce: null` : `- set:\n    qos:\n      roce:\n        mode: ${sw.pending.roce}`);
      for (const [n, p] of Object.entries(sw.pending.ports)) {
        const o = sw.cfg.ports[n];
        if (p.mtu !== o.mtu) lines.push(`- set:\n    interface:\n      ${n}:\n        link:\n          mtu: ${p.mtu}`);
        if (p.admin !== o.admin) lines.push(`- set:\n    interface:\n      ${n}:\n        link:\n          state: ${p.admin ? 'up' : 'down'}`);
        if ((p.pfcwd !== false) !== (o.pfcwd !== false)) lines.push(`- set:\n    interface:\n      ${n}:\n        qos:\n          pfc-watchdog:\n            state: ${p.pfcwd !== false ? 'enabled' : 'disabled'}`);
      }
      return { out: lines.join('\n') + (lines.length ? '\n' : '') };
    }
    if (rest[0] === 'apply') {
      if (!sw.pending) return { out: 'Warning: there are no pending changes to apply\n' };
      sw.cfg = sw.pending;
      sw.pending = null;
      for (const [n, p] of Object.entries(sw.cfg.ports)) {
        sw.ports[n].mtu = p.mtu;
        sw.ports[n].admin = p.admin;
        sw.ports[n].pfcwd = p.pfcwd !== false;
      }
      return { out: 'applied [rev_id: 12]\n', changed: true };
    }
    return { out: 'Supported: nv config diff | nv config apply [-y]\n' };
  }
  void cfg;
  return { out: 'Supported verbs: nv show | nv set | nv unset | nv config (type "help")\n' };
}

function showPfcwd(sw: Switch, p: Port): string {
  const applied = sw.cfg.ports[p.name].pfcwd !== false ? 'enabled' : 'disabled';
  const oper = p.pfcwd !== false ? 'enabled' : 'disabled';
  let out = `                 operational  applied\n---------------  -----------  -------\nstate            ${pad(oper, 13)}${applied}\n`;
  if (p.pfcwd === false || !p.wd) return out;
  out += '\nPFC WD Status\n===========================\n    traffic-class  status    deadlock-count\n    -------------  --------  --------------\n\n';
  out += p.wd.status.map((st, tc) => `    ${pad(tc, 15)}${pad(st, 10)}${p.wd!.deadlocks[tc]}`).join('\n') + '\n';
  return out;
}

function showRoceCounters(p: Port): string {
  const c = p.counters;
  const row = (label: string, v: string | number, d: string) => `${pad(label, 31)}${pad(v, 23)}${d}`;
  return [
    '                               operational            description',
    '-----------------------------  ---------------------  ------------------------------------------',
    'rx-stats',
    '  rx-pfc-stats',
    row('    pause-packets', c.rx_pfc_pause, 'Rx PFC pause packets for RoCE traffic'),
    '  rx-roce-stats',
    row('    no-buffer-discard', 0, 'Rx buffer discards for RoCE traffic'),
    row('    roce-packets', c.rx_packets, 'Rx RoCE Packets'),
    'tx-stats',
    '  tx-cnp-stats',
    row('    cnp-packets', Math.round(c.ecn_marked * 0.97), 'Tx CNP Packets'),
    '  tx-ecn-stats',
    row('    ecn-marked-packets', c.ecn_marked, 'Tx ECN marked packets'),
    '  tx-pfc-stats',
    row('    pause-packets', c.tx_pfc_pause, 'Tx PFC pause packets for RoCE traffic'),
    '  tx-roce-stats',
    row('    roce-packets', c.tx_packets, 'Tx RoCE Packets'),
    row('    unicast-no-buffer-discard', c.tx_drops, 'Tx buffer discards for RoCE traffic'),
    '(subset of the fields; buffer-usage and pause-duration rows are not modelled)',
  ].join('\n') + '\n';
}

export const allHosts = [...NODES, ...LEAVES, ...SPINES];
