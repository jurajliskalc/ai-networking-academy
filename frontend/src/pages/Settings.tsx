import { useRef, useState } from 'react';
import { Download, Trash2, Upload } from 'lucide-react';
import { useProgress } from '../store';
import { emptyProgress, sanitize, SCHEMES, type Scheme, type Theme } from '../progress';
import { REPO_URL } from '../components/Layout';
import { Button, Card, PageHeader } from '../components/ui';

const SCHEME_INFO: Record<Scheme, { name: string; hint: string }> = {
  noc: { name: 'NOC', hint: 'Graphite with signal green (default)' },
  ocean: { name: 'Ocean', hint: 'Cool slate and blue' },
  violet: { name: 'Violet', hint: 'Soft violet accents' },
  sepia: { name: 'Sepia', hint: 'Warm paper tones for long reading' },
  contrast: { name: 'High contrast', hint: 'Black and white, text at 7:1 or more' },
};

/** A small mock of the app drawn with the scheme's own tokens (index.css matches data-scheme on any element). */
function SchemePreview({ scheme }: { scheme: Scheme }) {
  return (
    <div data-scheme={scheme} aria-hidden className="w-full overflow-hidden rounded-md border border-line bg-bg p-2">
      <div className="rounded border border-line bg-panel p-2">
        <div className="text-xs font-semibold text-fg">Aa <span className="font-normal text-muted">muted</span></div>
        <div className="mt-1.5 flex gap-1">
          {['bg-accent', 'bg-data', 'bg-warn', 'bg-danger'].map((c) => <span key={c} className={`h-2.5 w-5 rounded-sm ${c}`} />)}
        </div>
      </div>
    </div>
  );
}

export default function Settings() {
  const { progress, update, replace } = useProgress();
  const file = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(progress, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ai-networking-academy-progress-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const importJson = async (f: File) => {
    try {
      replace(sanitize(JSON.parse(await f.text())));
      setMsg('Progress imported.');
    } catch {
      setMsg('That file is not a valid progress export.');
    }
  };
  const setTheme = (theme: Theme) => update((p) => ({ ...p, settings: { ...p.settings, theme } }));
  const setScheme = (scheme: Scheme) => update((p) => ({ ...p, settings: { ...p.settings, scheme } }));

  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader eyebrow="Settings" title="Settings" />
      <Card className="p-5">
        <h2 id="theme-label" className="mb-3 font-semibold">Theme</h2>
        <div className="flex gap-2" role="group" aria-labelledby="theme-label">{(['system', 'light', 'dark'] as const).map((t) => <Button key={t} variant={progress.settings.theme === t ? 'primary' : 'ghost'} pressed={progress.settings.theme === t} onClick={() => setTheme(t)}>{t}</Button>)}</div>
      </Card>
      <Card className="p-5">
        <h2 id="scheme-label" className="font-semibold">Colour scheme</h2>
        <p className="mt-1 text-sm text-muted">Each scheme has a light and a dark variant; the theme above chooses which one you see.</p>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3" role="group" aria-labelledby="scheme-label">
          {SCHEMES.map((s) => {
            const on = progress.settings.scheme === s;
            return (
              <button key={s} type="button" aria-pressed={on} onClick={() => setScheme(s)}
                className={`flex flex-col gap-2 rounded-lg border p-2 text-left transition ${on ? 'border-accent bg-accent-soft' : 'border-line bg-panel hover:bg-panel-2'}`}>
                <SchemePreview scheme={s} />
                <span className="px-0.5">
                  <span className="block text-sm font-semibold">{SCHEME_INFO[s].name}</span>
                  <span className="block text-xs text-muted">{SCHEME_INFO[s].hint}</span>
                </span>
              </button>
            );
          })}
        </div>
      </Card>
      <Card className="p-5">
        <h2 className="font-semibold">Your data</h2>
        <p className="mt-1 text-sm text-muted">Progress is stored only in this browser (localStorage). Nothing is sent anywhere. Export it to move between machines or keep a backup.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="ghost" onClick={exportJson}><Download size={16} />Export progress</Button>
          <Button variant="ghost" onClick={() => file.current?.click()}><Upload size={16} />Import progress</Button>
          <input ref={file} type="file" accept="application/json" className="hidden" aria-label="Progress file to import" onChange={(e) => e.target.files?.[0] && importJson(e.target.files[0])} />
          {!confirmReset ? <Button variant="danger" onClick={() => setConfirmReset(true)}><Trash2 size={16} />Reset all progress</Button>
            : <Button variant="danger" onClick={() => { replace({ ...emptyProgress(), settings: progress.settings }); setConfirmReset(false); setMsg('Progress reset.'); }}>Really reset everything?</Button>}
        </div>
        <p role="status" className="mt-3 text-sm text-accent empty:hidden">{msg}</p>
      </Card>
      <Card className="p-5 text-sm text-muted">
        <h2 className="mb-1 font-semibold text-fg">About</h2>
        AI Networking Academy is an open, unofficial study platform. Product names belong to their owners; nothing here is endorsed by any vendor.
        Mock exams are original practice material. Source, issues and contributions: <a className="text-data underline underline-offset-2" href={REPO_URL} target="_blank" rel="noreferrer">{REPO_URL.replace('https://', '')}<span className="sr-only"> (opens in a new tab)</span></a>.
      </Card>
    </div>
  );
}
