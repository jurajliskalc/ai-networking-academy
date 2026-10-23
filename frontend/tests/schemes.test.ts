// Colour schemes: every scheme in index.css defines the full token set in light and dark, and every text
// token reaches WCAG AA contrast (4.5:1; 7:1 for High contrast) on every surface it is drawn on.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCHEMES, sanitize } from '../src/progress';

const css = fs.readFileSync(path.resolve(__dirname, '../src/index.css'), 'utf8');
const KEYS = ['bg', 'bg-soft', 'panel', 'panel-2', 'border', 'text', 'muted', 'accent', 'accent-soft', 'on-accent',
  'data', 'warn', 'danger', 'analogy', 'interview', 'code-bg', 'code-text'];
const TEXT = ['text', 'muted', 'accent', 'data', 'warn', 'danger', 'analogy', 'interview'];
const SURFACES = ['bg', 'bg-soft', 'panel', 'panel-2'];

function block(selector: string): Record<string, string> {
  const i = css.indexOf(`${selector} {`);
  if (i < 0) throw new Error(`no CSS block ${selector}`);
  const body = css.slice(i, css.indexOf('}', i));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2].toLowerCase()]));
}
const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const tokens = (scheme: string, dark: boolean) =>
  block(dark ? `.dark[data-scheme="${scheme}"], .dark [data-scheme="${scheme}"]` : `[data-scheme="${scheme}"]`);

describe('colour schemes', () => {
  for (const scheme of SCHEMES) {
    for (const dark of [false, true]) {
      it(`${scheme} ${dark ? 'dark' : 'light'}: complete token set and readable text`, () => {
        const t = tokens(scheme, dark);
        expect(Object.keys(t).sort()).toEqual([...KEYS].sort());
        const need = scheme === 'contrast' ? 7 : 4.5;
        const pairs: [string, string][] = [...TEXT.flatMap((f) => SURFACES.map((s) => [f, s] as [string, string])),
          ['accent', 'accent-soft'], ['text', 'accent-soft'], ['muted', 'accent-soft'], ['on-accent', 'accent'], ['code-text', 'code-bg']];
        const failing = pairs.filter(([f, s]) => ratio(t[f], t[s]) < need).map(([f, s]) => `${f} ${t[f]} on ${s} ${t[s]}: ${ratio(t[f], t[s]).toFixed(2)}`);
        expect(failing).toEqual([]);
      });
    }
  }

  it('the default scheme blocks (used by previews) repeat the :root tokens exactly', () => {
    expect(tokens('noc', false)).toEqual(block(':root'));
    expect(tokens('noc', true)).toEqual({ ...block(':root'), ...block(':root.dark') });
  });

  it('progress keeps a known scheme and falls back to the default otherwise', () => {
    expect(sanitize({ settings: { theme: 'dark', scheme: 'sepia' } }).settings).toEqual({ theme: 'dark', scheme: 'sepia', stack: 'doca' });
    expect(sanitize({ settings: { theme: 'light', scheme: 'neon' } }).settings.scheme).toBe('noc');
    expect(sanitize({ settings: { theme: 'light' } }).settings.scheme).toBe('noc');
  });

  it('the pre-paint script in index.html knows every non-default scheme', () => {
    const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
    for (const s of SCHEMES.filter((x) => x !== 'noc')) expect(html).toContain(`'${s}'`);
  });
});
