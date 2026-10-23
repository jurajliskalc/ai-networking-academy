import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { LEAVES, NETDEVS, NODES, SPINES, type FabricState } from '../sim/fabric';
import { exec } from '../sim/shell';

interface Line { kind: 'in' | 'out'; text: string; prompt?: string }

const isSwitch = (h: string) => h.startsWith('leaf') || h.startsWith('spine');
const promptFor = (h: string) => (isSwitch(h) ? `cumulus@${h}:mgmt:~$` : `root@${h}:~#`);

const WORDS = [
  'ssh', 'exit', 'clear', 'help', 'hostname', 'ip', 'link', 'addr', 'route', 'set', 'dev', 'mtu', 'show', 'ibdev2netdev', 'ibv_devices', 'ibv_devinfo', 'rdma',
  'statistic', 'show_gids', 'ethtool', 'mlnx_qos', '--trust', '--pfc', 'lspci', 'nvidia-smi', 'topo', 'dmesg', 'mlxlink', 'ping', 'ib_write_bw',
  '--report_gbits', 'all_reduce_perf', 'cat', '/etc/nccl.conf', 'sed', 'echo', 'grep', 'replace-cable', 'reseat-nic', 'nv', 'interface', 'counters', 'qos', 'roce',
  'config', 'apply', 'diff', 'unset', 'state', 'lossless', 'ibstat', 'ibstatus', 'iblinkinfo', 'perfquery', 'sminfo', 'ibqueryerrors',
  'systemctl', 'opensm', 'sleep', ...NODES, ...LEAVES, ...SPINES, ...NETDEVS, ...Array.from({ length: 8 }, (_, i) => `mlx5_${i}`),
  ...Array.from({ length: 8 }, (_, i) => `swp${i + 1}`), 'swp31', 'swp32',
];

export default function Terminal({ state, start, onChange, banner, autorun, autoFocus = false }: {
  state: FabricState; start: string; onChange: () => void; banner?: string; autorun?: string[];
  /** Focus the input on mount (the sandbox page); lab pages leave focus alone so the ticket is read first. */
  autoFocus?: boolean;
}) {
  const [host, setHost] = useState(start);
  const [lines, setLines] = useState<Line[]>(() => [{ kind: 'out', text: banner ?? 'Fabric Simulator. Type "help" for the command list.' }]);
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [hpos, setHpos] = useState<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  // Tab completes commands. Escape releases the keyboard so the next Tab leaves the terminal (no keyboard trap).
  const released = useRef(false);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [lines]);

  // Commands passed in a shareable link (?run=...) are executed once, as if typed.
  const autoRan = useRef(false);
  useEffect(() => {
    if (autoRan.current || !autorun?.length) return;
    autoRan.current = true;
    let h = start;
    const out: Line[] = [];
    for (const cmd of autorun) {
      const res = exec({ state, host: h }, cmd);
      out.push({ kind: 'in', text: cmd, prompt: promptFor(h) });
      if (res.out) out.push({ kind: 'out', text: res.out.replace(/\n$/, '') });
      if (res.host) h = res.host;
    }
    setHost(h);
    setLines((l) => [...l, ...out]);
    setHistory(autorun);
  }, [autorun, start, state]);

  const run = (cmd: string) => {
    const prompt = promptFor(host);
    const res = exec({ state, host }, cmd);
    if (res.clear) {
      setLines([]);
    } else {
      setLines((l) => [...l, { kind: 'in' as const, text: cmd, prompt }, ...(res.out ? [{ kind: 'out' as const, text: res.out.replace(/\n$/, '') }] : [])].slice(-600));
    }
    if (res.host) setHost(res.host);
    if (cmd.trim()) setHistory((h) => (h[h.length - 1] === cmd ? h : [...h, cmd].slice(-200)));
    setHpos(null);
    if (res.changed || res.host) onChange();
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      released.current = true;
      return;
    }
    if (e.key === 'Tab' && (released.current || e.shiftKey || !input.trim())) {
      released.current = false;
      return; // normal focus navigation
    }
    released.current = false;
    if (e.key === 'Enter') {
      run(input);
      setInput('');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!history.length) return;
      const p = hpos === null ? history.length - 1 : Math.max(0, hpos - 1);
      setHpos(p);
      setInput(history[p]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (hpos === null) return;
      const p = hpos + 1;
      if (p >= history.length) {
        setHpos(null);
        setInput('');
      } else {
        setHpos(p);
        setInput(history[p]);
      }
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const m = input.match(/(\S*)$/);
      const word = m?.[1] ?? '';
      if (!word) return;
      const hits = [...new Set(WORDS.filter((w) => w.startsWith(word)))];
      if (hits.length === 1) setInput(input.slice(0, input.length - word.length) + hits[0] + ' ');
      else if (hits.length > 1) {
        let common = hits[0];
        for (const h of hits) while (!h.startsWith(common)) common = common.slice(0, -1);
        if (common.length > word.length) setInput(input.slice(0, input.length - word.length) + common);
        else setLines((l) => [...l, { kind: 'in' as const, text: input, prompt: promptFor(host) }, { kind: 'out' as const, text: hits.join('  ') }]);
      }
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      setLines([]);
    } else if (e.key === 'c' && e.ctrlKey && !window.getSelection()?.toString()) {
      e.preventDefault();
      setLines((l) => [...l, { kind: 'in' as const, text: input + '^C', prompt: promptFor(host) }]);
      setInput('');
    }
  };

  return (
    <div className="term flex h-full min-h-[420px] flex-col overflow-hidden rounded-xl border border-line" onClick={() => !window.getSelection()?.toString() && field.current?.focus()}>
      <div className="flex items-center gap-2 border-b border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] text-[#8b97ab]">
        <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-[#f87171]" /><span aria-hidden className="h-2.5 w-2.5 rounded-full bg-[#fbbf24]" /><span aria-hidden className="h-2.5 w-2.5 rounded-full bg-[#4ade80]" />
        <span className="ml-2">ssh {host} · simulated</span>
      </div>
      <p id="term-help" className="sr-only">Type a command and press Enter. Up and Down recall history. Tab completes a command; to leave the terminal press Escape, then Tab.</p>
      <div ref={scroller} className="flex-1 overflow-auto p-3" role="log" aria-label="Terminal output" aria-live="polite" tabIndex={-1}>
        {lines.map((l, i) => l.kind === 'in'
          ? <div key={i} className="whitespace-pre-wrap break-all"><span className="prompt">{l.prompt}</span> {l.text}</div>
          : <pre key={i} className={`whitespace-pre font-[inherit] ${/command not found|WARN|failure|Failed|error/i.test(l.text) ? '' : ''}`}>{highlight(l.text)}</pre>)}
        <div className="flex items-center">
          <span className="prompt whitespace-nowrap">{promptFor(host)}</span>&nbsp;
          <input ref={field} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={onKey} spellCheck={false} autoCapitalize="off" autoComplete="off"
            aria-label="Terminal input" aria-describedby="term-help" className="flex-1 bg-transparent text-[#e3f5ea] outline-none caret-[#4ade80]" autoFocus={autoFocus} />
        </div>
      </div>
    </div>
  );
}

function highlight(text: string) {
  return text.split('\n').map((ln, i) => (
    <span key={i} className={/NCCL WARN|Failed|failure|Completion with error|command not found|Error:|Unreachable|100% packet loss/.test(ln) ? 'err' : /^\[lab action\]|^#/.test(ln) ? 'dim' : undefined}>
      {ln}{'\n'}
    </span>
  ));
}
