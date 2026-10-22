import { useState, type ReactNode } from 'react';
import { Pill } from '../components/ui';

// ---------- Pure calculation (unit-testable) ----------

export type L3 = 'ipv4' | 'ipv6' | 'rocev1';
export type L4 = 'udp' | 'tcp';
export type Layer = 'l1' | 'l2' | 'l3' | 'l4' | 'ib' | 'data' | 'pad';

export interface FrameOptions { vlan: boolean; l3: L3; l4: L4; roce: boolean; payload: number }
export interface Part { id: string; short: string; bytes: number; layer: Layer }
export interface FrameResult {
  parts: Part[];           // wire order, including preamble/SFD and IFG
  l2Payload: number;       // bytes after the EtherType (IP total length, or RoCEv1 GRH..ICRC)
  ibPad: number;           // IB payload pad (BTH PadCnt) to a 4-byte multiple, RoCE only
  pad: number;             // padding added to reach the 64-byte minimum frame
  frame: number;           // dst MAC .. FCS (what "frame size" means in IEEE 802.3)
  wire: number;            // frame + preamble/SFD 8 + IFG 12
  efficiency: number;      // application payload / wire bytes
  etherType: number;
  isRoce: boolean;
}

export const MIN_FRAME = 64;
export const WIRE_OVERHEAD = 8 + 12; // preamble+SFD, minimum inter-packet gap

export function l3HeaderBytes(l3: L3): number { return l3 === 'ipv4' ? 20 : 40; } // RoCEv1 GRH is 40 B like IPv6
export function l4HeaderBytes(l4: L4): number { return l4 === 'udp' ? 8 : 20; }

export function buildFrame(o: FrameOptions): FrameResult {
  const isRoce = o.l3 === 'rocev1' || (o.l4 === 'udp' && o.roce);
  const mac = 14 + (o.vlan ? 4 : 0);
  const l4 = o.l3 === 'rocev1' ? 0 : l4HeaderBytes(o.l4);
  const ibPad = isRoce ? (4 - (o.payload % 4)) % 4 : 0; // IBA pads the payload to a multiple of 4 B (BTH PadCnt)
  const ib = isRoce ? 12 + 4 + ibPad : 0; // BTH + ICRC + pad
  const l2Payload = l3HeaderBytes(o.l3) + l4 + ib + o.payload;
  const unpadded = mac + l2Payload + 4;
  const pad = Math.max(0, MIN_FRAME - unpadded);
  const frame = unpadded + pad;
  const wire = frame + WIRE_OVERHEAD;
  const parts: Part[] = [{ id: 'pre', short: 'PRE+SFD', bytes: 8, layer: 'l1' }, { id: 'mac', short: 'DST+SRC', bytes: 12, layer: 'l2' }];
  if (o.vlan) parts.push({ id: 'vlan', short: '802.1Q', bytes: 4, layer: 'l2' });
  parts.push({ id: 'etype', short: 'TYPE', bytes: 2, layer: 'l2' });
  parts.push({ id: o.l3, short: o.l3 === 'ipv4' ? 'IPv4' : o.l3 === 'ipv6' ? 'IPv6' : 'GRH', bytes: l3HeaderBytes(o.l3), layer: o.l3 === 'rocev1' ? 'ib' : 'l3' });
  if (o.l3 !== 'rocev1') parts.push({ id: o.l4, short: o.l4.toUpperCase(), bytes: l4, layer: 'l4' });
  if (isRoce) parts.push({ id: 'bth', short: 'BTH', bytes: 12, layer: 'ib' });
  parts.push({ id: 'payload', short: 'PAYLOAD', bytes: o.payload, layer: 'data' });
  if (ibPad) parts.push({ id: 'ibpad', short: 'IB PAD', bytes: ibPad, layer: 'ib' });
  if (isRoce) parts.push({ id: 'icrc', short: 'ICRC', bytes: 4, layer: 'ib' });
  if (pad) parts.push({ id: 'pad', short: 'PAD', bytes: pad, layer: 'pad' });
  parts.push({ id: 'fcs', short: 'FCS', bytes: 4, layer: 'l2' }, { id: 'ifg', short: 'IFG', bytes: 12, layer: 'l1' });
  const etherType = o.l3 === 'ipv4' ? 0x0800 : o.l3 === 'ipv6' ? 0x86dd : 0x8915;
  return { parts, l2Payload, ibPad, pad, frame, wire, efficiency: o.payload / wire, etherType, isRoce };
}

