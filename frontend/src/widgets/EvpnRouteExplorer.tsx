import { useState } from 'react';
import { Pill } from '../components/ui';

// ---------- data (RFC 7432 sec. 7, RFC 8365 for VXLAN, RFC 9136 for type 5, RFC 9135 for IRB) ----------

export interface Field { name: string; bytes: string; note: string }
export interface RouteType {
  type: number; name: string; short: string; rfc: string; purpose: string; when: string; breaks: string;
  fields: Field[]; attrs: string[];
}

export const ROUTE_TYPES: RouteType[] = [
  {
    type: 1, name: 'Ethernet Auto-Discovery (EAD)', short: 'EAD', rfc: 'RFC 7432 §7.1, §8.2, §8.4',
    purpose: 'Advertises reachability of a multihomed Ethernet segment. Per-ES EAD enables mass withdraw (and carries the ESI Label for split horizon); per-EVI EAD enables aliasing (remote VTEPs load-balance to every leaf on the segment).',
    when: 'When a leaf has a local, non-zero ESI configured and the segment link is up: one per-ES route per segment, plus one per-EVI route per EVI (VNI) on that segment.',
    breaks: 'Remote leaves only send to the leaf that happened to advertise the MAC (no aliasing), and a link failure is repaired MAC by MAC through individual type 2 withdrawals instead of one segment-wide withdrawal.',
    fields: [
      { name: 'Route Distinguisher', bytes: '8', note: 'makes the route unique, e.g. 10.0.0.11:2' },
      { name: 'Ethernet Segment Identifier', bytes: '10', note: 'non-zero ESI shared by all leaves on the segment' },
      { name: 'Ethernet Tag ID', bytes: '4', note: 'per-ES: MAX-ET 0xFFFFFFFF; per-EVI: tag of the EVI (0 in VLAN-based service)' },
      { name: 'MPLS Label (VNI)', bytes: '3', note: 'per-ES: 0; per-EVI: VNI for aliasing (RFC 8365)' },
    ],
    attrs: ['Route Targets', 'ESI Label extended community (per-ES route; single-active / all-active flag)'],
  },
  {
    type: 2, name: 'MAC/IP Advertisement', short: 'MAC/IP', rfc: 'RFC 7432 §7.2, RFC 9135',
    purpose: 'Advertises a host MAC, optionally with its IP, and the VNI(s) and VTEP that reach it. Remote leaves program MAC → VXLAN tunnel; with the IP they can answer ARP locally and install /32 or /128 host routes.',
    when: 'When a leaf learns a MAC on a local port (data plane learning on the access side). A second route with MAC + IP is sent once the IP binding is known (ARP/ND snooping, DHCP, or the IRB interface).',
    breaks: 'No control-plane learning: VTEPs fall back to flood-and-learn, ARP requests are flooded across the fabric (no ARP suppression) and symmetric IRB has no host routes.',
    fields: [
      { name: 'Route Distinguisher', bytes: '8', note: 'per EVI, e.g. 10.0.0.11:2' },
      { name: 'Ethernet Segment Identifier', bytes: '10', note: '0 if single-homed, else the segment ESI' },
      { name: 'Ethernet Tag ID', bytes: '4', note: '0 in VLAN-based service (RFC 8365)' },
      { name: 'MAC Address Length / MAC', bytes: '1 + 6', note: '48 and the host MAC' },
      { name: 'IP Address Length / IP', bytes: '1 + 0, 4 or 16', note: '0 (MAC only), 32 or 128' },
      { name: 'MPLS Label1 (L2 VNI)', bytes: '3', note: 'the bridging VNI, e.g. 10100' },
      { name: 'MPLS Label2 (L3 VNI)', bytes: '0 or 3', note: 'symmetric IRB: the tenant VRF VNI, e.g. 50001' },
    ],
    attrs: ['Route Targets', 'BGP Encapsulation extended community (VXLAN)', 'Router MAC (with L3 VNI)', 'MAC Mobility (sequence number, when a MAC moves)'],
  },
  {
    type: 3, name: 'Inclusive Multicast Ethernet Tag (IMET)', short: 'IMET', rfc: 'RFC 7432 §7.3, RFC 8365 §5.1.3',
    purpose: '"I am a VTEP for this VNI and this is how to flood to me." Every leaf builds its per-VNI flood list (ingress replication) from these routes.',
    when: 'As soon as the VNI is configured and up on the leaf, before any host is learned. One per VNI per VTEP.',
    breaks: 'No BUM (broadcast, unknown unicast, multicast) delivery to that VTEP: the first ARP of a host behind it never arrives and silent hosts stay unreachable.',
    fields: [
      { name: 'Route Distinguisher', bytes: '8', note: 'per EVI' },
      { name: 'Ethernet Tag ID', bytes: '4', note: '0 in VLAN-based service' },
      { name: 'IP Address Length', bytes: '1', note: '32 (IPv4 VTEP) or 128' },
      { name: "Originating Router's IP Address", bytes: '4 or 16', note: 'the VTEP address, e.g. 10.0.0.11' },
    ],
    attrs: ['Route Targets', 'PMSI Tunnel attribute: tunnel type ingress replication, label = VNI', 'BGP Encapsulation extended community (VXLAN)'],
  },
  {
    type: 4, name: 'Ethernet Segment', short: 'ES', rfc: 'RFC 7432 §7.4, §8.5',
    purpose: 'Lets the leaves attached to the same Ethernet segment discover each other and elect a designated forwarder (DF) per VNI for BUM traffic.',
    when: 'When a non-zero ESI is configured on a local port (multihoming / ESI-LAG). Imported only by leaves on the same segment (ES-Import RT).',
    breaks: 'No DF election: every leaf on the segment forwards floods to the host, so it receives each broadcast, unknown-unicast or multicast frame once per attached leaf (duplicates).',
    fields: [
      { name: 'Route Distinguisher', bytes: '8', note: 'per leaf' },
      { name: 'Ethernet Segment Identifier', bytes: '10', note: 'the segment' },
      { name: 'IP Address Length', bytes: '1', note: '32 or 128' },
      { name: "Originating Router's IP Address", bytes: '4 or 16', note: 'used as the DF election candidate' },
    ],
    attrs: ['ES-Import Route Target (derived from the ESI)'],
  },
  {
    type: 5, name: 'IP Prefix', short: 'IP prefix', rfc: 'RFC 9136',
    purpose: 'Advertises an IP prefix in a tenant VRF, decoupled from any MAC: subnets, silent hosts, and external routes such as a default route from the border leaves.',
    when: 'When the leaf is told to advertise the VRF unicast routes into EVPN (connected subnets, static or redistributed routes, routes learned from external peers).',
    breaks: 'The overlay only knows hosts it has seen as type 2 routes: no subnet routes for silent hosts, no default route into the tenant VRF, no external or inter-fabric prefixes.',
    fields: [
      { name: 'Route Distinguisher', bytes: '8', note: 'per VRF, e.g. 10.0.0.11:3' },
      { name: 'Ethernet Segment Identifier', bytes: '10', note: 'usually 0 (overlay index alternative)' },
      { name: 'Ethernet Tag ID', bytes: '4', note: '0' },
      { name: 'IP Prefix Length / IP Prefix', bytes: '1 + 4 or 16', note: 'e.g. 24 / 10.1.100.0' },
      { name: 'Gateway IP Address', bytes: '4 or 16', note: '0 when the next hop is the VTEP itself (interface-less model)' },
      { name: 'MPLS Label (L3 VNI)', bytes: '3', note: 'the VRF VNI, e.g. 50001' },
    ],
    attrs: ['Route Targets', 'BGP Encapsulation extended community (VXLAN)', 'Router MAC (interface-less model over VXLAN)'],
  },
];

