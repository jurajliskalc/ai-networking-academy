import { useState } from 'react';
import { Button, Pill } from '../components/ui';

type State = 'RESET' | 'INIT' | 'RTR' | 'RTS' | 'SQD' | 'SQE' | 'ERR';
type Transport = 'RC' | 'UD';

const POS: Record<State, { x: number; y: number }> = {
  RESET: { x: 70, y: 70 }, INIT: { x: 230, y: 70 }, RTR: { x: 390, y: 70 }, RTS: { x: 560, y: 70 },
  SQD: { x: 650, y: 200 }, SQE: { x: 470, y: 200 }, ERR: { x: 150, y: 200 },
};
const W = 96, H = 40;

const CAN: Record<State, { recv: string; send: string; note: string }> = {
  RESET: { recv: 'no', send: 'no', note: 'Freshly created (or reset). No WRs can be posted; queues are empty.' },
  INIT: { recv: 'yes (queued)', send: 'no', note: 'Port, P_Key and access are bound. Post receives now so they are ready before the peer sends; they are not processed yet.' },
  RTR: { recv: 'yes (processed)', send: 'no', note: 'Ready To Receive: the responder side is live. Incoming packets are matched against posted receives.' },
  RTS: { recv: 'yes', send: 'yes', note: 'Ready To Send: fully operational requester and responder.' },
  SQD: { recv: 'yes', send: 'yes (queued, not started)', note: 'Send Queue Drained: in-progress sends finish, new ones wait. Used to change some attributes on a live QP.' },
  SQE: { recv: 'yes', send: 'flushed', note: 'Send Queue Error (UD/UC only): a send failed; outstanding sends flush, receives keep working. Move back to RTS to resume.' },
  ERR: { recv: 'flushed', send: 'flushed', note: 'Every outstanding and newly posted WR completes with IBV_WC_WR_FLUSH_ERR. The only way out is modify to RESET.' },
};

interface Tx { to: State; mask: string[]; attrs: string[]; why: string }

