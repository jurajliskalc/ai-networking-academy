import { useState, type ReactNode } from 'react';
import { Pill } from '../components/ui';
import NumInput from '../components/NumInput';

// ---------- Pure calculation (unit-testable) ----------

export const IB_MTUS = [256, 512, 1024, 2048, 4096] as const;
/** Bytes the Linux kernel subtracts in iboe_get_mtu() (include/rdma/ib_addr.h):
 *  GRH 40 + UDP 8 + BTH 12 + XRC ETH 4 + AtomicETH 28 + ICRC 4. A worst case, independent of IPv4/IPv6. */
export const IBOE_OVERHEAD = 40 + 8 + 12 + 4 + 28 + 4; // 96

/** RoCE active MTU from the netdev MTU, as the kernel does it: largest IB MTU <= netdev MTU − 96, or 0 if none fits. */
export function iboeActiveMtu(netdevMtu: number): number {
  const room = netdevMtu - IBOE_OVERHEAD;
  for (let i = IB_MTUS.length - 1; i >= 0; i--) if (room >= IB_MTUS[i]) return IB_MTUS[i];
  return 0;
}

export type Overlay = 'none' | 'vxlan4' | 'vxlan6';
export const OVERLAY_BYTES: Record<Overlay, number> = { none: 0, vxlan4: 50, vxlan6: 70 }; // outer IP length = inner IP + inner Eth 14 + VXLAN 8 + UDP 8 + outer IP 20/40

/** RoCEv2 IP packet for a full-MTU RDMA WRITE First: payload + IP + UDP 8 + BTH 12 + RETH 16 + ICRC 4 (ImmDt/XRCETH can add 4-8 B). */
export function rocePacketIpLen(activeMtu: number, ipv6: boolean): number {
  return activeMtu + (ipv6 ? 40 : 20) + 8 + 12 + 16 + 4;
}
export const tcpMss = (mtu: number, ipv6: boolean) => mtu - (ipv6 ? 60 : 40);
export const pingMaxPayload = (mtu: number, ipv6: boolean) => mtu - (ipv6 ? 48 : 28); // IP + ICMP(v6) 8

export type Convention = 'l3' | 'l2';
/** Size a hop compares against its configured MTU, for a packet whose (outer) IP length is ipLen. */
export function hopSize(ipLen: number, conv: Convention, vlan: boolean): number {
  return conv === 'l3' ? ipLen : ipLen + 14 + (vlan ? 4 : 0); // L2 convention here: frame without FCS
}

export interface HopVerdict { limit: number; roceSize: number; fullSize: number; roceFits: boolean; fullFits: boolean; innerMtu: number }
export function checkHop(limit: number, netdev: number, roceIp: number, overlay: Overlay, conv: Convention, vlan: boolean): HopVerdict {
  const o = OVERLAY_BYTES[overlay];
  const roceSize = hopSize(roceIp + o, conv, vlan);
  const fullSize = hopSize(netdev + o, conv, vlan);
  const innerMtu = limit - o - (conv === 'l2' ? 14 + (vlan ? 4 : 0) : 0);
  return { limit, roceSize, fullSize, roceFits: roceSize <= limit, fullFits: fullSize <= limit, innerMtu };
}

// ---------- UI ----------

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

