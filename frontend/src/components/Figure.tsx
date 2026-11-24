// Draws a figure that scripts/figures.mjs laid out at build time. Everything here is presentation: the
// boxes, labels and connections come from the lesson's source, already positioned. Colours are the app's
// design tokens, so a figure follows the colour scheme like every widget does.
import { useEffect, useId, useRef, useState } from 'react';
import { Play, RotateCcw } from 'lucide-react';

interface Box { x: number; y: number; w: number; h: number }
interface FlowNode extends Box { id: string; shape: 'rect' | 'decision' | 'cylinder'; lines: string[] }
interface FlowGroup extends Box { id: string; title: string; tw: number }
interface FlowEdge { from: string; to: string; style: 'arrow' | 'line' | 'dotted'; points: [number, number][]; label?: Box & { lines: string[] } }
interface SeqActor extends Box { id: string; cx: number; lines: string[] }
type SeqStep =
  | { type: 'message'; self: boolean; dashed: boolean; x1: number; x2: number; y: number; h?: number; lines: string[]; tx: number; ty: number; anchor: 'start' | 'middle' }
  | (Box & { type: 'note'; lines: string[] });
interface Common { v: number; alt: string; w: number; h: number; flowing: boolean }
export type FigureData =
  | (Common & { kind: 'flow'; dir: 'TB' | 'LR' | 'RL'; nodes: FlowNode[]; groups: FlowGroup[]; edges: FlowEdge[] })
  | (Common & { kind: 'sequence'; actors: SeqActor[]; lifeline: { y1: number; y2: number }; steps: SeqStep[] });

/** An orthogonal polyline with rounded corners. */
export function roundedPath(points: [number, number][], radius = 7): string {
  if (points.length < 3) return points.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join(' ');
  let d = `M${points[0][0]},${points[0][1]}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i - 1];
    const [x, y] = points[i];
    const [nx, ny] = points[i + 1];
    const r = Math.min(radius, Math.hypot(x - px, y - py) / 2, Math.hypot(nx - x, ny - y) / 2);
    const a = [x + Math.sign(px - x) * r, y + Math.sign(py - y) * r];
    const b = [x + Math.sign(nx - x) * r, y + Math.sign(ny - y) * r];
    d += ` L${a[0]},${a[1]} Q${x},${y} ${b[0]},${b[1]}`;
  }
  const [lx, ly] = points[points.length - 1];
  return `${d} L${lx},${ly}`;
}

/** Centred lines of text. `max` lets a line be squeezed if a fallback font or a long lab value makes it too wide. */
function Lines({ lines, x, y, lineHeight, max, anchor = 'middle', className }: { lines: string[]; x: number; y: number; lineHeight: number; max?: number; anchor?: 'start' | 'middle'; className: string }) {
  return (
    <text className={className} textAnchor={anchor}>
      {lines.map((l, i) => <tspan key={i} x={x} y={y + i * lineHeight} data-max={max}>{l}</tspan>)}
    </text>
  );
}

const TINTS = ['data', 'analogy', 'accent', 'warn'];

function Flow({ data, arrow }: { data: Extract<FigureData, { kind: 'flow' }>; arrow: string }) {
  const hasDecisions = data.nodes.some((n) => n.shape === 'decision');
  const outgoing = new Set(data.edges.map((e) => e.from));
  const incoming = new Set(data.edges.map((e) => e.to));
  return (
    <>
      {data.groups.map((g, i) => (
        <g key={g.id} className={`fig-group fig-tint-${TINTS[i % TINTS.length]}`}>
          <rect x={g.x} y={g.y} width={g.w} height={g.h} rx={14} />
        </g>
      ))}
      {data.edges.map((e, i) => {
        const d = roundedPath(e.points);
        return (
          <g key={i} className={`fig-edge fig-edge-${e.style}`}>
            <path d={d} markerEnd={e.style === 'line' ? undefined : `url(#${arrow})`} />
            {data.flowing && <path className="fig-flow" d={d} />}
          </g>
        );
      })}
      {/* Titles are drawn over the connections, on a plate, so a line entering a group never strikes one through. */}
      {data.groups.map((g, i) => (
        <g key={g.id} className={`fig-group-title fig-tint-${TINTS[i % TINTS.length]}`}>
          <rect className="fig-group-plate" x={g.x + 9} y={g.y + 9} width={Math.min(g.tw + 14, g.w - 18)} height={20} rx={6} />
          <text x={g.x + 16} y={g.y + 23} data-max={g.w - 32}>{g.title}</text>
        </g>
      ))}
      {data.nodes.map((n) => {
        // In a tree of decisions the boxes that lead nowhere further are the outcomes.
        // Along a path that data or control takes, mark where it starts and where it ends.
        const role = n.shape === 'decision' ? 'fig-decision' : n.shape === 'cylinder' ? 'fig-store' : hasDecisions && !outgoing.has(n.id) ? 'fig-outcome'
          : data.flowing && !incoming.has(n.id) && outgoing.has(n.id) ? 'fig-source' : data.flowing && incoming.has(n.id) && !outgoing.has(n.id) ? 'fig-sink' : '';
        const cy = n.y + n.h / 2 + (n.shape === 'cylinder' ? 5 : 0);
        return (
          <g key={n.id} className={`fig-node ${role}`}>
            {n.shape === 'rect' && <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={10} />}
            {n.shape === 'decision' && <polygon points={`${n.x + 15},${n.y} ${n.x + n.w - 15},${n.y} ${n.x + n.w},${n.y + n.h / 2} ${n.x + n.w - 15},${n.y + n.h} ${n.x + 15},${n.y + n.h} ${n.x},${n.y + n.h / 2}`} />}
            {n.shape === 'cylinder' && (
              <>
                <path d={`M${n.x},${n.y + 8} a${n.w / 2},8 0 0 1 ${n.w},0 v${n.h - 16} a${n.w / 2},8 0 0 1 ${-n.w},0 z`} />
                <path className="fig-store-rim" d={`M${n.x},${n.y + 8} a${n.w / 2},8 0 0 0 ${n.w},0`} />
              </>
            )}
            <Lines className="fig-node-text" lines={n.lines} x={n.x + n.w / 2} y={cy - ((n.lines.length - 1) * 18) / 2 + 4.5} lineHeight={18} max={n.w - (n.shape === 'decision' ? 34 : 16)} />
          </g>
        );
      })}
      {data.edges.map((e, i) => e.label && (
        <g key={i} className="fig-edge-label">
          <rect x={e.label.x} y={e.label.y} width={e.label.w} height={e.label.h} rx={7} />
          <Lines className="fig-edge-text" lines={e.label.lines} x={e.label.x + e.label.w / 2} y={e.label.y + 4 + 11} lineHeight={15} max={e.label.w - 6} />
        </g>
      ))}
    </>
  );
}

