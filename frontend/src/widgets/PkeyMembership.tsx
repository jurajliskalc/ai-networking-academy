import { useMemo, useState, type ReactNode } from 'react';
import { Pill } from '../components/ui';

// ---------- Pure model (unit-testable) ----------
//
// Sources for the rules below:
// - IBTA InfiniBand Architecture Specification Vol. 1, partitioning (ch. 10.9) and BTH P_Key field: a P_Key
//   is 16 bits; bit 15 is the membership type (1 = full, 0 = limited), bits 14..0 the partition number.
//   Two keys match when their low 15 bits are equal and at least one of them is a full member; partition
//   number 0 (keys 0x0000 / 0x8000) is not a usable partition. Default partition 0x7FFF (0xFFFF full).
// - Academy lessons ib-architecture, multi-tenancy-isolation and ai-fabric-security (same rules, plus the
//   NVIDIA InfiniBand security guidance: end nodes limited in the default partition, switch enforcement).
// - OpenSM doc/partition-config.txt for the partitions.conf syntax rendered at the bottom:
//   "[PartitionName][=PKey][,ipoib_bc_flags][,defmember=full|limited|both] : <PortGUID>[=full|limited|both], ... ;"
//   with keywords ALL, ALL_CAS, ALL_SWITCHES, ALL_ROUTERS and SELF (the SM's own port); an omitted
//   membership means limited. Its documented example: "Default=0x7fff : ALL, SELF=full ;". The same document says the
//   default partition is created unconditionally and the SM's own port is always a full member of it.

export type Membership = 'full' | 'limited' | null;

export const FULL_BIT = 0x8000;
export const DEFAULT_PARTITION = 0x7fff;

export interface Partition { id: string; name: string; num: number }
export interface PortDef { id: string; label: string; role: string; guid: string; self?: boolean }

export const PARTITIONS: Partition[] = [
  { id: 'default', name: 'Default', num: DEFAULT_PARTITION },
  { id: 'tenant_a', name: 'tenant_a', num: 0x0101 }, // same numbers as the multi-tenancy-isolation lesson
  { id: 'tenant_b', name: 'tenant_b', num: 0x0102 },
  { id: 'storage', name: 'storage', num: 0x0200 },
];

// GUIDs are placeholders for the rendered config, not real vendor values.
export const PORTS: PortDef[] = [
  { id: 'A1', label: 'A1', role: 'Tenant A GPU node', guid: '0x00000000000a0001' },
  { id: 'A2', label: 'A2', role: 'Tenant A GPU node', guid: '0x00000000000a0002' },
  { id: 'B1', label: 'B1', role: 'Tenant B GPU node', guid: '0x00000000000b0001' },
  { id: 'B2', label: 'B2', role: 'Tenant B GPU node', guid: '0x00000000000b0002' },
  { id: 'STOR', label: 'Storage', role: 'Shared storage server', guid: '0x00000000000c0001' },
  { id: 'UFM', label: 'UFM', role: 'Management / UFM host', guid: '0x00000000000d0001' },
  { id: 'SM', label: 'SM', role: 'Subnet manager port', guid: '0x00000000000e0001', self: true },
];

/** Memberships: port id -> partition id -> membership. */
export type Assign = Record<string, Record<string, Membership>>;

export const pkeyValue = (num: number, m: Exclude<Membership, null>) => (m === 'full' ? FULL_BIT | num : num) & 0xffff;
export const partitionNumber = (pkey: number) => pkey & 0x7fff;
export const isFullMember = (pkey: number) => (pkey & FULL_BIT) !== 0;
export const hex4 = (v: number) => `0x${v.toString(16).padStart(4, '0')}`;

/** IBTA P_Key match: same partition number (not 0) and not both limited. */
export function pkeyMatch(a: number, b: number): boolean {
  const n = partitionNumber(a);
  if (n === 0 || n !== partitionNumber(b)) return false;
  return isFullMember(a) || isFullMember(b);
}

