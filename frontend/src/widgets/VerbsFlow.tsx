import { useEffect, useMemo, useState } from 'react';
import { Pill } from '../components/ui';

export type Op = 'write' | 'send' | 'read';
export type Part = 'cpuA' | 'memA' | 'nicA' | 'wire' | 'nicB' | 'memB' | 'cpuB';
export interface Packet { psn: number; opcode: string; headers: string; bytes: number; dir: 'A→B' | 'B→A' }
export interface Step { title: string; detail: string; active: Part[]; packets?: Packet[]; tone?: 'danger' | 'accent' }

const PSN0 = 1000; // illustrative starting PSN (agreed at RTR/RTS: rq_psn / sq_psn)

/** Number of packets an RC message of `bytes` needs at path MTU `mtu` (a zero-length message still takes one packet). */
export function packetCount(bytes: number, mtu: number): number {
  return Math.max(1, Math.ceil(bytes / mtu));
}

/** IBTA opcode names for an RC message split into packets. prefix: RDMA_WRITE, SEND or RDMA_READ_RESPONSE. */
export function segmentOpcodes(prefix: string, n: number): string[] {
  if (n === 1) return [`${prefix}_ONLY`];
  return Array.from({ length: n }, (_, i) => `${prefix}_${i === 0 ? 'FIRST' : i === n - 1 ? 'LAST' : 'MIDDLE'}`);
}

export function segment(op: Op, bytes: number, mtu: number): Packet[] {
  const n = packetCount(bytes, mtu);
  const prefix = op === 'write' ? 'RDMA_WRITE' : op === 'send' ? 'SEND' : 'RDMA_READ_RESPONSE';
  return segmentOpcodes(prefix, n).map((opcode, i) => {
    const len = i === n - 1 ? bytes - mtu * (n - 1) : mtu;
    let headers = 'BTH';
    if (op === 'write' && i === 0) headers = 'BTH + RETH';
    // Read responses carry an AETH on FIRST, LAST and ONLY, not on MIDDLE.
    if (op === 'read' && (i === 0 || i === n - 1)) headers = 'BTH + AETH';
    return { psn: PSN0 + i, opcode, headers, bytes: len, dir: op === 'read' ? 'B→A' : 'A→B' };
  });
}

