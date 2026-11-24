// Figures are written in the lessons as Mermaid source and drawn by our own compiler (scripts/figures.mjs)
// and renderer. The source is the content: these tests hold the compiler to reading it exactly, and the
// layout to being drawable, for every figure in the content.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { compileFigure, compileFigures, crossings, FigureError, figureAlt, figureSources, figureTexts, parseFigure, TARGET_WIDTH, textWidth, wrapText, type FlowModel, type SequenceModel } from '../scripts/figures.mjs';
import { roundedPath, type FigureData } from '../src/components/Figure';
import { repoStats } from '../scripts/doc-stats.mjs';

const content = path.resolve(__dirname, '../../content');
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.md') ? [path.join(dir, e.name)] : []));
const figures = walk(content).sort().flatMap((file) => {
  const rel = path.relative(content, file).split(path.sep).join('/');
  return figureSources(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).map((source, index) => ({ page: rel, index, source, name: `${rel} #${index + 1}` }));
});
const hardware = yaml.load(fs.readFileSync(path.join(content, 'hardware/hardware.yaml'), 'utf8')) as { variables: { name: string; default?: string }[] };
const vars = Object.fromEntries(hardware.variables.filter((v) => typeof v.default === 'string').map((v) => [v.name, v.default as string]));
const filled = (s: string) => s.replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, (_, k: string) => vars[k] ?? `{{${k}}}`);
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

