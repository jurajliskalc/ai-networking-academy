import { useEffect, useId, useMemo, useState } from 'react';
import mermaid from 'mermaid';

let configuredFor: string | null = null;

const KINDS: Record<string, string> = {
  flowchart: 'Flowchart', graph: 'Flowchart', sequenceDiagram: 'Sequence diagram', stateDiagram: 'State diagram', 'stateDiagram-v2': 'State diagram',
  classDiagram: 'Class diagram', gantt: 'Gantt chart', pie: 'Pie chart', timeline: 'Timeline', mindmap: 'Mind map', quadrantChart: 'Quadrant chart',
  'xychart-beta': 'Chart', block: 'Block diagram', 'block-beta': 'Block diagram', erDiagram: 'Entity relationship diagram', journey: 'Journey diagram',
};

/** A text alternative for a rendered diagram: its kind (or accTitle) plus the labels it shows, in source order. */
export function diagramLabel(chart: string, svg: string | null): string {
  const title = chart.match(/^\s*accTitle\s*:\s*(.+)$/m)?.[1]?.trim();
  const first = chart.trim().split(/\s+/)[0] ?? '';
  const kind = KINDS[first] ?? 'Diagram';
  let labels: string[] = [];
  if (svg) {
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const seen = new Set<string>();
    for (const el of doc.querySelectorAll('.nodeLabel, .edgeLabel, .messageText, .actor, .stateLabel, text')) {
      const t = el.textContent?.replace(/\s+/g, ' ').trim();
      if (t && !seen.has(t)) { seen.add(t); labels.push(t); }
    }
    labels = labels.slice(0, 24);
  }
  return `${title ?? kind}${labels.length ? `: ${labels.join('; ')}` : ''}`;
}

export default function Mermaid({ chart }: { chart: string }) {
  const id = useId().replace(/:/g, '');
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isDark = () => document.documentElement.classList.contains('dark');
  const [dark, setDark] = useState(isDark);

  // Follow theme changes: the class on <html> is the source of truth and is set after React renders.
  useEffect(() => {
    const obs = new MutationObserver(() => setDark(isDark()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    const theme = dark ? 'dark' : 'default';
    if (configuredFor !== theme) {
      // Dark theme: mermaid's default edge-label background (#585858) leaves its #ccc text at 4.4:1; use a darker one.
      mermaid.initialize({ startOnLoad: false, theme, securityLevel: 'strict', fontFamily: 'Inter, system-ui, sans-serif', ...(dark ? { themeVariables: { edgeLabelBackground: '#1f2a3b' } } : {}) });
      configuredFor = theme;
    }
    let alive = true;
    mermaid.render(`m${id}`, chart).then(
      (r) => alive && setSvg(r.svg),
      (e: Error) => alive && setError(e.message),
    );
    return () => {
      alive = false;
    };
  }, [chart, id, dark]);

  const label = useMemo(() => diagramLabel(chart, svg), [chart, svg]);
  if (error) return <pre title={error} data-mermaid-error="">{chart}</pre>;
  if (!svg) return <div className="h-24 animate-pulse rounded-lg bg-panel-2" role="img" aria-label="Diagram loading" />;
  // role="img" with a generated name: the SVG's own text is fragmented into many nodes for assistive tech.
  return <div role="img" aria-label={label} className="my-6 flex justify-center overflow-x-auto rounded-xl border border-line bg-panel p-4 [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: svg }} />;
}