// ---------- Field catalogue ----------

interface Field { name: string; bits: number; value: string }
const hex = (n: number, w = 4) => `0x${n.toString(16).toUpperCase().padStart(w, '0')}`;

function fieldsFor(id: string, o: FrameOptions, r: FrameResult): { title: string; blurb: string; fields: Field[] } {
  const ipLen = r.l2Payload;
  switch (id) {
    case 'pre': return { title: 'Preamble + SFD (8 B, wire only)', blurb: 'Not part of the frame and never in a capture, but it occupies link time.', fields: [
      { name: 'Preamble', bits: 56, value: '0x55 × 7' }, { name: 'Start frame delimiter', bits: 8, value: '0xD5' }] };
    case 'mac': return { title: 'MAC addresses (12 B)', blurb: 'Rewritten at every routed hop; switches learn from the source address.', fields: [
      { name: 'Destination MAC', bits: 48, value: 'b8:3f:d2:ab:cd:ef' }, { name: 'Source MAC', bits: 48, value: 'b8:3f:d2:12:34:56' }] };
    case 'vlan': return { title: '802.1Q tag (4 B)', blurb: 'Inserted between source MAC and EtherType. PCP is the 802.1p priority; PFC keys on it when the port trusts PCP (many RoCE fabrics trust DSCP instead).', fields: [
      { name: 'TPID', bits: 16, value: '0x8100' }, { name: 'PCP (priority)', bits: 3, value: '3' }, { name: 'DEI', bits: 1, value: '0' }, { name: 'VID (VLAN ID, 1-4094)', bits: 12, value: '100' }] };
    case 'etype': return { title: 'EtherType (2 B)', blurb: 'Says what follows. With a VLAN tag this is the inner EtherType after the TCI.', fields: [
      { name: 'EtherType', bits: 16, value: `${hex(r.etherType)} (${o.l3 === 'ipv4' ? 'IPv4' : o.l3 === 'ipv6' ? 'IPv6' : 'RoCEv1'})` }] };
    case 'ipv4': return { title: 'IPv4 header (20 B, no options)', blurb: 'End to end; routers decrement TTL and update the checksum.', fields: [
      { name: 'Version', bits: 4, value: '4' }, { name: 'IHL (32-bit words)', bits: 4, value: '5' }, { name: 'DSCP', bits: 6, value: o.l4 === 'udp' && o.roce ? '26 (common RoCE choice)' : '0' },
      { name: 'ECN', bits: 2, value: o.roce && o.l4 === 'udp' ? '10 (ECT(0))' : '00' }, { name: 'Total length', bits: 16, value: `${ipLen}` }, { name: 'Identification', bits: 16, value: 'any' },
      { name: 'Flags (reserved, DF, MF)', bits: 3, value: 'DF=1' }, { name: 'Fragment offset', bits: 13, value: '0' }, { name: 'TTL', bits: 8, value: '64' },
      { name: 'Protocol', bits: 8, value: o.l4 === 'udp' ? '17 (UDP)' : '6 (TCP)' }, { name: 'Header checksum', bits: 16, value: 'computed' },
      { name: 'Source address', bits: 32, value: '10.0.3.11' }, { name: 'Destination address', bits: 32, value: '10.0.3.12' }] };
    case 'ipv6': return { title: 'IPv6 header (40 B)', blurb: 'Fixed size; no header checksum. Payload length excludes the 40-byte base header.', fields: [
      { name: 'Version', bits: 4, value: '6' }, { name: 'Traffic class (DSCP 6 + ECN 2)', bits: 8, value: o.roce && o.l4 === 'udp' ? '0x6A (DSCP 26, ECT(0))' : '0x00' },
      { name: 'Flow label', bits: 20, value: 'any' }, { name: 'Payload length', bits: 16, value: `${ipLen - 40}` }, { name: 'Next header', bits: 8, value: o.l4 === 'udp' ? '17 (UDP)' : '6 (TCP)' },
      { name: 'Hop limit', bits: 8, value: '64' }, { name: 'Source address', bits: 128, value: 'fd00:0:3::b' }, { name: 'Destination address', bits: 128, value: 'fd00:0:3::c' }] };
    case 'rocev1': return { title: 'InfiniBand GRH (40 B, RoCEv1)', blurb: 'RoCEv1 has no IP header: the GRH sits right after the Ethernet header, so it cannot be routed.', fields: [
      { name: 'IP version', bits: 4, value: '6' }, { name: 'Traffic class', bits: 8, value: '0' }, { name: 'Flow label', bits: 20, value: '0' },
      { name: 'Payload length', bits: 16, value: `${ipLen - 40}` }, { name: 'Next header', bits: 8, value: '0x1B (BTH)' }, { name: 'Hop limit', bits: 8, value: '1' },
      { name: 'Source GID', bits: 128, value: 'fe80::…' }, { name: 'Destination GID', bits: 128, value: 'fe80::…' }] };
    case 'udp': return { title: 'UDP header (8 B)', blurb: o.roce ? 'For RoCEv2 the source port carries per-QP ECMP entropy; the destination is always 4791.' : 'Plain UDP datagram.', fields: [
      { name: 'Source port', bits: 16, value: o.roce ? '49152 (varies per QP)' : '5001' }, { name: 'Destination port', bits: 16, value: o.roce ? '4791 (RoCEv2)' : '5001' },
      { name: 'Length', bits: 16, value: `${ipLen - l3HeaderBytes(o.l3)}` }, { name: 'Checksum', bits: 16, value: o.roce ? 'often 0 on IPv4; ICRC protects the payload' : 'computed' }] };
    case 'tcp': return { title: 'TCP header (20 B, no options)', blurb: 'Options (timestamps, SACK) usually add 12 B or more in practice; this shows the minimum.', fields: [
      { name: 'Source port', bits: 16, value: '43512' }, { name: 'Destination port', bits: 16, value: '5201' }, { name: 'Sequence number', bits: 32, value: 'any' },
      { name: 'Acknowledgment number', bits: 32, value: 'any' }, { name: 'Data offset', bits: 4, value: '5' }, { name: 'Reserved', bits: 4, value: '0' },
      { name: 'Flags (CWR ECE URG ACK PSH RST SYN FIN)', bits: 8, value: 'ACK' }, { name: 'Window', bits: 16, value: 'any' }, { name: 'Checksum', bits: 16, value: 'computed' },
      { name: 'Urgent pointer', bits: 16, value: '0' }] };
    case 'bth': return { title: 'IB Base Transport Header (12 B)', blurb: 'The InfiniBand transport header, unchanged from native IB.', fields: [
      { name: 'OpCode', bits: 8, value: '0x04 (RC SEND Only)' }, { name: 'SE', bits: 1, value: '0' }, { name: 'M', bits: 1, value: '1' }, { name: 'PadCnt', bits: 2, value: `${r.ibPad}` },
      { name: 'TVer', bits: 4, value: '0' }, { name: 'P_Key', bits: 16, value: '0xFFFF' }, { name: 'F / B (FECN/BECN)', bits: 2, value: '0' }, { name: 'Resv6', bits: 6, value: '0' },
      { name: 'Destination QP', bits: 24, value: '0x000123' }, { name: 'A (AckReq)', bits: 1, value: '0' }, { name: 'Resv7', bits: 7, value: '0' }, { name: 'PSN', bits: 24, value: '0x0000A0' }] };
    case 'payload': return { title: `Payload (${o.payload} B)`, blurb: r.isRoce ? 'RDMA payload, at most the RDMA path MTU (256-4096 B). Shown as an RC SEND Only packet (BTH only); an RDMA WRITE First/Only packet would add a 16 B RETH.' : 'Application data.', fields: [
      { name: 'Data', bits: o.payload * 8, value: `${o.payload} B` }] };
    case 'ibpad': return { title: `IB pad (${r.ibPad} B)`, blurb: 'InfiniBand pads the payload to a multiple of 4 bytes; BTH PadCnt says how many pad bytes the receiver strips.', fields: [{ name: 'Pad', bits: r.ibPad * 8, value: 'zeros' }] };
    case 'icrc': return { title: 'ICRC (4 B)', blurb: 'Invariant CRC over the fields no router changes (variant fields such as TTL, DSCP/ECN are masked).', fields: [{ name: 'ICRC', bits: 32, value: 'CRC-32' }] };
    case 'pad': return { title: `Pad (${r.pad} B)`, blurb: 'Added by the MAC so the frame reaches 64 B. The receiver strips it using the IP length.', fields: [{ name: 'Pad', bits: r.pad * 8, value: 'zeros' }] };
    case 'fcs': return { title: 'FCS (4 B)', blurb: 'CRC-32 over dst MAC through pad. Recomputed per hop; frames failing it are dropped.', fields: [{ name: 'FCS', bits: 32, value: 'CRC-32' }] };
    default: return { title: 'Inter-packet gap (12 B minimum, wire only)', blurb: 'Idle time between frames. Counted in throughput math, never in captures.', fields: [{ name: 'IFG', bits: 96, value: 'idle' }] };
  }
}

