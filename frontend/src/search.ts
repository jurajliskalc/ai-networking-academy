// Site-wide search over public/content/search.json (built by scripts/search-index.mjs).
// Dependency-free ranking: every query word must prefix-match a word of the section (words in the index's
// common-word list are optional), with boosts for matches in the page title and the section heading.

export type SearchType = 'lesson' | 'module' | 'quiz' | 'sim' | 'lab' | 'guide' | 'command' | 'term' | 'widget' | 'exam';

export interface SearchIndexFile {
  v: 1;
  types: string[];
  c: string[];
  d: [number, string, string][];
  e: [number, string, string, string, string][];
}

export interface SearchDoc {
  type: SearchType;
  url: string;
  title: string;
  /** Section anchor ('' for the top of the page). */
  anchor: string;
  heading: string;
  snippet: string;
  // Pre-tokenised fields for matching.
  tTitle: string[];
  tHeading: string[];
  tBody: string[];
}

export interface PreparedIndex { docs: SearchDoc[]; common: Set<string> }

export interface SearchHit { doc: SearchDoc; score: number; href: string }
export interface SearchGroup { type: SearchType; label: string; hits: SearchHit[] }

export const TYPE_LABELS: Record<SearchType, string> = {
  lesson: 'Lessons', module: 'Modules', quiz: 'Quizzes', sim: 'Simulator labs', lab: 'Hands-on and hardware labs',
  guide: 'Hardware guides', command: 'Commands', term: 'Glossary', widget: 'Visualizations', exam: 'Mock exams',
};

/** Same tokenizer as scripts/search-index.mjs. */
export const tokenize = (s: string) => s.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);

export function prepare(ix: SearchIndexFile): PreparedIndex {
  const docs = ix.e.map(([di, anchor, heading, snippet, kw]) => {
    const [ti, url, title] = ix.d[di];
    return {
      type: ix.types[ti] as SearchType, url, title, anchor, heading, snippet,
      tTitle: tokenize(title), tHeading: tokenize(heading), tBody: tokenize(`${snippet} ${kw}`),
    };
  });
  return { docs, common: new Set(ix.c ?? []) };
}

export const hrefOf = (d: Pick<SearchDoc, 'url' | 'anchor'>) =>
  d.anchor ? `${d.url}${d.url.includes('?') ? '&' : '?'}s=${encodeURIComponent(d.anchor)}` : d.url;

/** 2 for an exact word, 1 for a prefix, 0 for no match. */
function matchIn(tokens: string[], term: string): number {
  let best = 0;
  for (const t of tokens) {
    if (t === term) return 2;
    if (best === 0 && t.startsWith(term)) best = 1;
  }
  return best;
}

const TYPE_BOOST: Partial<Record<SearchType, number>> = { lesson: 1.5, term: 1, command: 1, widget: 1, module: 0.5 };

/** Score one section against the query words; null when a required word does not match. */
export function scoreDoc(doc: SearchDoc, terms: string[], common: Set<string> = new Set(), phrase = ''): number | null {
  let score = 0;
  let matched = 0;
  for (const term of terms) {
    const ti = matchIn(doc.tTitle, term);
    const hi = matchIn(doc.tHeading, term);
    const bi = ti || hi ? 0 : matchIn(doc.tBody, term);
    if (!ti && !hi && !bi) {
      // A common word (or a prefix of one) was pruned from many keyword lists, so it cannot be required.
      if (isCommon(term, common)) continue;
      return null;
    }
    matched++;
    score += ti ? 8 + 4 * (ti - 1) : 0;
    score += hi ? 5 + 2 * (hi - 1) : 0;
    score += bi ? 1 + (bi - 1) : 0;
  }
  if (!matched) return null;
  const title = doc.title.toLowerCase();
  if (phrase && title === phrase) score += 20;
  else if (phrase && title.startsWith(phrase)) score += 8;
  else if (phrase.includes(' ') && (title.includes(phrase) || doc.heading.toLowerCase().includes(phrase))) score += 6;
  // Whole-page entries beat their sub-sections when the title matches, so the page comes first.
  if (!doc.anchor && !doc.heading && score > 0) score += 1;
  return score + (TYPE_BOOST[doc.type] ?? 0);
}

function isCommon(term: string, common: Set<string>): boolean {
  if (common.has(term)) return true;
  if (term.length < 3) return false;
  for (const c of common) if (c.startsWith(term)) return true;
  return false;
}

/** Ranked hits, best first; at most `perType` sections per type and `perPage` sections per page. */
export function search(ix: PreparedIndex, query: string, { limit = 40, perType = 8, perPage = 3 } = {}): SearchHit[] {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length) return [];
  const phrase = query.trim().toLowerCase();
  const hits: SearchHit[] = [];
  for (const doc of ix.docs) {
    const score = scoreDoc(doc, terms, ix.common, phrase);
    if (score !== null) hits.push({ doc, score, href: hrefOf(doc) });
  }
  hits.sort((a, b) => b.score - a.score || a.doc.title.length - b.doc.title.length);
  const byType = new Map<string, number>();
  const byPage = new Map<string, number>();
  const out: SearchHit[] = [];
  for (const h of hits) {
    const nt = byType.get(h.doc.type) ?? 0;
    const np = byPage.get(h.doc.url) ?? 0;
    if (nt >= perType || np >= perPage) continue;
    byType.set(h.doc.type, nt + 1);
    byPage.set(h.doc.url, np + 1);
    out.push(h);
    if (out.length >= limit) break;
  }
  return out;
}

/** Hits grouped by type; groups ordered by their best hit. */
export function group(hits: SearchHit[]): SearchGroup[] {
  const m = new Map<SearchType, SearchHit[]>();
  for (const h of hits) m.set(h.doc.type, [...(m.get(h.doc.type) ?? []), h]);
  return [...m].map(([type, hs]) => ({ type, label: TYPE_LABELS[type] ?? type, hits: hs }));
}

/** Splits `text` into plain and highlighted parts: a part is a hit when a query word prefixes a word there. */
export function highlight(text: string, terms: string[]): { text: string; hit: boolean }[] {
  const ts = terms.filter(Boolean).map((t) => t.toLowerCase());
  if (!ts.length || !text) return [{ text, hit: false }];
  const parts: { text: string; hit: boolean }[] = [];
  const re = /[A-Za-z0-9_]+/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const w = m[0].toLowerCase();
    const t = ts.filter((x) => w.startsWith(x)).sort((a, b) => b.length - a.length)[0];
    if (!t) continue;
    if (m.index > last) parts.push({ text: text.slice(last, m.index), hit: false });
    parts.push({ text: text.slice(m.index, m.index + t.length), hit: true });
    last = m.index + t.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), hit: false });
  return parts;
}
