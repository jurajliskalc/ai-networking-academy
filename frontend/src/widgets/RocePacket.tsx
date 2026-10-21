import { useMemo, useState } from 'react';

type Layer = 'l1' | 'l2' | 'l3' | 'l4' | 'ib' | 'data';

interface Field { name: string; bits: string; value: string; note?: string }
interface Segment { id: string; short: string; name: string; bytes: number; layer: Layer; fields: Field[]; blurb: string; wire?: boolean }

const LAYER_COLOR: Record<Layer, string> = {
  l1: 'var(--muted)',
  l2: 'var(--data)',
  l3: 'var(--accent)',
  l4: 'var(--warn)',
  ib: '#a78bfa',
  data: 'var(--text)',
};

const LAYER_LABEL: Record<Layer, string> = {
  l1: 'Physical (wire only)', l2: 'Ethernet L2', l3: 'IP L3', l4: 'UDP L4', ib: 'InfiniBand transport', data: 'Payload',
};

const MTUS = [256, 512, 1024, 2048, 4096] as const;
const SPEEDS = [100, 200, 400, 800] as const;

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-xs select-none">
      <input type="checkbox" className="h-3.5 w-3.5 accent-[var(--accent)]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function Seg<T extends string | number>({ options, value, onChange, fmt }: { options: readonly T[]; value: T; onChange: (v: T) => void; fmt?: (v: T) => string }) {
  return (
    <div className="inline-flex flex-wrap overflow-hidden rounded-lg border border-line">
      {options.map((o) => (
        <button key={String(o)} type="button" onClick={() => onChange(o)}
          className={`px-2.5 py-1 font-mono text-xs transition ${o === value ? 'bg-accent-soft text-accent' : 'bg-panel text-muted hover:text-fg'}`}>
          {fmt ? fmt(o) : String(o)}
        </button>
      ))}
    </div>
  );
}