// ---------- UI ----------

const LAYER_COLOR: Record<Layer, string> = { l1: 'var(--muted)', l2: 'var(--data)', l3: 'var(--accent)', l4: 'var(--warn)', ib: 'var(--danger)', data: 'var(--text)', pad: 'var(--border)' };
const LAYER_NAME: Record<Layer, string> = { l1: 'wire only', l2: 'Ethernet', l3: 'IP', l4: 'UDP/TCP', ib: 'IB transport', data: 'payload', pad: 'pad' };
const PAYLOADS = [0, 18, 64, 256, 1024, 1460, 4096, 8192] as const;
const fmt = (n: number) => n.toLocaleString('en-US');

function Seg<T extends string | number>({ label, value, options, onChange, render }: {
  label: string; value: T; options: readonly T[]; onChange: (v: T) => void; render?: (v: T) => string;
}) {
  return (
    <div>
      <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{label}</div>
      <div className="flex flex-wrap gap-1" role="group" aria-label={label}>
        {options.map((o) => (
          <button key={String(o)} type="button" onClick={() => onChange(o)} aria-pressed={o === value}
            className={`rounded-md border px-2 py-1 font-mono text-xs transition ${o === value ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-panel hover:bg-panel-2'}`}>
            {render ? render(o) : String(o)}
          </button>
        ))}
      </div>
    </div>
  );
}

