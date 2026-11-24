// Keeps the numbers the public docs advertise equal to what is in the source tree.
// The counts come from the content compiler (`build-content.mjs --stats`); CLAIMS says which phrases in
// which docs state them. `npm test` runs this through tests/doc-stats.test.ts, so a stale count fails CI.
// Usage: node scripts/doc-stats.mjs [extra-file ...]   prints the counts, exits 1 on a stale number
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');

/** Docs whose numbers must always be current. Dated snapshots (CHANGELOG.md, docs/releases/) are not listed. */
export const DOCS = [
  'README.md',
  'ROADMAP.md',
  'CONTRIBUTING.md',
  'IMPLEMENTATION_STATUS.md',
  'docs/PORTFOLIO_TOUR.md',
  'docs/ARCHITECTURE.md',
  'docs/CURRICULUM_PLAN.md',
  'labs/README.md',
  'frontend/src/components/Layout.tsx', // the sidebar footer states the module count
];

/**
 * One entry per way a doc states a count. `re` has one capture group holding the number; every match in
 * every checked doc must equal `stats[stat]`. `per` gives the unit of an approximate figure ("198,000
 * words" is checked to the nearest `per`), and `required` lists docs that must state the number at all.
 */
export const CLAIMS = [
  { stat: 'modules', re: /\b(\d+) modules\b/g, required: ['README.md'] },
  { stat: 'lessons', re: /(?<!\bin )\b(\d+) (?:structured )?lessons\b/g, required: ['README.md'] },
  { stat: 'lessons', re: /badge\/lessons-(\d+)-/g, required: ['README.md'] },
  { stat: 'lessons', re: /\bof the (\d+) lessons\b/g },
  { stat: 'lessonWords', re: /\b(?:about |~)(\d{2,3},\d{3}) words\b/g, per: 1000 },
  { stat: 'lessonWords', re: /~(\d+)k words\b/g, per: 1000, scale: 1000 },
  { stat: 'quizQuestions', re: /\b(\d[\d,]*) quiz questions\b/g, required: ['README.md'] },
  { stat: 'quizQuestions', re: /\| Quiz questions \| (\d[\d,]*) \|/g },
  { stat: 'exams', re: /\b(\d+) (?:timed )?mock exams\b/g, required: ['README.md'] },
  { stat: 'exams', re: /\| Mock exams \| (\d+) \(/g },
  { stat: 'examQuestions', re: /mock exams\*{0,2} \((\d+) questions\)/gi, required: ['README.md'] },
  { stat: 'examQuestions', re: /\| Mock exams \| \d+ \((\d+) questions\)/g },
  { stat: 'questions', re: /badge\/questions-(\d+)-/g, required: ['README.md'] },
  { stat: 'simLabs', re: /\b(\d+) (?:Fabric Simulator|simulator|fault-injection|break\/fix) (?:labs|incidents)\b/gi, required: ['README.md'] },
  { stat: 'simLabs', re: /\| Simulator labs \| (\d+) \|/g },
  { stat: 'handsOnLabs', re: /\b(\d+) (?:hands-on|Real HW) labs\b/g, required: ['README.md'] },
  { stat: 'handsOnLabs', re: /\b\d+ of the (\d+) (?:hands-on )?labs\b/g },
  { stat: 'verifiedLabs', re: /\b(\d+) of the \d+ (?:hands-on )?labs\b/g, required: ['README.md', 'labs/README.md'] },
  { stat: 'vmLabs', re: /\| Hands-on labs, Tier 0 \(VM\) \| (\d+) \|/g },
  { stat: 'hardwareLabs', re: /\| Real hardware labs, Tier 1-3 \| (\d+) \(/g },
  { stat: 'hardwareLabs', re: /\b(\d+) real-hardware labs\b/g },
  { stat: 'verifiedHardwareLabs', re: /\b(\d+) of the \d+ real-hardware labs\b/g },
  { stat: 'labs', re: /badge\/labs-(\d+)-/g, required: ['README.md'] },
  { stat: 'hardwareGuides', re: /\| Real hardware guides \| (\d+) \|/g },
  { stat: 'widgets', re: /\b(\d+) interactive visualizations\b/g, required: ['README.md'] },
  { stat: 'widgets', re: /^\| (\d+) widgets \|/gm },
  { stat: 'widgetEmbeds', re: /\bembedded (\d+) times\b/gi },
  { stat: 'lessonsWithWidgets', re: /\bembedded \d+ times in (\d+) (?:of the \d+ )?lessons\b/gi },
  { stat: 'commands', re: /\b(\d+) annotated commands\b/g, required: ['README.md'] },
  { stat: 'commands', re: /\| Commands \/ glossary \| (\d+) \/ \d+ \|/g },
  { stat: 'glossaryTerms', re: /\b(\d+)-term glossary\b/g, required: ['README.md'] },
  { stat: 'glossaryTerms', re: /\| Commands \/ glossary \| \d+ \/ (\d+) \|/g },
  { stat: 'stackVariantGroups', re: /\b(\d+) variant groups\b/g },
  { stat: 'realCaptures', re: /\b(\d+) output blocks are real captures\b/g },
  { stat: 'verifiedNotes', re: /\b(\d+) (?:`\[!VERIFIED\]` callouts|verified-on-hardware notes)/g },
  { stat: 'references', re: /\b(\d+) references\b/g, required: ['README.md'] },
  { stat: 'referenceUrls', re: /\b(\d+) distinct documents\b/g, required: ['README.md'] },
  { stat: 'referenceUrls', re: /\| Further-reading links \| (\d+) external links/g },
];

/** Counts derived from the source tree by the content compiler. Throws if the content does not validate. */
export function repoStats() {
  return JSON.parse(execFileSync(process.execPath, [path.join(HERE, 'build-content.mjs'), '--stats'], { encoding: 'utf8' }));
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/**
 * Compare `docs` (paths relative to the repository root) with `stats`.
 * Returns the stale or missing claims as readable strings, and how many numbers were checked.
 */
export function checkDocs(stats, docs = DOCS, readDoc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')) {
  const problems = [];
  let checked = 0;
  for (const rel of docs) {
    const text = readDoc(rel);
    for (const c of CLAIMS) {
      if (!(c.stat in stats)) throw new Error(`doc-stats: unknown stat ${c.stat}`);
      const actual = stats[c.stat];
      const matches = [...text.matchAll(c.re)];
      if (!matches.length && c.required?.includes(rel)) problems.push(`${rel}: no longer states "${c.stat}" (expected a match for ${c.re}); update the doc or CLAIMS`);
      for (const m of matches) {
        checked++;
        const said = Number(m[1].replace(/,/g, '')) * (c.scale ?? 1);
        const ok = c.per ? Math.abs(said - actual) <= c.per : said === actual;
        if (!ok) problems.push(`${rel}:${lineOf(text, m.index)}: "${m[0]}" but the source tree has ${actual.toLocaleString('en')} (${c.stat})`);
      }
    }
  }
  return { problems, checked };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stats = repoStats();
  const docs = [...DOCS, ...process.argv.slice(2)];
  const { problems, checked } = checkDocs(stats, docs);
  console.log(Object.entries(stats).map(([k, v]) => `${k.padEnd(22)}${v.toLocaleString('en')}`).join('\n'));
  if (problems.length) {
    console.error(`\n${problems.length} stale or missing count(s):\n${problems.map((p) => `  ${p}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`\nDocs OK: ${checked} advertised numbers in ${docs.length} files match the source tree`);
}
