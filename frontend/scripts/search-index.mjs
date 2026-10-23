// Builds the compact site-wide search index (public/content/search.json). Pure functions only, so
// build-content.mjs can call them and tests/search.test.ts can exercise them without touching disk.
//
// Format (version 1): { v: 1, types: string[], c: string[], d: Doc[], e: Entry[] }
//   c     = common words: keywords found in more than COMMON_SHARE of all sections. They are removed from
//           the keyword lists (they discriminate nothing and are a fifth of the file) and the ranker treats
//           a query word that matches one of them as optional rather than required.
//   Doc   = [typeIndex, url, title]                       one per page (lesson, lab, command, ...)
//   Entry = [docIndex, anchor, heading, snippet, keywords] one per section of that page
// anchor:   the heading id to scroll to ('' for the top of the page); the app links to `${url}?s=${anchor}`
// heading:  the section heading ('' for the page itself or its introduction)
// snippet:  the first ~SNIPPET_CHARS characters of the section as plain text (shown in results)
// keywords: the remaining distinct words of the section, lower-cased and space separated (matched, never
//           shown). Stop words are dropped, and so is any word that is a prefix of another word of the same
//           entry, because search matches word prefixes: "port" adds nothing when "ports" is present.

export const TYPES = ['lesson', 'module', 'quiz', 'sim', 'lab', 'guide', 'command', 'term', 'widget', 'exam'];
export const SNIPPET_CHARS = 180;
export const COMMON_SHARE = 0.03;