export function buildSteps(op: Op, bytes: number, mtu: number, inline: boolean, badRkey: boolean): Step[] {
  const pk = segment(op, bytes, mtu);
  const n = pk.length;
  const last = PSN0 + n - 1;
  const opName = { write: 'IBV_WR_RDMA_WRITE', send: 'IBV_WR_SEND', read: 'IBV_WR_RDMA_READ' }[op];
  const wcOp = { write: 'IBV_WC_RDMA_WRITE', send: 'IBV_WC_SEND', read: 'IBV_WC_RDMA_READ' }[op];
  const s: Step[] = [];

  if (op === 'send') s.push({ title: 'Receiver pre-posts a receive WQE', active: ['cpuB', 'memB'],
    detail: 'Earlier, host B called ibv_post_recv(): a receive WQE with an SGE (addr, len, lkey of B\'s own MR) sits in B\'s receive queue (or SRQ). A SEND can only land in a buffer the receiver offered in advance.' });

  s.push({ title: op === 'read' ? 'App prepares the local sink buffer' : 'App fills a registered buffer', active: ['cpuA', 'memA'],
    detail: op === 'read'
      ? 'Host A owns a buffer registered with ibv_reg_mr(..., IBV_ACCESS_LOCAL_WRITE) so its NIC may write the returned data there (lkey). From B it learned, out of band, the remote address and an rkey of an MR registered with IBV_ACCESS_REMOTE_READ.'
      : op === 'write'
        ? 'Host A writes its data into a buffer registered with ibv_reg_mr() (pinned, translated, lkey). From B it learned, out of band (TCP bootstrap, rdma_cm), the remote virtual address and the rkey of an MR that B registered with IBV_ACCESS_REMOTE_WRITE.'
        : 'Host A writes its data into a buffer registered with ibv_reg_mr() (lkey). SEND needs no remote address or rkey: B decides where the data lands.' });

  const sge = `SGE {addr, length=${bytes.toLocaleString('en-US')}, lkey}`;
  s.push({ title: 'ibv_post_send builds a WQE in the send queue', active: ['cpuA', 'memA'],
    detail: `The provider library (e.g. libmlx5) writes a WQE into the SQ ring in host memory: opcode ${opName}, wr_id, IBV_SEND_SIGNALED, ` +
      (inline ? `and, because of IBV_SEND_INLINE, the ${bytes} payload bytes copied by the CPU into the WQE itself (no SGE is dereferenced later; must fit max_inline_data). `
        : `${sge}. `) +
      (op === 'send' ? 'No remote address or rkey.' : 'Plus a remote-address segment {remote_addr, rkey}.') + ' No system call happens.' });

  s.push({ title: 'Doorbell: one MMIO write to the NIC', active: ['cpuA', 'memA', 'nicA'],
    detail: 'The library writes the new SQ producer index to a doorbell register in a UAR page that is mapped into the process. That posted write crosses PCIe to the NIC. (ConnectX can also push a small WQE with the doorbell, "BlueFlame"; an implementation detail of the provider.)' });

  s.push({ title: inline || op === 'read' ? 'NIC DMA-reads the WQE' : 'NIC DMA-reads the WQE, then the payload', active: ['memA', 'nicA'],
    detail: op === 'read'
      ? 'The NIC fetches the WQE over PCIe. There is no local payload to read: the data comes back from B.'
      : inline
        ? 'The NIC fetches the WQE over PCIe (unless it was pushed with the doorbell). The payload is already inside it, so there is no second DMA read: that saved PCIe round trip is why inline lowers latency for tiny messages.'
        : 'The NIC fetches the WQE over PCIe, translates the SGE through the MR (lkey checks PD, bounds and access) and issues PCIe reads for the payload from host or GPU memory. The CPU is no longer involved.' });

  if (op === 'read') {
    s.push({ title: 'NIC sends one RDMA READ request', active: ['nicA', 'wire'],
      packets: [{ psn: PSN0, opcode: 'RDMA_READ_REQUEST', headers: 'BTH + RETH', bytes: 0, dir: 'A→B' }],
      detail: `A single request packet carries the RETH {remote VA, rkey, DMA length = ${bytes.toLocaleString('en-US')}} and no payload. It reserves PSNs ${PSN0}..${last} for the ${n} response packet(s). Outstanding reads per QP are capped by max_rd_atomic (and the peer's max_dest_rd_atomic).` });
  } else {
    s.push({ title: `Segmentation into ${n} packet${n > 1 ? 's' : ''} at path MTU ${mtu}`, active: ['nicA'], packets: pk,
      detail: `${bytes.toLocaleString('en-US')} B / ${mtu} B → ${n} packet(s), consecutive PSNs ${PSN0}..${last}. ` +
        (op === 'write' ? 'Only the first (or only) packet carries the RETH; the responder remembers address and rkey for the rest. ' : 'SEND packets carry no RETH. ') +
        'The last packet normally has the AckReq bit set. On RoCEv2 each one is wrapped in Ethernet / IP / UDP (dst port 4791) with ICRC.' });
    s.push({ title: 'Packets cross the wire', active: ['nicA', 'wire', 'nicB'],
      detail: 'Switches forward them like any UDP traffic (ideally in a lossless or ECN-controlled class). The RC responder checks that each PSN is the next expected one; a gap would trigger a PSN-sequence-error NAK and go-back-N retransmission.' });
  }

  if (badRkey) {
    s.push({ title: 'Remote NIC rejects the rkey', active: ['nicB'], tone: 'danger',
      detail: `B's NIC looks up the rkey from the RETH: it is unknown, belongs to another PD, lacks ${op === 'read' ? 'REMOTE_READ' : 'REMOTE_WRITE'}, or [VA, VA+len) is outside the MR. Nothing is ${op === 'read' ? 'read' : 'written'}. Any following packets of the same message are discarded. The responder QP typically moves to the error state as well, raising an affiliated async event (IBV_EVENT_QP_ACCESS_ERR) on B.` });
    s.push({ title: 'NAK: Remote Access Error', active: ['nicB', 'wire', 'nicA'], tone: 'danger',
      packets: [{ psn: PSN0, opcode: 'ACKNOWLEDGE (NAK)', headers: 'BTH + AETH (syndrome: NAK, Remote Access Error)', bytes: 0, dir: 'B→A' }],
      detail: 'The AETH syndrome says NAK with code Remote Access Error. Unlike a sequence error or a timeout, this is not retried: retransmitting cannot fix a bad key.' });
    s.push({ title: 'Error CQE, QP to ERR', active: ['nicA', 'memA'], tone: 'danger',
      detail: 'A\'s NIC writes a CQE with status IBV_WC_REM_ACCESS_ERR (only wr_id, status, qp_num and vendor_err are valid in an error completion). The QP moves to IBV_QPS_ERR, and every WR still queued on it completes with IBV_WC_WR_FLUSH_ERR.' });
    s.push({ title: 'App polls and finds the error', active: ['cpuA', 'memA'], tone: 'danger',
      detail: 'ibv_poll_cq returns the error. ibv_wc_status_str() prints "remote access error". Recovery: fix the key exchange (stale rkey, deregistered MR, missing access flag), then reset or recreate the QP.' });
    return s;
  }

  if (op === 'write') {
    s.push({ title: 'Remote NIC checks the rkey and DMA-writes', active: ['nicB', 'memB'],
      detail: 'B\'s NIC validates the rkey, bounds and REMOTE_WRITE permission from the RETH, then writes each packet\'s payload straight into B\'s memory over B\'s PCIe. B\'s CPU is not interrupted, and no CQE appears on B. Only IBV_WR_RDMA_WRITE_WITH_IMM would consume a receive WQE and create a CQE on B.' });
  } else if (op === 'send') {
    s.push({ title: 'Remote NIC consumes the receive WQE', active: ['nicB', 'memB'],
      detail: 'B\'s NIC takes the next receive WQE and scatters the payload into its SGE(s). With no receive posted, it would answer with an RNR NAK (retried up to rnr_retry). If the buffer is too small, the receive completes with IBV_WC_LOC_LEN_ERR.' });
    s.push({ title: 'Remote CQE: IBV_WC_RECV', active: ['nicB', 'memB', 'cpuB'], tone: 'accent',
      detail: 'Once the whole message is placed, B\'s NIC writes a CQE (status IBV_WC_SUCCESS, opcode IBV_WC_RECV, the receive WR\'s wr_id, byte_len; src_qp is only meaningful for UD) into B\'s CQ. B\'s application must poll it: two-sided means both CPUs take part, though neither copies data.' });
  } else {
    s.push({ title: 'Remote NIC checks the rkey and DMA-reads', active: ['nicB', 'memB'],
      detail: 'B\'s NIC validates rkey, bounds and REMOTE_READ, then reads the data from B\'s memory over PCIe. B\'s CPU does nothing, and B gets no completion.' });
    s.push({ title: `${n} READ response packet${n > 1 ? 's' : ''} flow back`, active: ['nicB', 'wire', 'nicA'], packets: pk,
      detail: 'Responses use the PSNs the request reserved. FIRST, LAST and ONLY carry an AETH; the responses themselves acknowledge the request, so there is no separate ACK.' });
    s.push({ title: 'Local NIC DMA-writes into the sink buffer', active: ['nicA', 'memA'],
      detail: 'A\'s NIC places each response payload into the local SGE (checked against the lkey and LOCAL_WRITE).' });
  }

  if (op !== 'read') s.push({ title: 'ACK comes back', active: ['nicB', 'wire', 'nicA'],
    packets: [{ psn: last, opcode: 'ACKNOWLEDGE', headers: 'BTH + AETH (syndrome: ACK, credits / MSN)', bytes: 0, dir: 'B→A' }],
    detail: `B acknowledges PSN ${last}; ACKs are cumulative and may be coalesced. A's NIC can now retire the WQE. If no ACK arrives within 4.096 µs × 2^timeout, A retransmits up to retry_cnt times before IBV_WC_RETRY_EXC_ERR.` });

  s.push({ title: `Local CQE: ${wcOp}`, active: ['nicA', 'memA'], tone: 'accent',
    detail: `A's NIC DMA-writes a CQE into A's CQ: status IBV_WC_SUCCESS, opcode ${wcOp}, the WR's wr_id. ` +
      (op === 'read' ? 'For a READ this means the data is now in local memory.' : 'For RC it means B\'s NIC has the data, not that B\'s application has seen it.') + ' (An unsignaled WR produces no CQE unless it fails.)' });
  s.push({ title: 'App polls the CQ', active: ['cpuA', 'memA'], tone: 'accent',
    detail: 'ibv_poll_cq() reads the CQE from host memory without a system call and matches wr_id to the request. The buffer may now be reused.' });
  return s;
}