describe('figure parser', () => {
  it('reads boxes, shapes, connections and their labels', () => {
    const m = parseFigure(`flowchart LR
  A["Sender (400G)"] --> Q{"Queue full?"}
  Q -->|"Yes"| P["Pause"] -- "after XOFF" --> A
  Q -. "No" .-> D[("Buffer cells")]
  P --- X[Plain label]
  D -.-> X`) as FlowModel;
    expect(m.dir).toBe('LR');
    expect(m.nodes).toEqual([
      { id: 'A', label: 'Sender (400G)', shape: 'rect', group: null }, { id: 'Q', label: 'Queue full?', shape: 'decision', group: null },
      { id: 'P', label: 'Pause', shape: 'rect', group: null }, { id: 'D', label: 'Buffer cells', shape: 'cylinder', group: null }, { id: 'X', label: 'Plain label', shape: 'rect', group: null },
    ]);
    expect(m.edges).toEqual([
      { from: 'A', to: 'Q', style: 'arrow', label: '' }, { from: 'Q', to: 'P', style: 'arrow', label: 'Yes' }, { from: 'P', to: 'A', style: 'arrow', label: 'after XOFF' },
      { from: 'Q', to: 'D', style: 'dotted', label: 'No' }, { from: 'P', to: 'X', style: 'line', label: '' }, { from: 'D', to: 'X', style: 'dotted', label: '' },
    ]);
  });

  it('puts a box in the subgraph it is written in, keeps line breaks, and treats TD as TB', () => {
    const m = parseFigure(`graph TD
  subgraph S1["Server A"]
    A0["GPU0<br/>NIC0"]
    subgraph Inner[Inner group]
      A1["GPU1"]
    end
  end
  L0["Leaf 0"]
  A0 --- L0
  A1 --- L0
  L0 --> S1`) as FlowModel;
    expect(m.dir).toBe('TB');
    expect(m.groups).toEqual([{ id: 'S1', title: 'Server A', parent: null }, { id: 'Inner', title: 'Inner group', parent: 'S1' }]);
    expect(m.nodes.map((n) => [n.id, n.label, n.group])).toEqual([['A0', 'GPU0\nNIC0', 'S1'], ['A1', 'GPU1', 'Inner'], ['L0', 'Leaf 0', null]]);
    expect(m.edges[2]).toEqual({ from: 'L0', to: 'S1', style: 'arrow', label: '' }); // an arrow to the subgraph itself
  });

  it('reads sequence diagrams: participants, messages, replies, self messages and notes', () => {
    const m = parseFigure(`sequenceDiagram
  participant A as Host A 10.0.3.11
  participant S as Switch
  A->>S: Who has 10.0.3.12?
  S-->>A: reply: with a colon
  A->>A: update cache
  Note over A,S: both learn
  S->>B: implicit participant`) as SequenceModel;
    expect(m.actors).toEqual([{ id: 'A', label: 'Host A 10.0.3.11' }, { id: 'S', label: 'Switch' }, { id: 'B', label: 'B' }]);
    expect(m.steps).toEqual([
      { type: 'message', from: 'A', to: 'S', dashed: false, text: 'Who has 10.0.3.12?' }, { type: 'message', from: 'S', to: 'A', dashed: true, text: 'reply: with a colon' },
      { type: 'message', from: 'A', to: 'A', dashed: false, text: 'update cache' }, { type: 'note', over: ['A', 'S'], text: 'both learn' },
      { type: 'message', from: 'S', to: 'B', dashed: false, text: 'implicit participant' },
    ]);
  });

  it('rejects anything it would otherwise have to guess at, naming the line', () => {
    const bad = (src: string, re: RegExp) => expect(() => parseFigure(src)).toThrowError(re);
    bad('pie title Pets', /line 1: unsupported header/);
    bad('flowchart LR\n  A(["Stadium"]) --> B', /line 2: unsupported node shape/);
    bad('flowchart LR\n  A ==> B', /line 2: unsupported connection/);
    bad('flowchart LR\n  A --> B\n  classDef x fill:#f00', /line 3/);
    bad('flowchart TB\n  subgraph G["Group"]\n  A --> B', /not closed/);
    bad('flowchart TB\n  end', /without a subgraph/);
    bad('sequenceDiagram\n  A->>B: hi\n  loop every second', /line 3: unsupported sequence statement/);
    expect(() => parseFigure('flowchart LR\n  A ==> B')).toThrowError(FigureError);
  });

  it('describes a figure in words for people who cannot see it', () => {
    expect(figureAlt(parseFigure('flowchart LR\n  accTitle: Incast\n  S1["Sender 1"] --> L["Leaf queue"]\n  L -->|"400G drain"| R["Receiver"]\n  R --- X["Probe"]')))
      .toBe('Incast. Diagram. Connections: Sender 1 to Leaf queue; Leaf queue to Receiver (400G drain); Receiver with Probe.');
    expect(figureAlt(parseFigure('sequenceDiagram\n  participant A as App\n  participant N as NIC\n  A->>N: doorbell\n  Note over N: DMA\n  N-->>A: completion')))
      .toBe('Sequence diagram between App, NIC. App to NIC: doorbell; note at NIC: DMA; NIC to App: completion.');
  });
});

describe('text measurement and drawing helpers', () => {
  it('measures with the app\'s glyph widths and wraps at word boundaries', () => {
    expect(textWidth('iii', 'sans500', 13)).toBeLessThan(textWidth('WWW', 'sans500', 13));
    expect(textWidth('abc', 'mono500', 10)).toBeCloseTo(18, 5);
    const lines = wrapText('RoCE retransmits, pause storms or low throughput under load', 'sans500', 13, 150);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(' ')).toBe('RoCE retransmits, pause storms or low throughput under load');
    for (const l of lines) expect(textWidth(l, 'sans500', 13)).toBeLessThanOrEqual(150);
    expect(wrapText('one\ntwo', 'sans500', 13, 500)).toEqual(['one', 'two']);
  });
  it('rounds the corners of an orthogonal path and counts crossings', () => {
    expect(roundedPath([[0, 0], [10, 0]])).toBe('M0,0 L10,0');
    expect(roundedPath([[0, 0], [40, 0], [40, 40]], 8)).toBe('M0,0 L32,0 Q40,0 40,8 L40,40');
    expect(crossings([{ points: [[0, 0], [10, 10]] }, { points: [[0, 10], [10, 0]] }])).toBe(1);
    expect(crossings([{ points: [[0, 0], [10, 0]] }, { points: [[0, 5], [10, 5]] }])).toBe(0);
  });
});

