import { Children, isValidElement, lazy, Suspense, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { BookOpen, Briefcase, Info, Lightbulb, TriangleAlert, type LucideIcon } from 'lucide-react';
import { slug } from '../content';
import { WidgetFrame } from '../widgets/registry';

const Mermaid = lazy(() => import('./Mermaid'));

const CALLOUTS: Record<string, { cls: string; title: string; icon: LucideIcon }> = {
  NOTE: { cls: 'callout-note', title: 'Note', icon: Info },
  TIP: { cls: 'callout-tip', title: 'Tip', icon: Lightbulb },
  WARNING: { cls: 'callout-warning', title: 'Warning', icon: TriangleAlert },
  ANALOGY: { cls: 'callout-analogy', title: 'For network engineers', icon: BookOpen },
  INTERVIEW: { cls: 'callout-interview', title: 'Interview angle', icon: Briefcase },
};

function text(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  if (isValidElement(node)) return text((node.props as { children?: ReactNode }).children);
  return '';
}

/** Strip a leading "[!TYPE]" marker from the first paragraph of a blockquote. */
function stripMarker(children: ReactNode, marker: string): ReactNode {
  let done = false;
  const walk = (n: ReactNode): ReactNode => {
    if (done) return n;
    if (typeof n === 'string') {
      const i = n.indexOf(marker);
      if (i >= 0) {
        done = true;
        return n.slice(0, i) + n.slice(i + marker.length).replace(/^\s*\n?/, '');
      }
      return n;
    }
    if (Array.isArray(n)) return n.map(walk);
    if (isValidElement(n)) {
      const props = n.props as { children?: ReactNode };
      return { ...n, props: { ...props, children: walk(props.children) } };
    }
    return n;
  };
  return Children.map(children, walk);
}

function Heading({ level, children }: { level: 2 | 3 | 4; children: ReactNode }) {
  const id = slug(text(children));
  const Tag = `h${level}` as const;
  return (
    <Tag id={id} className="group">
      {children}
      <a href={`#${id}`} onClick={(e) => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }); }}
        className="ml-2 opacity-0 group-hover:opacity-40 text-muted no-underline" aria-label="Link to section">#</a>
    </Tag>
  );
}

export default function Markdown({ source }: { source: string }) {
  return (
    <div className="prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={{
          h2: ({ children }) => <Heading level={2}>{children}</Heading>,
          h3: ({ children }) => <Heading level={3}>{children}</Heading>,
          h4: ({ children }) => <Heading level={4}>{children}</Heading>,
          a: ({ href, children }) => <a href={href} target={href?.startsWith('http') ? '_blank' : undefined} rel="noreferrer">{children}</a>,
          blockquote: ({ children }) => {
            const m = text(children).trim().match(/^\[!(\w+)\]/);
            const c = m && CALLOUTS[m[1].toUpperCase()];
            if (!c) return <blockquote>{children}</blockquote>;
            const Icon = c.icon;
            return (
              <div className={`callout ${c.cls}`}>
                <div className="callout-title"><Icon size={14} />{c.title}</div>
                {stripMarker(children, m![0])}
              </div>
            );
          },
          pre: ({ children }) => {
            const child = Children.toArray(children)[0];
            if (isValidElement(child)) {
              const props = child.props as { className?: string; children?: ReactNode };
              const lang = props.className?.match(/language-(\w[\w-]*)/)?.[1];
              const code = text(props.children).replace(/\n$/, '');
              if (lang === 'mermaid') return <Suspense fallback={<pre>{code}</pre>}><Mermaid chart={code} /></Suspense>;
              if (lang === 'widget') return <div className="not-prose my-6"><WidgetFrame id={code.trim()} /></div>;
            }
            return <pre>{children}</pre>;
          },
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
