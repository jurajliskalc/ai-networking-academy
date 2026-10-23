// Driver-stack variants (scripts/stack-variants.mjs, src/stackMarkdown.ts) and the stack preference in progress.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import {
  captureLabel, checkCommandStacks, checkGroup, commandForStack, DEFAULT_STACK, extractVerified, parseFenceMeta, scanStackFences, STACKS,
} from '../scripts/stack-variants.mjs';
import { emptyProgress, sanitize, STACK_CHOICES } from '../src/progress';
import { ProgressProvider } from '../src/store';
import Markdown from '../src/components/Markdown';

const fence = (info: string, body: string) => `\`\`\`${info}\n${body}\n\`\`\``;

describe('parseFenceMeta', () => {
  it('reads stack= and real', () => {
    expect(parseFenceMeta('stack=inbox')).toEqual({ stack: 'inbox', real: null, errors: [] });
    expect(parseFenceMeta('stack=doca real')).toEqual({ stack: 'doca', real: 'doca', errors: [] });
    expect(parseFenceMeta('real=inbox')).toEqual({ stack: null, real: 'inbox', errors: [] });
    expect(parseFenceMeta('')).toEqual({ stack: null, real: null, errors: [] });
    expect(parseFenceMeta(null)).toEqual({ stack: null, real: null, errors: [] });
  });
  it('rejects unknown stacks, a bare real without a stack and contradictions', () => {
    expect(parseFenceMeta('stack=ofed').errors[0]).toMatch(/unknown stack "ofed"/);
    expect(parseFenceMeta('real').errors[0]).toMatch(/needs the stack/);
    expect(parseFenceMeta('real=mlnx').errors[0]).toMatch(/unknown capture stack/);
    expect(parseFenceMeta('stack=inbox real=doca').errors[0]).toMatch(/contradicts/);
    expect(parseFenceMeta('stak=inbox').errors[0]).toMatch(/did you mean/);
  });
});

describe('scanStackFences', () => {
  it('groups adjacent tagged fences and accepts a well-formed pair', () => {
    const md = ['Intro', '', fence('bash stack=inbox', 'dcb pfc show dev X'), '', fence('text stack=inbox real', 'pfc-cap 8'), '',
      fence('bash stack=doca', 'mlnx_qos -i X'), '', 'Text', '', fence('bash', 'plain')].join('\n');
    const s = scanStackFences(md);
    expect(s.errors).toEqual([]);
    expect(s.groups).toEqual([{ line: 3, stacks: ['inbox', 'inbox', 'doca'] }]);
    expect(s.fences.filter((f) => f.real)).toHaveLength(1);
  });
  it('flags a lone variant, interleaved stacks and bad attributes', () => {
    const lone = scanStackFences(fence('bash stack=inbox', 'x'));
    expect(lone.errors[0]).toMatch(/no stack=doca block/);
    const inter = scanStackFences([fence('a stack=inbox', '1'), fence('a stack=doca', '2'), fence('a stack=inbox', '3')].join('\n\n'));
    expect(inter.errors.some((e) => /interleaves/.test(e))).toBe(true);
    expect(scanStackFences(fence('text stack=nvidia', 'x')).errors[0]).toMatch(/line 1: unknown stack/);
  });
  it('splits groups at prose and at a change of indentation', () => {
    const md = [fence('a stack=inbox', '1'), '', fence('a stack=doca', '2'), '', 'between', '', fence('a stack=doca', '3'), '', fence('a stack=inbox', '4')].join('\n');
    expect(scanStackFences(md).groups.map((g) => g.stacks)).toEqual([['inbox', 'doca'], ['doca', 'inbox']]);
    const nested = ['- item', '', '  ```a stack=inbox', '  1', '  ```', '', '```a stack=doca', '2', '```'].join('\n');
    expect(scanStackFences(nested).groups).toHaveLength(2);
  });
  it('does not treat fence-like text inside a code block as a fence', () => {
    const md = ['````markdown', '```bash stack=inbox', 'x', '```', '````'].join('\n');
    expect(scanStackFences(md)).toMatchObject({ groups: [], errors: [] });
  });
  it('checkGroup needs both stacks', () => {
    expect(checkGroup(['inbox', 'doca'])).toEqual([]);
    expect(checkGroup(['doca'])).toHaveLength(1);
  });
});