function Sequence({ data, arrow, active }: { data: Extract<FigureData, { kind: 'sequence' }>; arrow: string; active: number | null }) {
  return (
    <>
      {data.actors.map((a) => <line key={a.id} className="fig-lifeline" x1={a.cx} x2={a.cx} y1={data.lifeline.y1} y2={data.lifeline.y2} />)}
      {data.steps.map((s, i) => {
        const state = active === null ? '' : active === i ? 'is-active' : 'is-dim';
        if (s.type === 'note') return (
          <g key={i} className={`fig-note ${state}`}>
            <rect x={s.x} y={s.y} width={s.w} height={s.h} rx={7} />
            <Lines className="fig-note-text" lines={s.lines} x={s.x + s.w / 2} y={s.y + 7 + 11} lineHeight={15} max={s.w - 10} />
          </g>
        );
        const dir = Math.sign(s.x2 - s.x1) || 1;
        const d = s.self ? `M${s.x1},${s.y} h${s.x2 - s.x1 - 8} q8,0 8,8 v${(s.h ?? 24) - 16} q0,8 -8,8 H${s.x1 + 3}` : `M${s.x1},${s.y} H${s.x2 - dir * 3}`;
        return (
          <g key={i} className={`fig-message ${s.dashed ? 'fig-message-reply' : ''} ${state}`}>
            <path d={d} markerEnd={`url(#${arrow})`} />
            {active === i && !s.self && <circle className="fig-dot" r={4} cx={s.x1} cy={s.y} style={{ '--fig-dx': `${s.x2 - s.x1}px` } as React.CSSProperties} />}
            <Lines className="fig-message-text" lines={s.lines} x={s.tx} y={s.ty} lineHeight={16} anchor={s.anchor} />
          </g>
        );
      })}
      {data.actors.map((a) => (
        <g key={a.id} className="fig-actor">
          <rect x={a.x} y={a.y} width={a.w} height={a.h} rx={10} />
          <Lines className="fig-actor-text" lines={a.lines} x={a.cx} y={a.y + a.h / 2 - ((a.lines.length - 1) * 18) / 2 + 4.5} lineHeight={18} max={a.w - 12} />
        </g>
      ))}
    </>
  );
}

