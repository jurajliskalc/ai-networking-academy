import { useEffect, useId, useState } from 'react';
import mermaid from 'mermaid';

let configuredFor: string | null = null;

export default function Mermaid({ chart }: { chart: string }) {
  const id = useId().replace(/:/g, '');
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dark = document.documentElement.classList.contains('dark');

  useEffect(() => {
    const theme = dark ? 'dark' : 'default';
    if (configuredFor !== theme) {
      mermaid.initialize({ startOnLoad: false, theme, securityLevel: 'strict', fontFamily: 'Inter, system-ui, sans-serif' });
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

  if (error) return <pre title={error} data-mermaid-error="">{chart}</pre>;
  if (!svg) return <div className="h-24 animate-pulse rounded-lg bg-panel-2" />;
  return <div className="my-6 flex justify-center overflow-x-auto rounded-xl border border-line bg-panel p-4 [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: svg }} />;
}
