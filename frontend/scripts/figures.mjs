// Figures. Lessons describe a diagram in Mermaid syntax (```mermaid fences). This module turns that source
// into positioned geometry at build time: a strict parser for the subset the content uses, text measured with
// the app's real glyph widths (figure-metrics.json), flowcharts laid out by ELK (layered, orthogonal edges)
// and sequence diagrams by a small layout of their own. The app only draws the result (src/components/Figure.tsx),
// so a figure looks the same everywhere, follows the colour scheme, and never shifts while a page loads.
//
// The source in the lesson is the content; nothing here may add, drop or reword a label or a connection.
// tests/figures.test.ts holds every figure in the content to that.
import fs from 'node:fs';
import ELK from 'elkjs/lib/elk.bundled.js';

const METRICS = JSON.parse(fs.readFileSync(new URL('./figure-metrics.json', import.meta.url), 'utf8'));

export class FigureError extends Error {
  constructor(line, message) {
    super(`figure line ${line}: ${message}`);
    this.line = line;
  }
}

// ---------- text ----------
const FACES = { sans500: 1, sans600: 1, mono500: 1, mono600: 1 };
/** Width in px of one line of text, from the measured glyph advances (unknown glyphs count as a wide letter). */
export function textWidth(text, face, size, tracking = 0) {
  if (!FACES[face]) throw new Error(`unknown face ${face}`);
  const table = METRICS[face];
  let w = 0;
  for (const ch of text) w += table[ch] ?? table.m;
  return w * size + tracking * size * [...text].length;
}

/** Greedy word wrap of a label (explicit line breaks kept) into lines no wider than `max` px. */
export function wrapText(label, face, size, max) {
  const lines = [];
  for (const para of label.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && textWidth(next, face, size) > max) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  return lines;
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '#quot;': '"', '&nbsp;': ' ' };
/** A label as written in the source: <br/> becomes a line break, the few HTML entities are decoded. */
const cleanLabel = (s) => s.replace(/<br\s*\/?>/gi, '\n').replace(/&amp;|&lt;|&gt;|&quot;|#quot;|&nbsp;/g, (e) => ENTITIES[e])
  .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).join('\n').trim();

// ---------- parser ----------
const ID = /^[A-Za-z0-9_]+/;
const EDGE_STYLE = { '-->': 'arrow', '---': 'line', '-.->': 'dotted' };

/** Parse a figure source. Throws FigureError on anything outside the supported subset. */
export function parseFigure(source) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => l.trim() && !l.trim().startsWith('%%'));
  if (start < 0) throw new FigureError(1, 'empty figure');
  const head = lines[start].trim();
  if (head === 'sequenceDiagram') return parseSequence(lines, start + 1);
  const m = head.match(/^(?:flowchart|graph)\s+(TB|TD|LR|RL)$/);
  if (!m) throw new FigureError(start + 1, `unsupported header "${head}" (use flowchart TB|TD|LR|RL or sequenceDiagram)`);
  return parseFlow(lines, start + 1, m[1]);
}