/** The P_Key table the SM would program for a port (order is the SM's choice; shown sorted). */
export function pkeyTable(assign: Assign, port: string, parts: Partition[] = PARTITIONS): number[] {
  const out: number[] = [];
  for (const p of parts) { const m = assign[port]?.[p.id]; if (m) out.push(pkeyValue(p.num, m)); }
  return out;
}

export interface TalkResult { ok: boolean; via: string[]; bothLimited: string[]; reason: string }

/** Can two ports exchange packets? Via every partition where both hold a key and at least one is full. */
export function canTalk(assign: Assign, a: string, b: string, parts: Partition[] = PARTITIONS): TalkResult {
  const via: string[] = [], bothLimited: string[] = [];
  for (const p of parts) {
    const ma = assign[a]?.[p.id], mb = assign[b]?.[p.id];
    if (!ma || !mb) continue;
    if (pkeyMatch(pkeyValue(p.num, ma), pkeyValue(p.num, mb))) via.push(p.name);
    else bothLimited.push(p.name);
  }
  const reason = via.length
    ? `can talk via ${via.map((n) => {
      const p = parts.find((q) => q.name === n)!; const ma = assign[a][p.id], mb = assign[b][p.id];
      return `${n} (${ma} + ${mb})`;
    }).join(', ')}`
    : bothLimited.length
      ? `cannot talk: both are limited members of ${bothLimited.join(' and ')}, and limited-limited never matches`
      : 'cannot talk: no partition in common';
  return { ok: via.length > 0, via, bothLimited, reason };
}

/**
 * A host whose owner has root forges a P_Key for a partition its port does not hold.
 * The target HCA accepts it if the forged key matches its own table (it cannot tell the key was forged);
 * a switch with inbound partition enforcement on the attacker's port drops it first.
 */
export function forgedDelivery(assign: Assign, attacker: string, target: string, part: Partition, switchEnforcement: boolean) {
  const forged = pkeyValue(part.num, 'full'); // the attacker sets the full bit: the value is visible in any captured packet
  const attackerHolds = pkeyTable(assign, attacker).some((k) => partitionNumber(k) === part.num);
  const targetAccepts = pkeyTable(assign, target).some((k) => pkeyMatch(k, forged));
  if (attackerHolds) {
    const own = pkeyTable(assign, attacker).find((k) => partitionNumber(k) === part.num)!;
    const legit = canTalk(assign, attacker, target).via.includes(part.name);
    const base = `${attacker} already holds ${part.name}, sends with its own key and the normal membership rule decides`;
    // OpenSM copies the end port's keys, membership bit included, to the switch port facing it (osm_pkey_mgr.c),
    // so a limited member that flips the full bit is a separate case; how the switch treats the bit is not modelled.
    const flip = !isFullMember(own) && !legit && targetAccepts
      ? `. Flipping the full bit (${hex4(forged)}) would be the real forgery here: ${target}'s HCA would accept it, and whether the switch port drops it depends on how its enforcement treats the membership bit (not modelled; check your switch and SM documentation)`
      : '';
    return { forged: own, delivered: legit, where: base + flip };
  }
  if (switchEnforcement) return { forged, delivered: false, where: `dropped by the leaf port facing ${attacker} (inbound partition enforcement; counted in PortRcvConstraintErrors)` };
  if (!targetAccepts) return { forged, delivered: false, where: `dropped by ${target}'s HCA: no ${part.name} key in its table` };
  return { forged, delivered: true, where: `accepted by ${target}'s HCA: the forged key matches its table, so isolation rests on the switch` };
}

/** Render an OpenSM partitions.conf (syntax per OpenSM doc/partition-config.txt). */
export function renderPartitionsConf(assign: Assign, ports: PortDef[] = PORTS, parts: Partition[] = PARTITIONS): string {
  const lines = ['# Illustrative OpenSM partitions.conf; GUIDs are placeholders'];
  for (const p of parts) {
    const members = ports.filter((o) => assign[o.id]?.[p.id]).map((o) => `${o.self ? 'SELF' : o.guid}=${assign[o.id][p.id]}`);
    if (!members.length) continue;
    lines.push(`${p.name}=${hex4(p.num)}, ipoib : ${members.join(', ')} ;`);
  }
  return lines.join('\n');
}