export default function RocePacket() {
  const [vlan, setVlan] = useState(true);
  const [ipv6, setIpv6] = useState(false);
  const [first, setFirst] = useState(true);
  const [mtu, setMtu] = useState<number>(4096);
  const [wire, setWire] = useState(true);
  const [speed, setSpeed] = useState<number>(400);
  const [sel, setSel] = useState<string>('bth');

  const segments = useMemo<Segment[]>(() => {
    const s: Segment[] = [];
    if (wire) s.push({ id: 'pre', short: 'PRE', name: 'Preamble + SFD', bytes: 8, layer: 'l1', wire: true,
      blurb: 'Not part of the frame: 7 bytes of 0x55 for clock recovery and a 1-byte start-frame delimiter 0xD5. Still consumes link time.',
      fields: [{ name: 'Preamble', bits: '56', value: '0x55 x 7' }, { name: 'SFD', bits: '8', value: '0xD5' }] });
    s.push({ id: 'eth', short: 'ETH', name: 'Ethernet header', bytes: 14, layer: 'l2',
      blurb: 'Hop-by-hop L2 header; rewritten by every routed hop. RoCEv2 is routable, so MACs only matter per link.',
      fields: [
        { name: 'Destination MAC', bits: '48', value: 'next-hop MAC' },
        { name: 'Source MAC', bits: '48', value: 'egress port MAC' },
        { name: 'EtherType', bits: '16', value: vlan ? '0x8100 (TPID: tag follows)' : ipv6 ? '0x86DD (IPv6)' : '0x0800 (IPv4)' },
      ] });
    if (vlan) s.push({ id: 'vlan', short: '.1Q', name: '802.1Q VLAN tag', bytes: 4, layer: 'l2',
      blurb: 'Carries PCP, the L2 priority PFC can key on. Most modern fabrics instead trust DSCP (L3) and run untagged on routed ports.',
      fields: [
        { name: 'PCP', bits: '3', value: '3', note: 'Priority Code Point: the 802.1p class. PFC pauses one of 8 priorities; RoCE is commonly on priority 3.' },
        { name: 'DEI', bits: '1', value: '0', note: 'Drop eligible indicator.' },
        { name: 'VID', bits: '12', value: 'e.g. 100' },
        { name: 'Inner EtherType', bits: '16', value: ipv6 ? '0x86DD' : '0x0800' },
      ] });
    if (!ipv6) s.push({ id: 'ip', short: 'IPv4', name: 'IPv4 header', bytes: 20, layer: 'l3',
      blurb: 'The ToS byte is the congestion-control interface: DSCP selects the lossless traffic class, ECN carries congestion marks from switches to the receiver.',
      fields: [
        { name: 'Version / IHL', bits: '4 + 4', value: '4 / 5 (20 B, no options)' },
        { name: 'DSCP', bits: '6', value: '26 (AF31) typical', note: 'Mapped to the lossless queue / PFC priority by the switch trust-DSCP table. Common choices: 24 or 26 for RoCE, 48 for CNPs.' },
        { name: 'ECN', bits: '2', value: '10 = ECT(0)', note: '00 Not-ECT, 10 ECT(0), 01 ECT(1), 11 CE. The NIC sends ECT(0); a congested switch rewrites to CE (11) instead of dropping. The receiver NIC sees CE and returns a CNP to the sender (DCQCN).' },
        { name: 'Total length', bits: '16', value: '' },
        { name: 'Identification / Flags / Frag offset', bits: '16 + 3 + 13', value: 'DF = 1', note: 'RoCE never fragments; the NIC sizes packets to the path MTU.' },
        { name: 'TTL', bits: '8', value: '64' },
        { name: 'Protocol', bits: '8', value: '17 (UDP)' },
        { name: 'Header checksum', bits: '16', value: 'per hop' },
        { name: 'Source / Destination IP', bits: '32 + 32', value: 'GID-derived addresses' },
      ] });
    else s.push({ id: 'ip', short: 'IPv6', name: 'IPv6 header', bytes: 40, layer: 'l3',
      blurb: 'Same role as IPv4; the Traffic Class byte holds DSCP + ECN, and the 20-bit flow label can add hash entropy.',
      fields: [
        { name: 'Version', bits: '4', value: '6' },
        { name: 'Traffic class (DSCP | ECN)', bits: '6 + 2', value: 'DSCP 26, ECN 10 = ECT(0)', note: 'ECN: 00 Not-ECT, 10 ECT(0), 01 ECT(1), 11 CE (congestion experienced, set by the switch).' },
        { name: 'Flow label', bits: '20', value: 'per-QP hash', note: 'Can be included in ECMP hashing for extra entropy.' },
        { name: 'Payload length', bits: '16', value: '' },
        { name: 'Next header', bits: '8', value: '17 (UDP)' },
        { name: 'Hop limit', bits: '8', value: '64' },
        { name: 'Source / Destination IP', bits: '128 + 128', value: 'GID = IPv6 address' },
      ] });
    s.push({ id: 'udp', short: 'UDP', name: 'UDP header', bytes: 8, layer: 'l4',
      blurb: 'UDP exists so that IP fabrics can route and ECMP-hash RoCE. The well-known destination port identifies RoCEv2; the source port is the entropy knob.',
      fields: [
        { name: 'Source port', bits: '16', value: '0xC000-0xFFFF', note: 'Entropy: the NIC derives it from a hash of the QP (or flow label), so different QPs take different ECMP paths. Same QP = same path = ordering preserved.' },
        { name: 'Destination port', bits: '16', value: '4791', note: 'IANA-assigned RoCEv2 port.' },
        { name: 'Length', bits: '16', value: '' },
        { name: 'Checksum', bits: '16', value: '0', note: 'Usually zero; the ICRC protects the transport.' },
      ] });
    s.push({ id: 'bth', short: 'BTH', name: 'IB Base Transport Header', bytes: 12, layer: 'ib',
      blurb: 'The InfiniBand transport header, unchanged from native IB. It names the destination queue pair and carries the packet sequence number used for ACK/NAK and go-back-N.',
      fields: [
        { name: 'OpCode', bits: '8', value: first ? '0x0A RC RDMA WRITE Only (0x06 First)' : '0x07 RC RDMA WRITE Middle (0x08 Last)', note: 'Top 3 bits = transport (000 RC, 001 UC, 011 UD), low 5 bits = operation.' },
        { name: 'SE (solicited event)', bits: '1', value: '0', note: 'Asks the responder to raise a completion event (relevant for SEND / WRITE with immediate).' },
        { name: 'M (MigReq)', bits: '1', value: '1', note: 'Automatic path migration state.' },
        { name: 'PadCnt', bits: '2', value: '0', note: 'Bytes of padding to make the payload a multiple of 4.' },
        { name: 'TVer', bits: '4', value: '0', note: 'Transport header version.' },
        { name: 'P_Key', bits: '16', value: '0xFFFF', note: 'Partition key, the IB equivalent of a VLAN; checked against the QP.' },
        { name: 'Reserved', bits: '8', value: '0', note: 'Native IB defines FECN/BECN bits here; RoCEv2 signals congestion with IP ECN instead.' },
        { name: 'Destination QP', bits: '24', value: '0x00012a', note: '24-bit QP number at the receiver: up to 16 M QPs.' },
        { name: 'A (AckReq)', bits: '1', value: '1 on last', note: 'Requests an ACK from the responder.' },
        { name: 'Reserved', bits: '7', value: '0' },
        { name: 'PSN', bits: '24', value: 'n', note: 'Packet sequence number, increments per packet and wraps at 2^24. A gap triggers a NAK and go-back-N retransmit, which is why loss hurts RoCE so much.' },
      ] });
    if (first) s.push({ id: 'reth', short: 'RETH', name: 'RDMA Extended Transport Header', bytes: 16, layer: 'ib',
      blurb: 'Present only in the First (or Only) packet of an RDMA WRITE (and in RDMA READ requests). Middle/Last packets are placed by PSN offset.',
      fields: [
        { name: 'Virtual address', bits: '64', value: 'remote buffer VA' },
        { name: 'R_Key', bits: '32', value: 'remote key', note: 'Authorises access to the registered memory region on the target.' },
        { name: 'DMA length', bits: '32', value: 'total WRITE size in bytes' },
      ] });
    s.push({ id: 'data', short: 'PAYLOAD', name: 'Payload', bytes: mtu, layer: 'data',
      blurb: `Up to one RoCE path MTU (${mtu} B) of application data per packet. Every packet except the last of a message carries a full MTU.`,
      fields: [{ name: 'Data', bits: String(mtu * 8), value: `${mtu} B`, note: 'RoCE MTU is one of the IB sizes 256..4096; there is no 9000-byte RoCE MTU.' }] });
    s.push({ id: 'icrc', short: 'ICRC', name: 'Invariant CRC', bytes: 4, layer: 'ib',
      blurb: 'End-to-end CRC over the IP, UDP, BTH and payload with the mutable fields (TTL, DSCP/ECN, checksums, flow label) masked to 1s, so switches can rewrite them without breaking it.',
      fields: [{ name: 'ICRC', bits: '32', value: 'CRC-32 (masked)' }] });
    s.push({ id: 'fcs', short: 'FCS', name: 'Ethernet FCS', bytes: 4, layer: 'l2',
      blurb: 'Per-hop CRC-32 over the frame; recomputed by each hop.',
      fields: [{ name: 'FCS', bits: '32', value: 'CRC-32' }] });
    if (wire) s.push({ id: 'ifg', short: 'IFG', name: 'Inter-frame gap', bytes: 12, layer: 'l1', wire: true,
      blurb: 'Minimum 12 byte-times of idle between frames. Not data, but it is link time you cannot use.',
      fields: [{ name: 'Idle', bits: '96', value: '12 byte times' }] });
    return s;
  }, [vlan, ipv6, first, mtu, wire]);

  const frame = segments.filter((s) => !s.wire).reduce((a, s) => a + s.bytes, 0);
  const l1 = 20; // preamble+SFD + IFG
  const wireBytes = frame + l1;
  const denom = wire ? wireBytes : frame;
  const eff = mtu / denom;
  const goodput = speed * (mtu / wireBytes);
  const ipLen = (ipv6 ? 40 : 20) + 8 + 12 + 16 + mtu + 4; // worst case incl. RETH
  const wireFor = (m: number) => 14 + (vlan ? 4 : 0) + (ipv6 ? 40 : 20) + 8 + 12 + m + 4 + 4 + 20; // no RETH, with preamble+IFG
  const selected = segments.find((s) => s.id === sel) ?? segments[0];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <div className="flex items-center gap-2"><span className="text-xs text-muted">RoCE MTU</span><Seg options={MTUS} value={mtu as (typeof MTUS)[number]} onChange={setMtu} /></div>
        <div className="flex items-center gap-2"><span className="text-xs text-muted">Link</span><Seg options={SPEEDS} value={speed as (typeof SPEEDS)[number]} onChange={setSpeed} fmt={(v) => `${v}G`} /></div>
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        <Toggle label="802.1Q tag" checked={vlan} onChange={setVlan} />
        <Toggle label="IPv6" checked={ipv6} onChange={setIpv6} />
        <Toggle label="First/Only packet (RETH)" checked={first} onChange={setFirst} />
        <Toggle label="Preamble + IFG" checked={wire} onChange={setWire} />
      </div>

      <div>
        <div className="mb-1 flex justify-between font-mono text-[10px] text-muted"><span>headers to scale, payload compressed</span><span>click a segment</span></div>
        <div className="flex h-16 w-full gap-[2px]" role="list">
          {segments.map((s) => {
            const grow = s.layer === 'data' ? 70 : s.bytes;
            const c = LAYER_COLOR[s.layer];
            const active = s.id === selected.id;
            return (
              <button key={s.id} type="button" role="listitem" onClick={() => setSel(s.id)} title={`${s.name}: ${s.bytes} B`}
                className="flex min-w-[1.6rem] flex-col items-center justify-center overflow-hidden rounded-md px-0.5 font-mono transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                style={{
                  flexGrow: grow, flexBasis: 0,
                  background: `color-mix(in srgb, ${c} ${active ? 34 : 16}%, transparent)`,
                  border: `1.5px ${s.wire ? 'dashed' : 'solid'} color-mix(in srgb, ${c} ${active ? 100 : 55}%, transparent)`,
                }}>
                <span className="w-full truncate text-center text-[10px] font-semibold leading-tight" style={{ color: s.layer === 'data' ? 'var(--text)' : c }}>{s.short}</span>
                <span className="w-full truncate text-center text-[10px] leading-tight text-muted">{s.bytes}</span>
              </button>
            );
          })}
        </div>
        <div className="mt-2 flex h-2 w-full overflow-hidden rounded-full border border-line" aria-label="True-scale bar">
          {segments.map((s) => <div key={s.id} style={{ flexGrow: s.bytes, flexBasis: 0, background: LAYER_COLOR[s.layer], opacity: s.layer === 'data' ? 0.35 : 0.9 }} />)}
        </div>
        <div className="mt-1 font-mono text-[10px] text-muted">true scale: overhead is a sliver at 4096 B, a sizeable slice at 256 B</div>
      </div>

      <div className="grid gap-4 md:grid-cols-[1.4fr_1fr]">
        <div className="rounded-xl border border-line bg-panel-2 p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="font-semibold">{selected.name}</div>
            <div className="font-mono text-xs" style={{ color: LAYER_COLOR[selected.layer] === 'var(--text)' ? 'var(--muted)' : LAYER_COLOR[selected.layer] }}>{selected.bytes} B · {LAYER_LABEL[selected.layer]}</div>
          </div>
          <p className="mt-1 text-sm text-muted">{selected.blurb}</p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead><tr className="border-b border-line text-muted"><th className="py-1 pr-2 font-medium">Field</th><th className="py-1 pr-2 font-medium">Bits</th><th className="py-1 font-medium">Value</th></tr></thead>
              <tbody>
                {selected.fields.map((f, i) => (
                  <tr key={i} className="border-b border-line/60 align-top last:border-0">
                    <td className="py-1.5 pr-2 font-medium">{f.name}{f.note && <div className="mt-0.5 font-normal text-muted">{f.note}</div>}</td>
                    <td className="py-1.5 pr-2 font-mono text-data">{f.bits}</td>
                    <td className="py-1.5 font-mono">{f.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="space-y-2">
          <Metric label="Ethernet frame (with FCS)" value={`${frame} B`} />
          <Metric label="Bytes on the wire" value={`${wireBytes} B`} sub="frame + 8 B preamble/SFD + 12 B IFG" />
          <Metric label={`Payload efficiency (${wire ? 'wire' : 'frame'})`} value={`${(eff * 100).toFixed(1)} %`} sub={`${mtu} B payload / ${denom} B`} accent />
          <Metric label={`Goodput at ${speed} Gb/s`} value={`${goodput.toFixed(1)} Gb/s`} sub={`= ${(goodput / 8).toFixed(2)} GB/s of payload, back to back`} accent />
          <Metric label="Interface (IP) MTU needed" value={`≥ ${mtu + 96} B`} sub={`This packet is ${ipLen} B at L3, but Linux (iboe_get_mtu) reserves 96 B of worst-case headers: RoCE MTU = largest IB MTU ≤ netdev MTU − 96. Hosts run 9000, switches 9216.`} />
        </div>
      </div>
      <p className="text-xs text-muted">
        The NIC picks the active RoCE MTU as the largest IB MTU (256..4096) whose packet fits the netdev MTU. With a 1500 B interface MTU you silently get 1024 B RoCE packets:
        about {(100 * (1 - 1024 / wireFor(1024))).toFixed(1)} % of the wire is overhead for middle packets, versus {(100 * (1 - 4096 / wireFor(4096))).toFixed(1)} % at 4096 B.
      </p>
    </div>
  );
}

function Metric({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className="rounded-xl border border-line bg-panel p-2.5">
      <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">{label}</div>
      <div className={`text-lg font-bold tabular-nums ${accent ? 'text-accent' : ''}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted">{sub}</div>}
    </div>
  );
}
