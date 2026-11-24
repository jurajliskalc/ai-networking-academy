// The counts the public docs advertise (README badges, "76 lessons", "22 Fabric Simulator labs", ...) must
// equal what the content compiler finds in the source tree. Add a lab and forget the README: this fails.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkDocs, CLAIMS, DOCS, repoStats, ROOT } from '../scripts/doc-stats.mjs';

const stats = repoStats();

describe('repository counts (build-content.mjs --stats)', () => {
  it('agree with a plain file count of the source tree', () => {
    const count = (dir: string, ext: string) => fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith(ext)).length;
    const modules = fs.readdirSync(path.join(ROOT, 'content/modules'));
    expect(stats.modules).toBe(modules.length);
    expect(stats.lessons).toBe(modules.reduce((n, m) => n + count(`content/modules/${m}/lessons`, '.md'), 0));
    expect(stats.simLabs).toBe(count('content/labs/sim', '.yaml'));
    expect(stats.handsOnLabs).toBe(count('content/labs/handson', '.md'));
    expect(stats.exams).toBe(count('content/exams', '.yaml'));
    expect(stats.labs).toBe(stats.simLabs + stats.handsOnLabs);
    expect(stats.handsOnLabs).toBe(stats.vmLabs + stats.hardwareLabs);
    expect(stats.questions).toBe(stats.quizQuestions + stats.examQuestions);
  });
});

describe('advertised counts in the docs', () => {
  it('match the source tree in every checked doc', () => {
    const { problems, checked } = checkDocs(stats);
    expect(problems).toEqual([]);
    expect(checked).toBeGreaterThan(30);
  });

  it('checks docs that exist, with claims that name real stats', () => {
    for (const rel of DOCS) expect(fs.existsSync(path.join(ROOT, rel)), rel).toBe(true);
    for (const c of CLAIMS) expect(Object.keys(stats), String(c.re)).toContain(c.stat);
  });

  it('catches a stale number, an approximate figure that drifted and a claim that disappeared', () => {
    const doc = (text: string) => checkDocs(stats, ['README.md'], () => text).problems;
    const good = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    expect(doc(good)).toEqual([]);
    const stale = good.replace(`${stats.simLabs} Fabric Simulator labs`, `${stats.simLabs - 3} Fabric Simulator labs`);
    expect(stale).not.toBe(good);
    expect(doc(stale).join('\n')).toMatch(/simLabs/);
    expect(doc(good.replace(/badge\/labs-\d+-/, 'badge/labs-35-')).join('\n')).toMatch(/\(labs\)/);
    expect(doc(good.replace(/badge\/lessons-\d+-/g, 'badge/lessons-many-')).join('\n')).toMatch(/no longer states "lessons"/);
    expect(doc(`${good}\nabout 150,000 words`).join('\n')).toMatch(/lessonWords/);
  });
});