const FLOW_MS = 4800; // under five seconds, so the motion needs no pause control (WCAG 2.2.2)
const STEP_MS = 1100;
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export default function Figure({ data }: { data: FigureData }) {
  const id = useId().replace(/:/g, '');
  const arrow = `fig-arrow-${id}`;
  const svg = useRef<SVGSVGElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = useState(false);
  const [flowing, setFlowing] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const steps = data.kind === 'sequence' ? data.steps.length : 0;

  // If a line turns out wider than its box (a fallback font, a long value from the learner's lab profile),
  // squeeze that line instead of letting it spill.
  useEffect(() => {
    const fit = () => svg.current?.querySelectorAll<SVGTextContentElement>('[data-max]').forEach((t) => {
      const max = Number(t.dataset.max);
      t.removeAttribute('textLength');
      if (max > 0 && t.getComputedTextLength() > max) { t.setAttribute('textLength', String(max)); t.setAttribute('lengthAdjust', 'spacingAndGlyphs'); }
    });
    fit();
    void document.fonts?.ready.then(fit);
  }, [data]);

  // A figure wider than the page scrolls sideways inside its frame; only then is the frame a tab stop.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const check = () => setScrolls(el.scrollWidth > el.clientWidth + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [data]);

  // Flow along the connections for a few seconds the first time the figure comes into view.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !data.flowing || reducedMotion() || typeof IntersectionObserver !== 'function') return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setFlowing(true); io.disconnect(); }
    }, { threshold: 0.6 });
    io.observe(el);
    return () => io.disconnect();
  }, [data]);
  useEffect(() => {
    if (!flowing) return;
    const t = setTimeout(() => setFlowing(false), FLOW_MS);
    return () => clearTimeout(t);
  }, [flowing]);

  // Walk through a sequence one step at a time.
  useEffect(() => {
    if (active === null) return;
    const t = setTimeout(() => setActive(active + 1 < steps ? active + 1 : null), STEP_MS);
    return () => clearTimeout(t);
  }, [active, steps]);

  const playable = data.kind === 'sequence' || data.flowing;
  const playing = data.kind === 'sequence' ? active !== null : flowing;
  return (
    <figure className="figure not-prose" data-kind={data.kind}>
      {playable && (
        <div className="figure-bar">
          <button type="button" className="figure-play" disabled={playing} onClick={() => (data.kind === 'sequence' ? setActive(0) : setFlowing(true))}>
            {data.kind === 'sequence' ? <Play size={12} aria-hidden /> : <RotateCcw size={12} aria-hidden />}
            {data.kind === 'sequence' ? 'Play step by step' : 'Replay the flow'}
          </button>
        </div>
      )}
      <div ref={scroller} className="figure-scroll" {...(scrolls ? { tabIndex: 0, role: 'group', 'aria-label': 'Figure, scrolls sideways' } : {})}>
        <svg ref={svg} className={`fig ${flowing ? 'is-flowing' : ''}`} role="img" aria-label={data.alt} viewBox={`0 0 ${data.w} ${data.h}`} width={data.w} height={data.h}
          style={{ maxWidth: data.w, minWidth: Math.min(data.w, Math.round(data.w * 0.82)) }}>
          <defs>
            <marker id={arrow} viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="7.5" markerHeight="7.5" orient="auto-start-reverse">
              <path className="fig-arrowhead" d="M1,1.2 L9.2,5 L1,8.8 L2.6,5 z" />
            </marker>
          </defs>
          {data.kind === 'flow' ? <Flow data={data} arrow={arrow} /> : <Sequence data={data} arrow={arrow} active={active} />}
        </svg>
      </div>
    </figure>
  );
}