function Out({ label, value, tone = 'text-fg' }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className="rounded-lg border border-line bg-panel-2 px-3 py-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">{label}</div>
      <div className={`font-mono text-lg font-semibold tabular-nums ${tone}`}>{value}</div>
    </div>
  );
}

export default function EthernetFrame() {
  const [vlan, setVlan] = useState(false);
  const [l3, setL3] = useState<L3>('ipv4');
  const [l4, setL4] = useState<L4>('udp');
  const [roce, setRoce] = useState(true);
  const [payload, setPayload] = useState(1024);
  const [sel, setSel] = useState('etype');
  const o: FrameOptions = { vlan, l3, l4, roce: l4 === 'udp' && roce, payload };
  const r = buildFrame(o);
  const selId = r.parts.some((p) => p.id === sel) ? sel : 'etype';
  const info = fieldsFor(selId, o, r);
  const totalBits = info.fields.reduce((s, f) => s + f.bits, 0);
  const hdrs = r.frame - payload - r.pad;
  const stackName = l3 === 'rocev1' ? 'RoCEv1' : `${l3 === 'ipv4' ? 'IPv4' : 'IPv6'}/${l4.toUpperCase()}${o.roce ? ' (RoCEv2)' : ''}`;
  const warnings: string[] = [];
  if (r.l2Payload > 1500) warnings.push(`L2 payload (IP packet) is ${fmt(r.l2Payload)} B > 1500: a jumbo frame. Every hop must have an MTU of at least ${fmt(r.l2Payload)}.`);
  if (r.l2Payload > 9216) warnings.push('Beyond the ~9000-9216 B jumbo sizes most platforms support.');
  if (r.isRoce && payload > 4096) warnings.push('RDMA payload per packet is capped by the IB MTU at 4096 B; the NIC would split this into several packets.');

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Seg label="Network layer (EtherType)" value={l3} options={['ipv4', 'ipv6', 'rocev1'] as const} onChange={setL3}
          render={(v) => (v === 'ipv4' ? 'IPv4 0x0800' : v === 'ipv6' ? 'IPv6 0x86DD' : 'RoCEv1 0x8915')} />
        {l3 !== 'rocev1' ? (
          <Seg label="Transport" value={l4 === 'udp' && roce ? 'roce' : l4} options={['roce', 'udp', 'tcp'] as const}
            onChange={(v) => { if (v === 'tcp') setL4('tcp'); else { setL4('udp'); setRoce(v === 'roce'); } }}
            render={(v) => (v === 'roce' ? 'UDP 4791 + BTH (RoCEv2)' : v === 'udp' ? 'UDP' : 'TCP')} />
        ) : <div className="self-end text-xs text-muted">RoCEv1: GRH + BTH directly in Ethernet, no IP/UDP.</div>}
        <div className="sm:col-span-2">
          <div className="mb-1 flex items-baseline justify-between font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
            <label htmlFor="ef-payload">Application payload (bytes)</label>
            <input id="ef-payload" type="number" min={0} max={9000} value={payload}
              onChange={(e) => setPayload(Math.max(0, Math.min(9000, Math.floor(Number(e.target.value) || 0))))}
              className="w-24 rounded-md border border-line bg-panel px-2 py-0.5 text-right text-sm text-fg" />
          </div>
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Payload presets">
            {PAYLOADS.map((p) => (
              <button key={p} type="button" aria-pressed={p === payload} onClick={() => setPayload(p)}
                className={`rounded-md border px-2 py-1 font-mono text-xs ${p === payload ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-panel hover:bg-panel-2'}`}>{p}</button>
            ))}
            <label className="ml-2 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={vlan} onChange={(e) => setVlan(e.target.checked)} className="accent-[var(--accent)]" />802.1Q VLAN tag
            </label>
          </div>
        </div>
      </div>

      <div>
        <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Frame on the wire (click a segment; widths not to scale)</div>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Frame segments">
          {r.parts.map((p) => (
            <button key={p.id} type="button" onClick={() => setSel(p.id)} aria-pressed={p.id === selId}
              style={{ borderTopColor: LAYER_COLOR[p.layer], flexGrow: Math.max(1, Math.log2(p.bytes + 1)) }}
              className={`min-w-[3.6rem] rounded-md border border-t-4 px-1.5 py-1 text-left font-mono transition ${p.id === selId ? 'border-accent bg-accent-soft' : 'border-line bg-panel-2 hover:bg-panel'} ${p.layer === 'l1' ? 'border-dashed' : ''}`}>
              <div className="text-[11px] font-semibold">{p.short}</div>
              <div className="text-[10px] text-muted">{fmt(p.bytes)} B</div>
            </button>
          ))}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted">
          {(['l1', 'l2', 'l3', 'l4', 'ib', 'data'] as Layer[]).map((l) => (
            <span key={l} className="inline-flex items-center gap-1"><span className="inline-block h-2 w-3 rounded-sm" style={{ background: LAYER_COLOR[l] }} />{LAYER_NAME[l]}</span>
          ))}
        </div>
      </div>

      <div className="rounded-lg border border-line bg-panel p-3">
        <div className="text-sm font-semibold">{info.title}</div>
        <p className="mt-0.5 text-xs text-muted">{info.blurb}</p>
        <div className="mt-2 overflow-x-auto" tabIndex={0} role="region" aria-label={`${info.title} fields`}>
          <table className="w-full text-left text-xs">
            <thead className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted"><tr><th className="py-1 pr-3">Field</th><th className="py-1 pr-3 text-right">Bits</th><th className="py-1">Example value</th></tr></thead>
            <tbody>
              {info.fields.map((f) => (
                <tr key={f.name} className="border-t border-line"><td className="py-1 pr-3">{f.name}</td><td className="py-1 pr-3 text-right font-mono tabular-nums">{fmt(f.bits)}</td><td className="py-1 font-mono text-data">{f.value}</td></tr>
              ))}
              <tr className="border-t border-line text-muted"><td className="py-1 pr-3">total</td><td className="py-1 pr-3 text-right font-mono">{fmt(totalBits)}</td><td className="py-1 font-mono">= {fmt(totalBits / 8)} B</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Pill>{stackName}</Pill>
        <Pill>EtherType {hex(r.etherType)}</Pill>
        {vlan && <Pill>TPID 0x8100 before it</Pill>}
        {r.pad > 0 && <Pill className="text-warn">padded +{r.pad} B to 64</Pill>}
      </div>

      {warnings.map((w) => <div key={w} className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn" role="status">{w}</div>)}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-live="polite">
        <Out label="Frame (dst MAC..FCS)" value={`${fmt(r.frame)} B`} tone="text-accent" />
        <Out label="IP / L2 payload" value={`${fmt(r.l2Payload)} B`} />
        <Out label="On the wire (+20)" value={`${fmt(r.wire)} B`} tone="text-data" />
        <Out label="Payload efficiency" value={`${(r.efficiency * 100).toFixed(1)} %`} tone={r.efficiency < 0.9 ? 'text-warn' : 'text-accent'} />
      </div>

      <div>
        <div className="flex h-3 w-full overflow-hidden rounded-full bg-panel-2" role="img" aria-label={`Payload is ${(r.efficiency * 100).toFixed(1)} percent of wire bytes`}>
          <div className="h-full bg-accent" style={{ width: `${r.efficiency * 100}%` }} />
          <div className="h-full bg-warn" style={{ width: `${((hdrs + r.pad) / r.wire) * 100}%` }} />
        </div>
        <div className="mt-1 text-[11px] text-muted">green = payload, amber = headers, trailers and pad, grey = preamble/SFD + IFG</div>
      </div>

      <div>
        <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Derivation</div>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
          <li>L2 payload = {l3 === 'ipv4' ? 'IPv4 20' : l3 === 'ipv6' ? 'IPv6 40' : 'GRH 40'}{l3 !== 'rocev1' ? ` + ${l4.toUpperCase()} ${l4HeaderBytes(l4)}` : ''}{r.isRoce ? ' + BTH 12' : ''} + payload {fmt(payload)}{r.ibPad ? ` + IB pad ${r.ibPad}` : ''}{r.isRoce ? ' + ICRC 4' : ''} = <span className="font-mono text-fg">{fmt(r.l2Payload)} B</span></li>
          <li>frame = MAC header {vlan ? '18 (14 + 4 tag)' : '14'} + {fmt(r.l2Payload)} + FCS 4 = {fmt(r.frame - r.pad)} B{r.pad > 0 ? <> &lt; 64 → pad {r.pad} B → <span className="font-mono text-fg">64 B</span></> : <> → <span className="font-mono text-fg">{fmt(r.frame)} B</span></>}</li>
          <li>wire = frame + preamble/SFD 8 + IFG 12 = <span className="font-mono text-fg">{fmt(r.wire)} B</span>; efficiency = {fmt(payload)} / {fmt(r.wire)} = <span className="font-mono text-fg">{(r.efficiency * 100).toFixed(2)} %</span></li>
          <li>minimum frame 64 B ⇒ minimum L2 payload {vlan ? '42 B with a tag (64 − 18 − 4)' : '46 B (64 − 14 − 4)'}; standard maximum frame {vlan ? '1522' : '1518'} B at a 1500 B MTU</li>
        </ol>
      </div>

      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Common EtherTypes">
        <table className="w-full text-left text-xs">
          <thead className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted"><tr><th className="py-1 pr-3">EtherType</th><th className="py-1">Meaning</th></tr></thead>
          <tbody className="font-mono">
            {[['0x0800', 'IPv4 (RoCEv2 over IPv4)'], ['0x86DD', 'IPv6 (RoCEv2 over IPv6)'], ['0x8100', '802.1Q VLAN tag (TPID)'], ['0x8915', 'RoCEv1 (GRH + BTH, not routable)'], ['0x0806', 'ARP'], ['0x8808', 'MAC Control (802.3x PAUSE, 802.1Qbb PFC)']].map(([v, m]) => (
              <tr key={v} className={`border-t border-line ${v === hex(r.etherType) || (vlan && v === '0x8100') ? 'text-accent' : ''}`}><td className="py-1 pr-3">{v}</td><td className="py-1 font-sans">{m}{(v === hex(r.etherType) || (vlan && v === '0x8100')) && <span className="sr-only"> (in this frame)</span>}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] leading-relaxed text-muted">
        Sizes per IEEE 802.3 / 802.1Q, RFC 791, RFC 8200, RFC 768, RFC 9293 and the IBTA RoCE annexes. Headers are shown without options (IPv4 options,
        TCP options such as timestamps, IPv6 extension headers) and RoCE packets as RC SEND Only packets with BTH only (an RDMA WRITE First/Only packet adds RETH 16 B,
        an ACK carries AETH 4 B; payloads that are not a multiple of 4 B get 1-3 B of IB pad). The 12 B IFG is the minimum; 802.3 allows a tagged frame's pad to shrink so the 64 B minimum still includes the tag.
        Example field values are illustrative.
      </p>
    </div>
  );
}
