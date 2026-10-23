import { useRef, useState } from 'react';
import { Download, Trash2, Upload } from 'lucide-react';
import { useProgress } from '../store';
import { emptyProgress, sanitize } from '../progress';
import { REPO_URL } from '../components/Layout';
import { Button, Card, PageHeader } from '../components/ui';

export default function Settings() {
  const { progress, replace } = useProgress();
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

  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader eyebrow="Settings" title="Settings" />
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
