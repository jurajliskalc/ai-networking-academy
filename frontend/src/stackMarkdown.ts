// remark plugin for driver-stack variants (syntax: scripts/stack-variants.mjs, docs/AUTHORING.md).
// Tags every fence that has `stack=` or `real` with data-stack / data-real, and wraps each run of adjacent
// stack-tagged fences in a <div class="stack-group">, which Markdown.tsx renders as one block with a toggle.
import { parseFenceMeta } from '../scripts/stack-variants.mjs';

export interface MdNode {
  type: string;
  children?: MdNode[];
  lang?: string | null;
  meta?: string | null;
  value?: string;
  data?: { hName?: string; hProperties?: Record<string, unknown>; [k: string]: unknown };
}

export const STACK_GROUP_CLASS = 'stack-group';

function walk(node: MdNode) {
  if (!node.children) return;
  const out: MdNode[] = [];
  let run: MdNode | null = null;
  for (const c of node.children) {
    walk(c);
    if (c.type === 'code') {
      const m = parseFenceMeta(c.meta);
      if (m.stack || m.real) {
        c.data = { ...c.data, hProperties: { ...c.data?.hProperties, ...(m.stack ? { dataStack: m.stack } : {}), ...(m.real ? { dataReal: m.real } : {}) } };
      }
      if (m.stack) {
        if (!run) {
          run = { type: 'stackGroup', data: { hName: 'div', hProperties: { className: [STACK_GROUP_CLASS] } }, children: [] };
          out.push(run);
        }
        run.children!.push(c);
        continue;
      }
    }
    run = null;
    out.push(c);
  }
  node.children = out;
}

export function remarkStackVariants() {
  return (tree: MdNode) => walk(tree);
}