const PARTS: { id: Part; label: string; host: 'A' | 'B' | '' }[] = [
  { id: 'cpuA', label: 'CPU / app', host: 'A' }, { id: 'memA', label: 'Memory + PCIe', host: 'A' }, { id: 'nicA', label: 'NIC', host: 'A' },
  { id: 'wire', label: 'Wire / fabric', host: '' },
  { id: 'nicB', label: 'NIC', host: 'B' }, { id: 'memB', label: 'Memory + PCIe', host: 'B' }, { id: 'cpuB', label: 'CPU / app', host: 'B' },
];
const SIZES = [64, 4096, 10000, 1048576];
const fmtSize = (b: number) => (b >= 1048576 ? `${b / 1048576} MiB` : `${b.toLocaleString('en-US')} B`);

function Seg<T extends string | number>({ label, value, options, onChange, render, disabled }: {
  label: string; value: T; options: readonly T[]; onChange: (v: T) => void; render?: (v: T) => string; disabled?: (v: T) => boolean;
}) {
  return (
    <div>
      <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{label}</div>
      <div className="flex flex-wrap gap-1">
        {options.map((o) => (
          <button key={String(o)} type="button" onClick={() => onChange(o)} aria-pressed={o === value} disabled={disabled?.(o)}
            className={`rounded-md border px-2 py-1 font-mono text-xs disabled:opacity-30 ${o === value ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-panel hover:bg-panel-2'}`}>
            {render ? render(o) : String(o)}
          </button>
        ))}
      </div>
    </div>
  );
}

