import { Children, isValidElement, lazy, memo, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import ReactMarkdown, { type Components, type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { BadgeCheck, BookOpen, Briefcase, Info, Lightbulb, TriangleAlert, type LucideIcon } from 'lucide-react';
import { slug } from '../content';
import { WidgetFrame } from '../widgets/registry';
import { captureLabel, type Stack } from '../../scripts/stack-variants.mjs';
import { remarkStackVariants, STACK_GROUP_CLASS } from '../stackMarkdown';
import StackToggle, { useStack } from './StackToggle';

const Mermaid = lazy(() => import('./Mermaid'));

const CALLOUTS: Record<string, { cls: string; title: string; icon: LucideIcon }> = {
  NOTE: { cls: 'callout-note', title: 'Note', icon: Info },
  TIP: { cls: 'callout-tip', title: 'Tip', icon: Lightbulb },
  WARNING: { cls: 'callout-warning', title: 'Warning', icon: TriangleAlert },
  ANALOGY: { cls: 'callout-analogy', title: 'For network engineers', icon: BookOpen },
  INTERVIEW: { cls: 'callout-interview', title: 'Interview angle', icon: Briefcase },
  VERIFIED: { cls: 'callout-verified', title: 'Verified on real hardware', icon: BadgeCheck },
};

interface HastNode { tagName?: string; properties?: Record<string, unknown>; children?: HastNode[] }
/** The data-stack / data-real tags remarkStackVariants put on the <code> inside a rendered <pre>. */
const codeTags = (pre: unknown) => {
  const code = (pre as HastNode | undefined)?.children?.find((c) => c.tagName === 'code');
  return { stack: (code?.properties?.dataStack as Stack | undefined) ?? null, real: (code?.properties?.dataReal as Stack | undefined) ?? null };
};

/** A run of stack-tagged fences: a toggle, then only the blocks of the chosen stack. */
function StackGroup({ children }: { children?: ReactNode }) {
  const [stack] = useStack();
  const items = Children.toArray(children).filter(isValidElement);
  return (
    <div className="stack-group" data-stack-group="">
      <div className="stack-group-bar"><StackToggle /></div>
      {items.map((el, i) => {
        const s = codeTags((el.props as { node?: unknown }).node).stack;
        return <div key={i} data-stack={s ?? undefined} hidden={s !== stack}>{el}</div>;
      })}
    </div>
  );
}

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

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Scrolls to a heading (smoothly unless the user prefers reduced motion) and moves keyboard focus to it. */
export function goToSection(id: string, focus = true) {
  const el = document.getElementById(id);
  if (!el) return false;
  el.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
  if (focus) {
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    el.focus({ preventScroll: true });
  }
  return true;
}

/** Deep links from search use `?s=<heading id>`: once the Markdown has rendered (`ready`), go there. */
export function useSectionParam(ready: boolean) {
  const [params] = useSearchParams();
  const s = params.get('s');
  useEffect(() => {
    if (!ready || !s) return;
    // Wait a frame so the layout's scroll-to-top on navigation runs first; retry while lazy parts render.
    let tries = 0;
    let t: ReturnType<typeof setTimeout>;
    const attempt = () => {
      if (!goToSection(s) && tries++ < 20) t = setTimeout(attempt, 100);
    };
    t = setTimeout(attempt, 30);
    return () => clearTimeout(t);
  }, [ready, s]);
}

/** Horizontally scrolling content (wide tables, long code lines) must be keyboard-scrollable: it gets a tab stop,
 *  but only while it actually overflows, so short blocks do not add noise to the tab order. */
function useScrollFocusable<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [scrolls, setScrolls] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setScrolls(el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, tabIndex: scrolls ? 0 : undefined };
}

function ScrollTable({ children }: { children?: ReactNode }) {
  const f = useScrollFocusable<HTMLTableElement>();
  return <table ref={f.ref} tabIndex={f.tabIndex}>{children}</table>;
}

function ScrollPre({ children }: { children?: ReactNode }) {
  const f = useScrollFocusable<HTMLPreElement>();
  return <pre ref={f.ref} tabIndex={f.tabIndex}>{children}</pre>;
}

function Heading({ level, children }: { level: 2 | 3 | 4; children: ReactNode }) {
  const title = text(children);
  const id = slug(title);
  const Tag = `h${level}` as const;
  return (
    <Tag id={id} className="group">
      {children}
      <a href={`#${id}`} onClick={(e) => { e.preventDefault(); goToSection(id); }}
        className="ml-2 text-muted no-underline opacity-0 focus:opacity-100 group-hover:opacity-60" aria-label={`Link to section: ${title}`}>#</a>
    </Tag>
  );
}

// Module-level and stable: an inline components object gives react-markdown new component types on every
// render, which remounts every widget and diagram (losing widget state) whenever the page re-renders, e.g. on scroll.
const COMPONENTS: Components = {
  h2: ({ children }) => <Heading level={2}>{children}</Heading>,
  h3: ({ children }) => <Heading level={3}>{children}</Heading>,
  h4: ({ children }) => <Heading level={4}>{children}</Heading>,
  a: ({ href, children }) => href?.startsWith('http')
    ? <a href={href} target="_blank" rel="noreferrer">{children}<span className="sr-only"> (opens in a new tab)</span></a>
    : <a href={href}>{children}</a>,
  // Wide tables scroll horizontally (see .prose table), so they must be reachable by keyboard.
  table: ({ children }) => <ScrollTable>{children}</ScrollTable>,
  // GFM allows an empty header cell (a corner); an empty <th> has no accessible name, so render it as a data cell.
  th: ({ children, style }) => (text(children).trim() ? <th scope="col" style={style}>{children}</th> : <td style={style} />),
  input: ({ type, checked, disabled }) => type === 'checkbox'
    ? <input type="checkbox" checked={!!checked} disabled={disabled} readOnly aria-label={checked ? 'Done' : 'To do'} className="mr-1.5 align-middle" />
    : <input type={type} disabled={disabled} />,
  blockquote: ({ children }) => {
    const m = text(children).trim().match(/^\[!(\w+)\]/);
    const c = m && CALLOUTS[m[1].toUpperCase()];
    if (!c) return <blockquote>{children}</blockquote>;
    const Icon = c.icon;
    if (c.cls === 'callout-verified') return (
      <div className={`callout ${c.cls}`} role="note" aria-label={c.title}>
        <div className="callout-title">
          <span className="verified-badge" aria-hidden><Icon size={13} />{c.title}</span>
          <Link to="/verified" className="verified-all">All hardware notes<span className="sr-only"> verified on real hardware</span></Link>
        </div>
        {stripMarker(children, m![0])}
      </div>
    );
    return (
      <div className={`callout ${c.cls}`} role="note" aria-label={c.title}>
        <div className="callout-title" aria-hidden><Icon size={14} />{c.title}</div>
        {stripMarker(children, m![0])}
      </div>
    );
  },
  div: ({ className, children }) => (String(className ?? '').split(' ').includes(STACK_GROUP_CLASS)
    ? <StackGroup>{children}</StackGroup> : <div className={className}>{children}</div>),
  pre: ({ node, children }) => {
    const child = Children.toArray(children)[0];
    if (isValidElement(child)) {
      const props = child.props as { className?: string; children?: ReactNode };
      const lang = props.className?.match(/language-(\w[\w-]*)/)?.[1];
      const code = text(props.children).replace(/\n$/, '');
      if (lang === 'mermaid') return <Suspense fallback={<pre>{code}</pre>}><Mermaid chart={code} /></Suspense>;
      if (lang === 'widget') return <div className="not-prose my-6"><WidgetFrame id={code.trim()} /></div>;
    }
    const { real } = codeTags(node);
    if (real) return (
      <figure className="capture">
        <figcaption className="capture-label"><BadgeCheck size={12} aria-hidden />{captureLabel(real)}</figcaption>
        <ScrollPre>{children}</ScrollPre>
      </figure>
    );
    return <ScrollPre>{children}</ScrollPre>;
  },
};
const REMARK: Options['remarkPlugins'] = [remarkGfm, remarkStackVariants];
const REHYPE: Options['rehypePlugins'] = [[rehypeHighlight, { detect: false, ignoreMissing: true }]];

function Markdown({ source }: { source: string }) {
  return (
    <div className="prose">
      <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={REHYPE} components={COMPONENTS}>
        {source}
      </ReactMarkdown>
    </div>
  );
}

export default memo(Markdown);
