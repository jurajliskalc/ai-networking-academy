// Driver-stack variants (inbox vs DOCA-OFED), real-capture labels and the "Verified on hardware" page.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { content, expect, progressOf, test } from './fixtures';

interface Note { kind: string; id: string; title: string; anchor: string }
interface Cmd { cmd: string; stacks?: Record<'inbox' | 'doca', { cmd?: string }> }
interface Index { lessons: { id: string }[]; verifiedNotes: Note[]; commands: { commands: Cmd[] }[] }
const ix = content<Index>('index.json');
const here = path.dirname(fileURLToPath(import.meta.url));
const body = (id: string) => content<{ body: string }>(`lessons/${id}.json`).body;
const lessonWithVariants = ix.lessons.map((l) => l.id).find((id) => fs.existsSync(path.resolve(here, '../dist/content/lessons', `${id}.json`)) && /```\S* +stack=inbox/.test(body(id)));

test('a variant group shows the DOCA-OFED block by default and switches every group to inbox', async ({ page }) => {
  test.skip(!lessonWithVariants, 'no lesson has stack variants');
  await page.goto(`#/lesson/${lessonWithVariants}`);
  const group = page.locator('[data-stack-group]').first();
  await expect(group).toBeVisible();
  await expect(group.locator('[data-stack="doca"]').first()).toBeVisible();
  await expect(group.locator('[data-stack="inbox"]').first()).toBeHidden();
  const inbox = group.getByRole('button', { name: 'Distro inbox' });
  await expect(inbox).toHaveAttribute('aria-pressed', 'false');
  await inbox.click();
  await expect(inbox).toHaveAttribute('aria-pressed', 'true');
  await expect(group.locator('[data-stack="inbox"]').first()).toBeVisible();
  await expect(group.locator('[data-stack="doca"]').first()).toBeHidden();
  // The choice is global: every group on the page follows, and it is stored with the progress settings.
  for (const g of await page.locator('[data-stack-group]').all()) await expect(g.locator('[data-stack="doca"]').first()).toBeHidden();
  expect((await progressOf(page)).settings.stack).toBe('inbox');
  await page.reload();
  await expect(page.locator('[data-stack-group]').first().locator('[data-stack="inbox"]').first()).toBeVisible();
});

test('settings: the driver stack preference', async ({ page }) => {
  await page.goto('#/settings');
  const group = page.getByRole('group', { name: 'Driver stack' });
  await expect(group.getByRole('button', { name: 'NVIDIA DOCA-OFED' })).toHaveAttribute('aria-pressed', 'true');
  await group.getByRole('button', { name: 'Distro inbox' }).click();
  expect((await progressOf(page)).settings.stack).toBe('inbox');
  await group.getByRole('button', { name: 'NVIDIA DOCA-OFED' }).click();
  expect((await progressOf(page)).settings.stack).toBe('doca');
});

test('reference: a command with stack variants follows the stack switch', async ({ page }) => {
  const c = ix.commands.flatMap((g) => g.commands).find((x) => x.stacks && (x.stacks.inbox.cmd ?? x.cmd) !== (x.stacks.doca.cmd ?? x.cmd));
  test.skip(!c, 'no command has a stack-specific command line');
  await page.goto('#/reference');
  const codes = page.locator('main code.font-semibold');
  await expect(codes.filter({ hasText: c!.stacks!.doca.cmd ?? c!.cmd }).first()).toBeVisible();
  await page.getByRole('group', { name: 'Driver stack' }).first().getByRole('button', { name: 'Distro inbox' }).click();
  await expect(codes.filter({ hasText: c!.stacks!.inbox.cmd ?? c!.cmd }).first()).toBeVisible();
});

test('verified on hardware: the index lists every note and links to its section', async ({ page }) => {
  test.skip(ix.verifiedNotes.length === 0, 'no [!VERIFIED] callouts yet');
  await page.goto('#/verified');
  await expect(page.getByRole('heading', { level: 1, name: 'Verified on hardware' })).toBeVisible();
  await expect(page.locator('main li h3')).toHaveCount(ix.verifiedNotes.length);
  const note = ix.verifiedNotes.find((n) => n.kind === 'lesson') ?? ix.verifiedNotes[0];
  const title = note.title.replace(/`/g, ''); // rendered text: backtick spans become <code>
  await page.locator('main li').filter({ hasText: title }).first().getByRole('link').last().click();
  const callout = page.getByRole('note', { name: 'Verified on real hardware' }).filter({ hasText: title });
  await expect(callout.first()).toBeVisible();
  // Each callout links back to the index.
  await callout.first().getByRole('link', { name: /All hardware notes/ }).click();
  await expect(page).toHaveURL(/#\/verified$/);
});

test('dashboard links to the verified-on-hardware notes', async ({ page }) => {
  test.skip(ix.verifiedNotes.length === 0, 'no [!VERIFIED] callouts yet');
  await page.goto('#/');
  await page.getByRole('link', { name: /notes verified on real hardware/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Verified on hardware' })).toBeVisible();
});