function Toggle({ label, on, set, disabled }: { label: string; on: boolean; set: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button type="button" aria-pressed={on} disabled={disabled} onClick={() => set(!on)}
      className={`rounded-md border px-2 py-1 font-mono text-xs disabled:opacity-30 ${on ? 'border-warn bg-panel-2 text-warn' : 'border-line bg-panel hover:bg-panel-2'}`}>
      {on ? '✓ ' : ''}{label}
    </button>
  );
}

export default function VerbsFlow() {
  const [op, setOp] = useState<Op>('write');
  const [size, setSize] = useState(10000);
  const [mtu, setMtu] = useState(4096);
  const [inlineReq, setInline] = useState(false);
  const [badReq, setBad] = useState(false);
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);

  const inlineOk = op !== 'read' && size <= 64;
  const inline = inlineReq && inlineOk;
  const badOk = op !== 'send';
  const bad = badReq && badOk;
  const steps = useMemo(() => buildSteps(op, size, mtu, inline, bad), [op, size, mtu, inline, bad]);
  const idx = Math.min(i, steps.length - 1);
  const step = steps[idx];

  useEffect(() => { setI(0); setPlaying(false); }, [op, size, mtu, inline, bad]);
  useEffect(() => {
    if (!playing) return;
    if (idx >= steps.length - 1) { setPlaying(false); return; }
    const t = window.setTimeout(() => setI((v) => v + 1), 1800);
    return () => window.clearTimeout(t);
  }, [playing, idx, steps.length]);

  const shownPk = step.packets && step.packets.length > 5 ? [...step.packets.slice(0, 3), null, step.packets[step.packets.length - 1]] : step.packets;
  const activeColor = step.tone === 'danger' ? 'border-danger bg-panel-2 text-danger' : 'border-accent bg-accent-soft text-accent';

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Seg label="Operation (RC)" value={op} options={['write', 'send', 'read'] as const} onChange={setOp}
          render={(v) => ({ write: 'RDMA WRITE', send: 'SEND / RECV', read: 'RDMA READ' }[v])} />
        <Seg label="Message size" value={size} options={SIZES} onChange={setSize} render={fmtSize} />
        <Seg label="Path MTU" value={mtu} options={[1024, 4096]} onChange={setMtu} />
        <div>
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">What if</div>
          <div className="flex flex-wrap gap-1">
            <Toggle label="IBV_SEND_INLINE" on={inline} set={setInline} disabled={!inlineOk} />
            <Toggle label="wrong rkey" on={bad} set={setBad} disabled={!badOk} />
          </div>
          <div className="mt-1 text-[11px] text-muted">
            {!inlineOk && (op === 'read' ? 'Inline does not apply to READ. ' : 'Inline needs a tiny message (pick 64 B). ')}
            {!badOk && 'SEND uses no rkey.'}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-7" aria-label="Components touched in this step">
        {PARTS.map((p) => {
          const on = step.active.includes(p.id);
          return (
            <div key={p.id} className={`rounded-lg border px-1.5 py-2 text-center motion-safe:transition ${on ? activeColor : 'border-line bg-panel text-muted'}`}>
              <div className="font-mono text-[10px] uppercase tracking-[0.1em]">{p.host ? `Host ${p.host}` : 'Network'}</div>
              <div className="text-xs font-semibold leading-tight">{p.label}</div>
              {p.id === 'cpuB' && op !== 'send' && <div className="mt-0.5 text-[10px] text-muted">untouched</div>}
            </div>
          );
        })}
      </div>

      <div className={`rounded-xl border p-4 ${step.tone === 'danger' ? 'border-danger/50' : 'border-line'} bg-panel-2`} aria-live="polite">
        <div className="mb-1 font-mono text-[11px] text-muted">Step {idx + 1} / {steps.length}</div>
        <div className={`text-base font-semibold ${step.tone === 'danger' ? 'text-danger' : ''}`}>{step.title}</div>
        <p className="mt-1.5 text-sm leading-relaxed text-muted">{step.detail}</p>
        {shownPk && (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[420px] text-left font-mono text-xs">
              <thead className="text-muted"><tr><th className="py-1 pr-3">PSN</th><th className="pr-3">BTH opcode</th><th className="pr-3">Headers</th><th className="pr-3">Payload</th><th>Dir</th></tr></thead>
              <tbody>
                {shownPk.map((p, k) => p ? (
                  <tr key={k} className="border-t border-line">
                    <td className="py-1 pr-3 text-data">{p.psn}</td><td className="pr-3 text-fg">{p.opcode}</td><td className="pr-3">{p.headers}</td>
                    <td className="pr-3">{p.bytes ? `${p.bytes.toLocaleString('en-US')} B` : '—'}</td><td>{p.dir}</td>
                  </tr>
                ) : (
                  <tr key={k} className="border-t border-line text-muted"><td colSpan={5} className="py-1">… {(step.packets!.length - 4).toLocaleString('en-US')} more MIDDLE packets …</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => { setPlaying(false); setI(Math.max(0, idx - 1)); }} disabled={idx === 0}
          className="rounded-lg border border-line bg-panel px-3 py-1.5 text-sm hover:bg-panel-2 disabled:opacity-40">← Prev</button>
        <button type="button" onClick={() => { setPlaying(false); setI(Math.min(steps.length - 1, idx + 1)); }} disabled={idx === steps.length - 1}
          className="rounded-lg border border-line bg-panel px-3 py-1.5 text-sm hover:bg-panel-2 disabled:opacity-40">Next →</button>
        <button type="button" aria-pressed={playing} onClick={() => { if (idx >= steps.length - 1) setI(0); setPlaying(!playing); }}
          className="rounded-lg border border-accent bg-accent-soft px-3 py-1.5 text-sm text-accent">{playing ? 'Pause' : 'Play'}</button>
        <button type="button" onClick={() => { setPlaying(false); setI(0); }} className="rounded-lg px-2 py-1.5 text-sm text-muted hover:text-fg">Reset</button>
        <Pill>{packetCount(size, mtu).toLocaleString('en-US')} data packet(s) · ⌈{size.toLocaleString('en-US')} / {mtu}⌉</Pill>
        <Pill>CPU B: {op === 'send' ? 'posts receive + polls' : 'not involved'}</Pill>
      </div>

      <ol className="grid gap-x-4 gap-y-0.5 text-xs text-muted sm:grid-cols-2">
        {steps.map((st, k) => (
          <li key={k}>
            <button type="button" onClick={() => { setPlaying(false); setI(k); }} aria-current={k === idx ? 'step' : undefined}
              className={`text-left hover:text-fg ${k === idx ? 'font-semibold text-fg' : ''} ${st.tone === 'danger' ? 'text-danger' : ''}`}>{k + 1}. {st.title}</button>
          </li>
        ))}
      </ol>

      <p className="text-[11px] leading-relaxed text-muted">
        Opcode and header names follow the IBTA transport (BTH, RETH, AETH); PSNs start at an illustrative {PSN0}. WQE/CQE layouts, doorbell mechanics,
        BlueFlame and max_inline_data are provider- and device-specific (check your adapter documentation). ACK coalescing and which packet requests an ACK
        vary by implementation. Error-path details follow the verbs man pages (ibv_poll_cq, ibv_get_async_event).
      </p>
    </div>
  );
}
