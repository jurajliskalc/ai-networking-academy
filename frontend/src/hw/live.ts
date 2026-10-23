// Live lab-port counters from `aina-hw serve` (/api/live, "aina.hw.live/1") and the rates the Live view
// shows. Pure functions, unit-tested; the same rate table as aina_hw.rate_spec / live_rates.

export const LIVE_SCHEMA = 'aina.hw.live/1';

export interface LivePort {
  dev: string; port: number; netdev: string | null; state: string | null; phys_state: string | null;
  rate_gbps: number | null; link_layer: string | null; operstate: string | null; counters: Record<string, number>;
}
export interface LiveSnapshot { schema: string; host: string; role: string | null; t: number; prio: number; ports: LivePort[] }
export interface LiveHost { role: string; ok: boolean; error: string | null; snapshot: LiveSnapshot | null }
export interface LiveResponse { schema: string; generated: string; prio: number; remote: boolean; hosts: LiveHost[] }

export function parseLive(json: unknown): LiveResponse {
  if (!json || typeof json !== 'object') throw new Error('Not a JSON object');
  const o = json as Record<string, unknown>;
  if (o.schema !== LIVE_SCHEMA || !Array.isArray(o.hosts)) throw new Error('That is not an aina-hw live response (upgrade the toolkit on host A).');
  const hosts = (o.hosts as LiveHost[]).filter((h) => h && typeof h.role === 'string').map((h): LiveHost => {
    const s = h.snapshot;
    const ok = !!s && s.schema === LIVE_SCHEMA && typeof s.t === 'number' && Array.isArray(s.ports);
    return { role: h.role, ok: !!h.ok && ok, error: typeof h.error === 'string' ? h.error : null, snapshot: ok ? s : null };
  });
  return { schema: LIVE_SCHEMA, generated: String(o.generated ?? ''), prio: Number.isInteger(o.prio) ? (o.prio as number) : 3, remote: !!o.remote, hosts };
}

const gbps = (d: number, dt: number) => (d * 8) / dt / 1e9;
const perS = (d: number, dt: number) => d / dt;

export const RATE_NAMES = ['rdma_rx_gbps', 'rdma_tx_gbps', 'prio_rx_gbps', 'prio_tx_gbps', 'pfc_rx_ps', 'pfc_tx_ps', 'global_pause_rx_ps', 'global_pause_tx_ps',
  'discards_ps', 'cnp_sent_ps', 'cnp_handled_ps', 'ecn_marked_ps', 'oos_ps', 'seq_err_ps', 'ack_timeout_ps', 'netdev_rx_gbps', 'netdev_tx_gbps', 'ib_tx_gbps', 'ib_rx_gbps'] as const;
export type RateName = (typeof RATE_NAMES)[number];
export type Rates = Record<RateName, number | null>;

/** name -> [counter key, scale]. Mirrors aina_hw.rate_spec. */
export function rateSpec(prio: number): [RateName, string, (d: number, dt: number) => number][] {
  return [
    ['rdma_rx_gbps', 'rx_vport_rdma_unicast_bytes', gbps], ['rdma_tx_gbps', 'tx_vport_rdma_unicast_bytes', gbps],
    ['prio_rx_gbps', `rx_prio${prio}_bytes`, gbps], ['prio_tx_gbps', `tx_prio${prio}_bytes`, gbps],
    ['pfc_rx_ps', `rx_prio${prio}_pause`, perS], ['pfc_tx_ps', `tx_prio${prio}_pause`, perS],
    ['global_pause_rx_ps', 'rx_global_pause', perS], ['global_pause_tx_ps', 'tx_global_pause', perS],
    ['discards_ps', 'rx_discards_phy', perS], ['cnp_sent_ps', 'np_cnp_sent', perS], ['cnp_handled_ps', 'rp_cnp_handled', perS],
    ['ecn_marked_ps', 'np_ecn_marked_roce_packets', perS], ['oos_ps', 'out_of_sequence', perS], ['seq_err_ps', 'packet_seq_err', perS],
    ['ack_timeout_ps', 'local_ack_timeout_err', perS], ['netdev_rx_gbps', 'netdev_rx_bytes', gbps], ['netdev_tx_gbps', 'netdev_tx_bytes', gbps],
    // InfiniBand port_xmit_data / port_rcv_data count 4-octet words
    ['ib_tx_gbps', 'port_xmit_data', (d, dt) => gbps(d * 4, dt)], ['ib_rx_gbps', 'port_rcv_data', (d, dt) => gbps(d * 4, dt)],
  ];
}

export const portKey = (p: { dev: string; port: number }) => `${p.dev}/${p.port}`;

/** Rates between two snapshots of the same host. A counter missing on either side or going backwards
 *  (reset, driver reload) gives null, never a negative rate; so does a non-positive time step. */