const fill = (rows: Record<string, Partial<Record<string, Membership>>>): Assign =>
  Object.fromEntries(PORTS.map((o) => [o.id, Object.fromEntries(PARTITIONS.map((p) => [p.id, rows[o.id]?.[p.id] ?? null]))]));

export const PRESETS: { id: string; label: string; note: string; assign: Assign }[] = [
  {
    id: 'flat', label: 'Out of the box',
    note: 'Every port a full member of the default partition (0xffff). Everything reaches everything: fine for one owner, no tenant isolation.',
    assign: fill(Object.fromEntries(PORTS.map((o) => [o.id, { default: 'full' }]))),
  },
  {
    id: 'tenants', label: 'Tenants, default limited',
    note: 'The pattern from the lessons: tenants full in their own partition and limited in Default; storage, UFM and the SM full in Default. Tenants reach shared services but not each other.',
    assign: fill({
      A1: { default: 'limited', tenant_a: 'full' }, A2: { default: 'limited', tenant_a: 'full' },
      B1: { default: 'limited', tenant_b: 'full' }, B2: { default: 'limited', tenant_b: 'full' },
      STOR: { default: 'full' }, UFM: { default: 'full' }, SM: { default: 'full' },
    }),
  },
  {
    id: 'storage', label: 'Storage partition',
    note: 'A dedicated storage partition: storage is the only full member, every tenant node is limited. Both tenants reach storage, but A and B cannot talk through it.',
    assign: fill({
      A1: { default: 'limited', tenant_a: 'full', storage: 'limited' }, A2: { default: 'limited', tenant_a: 'full', storage: 'limited' },
      B1: { default: 'limited', tenant_b: 'full', storage: 'limited' }, B2: { default: 'limited', tenant_b: 'full', storage: 'limited' },
      STOR: { default: 'limited', storage: 'full' }, UFM: { default: 'full' }, SM: { default: 'full' },
    }),
  },
  {
    id: 'mistake', label: 'Mistake: tenants full in storage',
    note: 'Same as before, but tenant nodes were made full members of the storage partition. Storage still works, and tenant A can now reach tenant B through it.',
    assign: fill({
      A1: { default: 'limited', tenant_a: 'full', storage: 'full' }, A2: { default: 'limited', tenant_a: 'full', storage: 'full' },
      B1: { default: 'limited', tenant_b: 'full', storage: 'full' }, B2: { default: 'limited', tenant_b: 'full', storage: 'full' },
      STOR: { default: 'limited', storage: 'full' }, UFM: { default: 'full' }, SM: { default: 'full' },
    }),
  },
];

/** Does any tenant-A port reach any tenant-B port? */
export function tenantsIsolated(assign: Assign): boolean {
  for (const a of ['A1', 'A2']) for (const b of ['B1', 'B2']) if (canTalk(assign, a, b).ok) return false;
  return true;
}

// ---------- UI ----------

const btn = (on: boolean) => `min-h-6 rounded-md border px-2 py-1 font-mono text-xs transition ${on ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-panel hover:bg-panel-2'}`;
const cap = 'font-mono text-[10px] uppercase tracking-[0.14em] text-muted';