function parseFlow(lines, start, dir) {
  const nodes = new Map();
  const owner = new Map();
  const edges = [];
  const groups = [];
  const stack = [];
  let title = '';
  const touch = (id) => {
    if (!nodes.has(id)) nodes.set(id, { id, label: id, shape: 'rect', defined: false });
    if (stack.length && !owner.has(id)) owner.set(id, stack[stack.length - 1].id);
    return nodes.get(id);
  };
  for (let i = start; i < lines.length; i++) {
    const s = lines[i].trim();
    if (!s || s.startsWith('%%')) continue;
    const fail = (msg) => { throw new FigureError(i + 1, `${msg}: ${s}`); };
    const acc = s.match(/^accTitle\s*:\s*(.+)$/);
    if (acc) { title = acc[1].trim(); continue; }
    const sub = s.match(/^subgraph\s+([A-Za-z0-9_]+)\s*(?:\[\s*(?:"([^"]*)"|([^\]]*))\s*\])?$/);
    if (sub) {
      if (groups.some((g) => g.id === sub[1])) fail('duplicate subgraph id');
      const group = { id: sub[1], title: cleanLabel(sub[2] ?? sub[3] ?? sub[1]), parent: stack.length ? stack[stack.length - 1].id : null };
      groups.push(group);
      stack.push(group);
      continue;
    }
    if (s === 'end') {
      if (!stack.length) fail('"end" without a subgraph');
      stack.pop();
      continue;
    }
    let p = 0;
    const skip = () => { while (s[p] === ' ' || s[p] === '\t') p++; };
    const nodeRef = () => {
      skip();
      const id = ID.exec(s.slice(p))?.[0];
      if (!id) fail('expected a node id');
      p += id.length;
      const rest = s.slice(p);
      let m;
      let shape = null;
      if ((m = /^\[\(\s*"([^"]*)"\s*\)\]/.exec(rest) ?? /^\[\(([^)\]"]*)\)\]/.exec(rest))) shape = 'cylinder';
      else if ((m = /^\["([^"]*)"\]/.exec(rest) ?? /^\[([^\]"]+)\]/.exec(rest))) shape = 'rect';
      else if ((m = /^\{"([^"]*)"\}/.exec(rest) ?? /^\{([^}"]+)\}/.exec(rest))) shape = 'decision';
      else if (/^[[({>]/.test(rest)) fail('unsupported node shape (supported: ["rect"], {"decision"}, [("cylinder")])');
      const node = touch(id);
      if (m) {
        p += m[0].length;
        node.label = cleanLabel(m[1]);
        node.shape = shape;
        node.defined = true;
      }
      return id;
    };
    const edgeOp = () => {
      skip();
      const rest = s.slice(p);
      let m;
      if ((m = /^(-->|---|-\.->)\s*\|\s*(?:"([^"]*)"|([^|]*?))\s*\|/.exec(rest))) { p += m[0].length; return { style: EDGE_STYLE[m[1]], label: cleanLabel(m[2] ?? m[3]) }; }
      if ((m = /^(-->|---|-\.->)/.exec(rest))) { p += m[0].length; return { style: EDGE_STYLE[m[1]], label: '' }; }
      if ((m = /^--\s+(?:"([^"]*)"|(.+?))\s+(-->|---)/.exec(rest))) { p += m[0].length; return { style: EDGE_STYLE[m[3]], label: cleanLabel(m[1] ?? m[2]) }; }
      if ((m = /^-\.\s+(?:"([^"]*)"|(.+?))\s+\.->/.exec(rest))) { p += m[0].length; return { style: 'dotted', label: cleanLabel(m[1] ?? m[2]) }; }
      return fail('unsupported connection (supported: -->, ---, -.->, with |label| or -- label -->)');
    };
    let from = nodeRef();
    for (;;) {
      skip();
      if (p >= s.length) break;
      const op = edgeOp();
      const to = nodeRef();
      edges.push({ from, to, style: op.style, label: op.label });
      from = to;
    }
  }
  if (stack.length) throw new FigureError(lines.length, `subgraph "${stack[stack.length - 1].id}" is not closed with "end"`);
  // An id that names a subgraph and was never given a label of its own refers to that subgraph.
  const groupIds = new Set(groups.map((g) => g.id));
  for (const [id, node] of nodes) if (groupIds.has(id) && !node.defined) { nodes.delete(id); owner.delete(id); }
  if (!nodes.size) throw new FigureError(start + 1, 'a flowchart needs at least one node');
  return {
    kind: 'flow', title, dir: dir === 'TD' ? 'TB' : dir,
    nodes: [...nodes.values()].map(({ id, label, shape }) => ({ id, label, shape, group: owner.get(id) ?? null })),
    edges, groups,
  };
}

function parseSequence(lines, start) {
  const actors = new Map();
  const steps = [];
  let title = '';
  const actor = (id) => { if (!actors.has(id)) actors.set(id, { id, label: id }); return id; };
  for (let i = start; i < lines.length; i++) {
    const s = lines[i].trim();
    if (!s || s.startsWith('%%')) continue;
    let m;
    if ((m = s.match(/^accTitle\s*:\s*(.+)$/))) title = m[1].trim();
    else if ((m = s.match(/^(?:participant|actor)\s+([A-Za-z0-9_]+)(?:\s+as\s+(.+))?$/))) {
      actors.set(m[1], { id: m[1], label: cleanLabel(m[2] ?? m[1]) });
    } else if ((m = s.match(/^([A-Za-z0-9_]+)\s*(-->>|->>)\s*([A-Za-z0-9_]+)\s*:\s*(.+)$/))) {
      steps.push({ type: 'message', from: actor(m[1]), to: actor(m[3]), dashed: m[2] === '-->>', text: cleanLabel(m[4]) });
    } else if ((m = s.match(/^Note over\s+([A-Za-z0-9_]+)(?:\s*,\s*([A-Za-z0-9_]+))?\s*:\s*(.+)$/))) {
      steps.push({ type: 'note', over: [actor(m[1]), ...(m[2] ? [actor(m[2])] : [])], text: cleanLabel(m[3]) });
    } else throw new FigureError(i + 1, `unsupported sequence statement (supported: participant X as Label, A->>B: text, A-->>B: text, Note over A: text): ${s}`);
  }
  if (!steps.length) throw new FigureError(start + 1, 'a sequence diagram needs at least one message');
  return { kind: 'sequence', title, actors: [...actors.values()], steps };
}

/** Every piece of text a reader sees in a figure, in source order. Used by the tests as the content of record. */
export function figureTexts(model) {
  return model.kind === 'flow'
    ? [...model.groups.map((g) => g.title), ...model.nodes.map((n) => n.label), ...model.edges.map((e) => e.label).filter(Boolean)]
    : [...model.actors.map((a) => a.label), ...model.steps.map((s) => s.text)];
}

/** A text alternative: what the figure is and what it connects, read in source order. */
export function figureAlt(model) {
  const described = describeFigure(model);
  return model.title ? `${model.title}. ${described}` : described;
}

function describeFigure(model) {
  const one = (s) => s.replace(/\n/g, ' ');
  if (model.kind === 'sequence') {
    const name = Object.fromEntries(model.actors.map((a) => [a.id, one(a.label)]));
    const steps = model.steps.map((s) => (s.type === 'note' ? `note at ${s.over.map((a) => name[a]).join(' and ')}: ${one(s.text)}`
      : s.from === s.to ? `${name[s.from]}: ${one(s.text)}` : `${name[s.from]} to ${name[s.to]}: ${one(s.text)}`));
    return `Sequence diagram between ${model.actors.map((a) => one(a.label)).join(', ')}. ${steps.join('; ')}.`;
  }
  const name = { ...Object.fromEntries(model.groups.map((g) => [g.id, one(g.title)])), ...Object.fromEntries(model.nodes.map((n) => [n.id, one(n.label)])) };
  const links = model.edges.map((e) => `${name[e.from]} ${e.style === 'line' ? 'with' : 'to'} ${name[e.to]}${e.label ? ` (${one(e.label)})` : ''}`);
  const groups = model.groups.map((g) => `${one(g.title)} contains ${model.nodes.filter((n) => n.group === g.id).map((n) => one(n.label)).join(', ') || 'other groups'}`);
  const loose = model.nodes.filter((n) => !model.edges.some((e) => e.from === n.id || e.to === n.id)).map((n) => one(n.label));
  return `Diagram. ${[links.length ? `Connections: ${links.join('; ')}` : '', groups.length ? `Groups: ${groups.join('; ')}` : '', loose.length ? `Also shown: ${loose.join(', ')}` : ''].filter(Boolean).join('. ')}.`;
}

// ---------- layout ----------
const r1 = (n) => Math.round(n * 10) / 10;
const NODE = { face: 'sans500', size: 13, line: 18, padX: 15, padY: 11, maxText: 190, minW: 76 };
const EDGE = { face: 'sans500', size: 11.5, line: 15, padX: 7, padY: 4, maxText: 170 };
const GROUP = { face: 'mono600', size: 10.5, tracking: 0.12, top: 36, pad: 16 };
const MARGIN = 6;
/** Figures wider than this are laid out again, more compactly: a lesson column shows about 630 px, and a
 *  figure may be drawn at 82 % of its size before it starts to scroll sideways. */
export const TARGET_WIDTH = 768;

/** Stand-in text for {{VAR}} lab-profile placeholders, so that a box fits a typical value. */
const sized = (text, vars) => text.replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, (_, k) => vars?.[k] ?? 'xxxxxxxxxxxx');

function nodeBox(node, vars, maxText) {
  const lines = wrapText(node.label, NODE.face, NODE.size, maxText);
  const text = Math.max(...lines.map((l) => textWidth(sized(l, vars), NODE.face, NODE.size)));
  const extra = node.shape === 'decision' ? 30 : 0;
  return {
    lines,
    w: Math.ceil(Math.max(NODE.minW, text + 2 * NODE.padX + extra)),
    h: lines.length * NODE.line + 2 * NODE.padY + (node.shape === 'cylinder' ? 14 : 0),
  };
}

const ELK_DIR = { TB: 'DOWN', LR: 'RIGHT', RL: 'LEFT' };
const elk = new ELK();

async function layoutFlowOnce(model, vars, options) {
  // A group is as wide as its boxes need. Where its title is wider than that, lay out again with the group padded.
  let g = await layoutFlowPass(model, vars, options, null);
  const widen = new Map(g.groups.filter((x) => x.tw + 34 > x.w).map((x) => [x.id, Math.ceil((x.tw + 34 - x.w) / 2)]));
  if (widen.size) g = await layoutFlowPass(model, vars, options, widen);
  return g;
}

async function layoutFlowPass(model, vars, { dir, layerGap, nodeGap, maxText, keepOrder, modelOrder = true }, widen) {
  const boxes = new Map(model.nodes.map((n) => [n.id, nodeBox(n, vars, maxText)]));
  // Options of the layered algorithm; a subgraph is laid out as a graph of its own, so it gets them too.
  const layered = {
    'elk.algorithm': 'layered',
    'elk.direction': ELK_DIR[dir],
    'elk.edgeRouting': 'ORTHOGONAL',
    'elk.layered.spacing.nodeNodeBetweenLayers': String(layerGap),
    'elk.layered.spacing.edgeNodeBetweenLayers': '18',
    'elk.layered.spacing.edgeEdgeBetweenLayers': '12',
    'elk.spacing.nodeNode': String(nodeGap),
    'elk.spacing.edgeNode': '16',
    'elk.spacing.edgeEdge': '12',
    'elk.spacing.edgeLabel': '4',
    'elk.spacing.labelLabel': '6',
    'elk.edgeLabels.inline': 'true',
    'elk.layered.considerModelOrder.strategy': modelOrder ? 'NODES_AND_EDGES' : 'NONE',
    // keepOrder: boxes of one layer stay in the order the author wrote them.
    'elk.layered.crossingMinimization.forceNodeModelOrder': String(keepOrder),
    'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
    'elk.layered.mergeEdges': 'false',
  };
  const root = {
    id: 'root',
    layoutOptions: { ...layered, 'elk.hierarchyHandling': 'INCLUDE_CHILDREN', 'elk.padding': `[top=${MARGIN},left=${MARGIN},bottom=${MARGIN},right=${MARGIN}]` },
    children: [],
    edges: [],
  };
  const containers = new Map([[null, root]]);
  const titleWidth = (g) => Math.ceil(textWidth(sized(g.title, vars).toUpperCase(), GROUP.face, GROUP.size, GROUP.tracking));
  for (const g of model.groups) {
    const title = titleWidth(g);
    // `widen` is extra side padding for a group whose title is wider than its boxes (see layoutFlowOnce's caller).
    const side = GROUP.pad + (widen?.get(g.id) ?? 0);
    const node = {
      id: `g:${g.id}`,
      layoutOptions: { ...layered, 'elk.padding': `[top=${GROUP.top},left=${side},bottom=${GROUP.pad},right=${side}]` },
      children: [],
    };
    containers.get(g.parent).children.push(node);
    containers.set(g.id, node);
  }
  for (const n of model.nodes) containers.get(n.group).children.push({ id: `n:${n.id}`, width: boxes.get(n.id).w, height: boxes.get(n.id).h });
  const isGroup = new Set(model.groups.map((g) => g.id));
  const ref = (id) => (isGroup.has(id) ? `g:${id}` : `n:${id}`);
  const labels = model.edges.map((e) => (e.label ? wrapText(e.label, EDGE.face, EDGE.size, EDGE.maxText) : null));
  // Where the figure has a loop, one arrow must be drawn against the reading direction. Make it the one that
  // points back to a box the author introduced earlier (the reply, the feedback), not an arbitrary one.
  const rank = new Map(model.nodes.map((n, i) => [n.id, i]));
  for (const g of model.groups) rank.set(g.id, Math.min(...model.nodes.filter((n) => n.group === g.id).map((n) => rank.get(n.id)), model.nodes.length));
  root.edges = model.edges.map((e, i) => ({
    id: `e${i}`, sources: [ref(e.from)], targets: [ref(e.to)],
    layoutOptions: { 'elk.layered.priority.direction': rank.get(e.from) <= rank.get(e.to) ? '10' : '0' },
    // A label sits on its connection, like a tag on a wire.
    labels: labels[i] ? [{ text: e.label, layoutOptions: { 'elk.edgeLabels.inline': 'true' }, width: Math.ceil(Math.max(...labels[i].map((l) => textWidth(sized(l, vars), EDGE.face, EDGE.size))) + 2 * EDGE.padX), height: labels[i].length * EDGE.line + 2 * EDGE.padY }] : [],
  }));

  const done = await elk.layout(root);
  const abs = new Map();
  const walk = (node, ox, oy) => {
    for (const c of node.children ?? []) {
      abs.set(c.id, { x: ox + c.x, y: oy + c.y, w: c.width, h: c.height });
      walk(c, ox + c.x, oy + c.y);
    }
  };
  abs.set('root', { x: 0, y: 0, w: done.width, h: done.height });
  walk(done, 0, 0);
  const nodes = model.nodes.map((n) => {
    const b = abs.get(`n:${n.id}`);
    return { id: n.id, shape: n.shape, x: r1(b.x), y: r1(b.y), w: r1(b.w), h: r1(b.h), lines: boxes.get(n.id).lines };
  });
  const groups = model.groups.map((g) => {
    const b = abs.get(`g:${g.id}`);
    return { id: g.id, title: g.title, tw: titleWidth(g), x: r1(b.x), y: r1(b.y), w: r1(b.w), h: r1(b.h) };
  });
  const edges = done.edges.map((e, i) => {
    // Section coordinates are relative to the node ELK reports as the edge's container.
    const o = abs.get(e.container ?? 'root') ?? abs.get('root');
    const s = e.sections[0];
    const points = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map((pt) => [r1(o.x + pt.x), r1(o.y + pt.y)]);
    const l = e.labels?.[0];
    const src = model.edges[i];
    return {
      from: src.from, to: src.to, style: src.style, points,
      ...(l ? { label: { x: r1(o.x + l.x), y: r1(o.y + l.y), w: r1(l.width), h: r1(l.height), lines: labels[i] } } : {}),
    };
  });
  return orient(model, { w: Math.ceil(done.width), h: Math.ceil(done.height), nodes, groups, edges }, dir);
}

/**
 * The engine is free to draw a layer in either direction. If the boxes that share a layer come out in the
 * reverse of the author's order more often than not (Server B left of Server A), the drawing is mirrored.
 * `agreement` is the share of such pairs that follow the author's order after that.
 */
function orient(model, g, dir) {
  const vertical = dir === 'TB';
  const along = (b) => (vertical ? [b.y, b.y + b.h] : [b.x, b.x + b.w]);
  const across = (b) => (vertical ? b.x + b.w / 2 : b.y + b.h / 2);
  let ordered = 0;
  let reversed = 0;
  for (let i = 0; i < g.nodes.length; i++) for (let j = i + 1; j < g.nodes.length; j++) {
    const [a0, a1] = along(g.nodes[i]);
    const [b0, b1] = along(g.nodes[j]);
    if (Math.min(a1, b1) - Math.max(a0, b0) <= 4) continue;
    if (across(g.nodes[j]) > across(g.nodes[i])) ordered++; else reversed++;
  }
  if (reversed > ordered) {
    const flip = (b) => (vertical ? { ...b, x: r1(g.w - b.x - b.w) } : { ...b, y: r1(g.h - b.y - b.h) });
    const point = ([x, y]) => (vertical ? [r1(g.w - x), y] : [x, r1(g.h - y)]);
    g = { ...g, nodes: g.nodes.map(flip), groups: g.groups.map(flip), edges: g.edges.map((e) => ({ ...e, points: e.points.map(point), ...(e.label ? { label: flip(e.label) } : {}) })) };
    [ordered, reversed] = [reversed, ordered];
  }
  return { ...g, agreement: ordered + reversed ? ordered / (ordered + reversed) : 1 };
}

/** How many times connections cross each other in a laid-out flowchart. */
export function crossings(edges) {
  const segs = edges.flatMap((e, i) => e.points.slice(1).map((b, k) => ({ i, a: e.points[k], b })));
  const side = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  let n = 0;
  for (let x = 0; x < segs.length; x++) for (let y = x + 1; y < segs.length; y++) {
    const s = segs[x], t = segs[y];
    if (s.i !== t.i && side(s.a, s.b, t.a) * side(s.a, s.b, t.b) < 0 && side(t.a, t.b, s.a) * side(t.a, t.b, s.b) < 0) n++;
  }
  return n;
}

/**
 * Lay a flowchart out. Each setting is tried with the boxes of a layer kept in the author's order and with
 * the engine free to reorder them; the author's order wins unless reordering removes crossings. A figure
 * that would be much wider than the lesson column is tried again with tighter spacing and narrower boxes
 * and, for a left-to-right figure that is still too wide, top to bottom: the same boxes and connections in
 * the same order, at a size that stays readable.
 */
async function layoutFlow(model, vars) {
  const horizontal = model.dir !== 'TB';
  const tries = horizontal
    ? [{ dir: model.dir, layerGap: 54, nodeGap: 20, maxText: NODE.maxText }, { dir: model.dir, layerGap: 38, nodeGap: 16, maxText: 130 },
      { dir: 'TB', layerGap: 44, nodeGap: 20, maxText: NODE.maxText }, { dir: 'TB', layerGap: 40, nodeGap: 14, maxText: 140 }]
    : [{ dir: 'TB', layerGap: 44, nodeGap: 20, maxText: NODE.maxText }, { dir: 'TB', layerGap: 40, nodeGap: 14, maxText: 150 }, { dir: 'TB', layerGap: 38, nodeGap: 12, maxText: 120 }];
  let best = null;
  for (const t of tries) {
    // The engine's model-order code fails on a few graphs (elkjs 0.12); those fall back to the next option.
    const attempt = (options) => layoutFlowOnce(model, vars, { ...t, ...options }).catch(() => null);
    const kept = await attempt({ keepOrder: true });
    const free = (await attempt({ keepOrder: false })) ?? (await layoutFlowOnce(model, vars, { ...t, keepOrder: false, modelOrder: false }));
    // Fewer crossings first; then the drawing that follows the author's order more closely.
    const cost = (x) => crossings(x.edges) - x.agreement / 2;
    const { agreement: _a, ...g } = kept && cost(kept) <= cost(free) ? kept : free;
    if (!best || g.w < best.w) best = { ...g, dir: t.dir };
    if (g.w <= TARGET_WIDTH) { best = { ...g, dir: t.dir }; break; }
  }
  // "Flowing" figures show a path that data or control takes: every connection has a direction and nothing
  // is a decision. The app may animate those; trees of decisions and plain topologies stay still.
  const flowing = model.edges.length > 0 && model.edges.every((e) => e.style !== 'line') && model.nodes.every((n) => n.shape !== 'decision');
  return { kind: 'flow', flowing, ...best };
}

const SEQ = { actorPadX: 14, actorPadY: 10, actorMax: 150, actorMin: 92, gapMin: 60, msgMax: 250, msgFace: 'sans500', msgSize: 12, msgLine: 16, rowGap: 22, top: 26, noteMax: 200, notePadX: 10, notePadY: 7, selfW: 34 };

/** A sequence diagram that would be too wide is laid out again with its labels wrapped sooner. */
function layoutSequence(model, vars) {
  let best = null;
  for (const [msgMax, actorMax, noteMax] of [[250, 150, 200], [190, 130, 170], [150, 110, 140], [120, 96, 120]]) {
    const g = layoutSequenceOnce(model, vars, { msgMax, actorMax, noteMax });
    if (!best || g.w < best.w) best = g;
    if (g.w <= TARGET_WIDTH) return g;
  }
  return best;
}

function layoutSequenceOnce(model, vars, { msgMax, actorMax, noteMax }) {
  const actors = model.actors.map((a) => {
    const lines = wrapText(a.label, 'sans600', 13, actorMax);
    const w = Math.ceil(Math.max(SEQ.actorMin, Math.max(...lines.map((l) => textWidth(sized(l, vars), 'sans600', 13))) + 2 * SEQ.actorPadX));
    return { id: a.id, lines, w, h: lines.length * 18 + 2 * SEQ.actorPadY };
  });
  const index = new Map(actors.map((a, i) => [a.id, i]));
  const steps = model.steps.map((s) => {
    if (s.type === 'note') {
      const lines = wrapText(s.text, 'sans500', 11.5, noteMax);
      return { ...s, lines, tw: Math.max(...lines.map((l) => textWidth(sized(l, vars), 'sans500', 11.5))) };
    }
    const lines = wrapText(s.text, SEQ.msgFace, SEQ.msgSize, msgMax);
    return { ...s, lines, tw: Math.max(...lines.map((l) => textWidth(sized(l, vars), SEQ.msgFace, SEQ.msgSize))) };
  });
  // Distance between neighbouring lifelines: room for the actor boxes and for every label that sits between them.
  const gaps = actors.slice(1).map((a, i) => Math.max(SEQ.gapMin + (actors[i].w + a.w) / 2, 120));
  const span = (i, j) => gaps.slice(i, j).reduce((s, g) => s + g, 0);
  const widen = (i, j, need) => { const have = span(i, j); if (have < need) for (let k = i; k < j; k++) gaps[k] += (need - have) / (j - i); };
  let rightRoom = 0;
  for (const s of steps) {
    if (s.type === 'message' && s.from !== s.to) {
      const [i, j] = [index.get(s.from), index.get(s.to)].sort((a, b) => a - b);
      widen(i, j, s.tw + 44);
    } else if (s.type === 'message') {
      const i = index.get(s.from);
      const need = SEQ.selfW + 12 + s.tw + 16;
      if (i < actors.length - 1) widen(i, i + 1, need + 10);
      else rightRoom = Math.max(rightRoom, need - actors[i].w / 2);
    } else if (s.over.length === 1) {
      const i = index.get(s.over[0]);
      const half = s.tw / 2 + SEQ.notePadX + 10;
      if (i < actors.length - 1) widen(i, i + 1, half + 30);
      if (i > 0) widen(i - 1, i, half + 30);
      if (i === actors.length - 1) rightRoom = Math.max(rightRoom, half - actors[i].w / 2);
    }
  }
  const leftRoom = Math.max(0, ...steps.filter((s) => s.type === 'note' && s.over.length === 1 && index.get(s.over[0]) === 0).map((s) => s.tw / 2 + SEQ.notePadX + 10 - actors[0].w / 2));
  let x = MARGIN + leftRoom + actors[0].w / 2;
  const headH = Math.max(...actors.map((a) => a.h));
  actors.forEach((a, i) => {
    if (i) x += gaps[i - 1];
    a.cx = r1(x);
    a.x = r1(x - a.w / 2);
    a.y = MARGIN + (headH - a.h);
  });
  let y = MARGIN + headH + SEQ.top;
  const out = steps.map((s) => {
    if (s.type === 'note') {
      const xs = s.over.map((id) => actors[index.get(id)].cx);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
      const w = Math.max(s.tw + 2 * SEQ.notePadX, Math.max(...xs) - Math.min(...xs) + 40);
      const h = s.lines.length * 15 + 2 * SEQ.notePadY;
      const step = { type: 'note', x: r1(cx - w / 2), y: r1(y - 6), w: r1(w), h, lines: s.lines };
      y += h + SEQ.rowGap - 6;
      return step;
    }
    const from = actors[index.get(s.from)].cx;
    const to = actors[index.get(s.to)].cx;
    const textH = s.lines.length * SEQ.msgLine;
    if (s.from === s.to) {
      const step = { type: 'message', self: true, dashed: s.dashed, x1: from, x2: r1(from + SEQ.selfW), y: r1(y), h: 24, lines: s.lines, tx: r1(from + SEQ.selfW + 12), ty: r1(y + 12 - textH / 2 + 12), anchor: 'start' };
      y += Math.max(24, textH) + SEQ.rowGap;
      return step;
    }
    y += textH - SEQ.msgLine;
    const step = { type: 'message', self: false, dashed: s.dashed, x1: from, x2: to, y: r1(y + 8), lines: s.lines, tx: r1((from + to) / 2), ty: r1(y - textH + SEQ.msgLine), anchor: 'middle' };
    y += 8 + SEQ.rowGap;
    return step;
  });
  const bottom = y - SEQ.rowGap + 22;
  const last = actors[actors.length - 1];
  return {
    kind: 'sequence', flowing: false,
    w: Math.ceil(last.cx + Math.max(last.w / 2, rightRoom + last.w / 2) + MARGIN), h: Math.ceil(bottom + MARGIN),
    actors: actors.map((a) => ({ id: a.id, x: a.x, y: a.y, w: a.w, h: a.h, cx: a.cx, lines: a.lines })),
    lifeline: { y1: MARGIN + headH, y2: r1(bottom) },
    steps: out,
  };
}

/** Geometry of a parsed figure. `vars` are default values for {{VAR}} placeholders, used for sizing only. */
export async function layoutFigure(model, vars = {}) {
  return model.kind === 'flow' ? layoutFlow(model, vars) : layoutSequence(model, vars);
}

/** Source to drawable figure: geometry plus the text alternative. */
export async function compileFigure(source, vars = {}) {
  const model = parseFigure(source);
  return { v: 1, alt: figureAlt(model), ...(await layoutFigure(model, vars)) };
}

const FENCE = /```mermaid\n([\s\S]*?)\n```/g;
/** All figure sources in a Markdown body, in order. */
export const figureSources = (body) => [...body.matchAll(FENCE)].map((m) => m[1]);

/** Replace every ```mermaid fence of a compiled body with a ```figure fence holding the geometry as JSON. */
export async function compileFigures(body, vars = {}) {
  const compiled = await Promise.all(figureSources(body).map((src) => compileFigure(src, vars)));
  let i = 0;
  return body.replace(FENCE, () => `\`\`\`figure\n${JSON.stringify(compiled[i++])}\n\`\`\``);
}
