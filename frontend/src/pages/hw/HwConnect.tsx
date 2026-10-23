import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Activity, AlertTriangle, CheckCircle2, ClipboardPaste, FileUp, FlaskConical, HardDrive, Link2, Loader2, RefreshCw, RotateCcw, Sparkles, Trash2, Unplug, Upload, Wand2, XCircle } from 'lucide-react';
import { useIndex } from '../../content';
import { useProgress } from '../../store';
import { recordHwCheck } from '../../progress';
import {
  defaults, derive, hostQos, hostsFile, netplan, nmcli, parseEnv, quickStart, rolesOf, sanitizeProfile, switchConfig, toEnv, validateProfile, type Profile,
} from '../../hw/profile';
import { dataPort, detectedProfile, hostLabel, isRoceV2Ipv4, parseReport, review, type HostFacts, type Report } from '../../hw/report';
import { fromPastedText, mergeChecks, mergeTasks, parseCheckJson, VERDICT_LABEL, verdictDetail, type CheckRecord } from '../../hw/checks';
import { Button, Card, Loading, Pill } from '../../components/ui';
import type { ContentIndex, HandsOnLab, HwVariable } from '../../types';
import demoReport from '../../hw/demo-report.json';
import { CodeBox, FindingRow, HwShell, SEVERITY, download, useProfile } from './shared';

const GROUPS: { id: string; title: string; note?: string }[] = [
  { id: 'lab', title: 'Lab' },
  { id: 'hosts', title: 'Hosts', note: 'Host A runs the check scripts and reaches B and C over SSH.' },
  { id: 'qos', title: 'MTU and RoCE QoS', note: 'Must match on every host and on the switch.' },
  { id: 'switch', title: 'Switch' },
  { id: 'gpu', title: 'GPU (Tier 3)' },
];

