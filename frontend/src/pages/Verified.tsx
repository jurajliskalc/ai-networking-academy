import { Link } from 'react-router-dom';
import { BadgeCheck } from 'lucide-react';
import { labPath, useIndex } from '../content';
import { REPO_URL } from '../components/Layout';
import Markdown from '../components/Markdown';
import { Card, Loading, PageHeader } from '../components/ui';
import type { ContentIndex, VerifiedNote } from '../types';

/** Renders `code` spans in a note title (titles come from Markdown callouts). */
function inlineCode(t: string) {
  return t.split(/`([^`]+)`/).map((part, i) => (i % 2 ? <code key={i} className="font-mono text-[0.9em]">{part}</code> : part));
}

const hrefOf = (n: VerifiedNote) => {
  const base = n.kind === 'lesson' ? `/lesson/${n.id}` : n.kind === 'lab' ? labPath(n.id) : n.id === 'overview' ? '/hw' : `/hw/${n.id}`;
  return n.anchor ? `${base}?s=${n.anchor}` : base;
};

/** Groups in curriculum order: one per module (lessons), then hardware labs and guides. */
function groups(ix: ContentIndex) {
  const out: { key: string; title: string; notes: VerifiedNote[] }[] = [];
  for (const m of ix.modules) {
    const notes = ix.verifiedNotes.filter((n) => n.kind === 'lesson' && n.module === m.id)
      .sort((a, b) => m.lessons.indexOf(a.id) - m.lessons.indexOf(b.id));
    if (notes.length) out.push({ key: m.id, title: `Module ${m.order}: ${m.title}`, notes });
  }
  const labs = ix.verifiedNotes.filter((n) => n.kind === 'lab');
  if (labs.length) out.push({ key: 'labs', title: 'Real hardware labs', notes: labs });
  const guides = ix.verifiedNotes.filter((n) => n.kind === 'guide');
  if (guides.length) out.push({ key: 'guides', title: 'Hardware guides', notes: guides });
  return out;
}

export default function Verified() {
  const { data: ix, error } = useIndex();
  if (!ix) return <Loading error={error} />;
  const gs = groups(ix);
  return (
    <div className="max-w-4xl">
      <PageHeader eyebrow="Reference" title="Verified on hardware">
        Behaviour that surprised us on real adapters: two ConnectX-5 hosts (firmware 16.29/16.34, Ubuntu 26.04, Secure Boot on), tested
        with the distribution's inbox stack and with NVIDIA DOCA-OFED 3.4, Ethernet back to back and InfiniBand. Each note is an observation
        on that hardware and those versions, not a promise for every NIC, firmware or switch: check yours. {ix.verifiedNotes.length} notes,
        each linked to the lesson or lab where it is explained.
        <span className="mt-2 block text-sm">
          Observed on 2026-10-23. What was run and what the tools printed on each driver stack is recorded in the{' '}
          <a href={`${REPO_URL}/blob/main/docs/HARDWARE_VERIFICATION.md`} target="_blank" rel="noreferrer" className="text-data underline underline-offset-2">hardware verification reference<span className="sr-only"> (opens in a new tab)</span></a>;
          anything not listed there is source-backed or illustrative, and labelled as such.
        </span>
      </PageHeader>
      {gs.length === 0 && <p className="text-muted" role="status">No notes yet.</p>}
      <div className="space-y-10">
        {gs.map((g) => (
          <section key={g.key} aria-labelledby={`vg-${g.key}`}>
            <h2 id={`vg-${g.key}`} className="mb-3 text-lg font-bold">{g.title}</h2>
            <ul className="space-y-3">
              {g.notes.map((n, i) => (
                <li key={`${n.id}-${i}`}>
                  <Card className="p-4">
                    <h3 className="flex items-start gap-2 font-semibold"><BadgeCheck size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden /><span>{inlineCode(n.title)}</span></h3>
                    {n.text && <div className="mt-1.5 text-sm [&_.prose]:max-w-none [&_.prose]:text-[0.92rem]"><Markdown source={n.text} /></div>}
                    <Link to={hrefOf(n)} className="mt-2 inline-block text-sm text-data underline underline-offset-2">
                      {n.kind === 'lesson' ? 'Lesson' : n.kind === 'lab' ? 'Lab' : 'Guide'}: {n.page.split(':')[0]}{n.heading ? ` · ${n.heading.replace(/[`*]/g, '')}` : ''}
                    </Link>
                  </Card>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