function Out({ label, value, sub, tone = 'text-fg' }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string }) {
  return (
    <div className="rounded-lg border border-line bg-panel-2 px-3 py-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">{label}</div>
      <div className={`font-mono text-lg font-semibold tabular-nums ${tone}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted">{sub}</div>}
    </div>
  );
}


export default function MtuCalculator() {
  const [netdev, setNetdev] = useState(9000);
  const [ipv6, setIpv6] = useState(false);
  const [vlan, setVlan] = useState(false);
  const [overlay, setOverlay] = useState<Overlay>('none');
  const [conv, setConv] = useState<Convention>('l3');
  const [hops, setHops] = useState<number[]>([9216, 9216, 9216]);

  const active = iboeActiveMtu(netdev);
  const roceIp = active ? rocePacketIpLen(active, ipv6) : 0;
  const verdicts = hops.map((h) => checkHop(h, netdev, roceIp, overlay, conv, vlan));
  const pathInner = Math.min(netdev, ...verdicts.map((v) => v.innerMtu));
  const allRoce = active > 0 && verdicts.every((v) => v.roceFits);
  const allFull = verdicts.every((v) => v.fullFits);
  const ov = OVERLAY_BYTES[overlay];
  const hdr = ipv6 ? 40 : 20;
  const setHop = (i: number, v: number) => setHops(hops.map((h, j) => (j === i ? v : h)));

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="mtu-netdev" className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Host netdev MTU (ip link)</label>
          <div className="flex flex-wrap items-center gap-1">
            <NumInput id="mtu-netdev" integer min={576} max={9216} value={netdev} onValue={setNetdev}
              className="w-24 rounded-md border border-line bg-panel px-2 py-1 font-mono text-sm" />
            {[1500, 2500, 4200, 9000].map((m) => (
              <button key={m} type="button" aria-pressed={m === netdev} onClick={() => setNetdev(m)}
                className={`rounded-md border px-2 py-1 font-mono text-xs ${m === netdev ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-panel hover:bg-panel-2'}`}>{m}</button>
            ))}
          </div>
        </div>
        <Seg label="RoCE / host IP version" value={ipv6 ? 'IPv6' : 'IPv4'} options={['IPv4', 'IPv6'] as const} onChange={(v) => setIpv6(v === 'IPv6')} />
        <Seg label="Overlay between host and hops" value={overlay} options={['none', 'vxlan4', 'vxlan6'] as const} onChange={setOverlay}
          render={(v) => (v === 'none' ? 'none' : v === 'vxlan4' ? 'VXLAN/IPv4 +50' : 'VXLAN/IPv6 +70')} />
        <Seg label="Switch MTU counts" value={conv} options={['l3', 'l2'] as const} onChange={setConv}
          render={(v) => (v === 'l3' ? 'IP packet (L3 MTU)' : 'L2 frame (hdr, no FCS)')} />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={vlan} onChange={(e) => setVlan(e.target.checked)} className="accent-[var(--accent)]" />802.1Q tag on the links (+4 B to the frame)
        </label>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
          <span>Switch hops (port MTU)</span>
          <span className="flex gap-1 normal-case tracking-normal">
            <button type="button" disabled={hops.length <= 2} onClick={() => setHops(hops.slice(0, -1))} aria-label="Remove a hop" className="min-h-6 rounded-md border border-line bg-panel px-2 py-0.5 disabled:opacity-40">− hop</button>
            <button type="button" disabled={hops.length >= 3} onClick={() => setHops([...hops, 9216])} aria-label="Add a hop" className="min-h-6 rounded-md border border-line bg-panel px-2 py-0.5 disabled:opacity-40">+ hop</button>
          </span>
        </div>
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Switch hops and verdicts">
          <table className="w-full text-left text-xs">
            <thead className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted">
              <tr><th className="py-1 pr-3">Hop</th><th className="py-1 pr-3">MTU</th><th className="py-1 pr-3 text-right">RoCE pkt</th><th className="py-1 pr-3 text-right">Full-MTU pkt</th><th className="py-1">Verdict</th></tr>
            </thead>
            <tbody>
              {verdicts.map((v, i) => (
                <tr key={i} className="border-t border-line">
                  <td className="py-1 pr-3 font-mono">{['leaf (ingress)', 'spine', 'leaf (egress)'][hops.length === 2 && i === 1 ? 2 : i]}</td>
                  <td className="py-1 pr-3">
                    <NumInput aria-label={`MTU of hop ${i + 1}`} integer min={576} max={10240} value={hops[i]} onValue={(v) => setHop(i, v)}
                      className="min-h-6 w-20 rounded-md border border-line bg-panel px-1.5 py-0.5 font-mono text-xs" />
                  </td>
                  <td className={`py-1 pr-3 text-right font-mono ${active && !v.roceFits ? 'text-danger' : ''}`}>{active ? fmt(v.roceSize) : '—'}</td>
                  <td className={`py-1 pr-3 text-right font-mono ${!v.fullFits ? 'text-warn' : ''}`}>{fmt(v.fullSize)}</td>
                  <td className="py-1">
                    {!active ? <span className="text-danger">no RoCE MTU</span>
                      : !v.roceFits ? <span className="text-danger">✗ drops RoCE packets (RDMA retries, then QP error)</span>
                      : !v.fullFits ? <span className="text-warn">⚠ RoCE fits; full-size TCP/ping dropped (black hole, max inner {fmt(v.innerMtu)})</span>
                      : <span className="text-accent">✓ everything fits ({fmt(v.limit - v.fullSize)} B spare)</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className={`rounded-lg border px-3 py-2 text-sm ${!allRoce ? 'border-danger/40 bg-danger/10 text-danger' : !allFull ? 'border-warn/40 bg-warn/10 text-warn' : 'border-accent/40 bg-accent-soft text-accent'}`} role="status">
        {!active ? `Netdev MTU ${netdev} leaves less than 256 B after the 96 B the kernel reserves: no RoCE MTU.`
          : !allRoce ? `Path broken for RDMA: at least one hop cannot carry a ${fmt(roceIp + ov)} B RoCE packet. Raise that hop's MTU or lower the host MTU.`
          : !allFull ? `RDMA works at ${active}, but host packets of ${fmt(netdev)} B do not fit every hop. Lower the host MTU to ${fmt(pathInner)} or raise the hops.`
          : `End to end OK: RoCE active MTU ${active} and full ${fmt(netdev)} B host packets fit every hop.`}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-live="polite">
        <Out label="RoCE active_mtu" value={active || 'none'} tone={active === 4096 ? 'text-accent' : 'text-warn'} sub={`largest IB MTU ≤ ${netdev} − 96 = ${netdev - 96}`} />
        <Out label="Largest RoCE IP pkt" value={active ? `${fmt(roceIp)} B` : '—'} tone="text-data" sub={ov ? `outer IP ${fmt(roceIp + ov)} B` : `frame ${fmt(roceIp + 18 + (vlan ? 4 : 0))} B incl. FCS`} />
        <Out label="TCP MSS" value={fmt(tcpMss(netdev, ipv6))} sub={`MTU − ${hdr} IP − 20 TCP`} />
        <Out label={ipv6 ? 'ping -6 -M do -s' : 'ping -M do -s'} value={fmt(pingMaxPayload(pathInner, ipv6))} tone={pathInner < netdev ? 'text-warn' : 'text-fg'}
          sub={pathInner < netdev ? `path max; host max ${fmt(pingMaxPayload(netdev, ipv6))}` : `MTU − ${hdr} IP − 8 ICMP`} />
      </div>

      <div>
        <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Derivation</div>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
          <li>Linux <span className="font-mono">iboe_get_mtu()</span>: room = netdev MTU − (GRH 40 + UDP 8 + BTH 12 + XRC 4 + AtomicETH 28 + ICRC 4) = {netdev} − 96 = <span className="font-mono text-fg">{netdev - 96}</span> → largest of 256/512/1024/2048/4096 that fits = <span className="font-mono text-fg">{active || 'none'}</span></li>
          <li>thresholds: 256 ≥ 352, 512 ≥ 608, 1024 ≥ 1120, 2048 ≥ 2144, <span className="text-fg">4096 needs netdev MTU ≥ 4192</span></li>
          {active > 0 && <li>largest RoCE packet (WRITE first, with RETH) = {active} + IP {hdr} + UDP 8 + BTH 12 + RETH 16 + ICRC 4 = <span className="font-mono text-fg">{fmt(roceIp)} B</span>{ov ? <> ; + VXLAN {ov} (inner Ethernet 14 + VXLAN 8 + UDP 8 + outer IP {ov - 30}) = <span className="font-mono text-fg">{fmt(roceIp + ov)} B</span> outer IP</> : null}</li>}
          {conv === 'l2' && <li>L2 convention: size = IP length + Ethernet 14{vlan ? ' + tag 4' : ''} (FCS not counted here; some platforms include it, check yours)</li>}
          <li>effective path MTU for host packets = min(host {fmt(netdev)}, hop MTU − overheads) = <span className="font-mono text-fg">{fmt(pathInner)}</span>; DF ping payload = {fmt(pathInner)} − {hdr} − 8 = <span className="font-mono text-fg">{fmt(pingMaxPayload(pathInner, ipv6))}</span></li>
        </ol>
      </div>

      <div className="flex flex-wrap gap-2">
        <Pill>IB MTU ceiling 4096</Pill>
        {overlay !== 'none' && <Pill>underlay needs ≥ host MTU + {ov}</Pill>}
        {vlan && <Pill>tagged frame = IP + 18 + 4 FCS</Pill>}
      </div>

      <p className="text-[11px] leading-relaxed text-muted">
        The 96-byte rule is the upstream kernel's <span className="font-mono">iboe_get_mtu()</span> (used by mlx5 and other RoCE drivers, then capped by the port's
        max_mtu); it reserves a worst case, so real RoCEv2 packets are smaller than the netdev MTU. Older kernels and some vendor drivers may compute it
        differently: trust <span className="font-mono">ibv_devinfo</span> active_mtu on your system. The RoCE size shown is the first packet of an RDMA WRITE (with RETH);
        middle packets are 16 B smaller, and a few packet types (WRITE with immediate, XRC) carry 4-8 B more, still inside the 96 B reserve. VXLAN overhead assumes no outer VLAN and that the inner VLAN tag is not carried. Switch MTU semantics
        (L3 vs L2, with or without FCS) are platform-specific; check your switch OS documentation.
      </p>
    </div>
  );
}