export interface Advert { type: number; nlri: string; detail: string; effect: string }
export interface Step { title: string; trigger: string; routes: Advert[] }

const VTEP = '10.0.0.11', MAC = '00:00:5e:00:53:01', IP = '10.1.100.21', ESI = '00:11:22:33:44:55:66:77:88:99';

/** The bring-up of one host behind leaf1, as a list of BGP EVPN advertisements (NLRI fields in RFC order, RD and labels omitted). */
export function scenario(multihomed: boolean): Step[] {
  const esi = multihomed ? ESI : '0';
  const steps: Step[] = [];
  if (multihomed) steps.push({
    title: 'ESI configured on the bond to H1', trigger: 'H1 is dual-homed (LACP) to leaf1 and leaf2; both set the same ESI on that port.',
    routes: [
      { type: 4, nlri: `[4]:[${ESI}]:[32]:[${VTEP}]`, detail: 'RD 10.0.0.11:1, ES-Import RT from the ESI', effect: 'leaf1 and leaf2 find each other and elect a DF for VNI 10100.' },
      { type: 1, nlri: `[1]:[${ESI}]:[4294967295]`, detail: 'per-ES EAD, Ethernet Tag MAX-ET, ESI Label ext. community', effect: 'remote leaves can withdraw the whole segment at once (mass withdraw).' },
      { type: 1, nlri: `[1]:[${ESI}]:[0]`, detail: 'per-EVI EAD, label/VNI 10100', effect: 'remote leaves may send to leaf1 or leaf2 for any MAC on this ESI (aliasing).' },
    ],
  });
  steps.push(
    { title: 'VNI 10100 configured on leaf1', trigger: 'The VLAN-to-VNI mapping and the VTEP come up; no host learned yet.',
      routes: [{ type: 3, nlri: `[3]:[0]:[32]:[${VTEP}]`, detail: 'RD 10.0.0.11:2, RT 65101:10100, PMSI tunnel: ingress replication, label 10100', effect: `every leaf with VNI 10100 adds ${VTEP} to its flood list.` }] },
    { title: 'H1 sends its first frame', trigger: `leaf1 learns ${MAC} on its server port in VLAN/VNI 10100.`,
      routes: [{ type: 2, nlri: `[2]:[${esi}]:[0]:[48]:[${MAC}]`, detail: 'Label1 = L2 VNI 10100, next hop = VTEP 10.0.0.11, encapsulation VXLAN', effect: `remote leaves program ${MAC} → VXLAN to ${VTEP}; no more flooding to reach H1.` }] },
    { title: 'H1 ARPs for its gateway', trigger: `leaf1 snoops the ARP (or sees it on the anycast gateway) and binds ${IP} to ${MAC}.`,
      routes: [{ type: 2, nlri: `[2]:[${esi}]:[0]:[48]:[${MAC}]:[32]:[${IP}]`, detail: 'Label1 = 10100, Label2 = L3 VNI 50001, Router MAC of leaf1', effect: `remote leaves answer ARP for ${IP} locally (ARP suppression) and install ${IP}/32 in VRF tenant-a.` }] },
    { title: 'Advertise the subnet into the VRF', trigger: 'VRF tenant-a (L3 VNI 50001) is set to advertise its unicast routes into EVPN.',
      routes: [{ type: 5, nlri: '[5]:[0]:[0]:[24]:[10.1.100.0]:[0.0.0.0]', detail: 'RD 10.0.0.11:3, label = L3 VNI 50001, gateway IP 0.0.0.0, Router MAC', effect: 'other subnets, border leaves and silent hosts in 10.1.100.0/24 are reachable by routing even without a type 2 for every host.' }] },
  );
  return steps;
}