function transitions(s: State, t: Transport): Tx[] {
  const any: Tx[] = [
    { to: 'RESET', mask: ['IBV_QP_STATE'], attrs: ['qp_state = IBV_QPS_RESET'], why: 'Allowed from any state. Discards queued WRs (no completions) and clears the QP context.' },
  ];
  if (s !== 'RESET' && s !== 'ERR') any.push({ to: 'ERR', mask: ['IBV_QP_STATE'], attrs: ['qp_state = IBV_QPS_ERR'], why: 'Forced error, e.g. on teardown to flush all outstanding WRs back as completions.' });
  switch (s) {
    case 'RESET':
      return t === 'RC'
        ? [{ to: 'INIT', mask: ['IBV_QP_STATE', 'IBV_QP_PKEY_INDEX', 'IBV_QP_PORT', 'IBV_QP_ACCESS_FLAGS'],
            attrs: ['qp_state = IBV_QPS_INIT', 'pkey_index = 0', 'port_num = 1', 'qp_access_flags = IBV_ACCESS_REMOTE_READ |\n                     IBV_ACCESS_REMOTE_WRITE'],
            why: 'Bind the QP to a port and partition, and say which remote operations the responder will accept.' }]
        : [{ to: 'INIT', mask: ['IBV_QP_STATE', 'IBV_QP_PKEY_INDEX', 'IBV_QP_PORT', 'IBV_QP_QKEY'],
            attrs: ['qp_state = IBV_QPS_INIT', 'pkey_index = 0', 'port_num = 1', 'qkey = 0x11111111'],
            why: 'UD has no RDMA access flags; instead a Q_Key that incoming datagrams must match.' }];
    case 'INIT':
      return [t === 'RC'
        ? { to: 'RTR', mask: ['IBV_QP_STATE', 'IBV_QP_AV', 'IBV_QP_PATH_MTU', 'IBV_QP_DEST_QPN', 'IBV_QP_RQ_PSN', 'IBV_QP_MAX_DEST_RD_ATOMIC', 'IBV_QP_MIN_RNR_TIMER'],
            attrs: ['qp_state = IBV_QPS_RTR', 'path_mtu = IBV_MTU_4096', 'dest_qp_num = remote.qpn', 'rq_psn = remote.psn', 'max_dest_rd_atomic = 16', 'min_rnr_timer = 12',
              'ah_attr.is_global = 1   /* RoCE: GRH required */', 'ah_attr.grh.dgid = remote.gid', 'ah_attr.grh.sgid_index = gid_idx', 'ah_attr.grh.hop_limit = 64', 'ah_attr.dlid = remote.lid /* IB */', 'ah_attr.port_num = 1'],
            why: 'RC is connected: the QP learns who its single peer is (address vector, QPN, starting PSN) and the path MTU. These come from an out-of-band exchange (TCP, rdma_cm).' }
        : { to: 'RTR', mask: ['IBV_QP_STATE'], attrs: ['qp_state = IBV_QPS_RTR'], why: 'UD is connectionless: the destination is given per send WR via an address handle, so nothing else is needed.' },
        { to: 'INIT', mask: ['IBV_QP_STATE', 'IBV_QP_PKEY_INDEX', 'IBV_QP_PORT', t === 'RC' ? 'IBV_QP_ACCESS_FLAGS' : 'IBV_QP_QKEY'], attrs: ['qp_state = IBV_QPS_INIT', '/* any subset of the optional attrs */'], why: 'INIT→INIT may modify the same optional attributes.' },
        ...any];
    case 'RTR':
      return [t === 'RC'
        ? { to: 'RTS', mask: ['IBV_QP_STATE', 'IBV_QP_SQ_PSN', 'IBV_QP_TIMEOUT', 'IBV_QP_RETRY_CNT', 'IBV_QP_RNR_RETRY', 'IBV_QP_MAX_QP_RD_ATOMIC'],
            attrs: ['qp_state = IBV_QPS_RTS', 'sq_psn = my.psn', 'timeout = 14       /* 4.096us * 2^14 ≈ 67 ms */', 'retry_cnt = 7', 'rnr_retry = 7      /* 7 = retry forever */', 'max_rd_atomic = 16'],
            why: 'Arm the requester: starting send PSN, ACK timeout and how many times to retransmit before giving up.' }
        : { to: 'RTS', mask: ['IBV_QP_STATE', 'IBV_QP_SQ_PSN'], attrs: ['qp_state = IBV_QPS_RTS', 'sq_psn = 0'], why: 'UD only needs a starting send PSN. No ACKs, so no timeout or retry counts.' },
        ...any];
    case 'RTS':
      return [{ to: 'SQD', mask: ['IBV_QP_STATE', '(IBV_QP_EN_SQD_ASYNC_NOTIFY)'], attrs: ['qp_state = IBV_QPS_SQD', 'en_sqd_async_notify = 1'], why: 'Drain the send queue; IBV_EVENT_SQ_DRAINED fires when done if notification is enabled.' },
        { to: 'RTS', mask: ['IBV_QP_STATE', '(IBV_QP_ALT_PATH | IBV_QP_PATH_MIG_STATE | ...)'], attrs: ['qp_state = IBV_QPS_RTS', '/* e.g. load an alternate path */'], why: 'RTS→RTS changes a few attributes on a live QP (APM, min_rnr_timer).' }, ...any];
    case 'SQD':
      return [{ to: 'RTS', mask: ['IBV_QP_STATE'], attrs: ['qp_state = IBV_QPS_RTS'], why: 'Resume sending queued WRs.' },
        { to: 'SQD', mask: ['IBV_QP_STATE', '(IBV_QP_TIMEOUT | IBV_QP_RETRY_CNT | IBV_QP_AV | ...)'], attrs: ['qp_state = IBV_QPS_SQD', '/* modify while drained */'], why: 'SQD→SQD is where most attributes may be changed on an established QP.' }, ...any];
    case 'SQE':
      return [{ to: 'RTS', mask: ['IBV_QP_STATE', '(IBV_QP_CUR_STATE)'], attrs: ['qp_state = IBV_QPS_RTS', 'cur_qp_state = IBV_QPS_SQE'], why: 'Recover the send queue after the flushed sends have been reaped from the CQ.' }, ...any];
    case 'ERR':
      return any;
  }
}