describe('every figure in the content', () => {
  it('is counted by the compiler', () => {
    expect(figures.length).toBe(repoStats().figures);
    expect(figures.length).toBeGreaterThan(50);
  });

  const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/figures-baseline.json'), 'utf8')).figures as Record<string, any>[];
  it('is read exactly as Mermaid itself read it before the renderer was replaced', () => {
    let compared = 0;
    for (const b of baseline) {
      const fig = figures.find((f) => f.page === b.page && f.index === b.index);
      if (!fig || crypto.createHash('sha1').update(fig.source).digest('hex').slice(0, 12) !== b.source) continue; // edited since: the generic checks below apply
      compared++;
      const m = parseFigure(fig.source);
      expect(m.kind, fig.name).toBe(b.kind);
      if (m.kind === 'sequence') {
        expect(m.actors.map((a) => flat(filled(a.label))).sort(), fig.name).toEqual(b.actors);
        expect(m.steps.map((s) => `${s.type}: ${flat(filled(s.text))}`), fig.name).toEqual(b.steps);
        expect(m.steps.filter((s) => s.type === 'message').map((s) => (s as { dashed: boolean }).dashed), fig.name).toEqual(b.replies);
      } else {
        expect(Object.fromEntries(m.nodes.map((n) => [n.id, flat(filled(n.label))])), fig.name).toEqual(b.nodes);
        expect(m.nodes.filter((n) => n.shape === 'decision').map((n) => n.id).sort(), fig.name).toEqual(b.decisions);
        expect(m.edges.map((e) => `${e.from} > ${e.to} | ${e.style} | ${flat(filled(e.label))}`).sort(), fig.name).toEqual(b.edges);
        expect(Object.fromEntries(m.groups.map((g) => [g.id, flat(filled(g.title))])), fig.name).toEqual(b.groups);
        if (Object.keys(b.members).length) expect(Object.fromEntries(m.nodes.map((n) => [n.id, n.group])), fig.name).toEqual(b.members);
      }
    }
    expect(compared).toBeGreaterThan(70);
  });

  it('is drawn with every label, no overlapping boxes, text that fits, and connections that reach their boxes', async () => {
    const overlap = (a: { x: number; y: number; w: number; h: number }, b: typeof a, gap = 0) => a.x < b.x + b.w - gap && b.x < a.x + a.w - gap && a.y < b.y + b.h - gap && b.y < a.y + a.h - gap;
    const onBorder = ([x, y]: [number, number], b: { x: number; y: number; w: number; h: number }) => x >= b.x - 2 && x <= b.x + b.w + 2 && y >= b.y - 2 && y <= b.y + b.h + 2
      && (Math.abs(x - b.x) < 2 || Math.abs(x - b.x - b.w) < 2 || Math.abs(y - b.y) < 2 || Math.abs(y - b.y - b.h) < 2);
    const widths: number[] = [];
    for (const fig of figures) {
      const model = parseFigure(fig.source);
      const g = await compileFigure(fig.source, vars) as FigureData;
      expect(g.v, fig.name).toBe(1);
      expect(g.alt.length, fig.name).toBeGreaterThan(20);
      widths.push(g.w);
      const drawn = g.kind === 'flow'
        ? [...g.groups.map((x) => x.title), ...g.nodes.map((n) => n.lines.join(' ')), ...g.edges.filter((e) => e.label).map((e) => e.label!.lines.join(' '))]
        : [...g.actors.map((a) => a.lines.join(' ')), ...g.steps.map((s) => s.lines.join(' '))];
      // nothing added, dropped or reworded
      expect(drawn.map(flat).sort(), fig.name).toEqual(figureTexts(model).map((t) => flat(t)).sort());
      const inside = (b: { x: number; y: number; w: number; h: number }) => b.x >= 0 && b.y >= 0 && b.x + b.w <= g.w + 0.5 && b.y + b.h <= g.h + 0.5;
      if (g.kind === 'flow') {
        const m = model as FlowModel;
        for (const [i, a] of g.nodes.entries()) {
          expect(inside(a), `${fig.name}: ${a.id} inside the drawing`).toBe(true);
          for (const b of g.nodes.slice(i + 1)) expect(overlap(a, b), `${fig.name}: ${a.id} overlaps ${b.id}`).toBe(false);
          for (const l of a.lines) expect(textWidth(filled(l), 'sans500', 13), `${fig.name}: "${l}" fits ${a.id}`).toBeLessThanOrEqual(a.w - (a.shape === 'decision' ? 34 : 16));
          const group = g.groups.find((x) => x.id === m.nodes.find((n) => n.id === a.id)!.group);
          if (group) expect(a.x >= group.x && a.y >= group.y && a.x + a.w <= group.x + group.w && a.y + a.h <= group.y + group.h, `${fig.name}: ${a.id} inside ${group.id}`).toBe(true);
        }
        for (const grp of g.groups) expect(grp.tw + 30, `${fig.name}: title of ${grp.id} fits`).toBeLessThanOrEqual(grp.w + 1);
        const box = (id: string) => g.nodes.find((n) => n.id === id) ?? g.groups.find((x) => x.id === id)!;
        for (const e of g.edges) {
          expect(e.points.length, fig.name).toBeGreaterThanOrEqual(2);
          expect(onBorder(e.points[0], box(e.from)), `${fig.name}: ${e.from} > ${e.to} starts at ${e.from}`).toBe(true);
          expect(onBorder(e.points[e.points.length - 1], box(e.to)), `${fig.name}: ${e.from} > ${e.to} ends at ${e.to}`).toBe(true);
          if (e.label) for (const n of g.nodes) expect(overlap(e.label, n, 1), `${fig.name}: label "${e.label.lines.join(' ')}" covers ${n.id}`).toBe(false);
        }
        expect(g.flowing, fig.name).toBe(m.edges.length > 0 && m.edges.every((e) => e.style !== 'line') && m.nodes.every((n) => n.shape !== 'decision'));
      } else {
        for (const [i, a] of g.actors.entries()) {
          expect(inside(a), fig.name).toBe(true);
          for (const b of g.actors.slice(i + 1)) expect(overlap(a, b), fig.name).toBe(false);
        }
        const ys = g.steps.map((s) => s.y);
        expect([...ys].sort((a, b) => a - b), `${fig.name}: steps in source order, top to bottom`).toEqual(ys);
        for (const s of g.steps) if (s.type === 'message' && !s.self) expect(Math.abs(s.x2 - s.x1), fig.name).toBeGreaterThanOrEqual(Math.max(...s.lines.map((l) => textWidth(filled(l), 'sans500', 12))) + 30);
      }
    }
    // a lesson column shows a figure at 82 % or more of its size; only a few may need to scroll sideways
    expect(Math.max(...widths)).toBeLessThan(1000);
    expect(widths.filter((w) => w > TARGET_WIDTH + 8).length).toBeLessThanOrEqual(4);
  }, 120_000);

  it('compiles into the lesson body as geometry, leaving nothing of the source fence behind', async () => {
    const body = 'Text before.\n\n```mermaid\nflowchart LR\n  A["One"] --> B["Two"]\n```\n\nBetween.\n\n```mermaid\nsequenceDiagram\n  A->>B: hi\n```\n\nAfter.';
    const out = await compileFigures(body);
    expect(out).not.toContain('```mermaid');
    const blocks = [...out.matchAll(/```figure\n(.*)\n```/g)].map((m) => JSON.parse(m[1]) as FigureData);
    expect(blocks.map((b) => b.kind)).toEqual(['flow', 'sequence']);
    expect(out.startsWith('Text before.') && out.endsWith('After.') && out.includes('Between.')).toBe(true);
  });
});