// ---------- UI ----------

const typeTone = ['', 'text-warn', 'text-accent', 'text-data', 'text-warn', 'text-data'];

export default function EvpnRouteExplorer() {
  const [sel, setSel] = useState(2);
  const [mh, setMh] = useState(false);
  const [step, setStep] = useState(0);
  const steps = scenario(mh);
  const cur = Math.min(step, steps.length - 1);
  const rt = ROUTE_TYPES.find((r) => r.type === sel)!;
  const sent = steps.slice(0, cur + 1).flatMap((s) => s.routes);

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="EVPN route types">
        <table className="w-full min-w-[560px] text-left text-sm">
          <thead className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
            <tr><th className="py-1 pr-3">Type</th><th className="py-1 pr-3">Name</th><th className="py-1 pr-3">Key NLRI fields</th><th className="py-1">Solves</th></tr>
          </thead>
          <tbody>
            {ROUTE_TYPES.map((r) => (
              <tr key={r.type} className={`border-t border-line ${r.type === sel ? 'bg-accent-soft' : ''}`}>
                <td className="py-1.5 pr-3"><button type="button" aria-pressed={r.type === sel} onClick={() => setSel(r.type)}
                  className={`min-h-6 rounded-md border px-2 py-0.5 font-mono text-xs ${r.type === sel ? 'border-accent text-accent' : 'border-line bg-panel hover:bg-panel-2'}`}>Type {r.type}</button></td>
                <td className="py-1.5 pr-3">{r.name}</td>
                <td className="py-1.5 pr-3 font-mono text-[11px] text-muted">{r.fields.map((f) => f.name.replace(' Address', '').replace("Originating Router's IP", 'Orig. router IP')).join(' · ')}</td>
                <td className="py-1.5 text-xs text-muted">{['', 'multihoming: aliasing, mass withdraw', 'host MAC/IP reachability, ARP suppression', 'BUM flood list per VNI', 'DF election on a segment', 'prefixes in a tenant VRF'][r.type]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="rounded-lg border border-line bg-panel-2 p-3" aria-live="polite">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className={`font-mono text-lg font-bold ${typeTone[rt.type]}`}>Type {rt.type}</span>
          <span className="font-semibold">{rt.name}</span>
          <Pill>{rt.rfc}</Pill>
        </div>
        <div className="mt-2 grid gap-3 md:grid-cols-2">
          <div className="space-y-2 text-sm">
            <p><span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">Purpose </span>{rt.purpose}</p>
            <p><span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">Advertised </span>{rt.when}</p>
            <p className="text-danger"><span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">Without it </span>{rt.breaks}</p>
            <p className="text-xs text-muted">Path attributes: {rt.attrs.join('; ')}.</p>
          </div>
          <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={`Type ${rt.type} NLRI fields`}>
            <table className="w-full text-left text-xs">
              <thead className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted"><tr><th className="pb-1 pr-2">NLRI field</th><th className="pb-1 pr-2">Bytes</th><th className="pb-1">In VXLAN fabrics</th></tr></thead>
              <tbody>{rt.fields.map((f) => <tr key={f.name} className="border-t border-line"><td className="py-1 pr-2 font-mono">{f.name}</td><td className="py-1 pr-2 font-mono tabular-nums">{f.bytes}</td><td className="py-1 text-muted">{f.note}</td></tr>)}</tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-line p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-semibold">Scenario: host H1 joins VNI 10100 behind leaf1 (VTEP {VTEP}, VRF tenant-a, L3 VNI 50001)</div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={mh} onChange={(e) => { setMh(e.target.checked); setStep(0); }} className="accent-[var(--accent)]" />H1 dual-homed (ESI)</label>
        </div>
        <div className="mt-2 flex flex-wrap gap-1" role="group" aria-label="Scenario steps">
          {steps.map((s, i) => <button key={s.title} type="button" aria-current={i === cur ? 'step' : undefined} onClick={() => setStep(i)}
            className={`rounded-md border px-2 py-1 font-mono text-xs ${i === cur ? 'border-accent bg-accent-soft text-accent' : i < cur ? 'border-line bg-panel-2' : 'border-line bg-panel hover:bg-panel-2'}`}>{i + 1}. {s.title}</button>)}
        </div>
        <div className="mt-2 flex gap-2">
          <button type="button" onClick={() => setStep(Math.max(0, cur - 1))} disabled={cur === 0} className="rounded-md border border-line bg-panel px-3 py-1 text-xs hover:bg-panel-2 disabled:opacity-40"><span aria-hidden>◀ </span>Back</button>
          <button type="button" onClick={() => setStep(Math.min(steps.length - 1, cur + 1))} disabled={cur === steps.length - 1} className="rounded-md border border-line bg-panel px-3 py-1 text-xs hover:bg-panel-2 disabled:opacity-40">Next<span aria-hidden> ▶</span></button>
        </div>
        <p className="mt-2 text-sm text-muted" aria-live="polite"><span className="sr-only">Step {cur + 1} of {steps.length}: {steps[cur].title}. </span><span className="text-fg">Trigger:</span> {steps[cur].trigger}</p>
        <ul className="mt-2 space-y-2">
          {steps[cur].routes.map((r) => (
            <li key={r.nlri} className="rounded-md border border-line bg-panel-2 px-3 py-2 text-sm">
              <button type="button" onClick={() => setSel(r.type)} aria-label={`Type ${r.type}: show route type details`} className={`min-h-6 font-mono text-xs font-semibold underline-offset-2 hover:underline ${typeTone[r.type]}`}>Type {r.type}</button>
              <div className="break-all font-mono text-xs text-fg">{r.nlri}</div>
              <div className="text-xs text-muted">{r.detail}</div>
              <div className="mt-0.5 text-xs">→ {r.effect}</div>
            </li>
          ))}
        </ul>
        <div className="mt-3 text-xs text-muted">Routes leaf1 has advertised so far: {sent.map((r) => `type ${r.type}`).join(', ')} ({sent.length}). A remote leaf with VNI 10100 and VRF tenant-a imports all of them by Route Target.</div>
      </div>

      <p className="text-[11px] leading-relaxed text-muted">
        Bracket notation lists the NLRI fields in RFC order after the route type, omitting RD and labels (FRR's display is similar but leaves out some fields such as the ESI); values are illustrative (MAC from the documentation range 00:00:5e:00:53:xx). Field layouts follow RFC 7432 §7 and RFC 9136;
        VXLAN carries the VNI in the label fields (RFC 8365). RD and RT values are auto-derived differently by each NOS, and whether a MAC-only type 2 is sent before the
        MAC+IP one is implementation-specific; check your platform's documentation. Labels are 3 bytes (24 bits), so a VNI fits exactly.
      </p>
    </div>
  );
}