interface Failure { id: string; label: string; transport: Transport[]; from: State[]; to: State | null; log: string[] }
const FAILURES: Failure[] = [
  { id: 'gid', label: 'Wrong dest GID', transport: ['RC'], from: ['RTS'], to: 'ERR', log: ['post_send(RDMA_WRITE) → packets routed to the wrong host, no ACK ever returns', 'ACK timeout × retry_cnt (7) exhausted', 'CQE: IBV_WC_RETRY_EXC_ERR (vendor_err set)', 'QP → ERR; remaining WRs: IBV_WC_WR_FLUSH_ERR'] },
  { id: 'mtu', label: 'Path MTU too large', transport: ['RC'], from: ['RTS'], to: 'ERR', log: ['path_mtu = 4096 but a hop only carries 1024 (or RoCE netdev MTU 1500)', 'oversized packets dropped silently in the fabric; small ones get through', 'retries of the large packet never succeed → IBV_WC_RETRY_EXC_ERR', 'QP → ERR; remaining WRs: IBV_WC_WR_FLUSH_ERR'] },
  { id: 'rkey', label: 'Bad rkey', transport: ['RC'], from: ['RTS'], to: 'ERR', log: ['RDMA_WRITE with an rkey the peer never registered (or no REMOTE_WRITE access)', 'responder returns NAK: remote access error', 'CQE: IBV_WC_REM_ACCESS_ERR; both QPs typically go to ERR', 'remaining WRs: IBV_WC_WR_FLUSH_ERR'] },
  { id: 'rnr', label: 'No receive posted (rnr_retry=0)', transport: ['RC'], from: ['RTS'], to: 'ERR', log: ['SEND arrives, responder has no posted receive → RNR NAK', 'rnr_retry exhausted (7 would retry forever)', 'CQE: IBV_WC_RNR_RETRY_EXC_ERR', 'QP → ERR; remaining WRs: IBV_WC_WR_FLUSH_ERR'] },
  { id: 'udgid', label: 'Wrong dest GID', transport: ['UD'], from: ['RTS'], to: null, log: ['post_send via an AH with the wrong GID', 'CQE: IBV_WC_SUCCESS: UD completes once the packet leaves the HCA', 'datagram silently lost; no state change. Reliability is the application\'s job'] },
  { id: 'udlkey', label: 'Bad lkey on send', transport: ['UD'], from: ['RTS'], to: 'SQE', log: ['send WR references memory not covered by its lkey', 'CQE: IBV_WC_LOC_PROT_ERR', 'QP → SQE; later sends flush with IBV_WC_WR_FLUSH_ERR, receives still work'] },
];

const EDGES: [State, State, string?][] = [
  ['RESET', 'INIT'], ['INIT', 'RTR'], ['RTR', 'RTS'], ['RTS', 'SQD'], ['SQD', 'RTS'], ['RTS', 'SQE'], ['SQE', 'RTS'], ['RTS', 'ERR', 'error'], ['ERR', 'RESET', 'reset'],
];

const PATHS: Record<string, string> = {
  'RESET-INIT': 'M118 70 L 179 70', 'INIT-RTR': 'M278 70 L 339 70', 'RTR-RTS': 'M438 70 L 509 70',
  'RTS-SQD': 'M590 90 Q 625 130 628 178', 'SQD-RTS': 'M672 180 Q 690 80 611 70',
  'RTS-SQE': 'M548 90 Q 540 150 498 178', 'SQE-RTS': 'M442 180 Q 455 110 520 91',
  'RTS-ERR': 'M560 90 C 600 300, 260 290, 199 205', 'ERR-RESET': 'M102 200 Q 50 160 66 93',
};
const edgePath = (a: State, b: State) => PATHS[`${a}-${b}`] ?? '';

