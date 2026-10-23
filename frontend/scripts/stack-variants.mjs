// Driver-stack variants and real-capture labels. Pure functions shared by build-content.mjs (validation,
// the "Verified on hardware" index) and the app (src/components/Markdown.tsx, src/pages/Reference.tsx).
//
// Markdown syntax (docs/AUTHORING.md, "Driver-stack variants"):
//   ```bash stack=inbox          a fence tagged with the stack it applies to
//   ```text stack=doca real      `real` = real capture on the reference hardware with that stack
//   ```text real=doca            a real capture on a fence that is not part of a variant group
// Consecutive tagged fences (only blank lines between them, same indentation) form one variant group, shown
// as one block with a stack toggle. A group needs at least one block of each stack, and the blocks of one stack
// must be contiguous (all inbox blocks, then all doca blocks, or the other way round).

export const STACKS = ['inbox', 'doca'];
export const DEFAULT_STACK = 'doca';
export const STACK_LABELS = { inbox: 'Distro inbox', doca: 'NVIDIA DOCA-OFED' };
export const STACK_HINTS = {
  inbox: 'Kernel mlx5 driver and the distribution rdma-core / iproute2 tools (RDMA devices named like rocep3s0f0)',
  doca: 'NVIDIA DOCA-OFED / MLNX_OFED: mlnx_qos, show_gids, ibdev2netdev, cma_roce_tos (RDMA devices named mlx5_N)',
};
/** The reference hardware of docs/HARDWARE_VERIFICATION.md, per stack. */
export const CAPTURE_HW = {
  inbox: 'ConnectX-5, fw 16.29, Ubuntu 26.04, inbox mlx5 + rdma-core 61',
  doca: 'ConnectX-5, fw 16.29, Ubuntu 26.04, DOCA-OFED 3.4',
};
export const captureLabel = (stack) => `Real capture · ${CAPTURE_HW[stack]}`;

/**
 * Parses the meta string of a code fence (everything after the language).
 * @param {string | null | undefined} meta
 * @returns {{ stack: string | null, real: string | null, errors: string[] }}
 */
export function parseFenceMeta(meta) {
  const out = { stack: null, real: null, errors: [] };
  let realFlag = false;
  for (const tok of String(meta ?? '').trim().split(/\s+/).filter(Boolean)) {
    const [k, v] = tok.split('=', 2);
    if (k === 'stack') {
      if (STACKS.includes(v)) out.stack = v;
      else out.errors.push(`unknown stack "${v ?? ''}" (use ${STACKS.map((s) => `stack=${s}`).join(' or ')})`);
    } else if (k === 'real') {
      if (v === undefined) realFlag = true;
      else if (STACKS.includes(v)) out.real = v;
      else out.errors.push(`unknown capture stack "real=${v}" (use real, ${STACKS.map((s) => `real=${s}`).join(' or ')})`);
    } else if (/^(stak|stacks|capture|variant)\b/.test(k)) out.errors.push(`unknown fence attribute "${tok}" (did you mean stack= or real?)`);
  }
  if (realFlag) {
    if (out.stack) out.real = out.stack;
    else out.errors.push('"real" without stack= needs the stack: real=inbox or real=doca');
  }
  if (out.stack && out.real && out.real !== out.stack) out.errors.push(`real=${out.real} contradicts stack=${out.stack}`);
  return out;
}

/** Checks the blocks of one variant group; returns error messages. */
export function checkGroup(stacks) {
  const errors = [];
  for (const s of STACKS) if (!stacks.includes(s)) errors.push(`variant group has no stack=${s} block (every group needs ${STACKS.join(' and ')})`);
  const runs = stacks.filter((s, i) => i === 0 || stacks[i - 1] !== s);
  if (runs.length !== new Set(runs).size) errors.push(`variant group interleaves stacks (${stacks.join(', ')}): keep the blocks of one stack together`);
  return errors;
}

/**
 * Finds the fenced code blocks of a Markdown body and their variant groups (line-based, like the renderer's
 * remark plugin: tagged fences separated only by blank lines and at the same indentation belong together).
 * @param {string} body
 * @returns {{ fences: Array<{ line: number, indent: string, lang: string, stack: string | null, real: string | null }>,
 *            groups: Array<{ line: number, stacks: string[] }>, errors: string[] }}
 */