function Section({ n, title, sub, children, right }: { n: number; title: string; sub?: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="mb-12">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-accent">Step {n}</div>
          <h2 className="text-xl font-bold tracking-tight">{title}</h2>
          {sub && <p className="mt-1 max-w-3xl text-sm text-muted">{sub}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

// ------------------------------------------------------------------ 1. profile form

function Field({ v, value, error, onChange }: { v: HwVariable; value: string; error?: string; onChange: (s: string) => void }) {
  const id = `hw-${v.name}`;
  const cls = `w-full rounded-lg border bg-bg px-2.5 py-1.5 font-mono text-sm outline-none focus:border-accent ${error ? 'border-danger' : 'border-line'}`;
  const note = error || v.help ? `${id}-note` : undefined;
  return (
    <div>
      <label htmlFor={id} className="mb-1 flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium">{v.label}</span><span className="font-mono text-[10px] text-muted">{v.name}</span>
      </label>
      {v.derived ? <input id={id} value={value} readOnly aria-describedby={note} className={`${cls} cursor-not-allowed text-muted`} title={`derived: ${v.derived}`} />
        : v.choices ? (
          <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={cls} aria-invalid={!!error || undefined} aria-describedby={note}>
            {v.choices.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        ) : <input id={id} value={value} onChange={(e) => onChange(e.target.value)} className={cls} spellCheck={false} autoComplete="off" aria-invalid={!!error || undefined} aria-describedby={note} />}
      {error ? <div id={note} className="mt-1 text-[11px] text-danger">{error}</div> : v.help && <div id={note} className="mt-1 text-[11px] leading-snug text-muted">{v.help}</div>}
    </div>
  );
}

function ProfileForm({ ix }: { ix: ContentIndex }) {
  const { profile, vars, setProfile, isDefault } = useProfile(ix);
  const errors = validateProfile(profile);
  const fileRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const roles = rolesOf(profile);
  const visible = (v: HwVariable) => {
    if (v.name.match(/^(HOST_C|C_)/) && !roles.includes('C')) return false;
    if (v.group === 'switch' && v.name !== 'SWITCH_OS' && profile.SWITCH_OS === 'none') return false;
    if (v.name.endsWith('_SWITCH_PORT') && v.name.startsWith('C') && !roles.includes('C')) return false;
    if (v.group === 'qos' && profile.FABRIC === 'ib' && ['ROCE_PRIO', 'ROCE_DSCP', 'CNP_DSCP', 'TCLASS', 'GID_INDEX'].includes(v.name)) return false;
    return true;
  };
  const set = (name: string, value: string) => setProfile(derive({ ...profile, [name]: value }));
  const importEnv = async (f: File) => {
    const parsed = parseEnv(await f.text());
    const known = Object.keys(parsed).filter((k) => vars.some((v) => v.name === k)).length;
    if (!known) return setMsg(`${f.name} has no lab.env variables.`);
    setProfile(sanitizeProfile({ ...profile, ...parsed }, vars));
    setMsg(`Imported ${known} values from ${f.name}.`);
  };
  return (
    <Card className="p-5">
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Button onClick={() => download('lab.env', toEnv(profile, vars))} disabled={Object.keys(errors).length > 0}><HardDrive size={15} />Download lab.env</Button>
        <Button variant="ghost" onClick={() => fileRef.current?.click()}><Upload size={15} />Import lab.env</Button>
        <input ref={fileRef} type="file" accept=".env,text/plain" className="hidden" aria-label="lab.env file to import" onChange={(e) => { const f = e.target.files?.[0]; if (f) void importEnv(f); e.target.value = ''; }} />
        {!isDefault && <Button variant="ghost" onClick={() => { setProfile(defaults(vars)); setMsg('Profile reset to the example values.'); }}><RotateCcw size={15} />Reset</Button>}
        <span className="text-xs text-muted" role="status">{Object.keys(errors).length ? <span className="text-danger">{Object.keys(errors).length} value(s) to fix</span> : 'Saved in this browser as you type.'}</span>
        <span className="text-xs text-accent empty:hidden" role="status">{msg}</span>
      </div>
      <div className="space-y-6">
        {GROUPS.map((g) => {
          const vs = vars.filter((v) => v.group === g.id && visible(v));
          if (!vs.length) return null;
          return (
            <fieldset key={g.id}>
              <legend className="mb-1 text-sm font-semibold">{g.title}</legend>
              {g.note && <p className="mb-3 text-xs text-muted">{g.note}</p>}
              <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
                {vs.map((v) => <Field key={v.name} v={v} value={profile[v.name] ?? ''} error={errors[v.name]} onChange={(s) => set(v.name, s)} />)}
              </div>
            </fieldset>
          );
        })}
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ 2. generated files

function Generated({ ix }: { ix: ContentIndex }) {
  const { profile, vars } = useProfile(ix);
  const roles = rolesOf(profile);
  const files = useMemo(() => {
    const list: { id: string; label: string; file: string; code: string }[] = [
      { id: 'quick', label: 'Quick start', file: 'aina-quickstart.sh', code: quickStart(profile) },
      { id: 'env', label: 'lab.env', file: 'labs/hw-toolkit/lab.env', code: toEnv(profile, vars) },
      { id: 'hosts', label: '/etc/hosts', file: 'hosts-aina.txt', code: hostsFile(profile) },
    ];
    for (const r of roles) list.push({ id: `np${r}`, label: `netplan ${r}`, file: `60-aina-rdma-${r.toLowerCase()}.yaml`, code: netplan(profile, r) });
    for (const r of roles) list.push({ id: `nm${r}`, label: `nmcli ${r}`, file: `aina-nmcli-${r.toLowerCase()}.sh`, code: nmcli(profile, r) });
    if (profile.FABRIC === 'roce') for (const r of roles) list.push({ id: `qos${r}`, label: `Host QoS ${r}`, file: `aina-qos-${r.toLowerCase()}.sh`, code: hostQos(profile, r) });
    if (profile.FABRIC === 'roce') list.push({ id: 'switch', label: 'Switch', file: `aina-switch-${profile.SWITCH_OS}.txt`, code: switchConfig(profile) });
    return list;
  }, [profile, vars, roles]);
  const [tab, setTab] = useState('quick');
  const cur = files.find((f) => f.id === tab) ?? files[0];
  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Generated file">
        {files.map((f) => (
          <button key={f.id} type="button" aria-pressed={cur.id === f.id} onClick={() => setTab(f.id)} className={`rounded-lg border px-3 py-1.5 font-mono text-xs ${cur.id === f.id ? 'border-accent/60 bg-accent-soft text-accent' : 'border-line bg-panel text-muted hover:text-fg'}`}>{f.label}</button>
        ))}
      </div>
      <CodeBox code={cur.code} file={cur.file} title={cur.file} />
      {cur.id.startsWith('qos') || cur.id === 'switch'
        ? <p className="mt-2 text-xs text-warn">These change device configuration. Do them as part of the QoS and switch labs, which save the original state first.</p>
        : <p className="mt-2 text-xs text-muted">Generated from your profile. Review before running; nothing here is executed for you.</p>}
    </div>
  );
}

// ------------------------------------------------------------------ 3. connect / import

type AgentState = { phase: 'idle' | 'busy' | 'ok' | 'error'; msg?: string; host?: string; at?: string; live?: boolean };

function useImport(ix: ContentIndex) {
  const { setHw } = useProfile(ix);
  const { update } = useProgress();
  const labIds = useMemo(() => new Set(ix.labs.map((l) => l.id)), [ix]);
  const applyChecks = useCallback((recs: CheckRecord[]) => {
    const known = recs.filter((r) => labIds.has(r.lab));
    setHw((s) => ({ ...s, checks: mergeChecks(s.checks, known), tasks: mergeTasks(s.tasks ?? {}, known) }));
    // Single-task runs (aina-hw check LAB --task N) show per-task progress but are not a lab attempt.
    update((p) => known.filter((r) => r.only_task === null).reduce((acc, r) => recordHwCheck(acc, r.lab, r), p));
    return known.length;
  }, [labIds, setHw, update]);
  const applyReport = useCallback((r: Report, source: string) => setHw((s) => ({ ...s, report: r, reportSource: source })), [setHw]);
  return { applyChecks, applyReport };
}

function AgentCard({ ix }: { ix: ContentIndex }) {
  const { hw, setHw } = useProfile(ix);
  const { applyChecks, applyReport } = useImport(ix);
  const [st, setSt] = useState<AgentState>({ phase: 'idle' });
  const [auto, setAuto] = useState(false);
  const pull = useCallback(async () => {
    const base = hw.agentUrl.replace(/\/+$/, '');
    setSt((s) => ({ ...s, phase: 'busy' }));
    try {
      const get = async (p: string) => {
        const r = await fetch(`${base}${p}`, { cache: 'no-store' });
        if (!r.ok && r.status !== 404) throw new Error(`${p}: HTTP ${r.status}`);
        return r.ok ? r.json() : null;
      };
      const status = await get('/api/status');
      if (status?.schema !== 'aina.hw.agent/1') throw new Error('That address answered, but it is not an aina-hw agent.');
      let n = 0;
      if (status.report) applyReport(parseReport(await get('/api/report')), `agent ${base}`);
      const checks = await get('/api/checks');
      if (Array.isArray(checks)) n = applyChecks(checks.map(parseCheckJson));
      setSt({ phase: 'ok', host: status.host, at: new Date().toLocaleTimeString(), live: !!status.live, msg: `${status.report ? 'report' : 'no report yet (run collect-all)'} · ${n} lab check(s)` });
      setHw((s) => ({ ...s, agentAt: new Date().toISOString() }));
    } catch (e) {
      const m = e instanceof TypeError
        ? `Could not reach ${base}. Is "aina-hw serve" running and the SSH tunnel open? If it is, the browser may have blocked the request: allow local network access when asked, or start the agent with --allow-origin ${window.location.origin}.`
        : (e as Error).message;
      setSt({ phase: 'error', msg: m });
      setAuto(false);
    }
  }, [hw.agentUrl, applyChecks, applyReport, setHw]);
  useEffect(() => {
    if (!auto) return;
    const t = setInterval(() => void pull(), 15000);
    return () => clearInterval(t);
  }, [auto, pull]);
  return (
    <Card className="flex flex-col p-5">
      <div className="mb-1 flex items-center gap-2 font-semibold"><Link2 size={16} className="text-accent" />Live: local agent</div>
      <p className="mb-4 text-sm text-muted">Run <code>./aina-hw serve</code> on host A and tunnel it: <code>ssh -L 8765:127.0.0.1:8765 host-a</code>. The agent is read-only; it serves the latest report and check results.</p>
      <div className="flex gap-2">
        <input value={hw.agentUrl} onChange={(e) => setHw((s) => ({ ...s, agentUrl: e.target.value }))} className="min-w-0 flex-1 rounded-lg border border-line bg-bg px-2.5 py-1.5 font-mono text-sm outline-none focus:border-accent" aria-label="Agent URL" spellCheck={false} />
        <Button onClick={() => void pull()} disabled={st.phase === 'busy'}>{st.phase === 'busy' ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <RefreshCw size={15} aria-hidden />}{st.phase === 'busy' ? 'Connecting' : 'Connect'}</Button>
      </div>
      <label className="mt-3 flex items-center gap-2 text-xs text-muted"><input type="checkbox" checked={auto} disabled={st.phase !== 'ok'} onChange={(e) => setAuto(e.target.checked)} className="accent-[var(--accent)]" />Refresh every 15 s (picks up new check results as you work)</label>
      <div role="status">
        {st.phase === 'ok' && <div className="mt-3 flex items-start gap-2 rounded-lg border border-accent/40 bg-accent-soft p-2.5 text-xs text-accent"><CheckCircle2 size={14} className="mt-px shrink-0" aria-hidden />Connected to {st.host} at {st.at}: {st.msg}</div>}
        {st.phase === 'ok' && st.live && <Link to="/hw/live" className="mt-2 inline-flex items-center gap-1.5 text-xs text-data hover:underline"><Activity size={13} aria-hidden />Open the live counters</Link>}
        {st.phase === 'error' && <div className="mt-3 flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 p-2.5 text-xs text-danger"><Unplug size={14} className="mt-px shrink-0" aria-hidden />{st.msg}</div>}
      </div>
    </Card>
  );
}

function ImportCard({ ix }: { ix: ContentIndex }) {
  const { applyChecks, applyReport } = useImport(ix);
  const fileRef = useRef<HTMLInputElement>(null);
  const [msgs, setMsgs] = useState<{ ok: boolean; text: string }[]>([]);
  const [drag, setDrag] = useState(false);
  const [pasteLab, setPasteLab] = useState('');
  const [paste, setPaste] = useState('');
  const hwLabs = ix.labs.filter((l): l is HandsOnLab => l.kind === 'handson').sort((a, b) => a.tier - b.tier || a.id.localeCompare(b.id));
  const handle = async (files: FileList | File[]) => {
    const out: { ok: boolean; text: string }[] = [];
    const checks: CheckRecord[] = [];
    for (const f of Array.from(files)) {
      try {
        const json = JSON.parse(await f.text());
        if (json?.schema === 'aina.hw.check/1') {
          checks.push(parseCheckJson(json));
          out.push({ ok: true, text: `${f.name}: check result for ${json.lab}` });
        } else {
          const r = parseReport(json);
          applyReport(r, f.name);
          out.push({ ok: true, text: `${f.name}: inventory of ${r.hosts.length} host(s)` });
        }
      } catch (e) {
        out.push({ ok: false, text: `${f.name}: ${(e as Error).message}` });
      }
    }
    if (checks.length) {
      const n = applyChecks(checks);
      if (n < checks.length) out.push({ ok: false, text: `${checks.length - n} check result(s) are for labs this academy does not know.` });
    }
    setMsgs(out);
  };
  const pasteIt = () => {
    try {
      const rec = fromPastedText(pasteLab, paste);
      applyChecks([rec]);
      setMsgs([{ ok: true, text: `Recorded ${rec.counts.PASS} PASS, ${rec.counts.FAIL} FAIL for ${pasteLab}: ${rec.passed ? 'lab verified.' : `${VERDICT_LABEL[rec.verdict].toLowerCase()}. ${verdictDetail(rec)}`}` }]);
      setPaste('');
    } catch (e) {
      setMsgs([{ ok: false, text: (e as Error).message }]);
    }
  };
  return (
    <Card className="flex flex-col p-5">
      <div className="mb-1 flex items-center gap-2 font-semibold"><FileUp size={16} className="text-accent" />Offline: import files</div>
      <p className="mb-4 text-sm text-muted">Copy <code>results/aina-report.json</code> and any <code>check-*.json</code> from host A and drop them here. Works in every browser, no network access needed.</p>
      <div onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); void handle(e.dataTransfer.files); }}
        onClick={() => fileRef.current?.click()} role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileRef.current?.click(); } }}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-5 text-center text-sm transition ${drag ? 'border-accent bg-accent-soft' : 'border-line hover:border-accent/50'}`}>
        <Upload size={20} className="mb-1.5 text-muted" aria-hidden />Drop JSON files or click to choose
      </div>
      <input ref={fileRef} type="file" accept=".json,application/json" multiple className="hidden" aria-label="Report or check result files" onChange={(e) => { if (e.target.files) void handle(e.target.files); e.target.value = ''; }} />
      <details className="mt-4 text-sm">
        <summary className="flex cursor-pointer items-center gap-2 text-muted hover:text-fg"><ClipboardPaste size={14} />Or paste the output of a check.sh</summary>
        <div className="mt-3 space-y-2">
          <select value={pasteLab} onChange={(e) => setPasteLab(e.target.value)} aria-label="Lab the pasted output belongs to" className="w-full rounded-lg border border-line bg-bg px-2.5 py-1.5 text-sm">
            <option value="">Which lab?</option>
            {hwLabs.map((l) => <option key={l.id} value={l.id}>T{l.tier} · {l.title}</option>)}
          </select>
          <textarea value={paste} onChange={(e) => setPaste(e.target.value)} rows={5} placeholder={'PASS: ...\nFAIL: ...'} aria-label="check.sh output" className="w-full rounded-lg border border-line bg-bg p-2.5 font-mono text-xs outline-none focus:border-accent" />
          <Button variant="ghost" onClick={pasteIt} disabled={!pasteLab || !paste.trim()}>Record result</Button>
          <p className="text-[11px] text-muted">Pasted results are marked as such; files from <code>aina-hw check</code> carry the host and timestamps.</p>
        </div>
      </details>
      <div role="status">{msgs.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs">
          {msgs.map((m, i) => <li key={i} className={`flex items-start gap-1.5 ${m.ok ? 'text-accent' : 'text-danger'}`}>{m.ok ? <CheckCircle2 size={13} className="mt-px shrink-0" aria-hidden /> : <XCircle size={13} className="mt-px shrink-0" aria-hidden />}<span className="sr-only">{m.ok ? 'Imported: ' : 'Error: '}</span>{m.text}</li>)}
        </ul>
      )}</div>
    </Card>
  );
}

// ------------------------------------------------------------------ 4. health review

function HostCard({ h, p }: { h: HostFacts; p: Profile }) {
  const dp = dataPort(h, p);
  const sw = h.software;
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-panel-2 px-4 py-2.5">
        <div className="font-semibold">{h.host.hostname ?? 'host'} {h.role && <Pill className="ml-1">role {h.role}</Pill>}</div>
        <div className="font-mono text-[11px] text-muted">{h.host.os} · {h.host.kernel}</div>
      </div>
      <div className="space-y-3 p-4 text-sm">
        <div className="flex flex-wrap gap-1.5">
          <Pill>{sw.ofed ? `OFED/DOCA ${sw.ofed}` : `rdma-core ${sw.rdma_core ?? '?'}`}</Pill>
          <Pill>perftest {sw.perftest ? sw.perftest.split('-')[0] : sw.tools.ib_write_bw ? 'yes' : 'missing'}</Pill>
          {h.host.numa_nodes && <Pill>{h.host.numa_nodes} NUMA</Pill>}
          {h.gpus.length > 0 && <Pill>{h.gpus.length} GPU · {h.gpus[0].name}</Pill>}
          {h.redacted && <Pill>redacted</Pill>}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-xs">
            <thead className="text-left font-mono text-[10px] uppercase tracking-wider text-muted">
              <tr><th className="py-1 pr-3">Port</th><th className="pr-3">State</th><th className="pr-3">Rate</th><th className="pr-3">MTU</th><th className="pr-3">netdev</th><th className="pr-3">PCIe</th><th>Firmware</th></tr>
            </thead>
            <tbody className="font-mono">
              {h.rdma.flatMap((d) => d.ports.map((x) => {
                const nd = h.netdevs.find((n) => n.name === x.netdev);
                const isData = dp?.dev === d && dp.port === x;
                const down = d.pcie.speed !== null && d.pcie.max_speed !== null && (d.pcie.speed < d.pcie.max_speed || (d.pcie.width ?? 0) < (d.pcie.max_width ?? 0));
                return (
                  <tr key={`${d.name}/${x.port}`} className={`border-t border-line ${isData ? '' : 'opacity-60'}`}>
                    <td className="py-1.5 pr-3">{d.name}/{x.port}{isData && <span className="ml-1 text-accent">●</span>}</td>
                    <td className={`pr-3 ${x.state === 'ACTIVE' ? 'text-accent' : 'text-danger'}`}>{x.state}</td>
                    <td className="pr-3">{x.rate_gbps ? `${x.rate_gbps}G` : '-'} {x.link_layer === 'InfiniBand' ? 'IB' : 'Eth'}</td>
                    <td className="pr-3">{nd?.mtu ?? '-'}/{x.active_mtu ?? '-'}</td>
                    <td className="pr-3">{x.netdev ?? '-'}{nd?.ipv4[0] ? ` ${nd.ipv4[0]}` : ''}</td>
                    <td className={`pr-3 ${down ? 'text-warn' : ''}`}>{d.pcie.speed ?? '?'}GT x{d.pcie.width ?? '?'}{down ? ` (max ${d.pcie.max_speed}x${d.pcie.max_width})` : ''}</td>
                    <td>{d.fw_ver ?? '-'}</td>
                  </tr>
                );
              }))}
            </tbody>
          </table>
        </div>
        {dp && (() => {
          const nd = h.netdevs.find((n) => n.name === dp.port.netdev);
          const q = nd?.qos;
          const v2 = dp.port.gids.filter(isRoceV2Ipv4).map((g) => g.index);
          return (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
              <div><dt className="text-muted">RoCE v2 GID</dt><dd className="font-mono">{dp.port.link_layer === 'Ethernet' ? (v2.length ? `index ${v2.join(', ')}` : 'none') : `LID ${dp.port.lid ?? '-'}`}</dd></div>
              <div><dt className="text-muted">Trust</dt><dd className="font-mono">{q?.trust ?? '-'}</dd></div>
              <div><dt className="text-muted">PFC</dt><dd className="font-mono">{q?.pfc_enabled ? (q.pfc_enabled.length ? q.pfc_enabled.join(',') : 'off') : '-'}</dd></div>
              <div><dt className="text-muted">NIC NUMA</dt><dd className="font-mono">{dp.dev.numa_node ?? '-'}</dd></div>
              {nd?.lldp?.port && <div className="col-span-2"><dt className="text-muted">LLDP neighbour</dt><dd className="font-mono">{nd.lldp.system} {nd.lldp.port}</dd></div>}
            </dl>
          );
        })()}
        {h.notes.length > 0 && <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-muted">{h.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
      </div>
    </Card>
  );
}

function Review({ ix }: { ix: ContentIndex }) {
  const { profile, hw, setHw, setProfile } = useProfile(ix);
  const r = hw.report;
  const findings = useMemo(() => (r ? review(r, profile) : []), [r, profile]);
  const detect = useMemo(() => (r ? detectedProfile(r, profile) : null), [r, profile]);
  const [shown, setShown] = useState<'all' | 'error' | 'warn' | 'info'>('all');
  if (!r) {
    return (
      <Card className="flex flex-wrap items-center justify-between gap-4 p-5">
        <div className="text-sm text-muted">No inventory yet. Connect the agent or import <code>aina-report.json</code>, or explore the review with an illustrative two-host report first.</div>
        <Button variant="ghost" onClick={() => setHw((s) => ({ ...s, report: parseReport(demoReport), reportSource: 'demo' }))}><Sparkles size={15} />Load demo report</Button>
      </Card>
    );
  }
  const count = (s: string) => findings.filter((f) => f.severity === s).length;
  const ports = r.hosts.flatMap((h) => { const d = dataPort(h, profile); return d ? [d.port] : []; });
  return (
    <div className="space-y-5">
      {hw.reportSource === 'demo' && <div className="callout callout-note text-sm"><div className="callout-title">Demo</div>This is an illustrative report generated by the toolkit's test suite from two fictional hosts with deliberate problems. Import your own to review your lab.</div>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {[
          ['Hosts', r.hosts.length, r.lab ?? ''],
          ['Data ports up', `${ports.filter((x) => x.state === 'ACTIVE').length}/${ports.length}`, ''],
          ['Errors', count('error'), ''],
          ['Warnings', count('warn'), ''],
          ['Collected', r.generated.slice(0, 10), hw.reportSource ?? ''],
        ].map(([k, v, s]) => (
          <Card key={k as string} className="p-4">
            <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{k}</div>
            <div className={`mt-1 text-2xl font-bold tabular-nums ${k === 'Errors' && Number(v) ? 'text-danger' : k === 'Warnings' && Number(v) ? 'text-warn' : ''}`}>{v}</div>
            {s && <div className="truncate text-[11px] text-muted">{s}</div>}
          </Card>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        {detect && detect.changes.length > 0 && (
          <Button variant="ghost" onClick={() => setProfile(detect.next)}><Wand2 size={15} />Use detected values in my profile ({detect.changes.length})</Button>
        )}
        <Button variant="ghost" onClick={() => download('aina-report.json', JSON.stringify(r, null, 2), 'application/json')}><HardDrive size={15} />Save report</Button>
        <Button variant="danger" onClick={() => setHw((s) => ({ ...s, report: null, reportSource: null }))}><Trash2 size={15} />Forget report</Button>
      </div>
      {detect && detect.changes.length > 0 && <p className="-mt-2 text-xs text-muted">Would change: {detect.changes.join(' · ')}</p>}
      <Card className="p-5">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="font-semibold">Findings</div>
          <div className="flex gap-1" role="group" aria-label="Show findings">
            {(['all', 'error', 'warn', 'info'] as const).map((s) => (
              <button key={s} type="button" aria-pressed={shown === s} onClick={() => setShown(s)} className={`rounded-md px-2.5 py-1 text-xs ${shown === s ? 'bg-accent-soft text-accent' : 'text-muted hover:text-fg'}`}>
                {s === 'all' ? `All ${findings.length}` : `${SEVERITY[s].label} ${count(s)}`}
              </button>
            ))}
          </div>
        </div>
        {findings.length ? <ul>{findings.filter((f) => shown === 'all' || f.severity === shown).map((f, i) => <FindingRow key={`${f.id}${i}`} f={f} />)}</ul>
          : <p className="flex items-center gap-2 py-3 text-sm text-accent"><CheckCircle2 size={16} />No problems found against your profile. Counters are cumulative: rerun after load to catch errors that grow.</p>}
      </Card>
      <div className="grid gap-4 2xl:grid-cols-2">{r.hosts.map((h, i) => <HostCard key={`${h.host.hostname}${i}`} h={h} p={profile} />)}</div>
      {r.hosts.some((h) => h.gpu_topo) && (
        <details className="text-sm"><summary className="cursor-pointer text-muted hover:text-fg">GPU topology (nvidia-smi topo -m)</summary>
          {r.hosts.filter((h) => h.gpu_topo).map((h) => <CodeBox key={hostLabel(h)} className="mt-3" title={hostLabel(h)} code={h.gpu_topo!} />)}
        </details>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ 5. check results

function Checks({ ix }: { ix: ContentIndex }) {
  const { hw, setHw } = useProfile(ix);
  const recs = Object.values(hw.checks).sort((a, b) => b.finished.localeCompare(a.finished));
  const title = (id: string) => ix.labs.find((l) => l.id === id)?.title ?? id;
  if (!recs.length) return <p className="text-sm text-muted">No check results yet. On host A: <code>./hw-toolkit/aina-hw check &lt;lab-id&gt;</code>, then connect or import.</p>;
  return (
    <Card className="divide-y divide-line">
      {recs.map((r) => (
        <details key={r.lab} className="group p-4">
          <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-sm font-medium">
              {r.passed ? <CheckCircle2 size={16} className="text-accent" aria-label="Passed" />
                : r.verdict === 'FAILED' ? <XCircle size={16} className="text-danger" aria-label={VERDICT_LABEL.FAILED} />
                : <AlertTriangle size={16} className="text-warn" aria-label={VERDICT_LABEL[r.verdict]} />}
              <Link to={`/hw/labs/${r.lab}`} className="hover:text-accent" onClick={(e) => e.stopPropagation()}>{title(r.lab)}</Link>
            </span>
            <span className="font-mono text-[11px] text-muted">{(r.tasks ?? []).length > 0 && `${r.tasks.filter((t) => t.n > 0 && t.status !== 'FAIL').length}/${r.tasks.filter((t) => t.n > 0).length} tasks ok · `}{r.counts.PASS} pass · {r.counts.FAIL} fail · {r.counts.WARN} warn · {r.host ?? 'pasted'} · {r.finished.slice(0, 16).replace('T', ' ')}</span>
          </summary>
          {(r.tasks ?? []).length > 0 && (
            <ul className="mt-3 flex flex-wrap gap-1.5 text-[11px]" aria-label="Tasks">
              {r.tasks.map((t) => <li key={t.n}><Pill className={t.status === 'FAIL' ? 'text-danger' : t.status === 'PASS' ? 'text-accent' : t.status === 'WARN' ? 'text-warn' : ''}>{t.n === 0 ? 'Before you start' : `Task ${t.n}`}: {t.status === 'NONE' ? 'info' : t.status === 'NOTRUN' ? 'not run' : t.status.toLowerCase()}</Pill></li>)}
            </ul>
          )}
          <ul className="mt-3 space-y-1 font-mono text-xs">
            {r.results.map((x, i) => <li key={i} className={x.status === 'PASS' ? 'text-accent' : x.status === 'FAIL' ? 'text-danger' : x.status === 'WARN' ? 'text-warn' : 'text-muted'}>{x.status}: <span className="text-fg">{x.text}</span></li>)}
          </ul>
        </details>
      ))}
      <div className="p-3 text-right"><button className="text-xs text-muted hover:text-danger" onClick={() => setHw((s) => ({ ...s, checks: {} }))}>Clear stored results (progress is kept)</button></div>
    </Card>
  );
}

export default function HwConnect() {
  const { data: ix, error } = useIndex();
  if (!ix) return <Loading error={error} />;
  return (
    <HwShell ix={ix}>
      <p className="mb-10 max-w-3xl text-muted">
        Describe your lab once. The academy personalises every hardware lab with these values and generates the files your hosts need. Then connect
        the read-only <Link to="/hw/toolkit" className="text-data underline underline-offset-2">aina-hw toolkit</Link> to review your fabric's health and record lab results.
        Everything stays in this browser.
      </p>
      <Section n={1} title="Describe your lab" sub="Defaults are examples. Values you enter here replace the {{placeholders}} in every hardware lab and guide."><ProfileForm ix={ix} /></Section>
      <Section n={2} title="Generated files" sub="lab.env goes to labs/hw-toolkit/ on every host. The rest are snippets for host and switch configuration."><Generated ix={ix} /></Section>
      <Section n={3} title="Connect your hardware" sub="Two ways in: a live read-only agent, or plain file import.">
        <div className="grid gap-4 lg:grid-cols-2"><AgentCard ix={ix} /><ImportCard ix={ix} /></div>
      </Section>
      <Section n={4} title="Fabric health review" sub="Rules a fabric engineer checks first, run against your inventory and your profile."><Review ix={ix} /></Section>
      <Section n={5} title="Lab check results" sub="The newest result per lab. A passing result marks the lab completed with evidence." right={<Button variant="ghost" to="/hw/labs"><FlaskConical size={15} />Hardware labs</Button>}><Checks ix={ix} /></Section>
    </HwShell>
  );
}