const fmtAttr = (a: string) => {
  if (a.startsWith('/*')) return `    ${a}`;
  const [lhs, cmt] = a.split('/*');
  return `    .${lhs.trim()},${cmt ? `  /*${cmt}` : ''}`;
};

export default function QpStateMachine() {
  const [transport, setTransport] = useState<Transport>('RC');
  const [state, setState] = useState<State>('RESET');
  const [sel, setSel] = useState<Tx | null>(null);
  const [log, setLog] = useState<string[]>(['ibv_create_qp() → QP in RESET']);

  const txs = transitions(state, transport);
  const show = sel ?? txs[0];

  const apply = (t: Tx) => {
    const flush = state === 'ERR' || t.to !== 'ERR' ? [] : ['outstanding WRs complete with IBV_WC_WR_FLUSH_ERR'];
    setLog((l) => [...l, `ibv_modify_qp(${state} → ${t.to})`, ...flush].slice(-10));
    setState(t.to);
    setSel(null);
  };
  const inject = (f: Failure) => {
    setLog((l) => [...l, ...f.log.map((x) => `  ${x}`)].slice(-10));
    if (f.to) setState(f.to);
    setSel(null);
  };
  const switchTransport = (t: Transport) => { setTransport(t); setState('RESET'); setSel(null); setLog([`ibv_create_qp(qp_type = IBV_QPT_${t}) → RESET`]); };

  const code = `struct ibv_qp_attr attr = {\n${show.attrs.map(fmtAttr).join('\n')}\n};\nint mask = ${show.mask.join(' |\n           ')};\nif (ibv_modify_qp(qp, &attr, mask))\n    perror("ibv_modify_qp"); /* EINVAL: wrong/missing mask bits */`;
  const failures = FAILURES.filter((f) => f.transport.includes(transport));
  const nextStates = new Set(txs.map((t) => t.to));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Transport</span>
        {(['RC', 'UD'] as const).map((t) => (
          <button key={t} type="button" onClick={() => switchTransport(t)} aria-pressed={t === transport}
            className={`rounded-md border px-2.5 py-1 font-mono text-xs ${t === transport ? 'border-accent bg-accent-soft text-accent' : 'border-line hover:bg-panel-2'}`}>{t}</button>
        ))}
        <Pill className="ml-auto">current: <span className="font-mono text-accent">{state}</span></Pill>
      </div>

      <svg viewBox="0 0 740 290" className="w-full" role="img" aria-label={`QP state diagram (${transport}), current state ${state}; valid next states: ${[...nextStates].filter((x) => x !== state).join(', ') || 'none'}. Any state can go to RESET; errors go to ERR.`}>
        <defs>
          <marker id="qp-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" fill="var(--muted)" />
          </marker>
          <marker id="qp-arrow-hot" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" fill="var(--accent)" />
          </marker>
        </defs>
        {EDGES.filter(([a, b]) => transport === 'UD' || (a !== 'SQE' && b !== 'SQE')).map(([a, b, lbl]) => {
          const hot = a === state && nextStates.has(b);
          const color = lbl === 'error' ? 'var(--danger)' : hot ? 'var(--accent)' : 'var(--muted)';
          return (
            <g key={`${a}${b}`}>
              <path d={edgePath(a, b)} fill="none" stroke={color} strokeWidth={hot ? 2.2 : 1.3} strokeDasharray={lbl ? '5 4' : undefined} markerEnd={`url(#${hot ? 'qp-arrow-hot' : 'qp-arrow'})`} opacity={hot || lbl ? 1 : 0.65} />
            </g>
          );
        })}
        <text x={250} y={284} fontSize={11} fill="var(--danger)" fontFamily="var(--font-mono)">CQE error / any state → ERR</text>
        <text x={8} y={150} fontSize={11} fill="var(--muted)" fontFamily="var(--font-mono)">any → RESET</text>
        {(Object.keys(POS) as State[]).filter((s) => transport === 'UD' || s !== 'SQE').map((s) => {
          const p = POS[s];
          const cur = s === state;
          const next = nextStates.has(s) && !cur;
          const stroke = cur ? 'var(--accent)' : s === 'ERR' ? 'var(--danger)' : next ? 'var(--data)' : 'var(--border)';
          return (
            <g key={s}>
              <rect x={p.x - W / 2} y={p.y - H / 2} width={W} height={H} rx={10} fill={cur ? 'var(--accent-soft)' : 'var(--panel-2)'} stroke={stroke} strokeWidth={cur ? 2.5 : 1.5} />
              <text x={p.x} y={p.y + 5} textAnchor="middle" fontSize={15} fontWeight={700} fontFamily="var(--font-mono)" fill={cur ? 'var(--accent)' : 'var(--text)'}>{s}</text>
            </g>
          );
        })}
      </svg>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-3">
          <div className="rounded-lg border border-line bg-panel-2 p-3 text-sm" aria-live="polite">
            <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">In {state}</div>
            <div className="flex flex-wrap gap-2 font-mono text-xs">
              <span>post_recv: <span className={CAN[state].recv.startsWith('yes') ? 'text-accent' : 'text-danger'}>{CAN[state].recv}</span></span>
              <span>post_send: <span className={CAN[state].send.startsWith('yes') ? 'text-accent' : 'text-danger'}>{CAN[state].send}</span></span>
            </div>
            <p className="mt-1.5 text-muted">{CAN[state].note}</p>
          </div>
          <div>
            <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Valid transitions</div>
            <div className="flex flex-wrap gap-1.5">
              {txs.map((t, i) => (
                <button key={i} type="button" onMouseEnter={() => setSel(t)} onFocus={() => setSel(t)} onClick={() => apply(t)} aria-label={`Modify QP to ${t.to}`}
                  className={`rounded-md border px-2 py-1 font-mono text-xs transition ${t.to === 'ERR' ? 'border-danger/40 text-danger hover:bg-danger/10' : t.to === 'RESET' ? 'border-line text-muted hover:bg-panel-2' : 'border-accent/50 text-accent hover:bg-accent-soft'}`}>
                  → {t.to}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Inject failure {state !== 'RTS' && '(needs RTS)'}</div>
            <div className="flex flex-wrap gap-1.5">
              {failures.map((f) => <Button key={f.id} variant="danger" className="!px-2 !py-1 text-xs" disabled={!f.from.includes(state)} onClick={() => inject(f)}>{f.label}</Button>)}
            </div>
          </div>
        </div>
        <div className="space-y-3">
          <div>
            <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{state} → {show.to} ({transport})</div>
            <pre className="overflow-x-auto rounded-lg p-3 font-mono text-[11.5px] leading-relaxed" style={{ background: 'var(--code-bg)', color: 'var(--code-text)' }} tabIndex={0} role="region" aria-label={`ibv_modify_qp call for ${state} to ${show.to}`}>{code}</pre>
            <p className="mt-1.5 text-sm text-muted">{show.why}</p>
          </div>
          <div className="rounded-lg border border-line bg-panel p-2 font-mono text-[11px] leading-relaxed" aria-live="polite">
            {log.map((l, i) => <div key={i} className={/ERR|error/.test(l) ? 'text-danger' : l.startsWith('  ') ? 'text-warn' : 'text-muted'}>{l}</div>)}
          </div>
        </div>
      </div>
      <p className="text-[11px] text-muted">
        Masks follow the libibverbs man page for ibv_modify_qp; parenthesised bits are optional. Values (MTU, timeouts, rd_atomic depths) are typical examples:
        query ibv_query_device / port attributes for real limits. rdma_cm performs these transitions for you; the attribute set is the same.
      </p>
    </div>
  );
}
