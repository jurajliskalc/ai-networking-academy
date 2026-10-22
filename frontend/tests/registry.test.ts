// The Visualizations page groups widgets by topic; a widget missing from TOPICS would not be listed.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TOPICS, WIDGETS } from '../src/widgets/registry';

describe('widget registry', () => {
  it('puts every widget in exactly one topic, and lists no unknown IDs', () => {
    const grouped = TOPICS.flatMap((t) => t.ids);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual(WIDGETS.map((w) => w.id).sort());
  });
  it('matches the WIDGETS list the content validator accepts', () => {
    const src = readFileSync(new URL('../scripts/build-content.mjs', import.meta.url), 'utf8');
    const list = src.match(/const WIDGETS = \[([\s\S]*?)\];/)![1];
    const ids = [...list.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);
    expect(ids.sort()).toEqual(WIDGETS.map((w) => w.id).sort());
  });
});
