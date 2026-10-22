// Site search: the index builder (scripts/search-index.mjs) and the ranking (src/search.ts).
import { describe, expect, it } from 'vitest';
import { buildSearchIndex, keywords, parseWidgetRegistry, slug as buildSlug, snippet, splitSections, stripMarkdown, tokenize as buildTokenize } from '../scripts/search-index.mjs';
import { group, highlight, hrefOf, prepare, search, tokenize, type SearchIndexFile } from '../src/search';
import { slug } from '../src/content';

const LESSON = `Intro paragraph about **RoCEv2** and [lossless](https://example.com) Ethernet.

## Why this matters
PFC pauses a priority. \`mlnx_qos\` shows the config.

\`\`\`bash
ethtool -S eth0 | grep pause_storm_noise
\`\`\`

## Headroom and \`xoff\` thresholds
> [!TIP]
> Headroom absorbs in-flight bytes after XOFF.

| Speed | Cable |
|---|---|
| 400G | 100 m |

### Sub topic: cable length
Longer cables need more headroom.
`;

function fixture() {
  const lessons = [{ id: 'pfc', title: 'Priority Flow Control', objectives: ['Explain PFC'], tags: ['lossless'] }];
  return buildSearchIndex({
    modules: [{ id: 'm06', order: 6, title: 'RoCEv2 and lossless Ethernet', summary: 'PFC, ECN and DCQCN.' }],
    lessons,
    lessonBodies: new Map([['pfc', LESSON]]),
    quizzes: [{ id: 'quiz-pfc', title: 'Knowledge check: PFC', lesson: 'pfc', questions: [{ prompt: 'What does a PAUSE frame stop?' }] }],
    labs: [
      { id: 'sim-03', kind: 'sim', title: 'PFC priority mismatch', summary: 'Drops on priority 3.', ticket: 'Training job **slow**.' },
      { id: 'hw-03', kind: 'handson', title: 'Host QoS', summary: 'Configure trust.' },
    ],
    labBodies: new Map([['hw-03', '## Goal\nSet `mlnx_qos --trust dscp` on {{A_NETDEV}}.\n']]),
    guides: [{ id: 'overview', title: 'Overview', summary: 'Bring your own gear.' }],
    guideBodies: new Map([['overview', 'Some text.\n\n## Safety first\nRead-only by default.']]),
    commands: [{ id: 'mellanox', title: 'NVIDIA NIC tools', commands: [{ cmd: 'mlnx_qos -i <dev>', summary: 'Show or set trust, PFC and ETS.', tags: ['pfc'] }] }],
    glossary: [{ term: 'XOFF', expansion: 'Transmit off', definition: 'The PFC threshold at which a pause is sent.' }],
    widgets: [{ id: 'headroom-calculator', title: 'PFC headroom calculator', summary: 'Cable length to headroom.' }],
    exams: [{ id: 'exam-1', title: 'Mock exam 1', description: 'Lossless Ethernet.' }],
  });
}