export function liveRates(prev: LiveSnapshot | null, cur: LiveSnapshot | null): Map<string, Rates> {
  const out = new Map<string, Rates>();
  if (!prev || !cur || prev.host !== cur.host) return out;
  const dt = cur.t - prev.t;
  const before = new Map(prev.ports.map((p) => [portKey(p), p]));
  for (const p of cur.ports) {
    const b = before.get(portKey(p));
    const r = {} as Rates;
    for (const [name, k, scale] of rateSpec(cur.prio ?? 3)) {
      const v0 = b?.counters[k], v1 = p.counters[k];
      r[name] = b && dt > 0 && typeof v0 === 'number' && typeof v1 === 'number' && v1 >= v0 ? scale(v1 - v0, dt) : null;
    }
    out.set(portKey(p), r);
  }
  return out;
}

export interface Sample { t: number; r: Rates }
export interface LiveState {
  /** Last snapshot per role, to difference the next one against. */
  prev: Record<string, LiveSnapshot>;
  /** Rate history per `${role} ${dev}/${port}`, oldest first, at most `max` samples. */
  history: Record<string, Sample[]>;
  /** Latest port facts per history key. */
  ports: Record<string, { role: string; host: string; port: LivePort }>;
  hosts: LiveHost[];
  remote: boolean;
  prio: number;
}
export const emptyLive = (): LiveState => ({ prev: {}, history: {}, ports: {}, hosts: [], remote: false, prio: 3 });

/** Fold one /api/live response into the state. A remote host sampled less often than the browser polls
 *  returns the same snapshot twice: that adds no sample (it would be a zero-length interval). */
export function advance(s: LiveState, res: LiveResponse, max = 60): LiveState {
  const prev = { ...s.prev };
  const history = { ...s.history };
  const ports = { ...s.ports };
  for (const h of res.hosts) {
    const snap = h.snapshot;
    if (!snap) continue;
    for (const p of snap.ports) ports[`${h.role} ${portKey(p)}`] = { role: h.role, host: snap.host, port: p };
    const old = prev[h.role];
    if (old && old.t === snap.t && old.host === snap.host) continue;
    for (const [k, r] of liveRates(old ?? null, snap)) {
      const key = `${h.role} ${k}`;
      history[key] = [...(history[key] ?? []), { t: snap.t, r }].slice(-max);
    }
    prev[h.role] = snap;
  }
  return { prev, history, ports, hosts: res.hosts, remote: res.remote, prio: res.prio };
}

export const latest = (h: Sample[] | undefined, name: RateName): number | null => {
  for (let i = (h?.length ?? 0) - 1; i >= 0; i--) if (h![i].r[name] !== null) return h![i].r[name];
  return null;
};

/** Pauses/s for one direction: per-priority PFC when the NIC exposes it (PFC on), else 802.3x global pause. */
export function pauseRate(r: Rates, dir: 'rx' | 'tx'): { value: number | null; kind: 'pfc' | 'global' | null } {
  const pfc = r[`pfc_${dir}_ps`], gl = r[`global_pause_${dir}_ps`];
  if (pfc !== null) return { value: pfc, kind: 'pfc' };
  if (gl !== null) return { value: gl, kind: 'global' };
  return { value: null, kind: null };
}

/** Compact, human formatting: 81.2 Gb/s, 0.11 Gb/s, 1.8k/s. */
export function fmtRate(v: number | null, unit: 'gbps' | 'ps'): string {
  if (v === null || !Number.isFinite(v)) return 'n/a';
  if (unit === 'gbps') return `${v >= 10 ? v.toFixed(1) : v >= 0.01 || v === 0 ? v.toFixed(2) : '<0.01'} Gb/s`;
  if (v === 0) return '0/s';
  if (v >= 10000) return `${(v / 1000).toFixed(0)}k/s`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k/s`;
  return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)}/s`;
}

export interface Flags { traffic: boolean; pause: boolean; cnp: boolean; oos: boolean }
export function flagsOf(r: Rates | undefined): Flags {
  if (!r) return { traffic: false, pause: false, cnp: false, oos: false };
  const pr = pauseRate(r, 'rx').value ?? 0, pt = pauseRate(r, 'tx').value ?? 0;
  return {
    traffic: (r.rdma_tx_gbps ?? 0) + (r.rdma_rx_gbps ?? 0) + (r.ib_tx_gbps ?? 0) + (r.ib_rx_gbps ?? 0) >= 1,
    pause: pr + pt > 0, cnp: (r.cnp_sent_ps ?? 0) + (r.cnp_handled_ps ?? 0) > 0, oos: (r.oos_ps ?? 0) + (r.seq_err_ps ?? 0) > 0,
  };
}

/** A short sentence for screen readers about what changed, or null when nothing notable changed.
 *  The Live view announces only these transitions, never every number. */
export function describeChange(label: string, before: Flags, now: Flags): string | null {
  const parts: string[] = [];
  if (now.traffic !== before.traffic) parts.push(now.traffic ? 'traffic started' : 'traffic stopped');
  if (now.pause !== before.pause) parts.push(now.pause ? 'pause frames started' : 'pause frames stopped');
  if (now.cnp !== before.cnp) parts.push(now.cnp ? 'CNPs started' : 'CNPs stopped');
  if (now.oos !== before.oos) parts.push(now.oos ? 'out-of-sequence packets seen' : 'no more out-of-sequence packets');
  return parts.length ? `${label}: ${parts.join(', ')}.` : null;
}