function Out({ label, value, sub, tone = 'text-fg' }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string }) {
  return (
    <div className="rounded-lg border border-line bg-panel-2 px-3 py-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">{label}</div>
      <div className={`font-mono text-lg font-semibold ${tone}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted">{sub}</div>}
    </div>
  );
}

const memShort = (m: Membership) => (m === 'full' ? 'F' : m === 'limited' ? 'L' : '·');

export default function PkeyMembership() {
  const [preset, setPreset] = useState('tenants');
  const [assign, setAssign] = useState<Assign>(() => PRESETS[1].assign);
  const [sel, setSel] = useState<[string, string]>(['A1', 'B1']);
  const [enforce, setEnforce] = useState(true);
  const [attackPart, setAttackPart] = useState('tenant_a');

  const pairs = useMemo(() => {
    const out: Record<string, TalkResult> = {};
    for (const a of PORTS) for (const b of PORTS) if (a.id !== b.id) out[`${a.id}|${b.id}`] = canTalk(assign, a.id, b.id);
    return out;
  }, [assign]);

  const set = (port: string, part: string, m: Membership) => {
    setAssign((prev) => ({ ...prev, [port]: { ...prev[port], [part]: m } }));
    setPreset('custom');
  };
  const choose = (id: string) => { const p = PRESETS.find((x) => x.id === id)!; setAssign(p.assign); setPreset(id); };

  const talking = Object.entries(pairs).filter(([k, r]) => r.ok && k.split('|')[0] < k.split('|')[1]).length;
  const totalPairs = (PORTS.length * (PORTS.length - 1)) / 2;
  const isolated = tenantsIsolated(assign);
  const tenants = ['A1', 'A2', 'B1', 'B2'];
  const storageOk = tenants.every((t) => pairs[`${t}|STOR`].ok);
  const smOk = PORTS.filter((o) => o.id !== 'SM').every((o) => pairs[`${o.id}|SM`].ok);
  const selR = pairs[`${sel[0]}|${sel[1]}`];
  const presetNote = PRESETS.find((p) => p.id === preset)?.note ?? 'Custom assignment: change any cell and watch the matrix.';

  const part = PARTITIONS.find((p) => p.id === attackPart)!;
  const attack = forgedDelivery(assign, 'B1', 'A1', part, enforce);
  const attackerHolds = pkeyTable(assign, 'B1').some((k) => partitionNumber(k) === part.num);

  const portLabel = (id: string) => PORTS.find((o) => o.id === id)!.label;

  return (
    <div className="space-y-4">
      <div>
        <div className={`${cap} mb-1`}>Start from</div>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Preset partition designs">
          {PRESETS.map((p) => (
            <button key={p.id} type="button" aria-pressed={preset === p.id} onClick={() => choose(p.id)} className={btn(preset === p.id)}>{p.label}</button>
          ))}
        </div>
        <p className="mt-1.5 text-sm text-muted">{presetNote}</p>
      </div>

      <div className="grid gap-4 2xl:grid-cols-2 [&>*]:min-w-0">
        <div>
          <div className={`${cap} mb-1`}>Membership (what the SM writes into each port's P_Key table)</div>
          <div className="overflow-x-auto rounded-lg border border-line" tabIndex={0} role="region" aria-label="Partition membership per port">
            <table className="w-full text-left text-xs">
              <caption className="sr-only">Membership of each port in each partition: none, limited or full</caption>
              <thead className="bg-panel-2 text-muted">
                <tr>
                  <th scope="col" className="px-2 py-1 font-normal">Port</th>
                  {PARTITIONS.map((p) => <th key={p.id} scope="col" className="px-2 py-1 font-mono font-normal">{p.name}<div className="text-[10px]">{hex4(p.num)}</div></th>)}
                </tr>
              </thead>
              <tbody>
                {PORTS.map((o) => (
                  <tr key={o.id} className="border-t border-line">
                    <th scope="row" className="px-2 py-1 font-normal"><span className="font-mono text-fg">{o.label}</span><div className="text-[10px] text-muted">{o.role}</div></th>
                    {PARTITIONS.map((p) => {
                      const m = assign[o.id][p.id];
                      const locked = !!o.self && p.id === 'default'; // OpenSM always makes its own port a full member of Default
                      return (
                        <td key={p.id} className="px-1.5 py-1">
                          <select aria-label={`${o.label} membership in ${p.name}${locked ? ' (fixed: OpenSM keeps its own port full in Default)' : ''}`} value={m ?? 'none'} disabled={locked}
                            onChange={(e) => set(o.id, p.id, e.target.value === 'none' ? null : (e.target.value as Membership))}
                            className={`min-h-6 w-full min-w-[5.5rem] rounded-md border bg-panel px-1 py-0.5 font-mono text-xs ${m === 'full' ? 'border-accent text-accent' : m === 'limited' ? 'border-data text-data' : 'border-line text-muted'}`}>
                            <option value="none">none</option>
                            <option value="limited">limited</option>
                            <option value="full">full</option>
                          </select>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <div className={`${cap} mb-1`}>Who can talk (select a cell for the reason)</div>
          <div className="overflow-x-auto rounded-lg border border-line" tabIndex={0} role="region" aria-label="Can-talk matrix">
            <table className="w-full text-center text-xs">
              <caption className="sr-only">Whether each pair of ports can exchange packets; ✓ can talk, ✗ cannot</caption>
              <thead className="bg-panel-2 text-muted">
                <tr><td className="px-1 py-1" />{PORTS.map((o) => <th key={o.id} scope="col" className="px-1 py-1 font-mono font-normal">{o.label}</th>)}</tr>
              </thead>
              <tbody>
                {PORTS.map((a) => (
                  <tr key={a.id} className="border-t border-line">
                    <th scope="row" className="px-1.5 py-0.5 text-left font-mono font-normal text-muted">{a.label}</th>
                    {PORTS.map((b) => {
                      if (a.id === b.id) return <td key={b.id} className="px-0.5 py-0.5 text-muted" aria-label="same port">—</td>;
                      const r = pairs[`${a.id}|${b.id}`];
                      const on = (sel[0] === a.id && sel[1] === b.id) || (sel[0] === b.id && sel[1] === a.id);
                      return (
                        <td key={b.id} className="px-0.5 py-0.5">
                          <button type="button" onClick={() => setSel([a.id, b.id])} aria-pressed={on}
                            className={`relative h-7 w-full min-w-7 rounded border font-mono text-sm ${on ? 'border-fg' : 'border-transparent'} ${r.ok ? 'bg-accent-soft text-accent' : r.bothLimited.length ? 'bg-panel-2 text-warn' : 'bg-panel-2 text-muted'}`}>
                            <span aria-hidden>{r.ok ? '✓' : r.bothLimited.length ? <>✗<span className="text-[9px]">L</span></> : '✗'}</span>
                            <span className="sr-only">{`${a.label} and ${b.label}: ${r.ok ? 'can talk' : r.bothLimited.length ? 'cannot talk, both limited' : 'cannot talk'}`}</span>
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1 text-[11px] text-muted">✓ can talk · ✗ no common partition · ✗L share a partition but both are limited</p>
        </div>
      </div>

      <div aria-live="polite" className="space-y-2">
        <div className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm">
          <span className="font-mono font-semibold text-fg">{portLabel(sel[0])} ↔ {portLabel(sel[1])}</span>
          <span className={selR.ok ? 'text-accent' : 'text-warn'}> {selR.ok ? '✓' : '✗'} </span>
          <span className="text-muted">{selR.reason}.</span>
          <div className="mt-1 font-mono text-[11px] text-muted">
            P_Key tables: {portLabel(sel[0])} [{pkeyTable(assign, sel[0]).map(hex4).join(', ') || 'empty'}] · {portLabel(sel[1])} [{pkeyTable(assign, sel[1]).map(hex4).join(', ') || 'empty'}]
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Out label="Pairs that can talk" value={`${talking} / ${totalPairs}`} />
          <Out label="Tenant A ↔ B" value={isolated ? 'isolated' : 'reachable'} tone={isolated ? 'text-accent' : 'text-danger'} sub={isolated ? 'no A-B pair matches' : 'a partition joins them'} />
          <Out label="Tenants → storage" value={storageOk ? 'all reach it' : 'blocked'} tone={storageOk ? 'text-accent' : 'text-warn'} sub="A1, A2, B1, B2" />
          <Out label="Every port → SM" value={smOk ? 'yes' : 'no'} tone={smOk ? 'text-accent' : 'text-warn'} sub={smOk ? 'SM full in a shared partition' : 'keep the SM full in Default'} />
        </div>
      </div>

      <div className="rounded-lg border border-line bg-panel p-3">
        <div className={`${cap} mb-2`}>A tenant with root forges a P_Key</div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-muted">
            <span className="mb-1 block">B1 sends to A1 with the key of</span>
            <select value={attackPart} onChange={(e) => setAttackPart(e.target.value)} className="min-h-6 rounded-md border border-line bg-panel px-2 py-1 font-mono text-xs text-fg">
              {PARTITIONS.map((p) => {
                const own = pkeyTable(assign, 'B1').find((k) => partitionNumber(k) === p.num);
                return <option key={p.id} value={p.id}>{p.name} ({own === undefined ? `forged ${hex4(pkeyValue(p.num, 'full'))}` : `own key ${hex4(own)}`})</option>;
              })}
            </select>
          </label>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Switch partition enforcement on host-facing ports">
            {([true, false] as const).map((v) => (
              <button key={String(v)} type="button" aria-pressed={enforce === v} onClick={() => setEnforce(v)} className={btn(enforce === v)}>
                {v ? 'switch enforcement on' : 'HCA checks only'}
              </button>
            ))}
          </div>
        </div>
        <p className="mt-2 text-sm" aria-live="polite">
          <span className={`font-mono font-semibold ${attack.delivered ? (attackerHolds ? 'text-accent' : 'text-danger') : 'text-accent'}`}>{attack.delivered ? 'delivered' : 'blocked'}</span>
          <span className="text-muted">: packet P_Key {hex4(attack.forged)}{attackerHolds ? '' : ' (forged, full bit set)'}, {attack.where}.</span>
        </p>
        <p className="mt-1 text-[12px] text-muted">
          The key is not a secret: it travels in clear text in every packet's BTH, so anyone who sees one packet knows it. Isolation holds because the SM
          alone programs the P_Key tables (guarded by M_Key, SM_Key and blocked SMPs on hosts) and because the switch port facing a host drops
          partitions that host was not given. A receiving HCA cannot tell a forged key from a real one.
        </p>
      </div>

      <div>
        <div className={`${cap} mb-1`}>The same design as an OpenSM partitions.conf (illustrative)</div>
        <pre className="overflow-x-auto rounded-lg border border-line bg-panel-2 p-2 font-mono text-[11px] leading-relaxed text-fg" tabIndex={0} aria-label="Rendered partitions.conf">{renderPartitionsConf(assign)}</pre>
        <div className="mt-1 flex flex-wrap gap-2">
          {PORTS.map((o) => <Pill key={o.id}><span className="font-mono">{o.label}: {PARTITIONS.map((p) => memShort(assign[o.id][p.id])).join('')}</span></Pill>)}
        </div>
        <p className="mt-1 text-[11px] text-muted">Pills: membership in {PARTITIONS.map((p) => p.name).join(' / ')} (F full, L limited, · none). SELF is OpenSM's keyword for its own port; OpenSM creates the Default partition unconditionally and always keeps its own port a full member of it, so that cell is fixed.</p>
      </div>

      <div className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm text-muted">
        <span className="font-semibold text-fg">Ethernet analogue:</span> RoCE fabrics have no P_Keys; tenants get a VRF and an L3 VNI each (VXLAN/EVPN), with the
        VTEP on the leaf or on a DPU the tenant cannot configure. A shared service is reached by leaking its routes into each tenant VRF, the
        routed cousin of "storage full, tenants limited".
      </div>

      <p className="text-[11px] leading-relaxed text-muted">
        Model: one port per host, four fixed partitions, the IBTA matching rule (same 15-bit partition number, not both limited). Real P_Key tables have
        a size limit per HCA and an index order chosen by the SM; OpenSM also offers a "both" membership that this widget leaves out. Switch
        (inbound) partition enforcement is configured by the SM and its support and defaults depend on the switch and SM version, so check your
        UFM/OpenSM documentation. Partitions control reachability only: two partitions still share links, queues and buffers.
      </p>
    </div>
  );
}