export function scanStackFences(body) {
  const lines = body.split('\n');
  const fences = [];
  const errors = [];
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    // Fences may sit inside list items or blockquotes; strip a blockquote prefix for the scan.
    const raw = lines[i].replace(/^(\s*>)+ ?/, '');
    const m = raw.match(/^(\s*)(`{3,}|~{3,})\s*([^\s`]*)\s*(.*)$/);
    if (!m) continue;
    if (open) {
      if (m[2][0] === open.ch && m[2].length >= open.len && !m[3] && !m[4]) {
        open.end = i;
        open = null;
      }
      continue;
    }
    const meta = parseFenceMeta(m[4]);
    for (const e of meta.errors) errors.push(`line ${i + 1}: ${e}`);
    open = { line: i + 1, start: i, end: -1, ch: m[2][0], len: m[2].length, indent: m[1], lang: m[3], stack: meta.stack, real: meta.real };
    fences.push(open);
  }
  const groups = [];
  let cur = null;
  for (let f = 0; f < fences.length; f++) {
    const x = fences[f];
    if (!x.stack) {
      cur = null;
      continue;
    }
    const prev = fences[f - 1];
    const adjacent = cur && prev && prev.stack && prev.indent === x.indent && prev.end >= 0 &&
      lines.slice(prev.end + 1, x.start).every((l) => !l.replace(/^(\s*>)+ ?/, '').trim());
    if (adjacent) cur.stacks.push(x.stack);
    else {
      cur = { line: x.line, stacks: [x.stack] };
      groups.push(cur);
    }
  }
  for (const g of groups) for (const e of checkGroup(g.stacks)) errors.push(`line ${g.line}: ${e}`);
  return { fences: fences.map(({ line, indent, lang, stack, real }) => ({ line, indent, lang, stack, real })), groups, errors };
}

/**
 * Validates the stack fields of a command-reference entry; returns error messages.
 * `real: inbox|doca` marks the base example as a real capture; `stacks: { inbox: {...}, doca: {...} }` holds the
 * per-stack variants (each may set cmd, example, notes and `real: true`).
 */
export function checkCommandStacks(entry) {
  const errors = [];
  if (entry.real !== undefined && !STACKS.includes(entry.real)) errors.push(`real must be one of ${STACKS.join(', ')}`);
  if (entry.stacks === undefined) return errors;
  const st = entry.stacks;
  if (!st || typeof st !== 'object' || Array.isArray(st)) return [...errors, 'stacks must be a mapping of stack -> variant'];
  for (const k of Object.keys(st)) if (!STACKS.includes(k)) errors.push(`unknown stack "${k}" in stacks`);
  for (const s of STACKS) {
    const v = st[s];
    if (!v || typeof v !== 'object') {
      errors.push(`stacks.${s} missing (variants need ${STACKS.join(' and ')})`);
      continue;
    }
    for (const k of Object.keys(v)) if (!['cmd', 'example', 'notes', 'real'].includes(k)) errors.push(`stacks.${s}: unknown key ${k}`);
    for (const k of ['cmd', 'example', 'notes']) if (v[k] !== undefined && typeof v[k] !== 'string') errors.push(`stacks.${s}.${k} must be a string`);
    if (v.real !== undefined && typeof v.real !== 'boolean') errors.push(`stacks.${s}.real must be true or false`);
    if (v.cmd === undefined && v.example === undefined && v.notes === undefined) errors.push(`stacks.${s} needs cmd, example or notes`);
  }
  return errors;
}

/** The fields of a command entry as shown for one stack. */
export function commandForStack(entry, stack) {
  const v = entry.stacks?.[stack];
  if (!v) return { cmd: entry.cmd, example: entry.example, notes: entry.notes, real: entry.real ?? null };
  return {
    cmd: v.cmd ?? entry.cmd,
    example: v.example ?? entry.example,
    notes: v.notes ?? entry.notes,
    real: v.real === true ? stack : v.example === undefined ? entry.real ?? null : null,
  };
}

/** `> [!VERIFIED]` callouts of a Markdown body: bold lead title, the rest of the text, and the enclosing heading. */
export function extractVerified(body) {
  const lines = body.split('\n');
  const out = [];
  const errors = [];
  let heading = '';
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim().startsWith('```')) fence = !fence;
    if (fence) continue;
    const h = l.match(/^(##|###) (.+)$/);
    if (h) heading = h[2].trim();
    const m = l.match(/^(\s*)> \[!VERIFIED\]\s*$/i);
    if (!m) continue;
    const quote = [];
    let j = i + 1;
    for (; j < lines.length && lines[j].startsWith(`${m[1]}>`); j++) quote.push(lines[j].slice(m[1].length + 1).replace(/^ /, ''));
    const text = quote.join('\n').trim();
    const t = text.match(/^\*\*(.+?)\*\*\s*([\s\S]*)$/);
    if (!t) errors.push(`line ${i + 1}: a [!VERIFIED] callout starts with a bold title: > **What was observed.** Details...`);
    else out.push({ title: t[1].trim(), text: t[2].trim(), heading, line: i + 1 });
    i = j - 1;
  }
  return { items: out, errors };
}