describe('command reference variants', () => {
  const entry = {
    cmd: 'show_gids', summary: 's', example: 'base', real: 'doca' as const,
    stacks: { inbox: { cmd: 'cat /sys/class/infiniband/rocep3s0f0/ports/1/gids/3', example: 'x', real: true }, doca: { notes: 'NVIDIA only' } },
  };
  it('validates the stacks mapping', () => {
    expect(checkCommandStacks(entry)).toEqual([]);
    expect(checkCommandStacks({ stacks: { inbox: { cmd: 'a' } } })[0]).toMatch(/stacks.doca missing/);
    expect(checkCommandStacks({ stacks: { inbox: { cmd: 'a' }, doca: { cmd: 'b' }, ofed: {} } })[0]).toMatch(/unknown stack "ofed"/);
    expect(checkCommandStacks({ stacks: { inbox: { cmd: 'a', real: 'yes' }, doca: { cmd: 'b' } } })[0]).toMatch(/real must be true or false/);
    expect(checkCommandStacks({ stacks: { inbox: {}, doca: { cmd: 'b' } } })[0]).toMatch(/needs cmd, example or notes/);
    expect(checkCommandStacks({ real: 'mlnx' })[0]).toMatch(/real must be one of/);
  });
  it('resolves the fields for a stack', () => {
    expect(commandForStack(entry, 'inbox')).toEqual({ cmd: entry.stacks.inbox.cmd, example: 'x', notes: undefined, real: 'inbox' });
    // doca overrides only the notes: the base example and its capture label are kept.
    expect(commandForStack(entry, 'doca')).toEqual({ cmd: 'show_gids', example: 'base', notes: 'NVIDIA only', real: 'doca' });
    expect(commandForStack({ cmd: 'a', example: 'b' }, 'inbox')).toEqual({ cmd: 'a', example: 'b', notes: undefined, real: null });
  });
});

describe('extractVerified', () => {
  it('collects [!VERIFIED] callouts with their section', () => {
    const md = ['## In practice', '### PFC and pause', '> [!VERIFIED]', '> **Enabling PFC turns global pause off.** Seen on', '> ConnectX-5.', '',
      '```', '> [!VERIFIED]', '```', '> [!VERIFIED]', '> no bold title'].join('\n');
    const v = extractVerified(md);
    expect(v.items).toEqual([{ title: 'Enabling PFC turns global pause off.', text: 'Seen on\nConnectX-5.', heading: 'PFC and pause', line: 3 }]);
    expect(v.errors).toHaveLength(1);
  });
});

describe('stack preference', () => {
  it('defaults and sanitizes like theme and scheme', () => {
    expect(STACK_CHOICES).toEqual(STACKS);
    expect(emptyProgress().settings.stack).toBe(DEFAULT_STACK);
    expect(sanitize({ settings: { stack: 'inbox' } }).settings.stack).toBe('inbox');
    expect(sanitize({ settings: { stack: 'mlnx' } }).settings.stack).toBe('doca');
    expect(sanitize({ settings: { theme: 'dark' } }).settings).toEqual({ theme: 'dark', scheme: 'noc', stack: 'doca' });
  });
  it('labels real captures with the reference hardware', () => {
    expect(captureLabel('doca')).toBe('Real capture · ConnectX-5, fw 16.29, Ubuntu 26.04, DOCA-OFED 3.4');
    expect(captureLabel('inbox')).toMatch(/inbox mlx5 \+ rdma-core 61$/);
  });
});

describe('Markdown rendering', () => {
  const render = (md: string) => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ProgressProvider, null, createElement(Markdown, { source: md }))));
  it('renders a variant group with a toggle and shows the preferred stack (doca by default)', () => {
    const html = render([fence('bash stack=inbox', 'dcb pfc show dev ens64f0np0'), '', fence('bash stack=doca real', 'mlnx_qos -i ens64f0np0')].join('\n'));
    expect(html).toContain('data-stack-group');
    expect(html).toContain('aria-label="Driver stack"');
    expect(html).toMatch(/<div data-stack="inbox" hidden="">/);
    expect(html).toMatch(/<div data-stack="doca">/);
    expect(html).toContain('Real capture · ConnectX-5, fw 16.29, Ubuntu 26.04, DOCA-OFED 3.4');
  });
  it('renders a lone real capture and leaves plain fences alone', () => {
    const html = render(`${fence('text real=inbox', 'link rocep3s0f0/1 state ACTIVE')}\n\n${fence('bash', 'ls')}`);
    expect(html).toContain('inbox mlx5 + rdma-core 61');
    expect(html).not.toContain('data-stack-group');
    expect((html.match(/<pre/g) ?? []).length).toBe(2);
  });
  it('renders the VERIFIED callout with its badge and a link to the index', () => {
    const html = render('> [!VERIFIED]\n> **Global pause turns off.** When PFC is enabled.');
    expect(html).toContain('Verified on real hardware');
    expect(html).toContain('href="/verified"');
    expect(html).not.toContain('[!VERIFIED]');
  });
});