describe('search index builder', () => {
  it('uses the same slug as the app, so section anchors match rendered heading ids', () => {
    for (const h of ['Headroom and `xoff` thresholds', 'Why this matters', 'PFC: pause *frames* (802.1Qbb)', 'A_B c--d'])
      expect(buildSlug(h)).toBe(slug(h));
  });

  it('uses the same tokenizer at build time and at query time', () => {
    for (const s of ['NCCL_IB_HCA=mlx5_0,mlx5_1', 'RoCEv2 / 802.1Qbb', 'ib_write_bw --report_gbits']) expect(buildTokenize(s)).toEqual(tokenize(s));
  });

  it('strips Markdown, code blocks, link targets and callout markers', () => {
    const t = stripMarkdown(LESSON);
    expect(t).toContain('RoCEv2 and lossless Ethernet');
    expect(t).toContain('mlnx_qos');
    expect(t).not.toMatch(/pause_storm_noise|https:|\[!TIP\]|\*\*|```|\|/);
    expect(stripMarkdown('Use {{A_NETDEV}} here')).toBe('Use A_NETDEV here');
  });

  it('splits at ## and ### headings and ignores # inside code fences', () => {
    const secs = splitSections(`${LESSON}\n\`\`\`\n## not a heading\n\`\`\`\n`);
    expect(secs.map((s) => s.heading)).toEqual(['', 'Why this matters', 'Headroom and xoff thresholds', 'Sub topic: cable length']);
    expect(secs[2].anchor).toBe(slug('Headroom and `xoff` thresholds'));
    expect(secs[3].text).toBe('Longer cables need more headroom.');
  });

  it('cuts snippets at a word boundary and drops redundant keywords', () => {
    const s = snippet('word '.repeat(100), 30);
    expect(s.length).toBeLessThanOrEqual(31);
    expect(s.endsWith('…')).toBe(true);
    // "port" is a prefix of "ports", "the" is a stop word, "pfc" is already shown in the title.
    expect(keywords('the port ports pfc buffer', 'PFC').split(' ').sort()).toEqual(['buffer', 'ports']);
  });

  it('emits one page per item, one entry per section, with deep-link anchors', () => {
    const ix = fixture();
    expect(ix.v).toBe(1);
    const types = new Set(ix.d.map((d) => ix.types[d[0]]));
    for (const t of ['lesson', 'module', 'quiz', 'sim', 'lab', 'guide', 'command', 'term', 'widget', 'exam']) expect(types.has(t)).toBe(true);
    const lessonDoc = ix.d.findIndex((d) => d[1] === '/lesson/pfc');
    const sections = ix.e.filter((e) => e[0] === lessonDoc);
    expect(sections.map((e) => e[1])).toEqual(['', 'why-this-matters', 'headroom-and-xoff-thresholds', 'sub-topic-cable-length']);
    expect(sections[0][3]).toContain('Explain PFC'); // the page entry carries the objectives
    expect(ix.d.find((d) => d[1] === '/hw')).toBeTruthy(); // the overview guide lives at /hw
    expect(ix.d.find((d) => d[2] === 'mlnx_qos -i <dev>')?.[1]).toBe('/reference?tab=commands&q=mlnx_qos%20-i%20%3Cdev%3E');
  });

  it('parses widget metadata from the registry source', () => {
    const src = `{ id: 'a-b', title: 'It\\'s a title', summary: 'Sum: one, two.', component: lazy(() => import('./A')) },`;
    expect(parseWidgetRegistry(src)).toEqual([{ id: 'a-b', title: "It's a title", summary: 'Sum: one, two.' }]);
  });
});

describe('search ranking', () => {
  const ix = prepare(fixture() as SearchIndexFile);

  it('matches word prefixes and requires every query word', () => {
    expect(search(ix, 'headr').length).toBeGreaterThan(0);
    expect(search(ix, 'headroom zebra')).toEqual([]);
    expect(search(ix, '')).toEqual([]);
  });

  it('ranks title matches above heading matches above body matches', () => {
    const hits = search(ix, 'headroom');
    expect(hits[0].doc.title).toBe('PFC headroom calculator');
    const headingHit = hits.findIndex((h) => h.doc.heading === 'Headroom and xoff thresholds');
    const bodyHit = hits.findIndex((h) => h.doc.heading === 'Sub topic: cable length');
    expect(headingHit).toBeGreaterThan(0);
    expect(bodyHit).toBeGreaterThan(headingHit);
  });

  it('prefers an exact title match and finds commands and glossary terms', () => {
    expect(search(ix, 'xoff')[0].doc).toMatchObject({ type: 'term', title: 'XOFF' });
    expect(search(ix, 'mlnx_qos')[0].doc.type).toBe('command');
  });

  it('treats common words as optional', () => {
    const common = { ...ix, common: new Set(['cables']) };
    // "cables" would otherwise be required; as a common word it only boosts.
    expect(search(common, 'headroom cables').length).toBeGreaterThan(0);
  });

  it('builds deep links with a section parameter', () => {
    const hit = search(ix, 'thresholds').find((h) => h.doc.anchor);
    expect(hit?.href).toBe('/lesson/pfc?s=headroom-and-xoff-thresholds');
    expect(hrefOf({ url: '/reference?tab=glossary&q=x', anchor: 'a b' })).toBe('/reference?tab=glossary&q=x&s=a%20b');
  });

  it('caps sections per page and groups by type in order of the best hit', () => {
    const hits = search(ix, 'pfc', { perPage: 1 });
    const pages = hits.map((h) => h.doc.url);
    expect(new Set(pages).size).toBe(pages.length);
    const groups = group(hits);
    expect(groups.map((g) => g.type)).toEqual([...new Set(hits.map((h) => h.doc.type))]);
    expect(groups.find((g) => g.type === 'term')?.label).toBe('Glossary');
  });

  it('highlights matched word prefixes only', () => {
    expect(highlight('PFC headroom is not overhead', ['head'])).toEqual([
      { text: 'PFC ', hit: false }, { text: 'head', hit: true }, { text: 'room is not overhead', hit: false },
    ]);
    expect(highlight('abc', [])).toEqual([{ text: 'abc', hit: false }]);
  });
});