/** Must stay identical to slug() in src/content.ts: the rendered heading ids come from it. */
export const slug = (s) =>
  s.toLowerCase().replace(/<[^>]+>/g, '').replace(/[`*_]/g, '').replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');

/** Heading text as the Markdown renderer shows it (links reduced to their text). */
export const headingText = (h) => h.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').trim();

const STOP = new Set(('a an and are as at be but by can do does for from has have how if in into is it its no not of on ' +
  'or so than that the their them then there these this those to too was we were what when where which while who why will ' +
  'with you your our also just more most only other same such very each any all both one two use used using every ' +
  'about after again against almost already always among another anything around because before being below between ' +
  'could did doing done down during either else enough even ever few first get gets getting given gives go goes ' +
  'going good got had here itself keep keeps last least less let like likely look looks made make makes many may might ' +
  'much must need needs never next now off often once onto others out over own per put quite rather really said say says ' +
  'see seen should since some something still take takes tell thing things think though through thus together ' +
  'under until up upon us usually want way ways well went whether whole whose within without would yet').split(' '));

/** Same tokenizer as src/search.ts: lower case, split on anything that is not a letter, digit or underscore. */
export const tokenize = (s) => s.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);

/** Markdown to plain prose: drops fenced blocks (code, mermaid, widgets), HTML, tables rules, link targets and markup. */
export function stripMarkdown(md) {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s*\|?\s*:?-{2,}.*$/gm, ' ') // table separator rows
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[!(NOTE|TIP|WARNING|ANALOGY|INTERVIEW|VERIFIED)\]/gi, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>+\s?/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, '$1')
    .replace(/[`*~|]/g, ' ')
    // _emphasis_ markers go, underscores inside identifiers (mlnx_qos, NCCL_IB_HCA) stay.
    .replace(/(?<![A-Za-z0-9])_+|_+(?![A-Za-z0-9])/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Splits a Markdown body at ## and ### headings. The text before the first heading has heading ''. */
export function splitSections(md) {
  const out = [];
  let cur = { heading: '', lines: [] };
  let fence = false;
  for (const line of md.split('\n')) {
    if (line.trim().startsWith('```')) fence = !fence;
    const m = !fence && line.match(/^(##|###) (.+)$/);
    if (m) {
      out.push(cur);
      cur = { heading: headingText(m[2]), lines: [] };
    } else cur.lines.push(line);
  }
  out.push(cur);
  return out
    .map((s) => ({ heading: s.heading.replace(/[`*]/g, ''), anchor: s.heading ? slug(s.heading) : '', text: stripMarkdown(s.lines.join('\n')) }))
    .filter((s) => s.heading || s.text);
}

/** First `max` characters of `text`, cut at a word boundary. */
export function snippet(text, max = SNIPPET_CHARS) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.(-]+$/, '')}…`;
}

/** Distinct, useful words of `text` that are not already in `exclude` and not a prefix of another word. */
export function keywords(text, exclude = '') {
  const shown = new Set(tokenize(exclude));
  const cand = new Set();
  for (const t of tokenize(text)) if (!shown.has(t) && !STOP.has(t) && (t.length > 1 || /\d/.test(t))) cand.add(t);
  // A word that prefixes a longer word (here or in the shown text) can never add a match.
  const all = [...new Set([...cand, ...shown])].sort();
  const redundant = new Set();
  for (let i = 0; i < all.length - 1; i++) if (all[i + 1].startsWith(all[i])) redundant.add(all[i]);
  return [...cand].filter((t) => !redundant.has(t)).join(' ');
}

function section(heading, text, extra = '', title = '') {
  const snip = snippet(text);
  return { heading, snip, kw: keywords(`${text} ${extra}`, `${title} ${heading} ${snip}`) };
}


/** One section per heading of a Markdown document; the first carries the document summary. */
function documentSections(title, body, summary = '') {
  const secs = splitSections(body);
  const out = secs.map((s, i) => ({ anchor: s.anchor, ...(i === 0 && !s.heading
    ? section('', `${summary} ${s.text}`.trim(), '', title)
    : section(s.heading, s.text, '', title)) }));
  if (!out.length || secs[0].heading) out.unshift({ anchor: '', ...section('', summary, '', title) });
  return out;
}

/**
 * @param {object} c content gathered by build-content.mjs
 * @returns {{ v: 1, types: string[], d: Array<[number, string, string]>, e: Array<[number, string, string, string, string]> }}
 */
export function buildSearchIndex(c) {
  const d = [];
  const e = [];
  const add = (type, url, title, sections) => {
    const ti = TYPES.indexOf(type);
    if (ti < 0) throw new Error(`unknown search type ${type}`);
    d.push([ti, url, title]);
    for (const s of sections) e.push([d.length - 1, s.anchor ?? '', s.heading, s.snip, s.kw]);
  };
  const one = (type, url, title, heading, text, extra = '') => add(type, url, title, [section(heading, text, extra, title)]);

  for (const m of c.modules ?? []) one('module', `/module/${m.id}`, `Module ${m.order}: ${m.title}`, '', m.summary ?? '');
  for (const l of c.lessons ?? [])
    add('lesson', `/lesson/${l.id}`, l.title, documentSections(l.title, c.lessonBodies?.get(l.id) ?? '', [...(l.objectives ?? []), ...(l.tags ?? [])].join('. ')));
  for (const q of c.quizzes ?? []) {
    const lesson = c.lessons?.find((l) => l.id === q.lesson);
    one('quiz', `/quiz/${q.id}`, q.title ?? `Quiz: ${lesson?.title ?? q.lesson}`, '', `${q.questions?.length ?? 0} questions on ${lesson?.title ?? q.lesson}.`,
      (q.questions ?? []).map((x) => x.prompt).join(' '));
  }
  for (const lab of c.labs ?? []) {
    if (lab.kind === 'sim') one('sim', `/labs/${lab.id}`, lab.title, '', stripMarkdown(`${lab.summary ?? ''} ${lab.ticket ?? ''}`));
    else add('lab', `/hw/labs/${lab.id}`, lab.title, documentSections(lab.title, c.labBodies?.get(lab.id) ?? '', lab.summary ?? ''));
  }
  for (const g of c.guides ?? [])
    add('guide', g.id === 'overview' ? '/hw' : `/hw/${g.id}`, g.title, documentSections(g.title, c.guideBodies?.get(g.id) ?? '', g.summary ?? ''));
  for (const grp of c.commands ?? [])
    for (const cmd of grp.commands ?? [])
      one('command', `/reference?tab=commands&q=${encodeURIComponent(cmd.cmd)}`, cmd.cmd, grp.title ?? '', cmd.summary ?? '',
        `${cmd.notes ?? ''} ${(cmd.tags ?? []).join(' ')} ${cmd.platform ?? ''} ${Object.values(cmd.stacks ?? {}).map((v) => `${v?.cmd ?? ''} ${v?.notes ?? ''}`).join(' ')}`);
  for (const t of c.glossary ?? [])
    one('term', `/reference?tab=glossary&q=${encodeURIComponent(t.term)}`, t.term, t.expansion ?? '', t.definition ?? '');
  for (const w of c.widgets ?? []) one('widget', `/visualize/${w.id}`, w.title, '', w.summary ?? '');
  for (const ex of c.exams ?? []) one('exam', `/exams/${ex.id}`, ex.title, '', ex.description ?? '');
  // Drop the most frequent keywords and publish them as the common-word list.
  const df = new Map();
  for (const x of e) for (const t of x[4].split(' ')) if (t) df.set(t, (df.get(t) ?? 0) + 1);
  const limit = Math.max(c.minCommonDf ?? 20, Math.round(e.length * COMMON_SHARE));
  const common = new Set([...df].filter(([, n]) => n > limit).map(([t]) => t));
  for (const x of e) x[4] = x[4].split(' ').filter((t) => t && !common.has(t)).join(' ');
  return { v: 1, types: TYPES, c: [...common].sort(), d, e };
}

/** Widget id, title and summary straight from src/widgets/registry.tsx (the single source of truth). */
export function parseWidgetRegistry(src) {
  return [...src.matchAll(/\{\s*id:\s*'([^']+)',\s*title:\s*'((?:[^'\\]|\\.)*)',\s*summary:\s*'((?:[^'\\]|\\.)*)'/g)]
    .map(([, id, title, summary]) => ({ id, title: title.replace(/\\'/g, "'"), summary: summary.replace(/\\'/g, "'") }));
}
