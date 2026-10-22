// Validates everything under content/ and compiles it into JSON under public/content/.
// Usage: node scripts/build-content.mjs [--check]   (--check validates without writing)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONTENT = path.join(ROOT, 'content');
const OUT = path.join(ROOT, 'frontend', 'public', 'content');
const CHECK_ONLY = process.argv.includes('--check');

const WIDGETS = ['rocev2-packet', 'allreduce-sim', 'pfc-ecn-sim', 'ecmp-collision', 'fabric-sizer',
  'qp-state-machine', 'pcie-topo', 'parallelism-map', 'ib-credit-flow',
  'ethernet-frame',
  'subnet-calculator',
  'mtu-calculator',
  'queue-latency',
  'training-step-timeline',
  'collective-explorer',
  'pcie-bandwidth',
  'nvlink-generations',
  'bgp-path-sim',
  'evpn-route-explorer',
  'ib-addressing',
  'ib-speeds',
  'verbs-flow',
  'transport-matrix',
  'headroom-calculator',
  'dscp-mapper',
  'pfc-deadlock',
  'nccl-env-explorer',
  'nccl-tests-reader',
  'optics-planner',
  'ber-fec',
  'troubleshooting-tree',
  'counter-decoder',
  'telemetry-sampling',
];
const SECTIONS = ['Why this matters', 'Concepts', 'How it works', 'In practice', 'Common pitfalls', 'Key takeaways'];
const QTYPES = ['single', 'multi', 'scenario'];

const errors = [];
const warnings = [];
const err = (file, msg) => errors.push(`${path.relative(ROOT, file)}: ${msg}`);
const warn = (file, msg) => warnings.push(`${path.relative(ROOT, file)}: ${msg}`);

const read = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const list = (dir, ext) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(ext)).sort() : []);

function loadYaml(file) {
  try {
    return yaml.load(read(file));
  } catch (e) {
    err(file, `YAML: ${e.message.split('\n')[0]}`);
    return null;
  }
}

function frontMatter(file) {
  const m = read(file).match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) {
    err(file, 'missing front matter');
    return null;
  }
  try {
    return { meta: yaml.load(m[1]) ?? {}, body: m[2] };
  } catch (e) {
    err(file, `front matter YAML: ${e.message.split('\n')[0]}`);
    return null;
  }
}

const words = (s) => s.replace(/```[\s\S]*?```/g, ' ').split(/\s+/).filter(Boolean).length;
const minutes = (s) => Math.max(1, Math.round(words(s) / 200));

export function checkQuestions(file, questions, { domains } = {}) {
  if (!Array.isArray(questions) || questions.length === 0) return err(file, 'no questions');
  const ids = new Set();
  for (const q of questions) {
    const where = `question ${q.id}`;
    if (!q.id || ids.has(q.id)) err(file, `${where}: missing or duplicate id`);
    ids.add(q.id);
    if (!QTYPES.includes(q.type)) err(file, `${where}: type must be one of ${QTYPES.join(', ')}`);
    if (typeof q.prompt !== 'string' || !q.prompt) err(file, `${where}: prompt must be a non-empty string`);
    const opts = q.options ?? [];
    if (opts.length < 3 || opts.length > 5) err(file, `${where}: needs 3-5 options`);
    const oids = new Set(opts.map((o) => o.id));
    if (oids.size !== opts.length) err(file, `${where}: duplicate option ids`);
    const correct = opts.filter((o) => o.correct === true).length;
    if (q.type === 'multi' ? correct < 2 : correct !== 1)
      err(file, `${where}: ${q.type} question has ${correct} correct options`);
    for (const o of opts) {
      if (typeof o.text !== 'string' || !o.text) err(file, `${where}/${o.id}: option text must be a non-empty string`);
      if (typeof o.explanation !== 'string' || !o.explanation) err(file, `${where}/${o.id}: option explanation must be a non-empty string`);
    }
    if (domains && !domains.has(q.domain)) err(file, `${where}: unknown domain ${q.domain}`);
  }
}

/** GFM splits table cells on every unescaped "|", even inside code spans; flag rows that do not match the header. */
function checkTables(file, body) {
  const cells = (l) => {
    let t = l.trim();
    if (t.startsWith('|')) t = t.slice(1);
    if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
    return t.split(/(?<!\\)\|/).length;
  };
  const lines = body.split('\n');
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith('```')) fence = !fence;
    if (fence || !lines[i].trim().startsWith('|') || !/^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) continue;
    const n = cells(lines[i]);
    let j = i + 2;
    for (; j < lines.length && lines[j].trim().startsWith('|'); j++)
      if (cells(lines[j]) !== n) err(file, `table row has ${cells(lines[j])} cells, header has ${n} (escape "|" as "\\|"): ${lines[j].slice(0, 80)}`);
    i = j - 1;
  }
}

// ---------- modules, lessons, quizzes ----------
const modules = [];
const lessons = new Map();
const quizzes = new Map();
const lessonBodies = new Map();
const moduleDirs = fs.readdirSync(path.join(CONTENT, 'modules')).sort();

for (const dir of moduleDirs) {
  const mdir = path.join(CONTENT, 'modules', dir);
  const mfile = path.join(mdir, 'module.yaml');
  const mod = loadYaml(mfile);
  if (!mod) continue;
  if (mod.id !== dir) err(mfile, `id ${mod.id} != directory ${dir}`);
  modules.push({ id: mod.id, order: mod.order, title: mod.title, level: mod.level, summary: mod.summary?.trim(), lessons: mod.lessons });
  for (const f of list(path.join(mdir, 'lessons'), '.md')) {
    const id = f.replace(/\.md$/, '');
    if (!mod.lessons.includes(id)) err(path.join(mdir, 'lessons', f), 'lesson not listed in module.yaml');
  }
  for (const lid of mod.lessons) {
    const lfile = path.join(mdir, 'lessons', `${lid}.md`);
    if (!fs.existsSync(lfile)) {
      warn(lfile, 'planned lesson not written yet');
      continue;
    }
    const fm = frontMatter(lfile);
    if (!fm) continue;
    const { meta, body } = fm;
    for (const k of ['id', 'title', 'module', 'level', 'estimated_minutes', 'objectives', 'quiz', 'tags'])
      if (meta[k] === undefined) err(lfile, `missing front matter key ${k}`);
    if (meta.id !== lid) err(lfile, `id ${meta.id} != file name`);
    if (meta.module !== mod.id) err(lfile, `module ${meta.module} != ${mod.id}`);
    if (meta.quiz !== `quiz-${lid}`) err(lfile, 'quiz must be quiz-<lesson id>');
    if (lessons.has(lid)) err(lfile, 'duplicate lesson id');
    for (const w of meta.widgets ?? []) if (!WIDGETS.includes(w)) err(lfile, `unknown widget ${w}`);
    for (const [, w] of body.matchAll(/```widget\n([\s\S]*?)\n```/g))
      if (!WIDGETS.includes(w.trim())) err(lfile, `unknown embedded widget ${w.trim()}`);
    let pos = -1;
    for (const s of SECTIONS) {
      const i = body.indexOf(`\n## ${s}\n`);
      if (i < 0) err(lfile, `missing section "## ${s}"`);
      else if (i < pos) err(lfile, `section "## ${s}" out of order`);
      else pos = i;
    }
    if ((body.match(/```/g) ?? []).length % 2) err(lfile, 'unbalanced code fences');
    checkTables(lfile, body);
    // An unquoted ": " inside a YAML list item silently becomes a mapping; catch it here, not in the browser.
    if (typeof meta.title !== 'string') err(lfile, 'title must be a string (quote it if it contains ": ")');
    for (const k of ['objectives', 'tags', 'prerequisites'])
      for (const v of meta[k] ?? []) if (typeof v !== 'string') err(lfile, `${k}: every item must be a string (quote items containing ": "): ${JSON.stringify(v)}`);
    for (const r of meta.further_reading ?? []) if (typeof r?.title !== 'string' || typeof r?.url !== 'string') err(lfile, `further_reading entries need string title and url: ${JSON.stringify(r)}`);
    const toc = [...body.matchAll(/^(##|###) (.+)$/gm)].map((m) => ({ depth: m[1].length, text: m[2].trim() }));
    lessons.set(lid, {
      id: lid, module: mod.id, title: meta.title, level: meta.level, minutes: meta.estimated_minutes,
      objectives: meta.objectives ?? [], prerequisites: meta.prerequisites ?? [], quiz: meta.quiz,
      widgets: meta.widgets ?? [], labs: meta.labs ?? [], tags: meta.tags ?? [],
      further_reading: meta.further_reading ?? [], words: words(body), toc,
    });
    lessonBodies.set(lid, body);

    const qfile = path.join(mdir, 'quizzes', `quiz-${lid}.yaml`);
    if (!fs.existsSync(qfile)) {
      err(qfile, 'quiz missing for lesson');
      continue;
    }
    const quiz = loadYaml(qfile);
    if (!quiz) continue;
    if (quiz.id !== `quiz-${lid}`) err(qfile, 'quiz id mismatch');
    if (quiz.lesson !== lid) err(qfile, 'quiz lesson mismatch');
    checkQuestions(qfile, quiz.questions);
    quizzes.set(quiz.id, { id: quiz.id, title: quiz.title, lesson: lid, pass_pct: quiz.pass_pct ?? 70, questions: quiz.questions ?? [] });
  }
}
modules.sort((a, b) => a.order - b.order);

// ---------- labs ----------
const labs = [];
const labBodies = new Map();
const SIM_DIR = path.join(CONTENT, 'labs', 'sim');
const HOL_DIR = path.join(CONTENT, 'labs', 'handson');
for (const f of list(SIM_DIR, '.yaml')) {
  const file = path.join(SIM_DIR, f);
  const lab = loadYaml(file);
  if (!lab) continue;
  if (lab.id !== f.replace(/\.yaml$/, '')) err(file, 'id != file name');
  for (const k of ['title', 'level', 'estimated_minutes', 'ticket', 'faults', 'diagnosis', 'checks'])
    if (lab[k] === undefined) err(file, `missing key ${k}`);
  if (lab.diagnosis) checkQuestions(file, [{ ...lab.diagnosis, id: 'diagnosis', type: 'single' }]);
  labs.push({ ...lab, kind: 'sim', lessons: lab.lessons ?? [] });
}
for (const f of list(HOL_DIR, '.md')) {
  const file = path.join(HOL_DIR, f);
  const fm = frontMatter(file);
  if (!fm) continue;
  const { meta, body } = fm;
  if (meta.id !== f.replace(/\.md$/, '')) err(file, 'id != file name');
  for (const k of ['title', 'level', 'estimated_minutes', 'environment', 'lessons'])
    if (meta[k] === undefined) err(file, `missing key ${k}`);
  if (meta.files && !fs.existsSync(path.join(ROOT, meta.files))) err(file, `files directory ${meta.files} missing`);
  labs.push({
    id: meta.id, kind: 'handson', title: meta.title, level: meta.level, estimated_minutes: meta.estimated_minutes,
    environment: meta.environment, lessons: meta.lessons ?? [], files: meta.files ?? null, verified: meta.verified === true,
    toc: [...body.matchAll(/^(##|###) (.+)$/gm)].map((m) => ({ depth: m[1].length, text: m[2].trim() })),
  });
  checkTables(file, body);
  labBodies.set(meta.id, body);
}
const labIds = new Set();
for (const lab of labs) {
  if (labIds.has(lab.id)) errors.push(`duplicate lab id ${lab.id}`);
  labIds.add(lab.id);
  for (const l of lab.lessons) if (!lessons.has(l)) warn(path.join(CONTENT, 'labs'), `${lab.id}: unknown lesson ${l}`);
}
// Lessons list the labs that reference them (derived, so authors only maintain one side).
for (const lab of labs) for (const l of lab.lessons) if (lessons.has(l) && !lessons.get(l).labs.includes(lab.id)) lessons.get(l).labs.push(lab.id);

// ---------- cross references ----------
for (const [lid, l] of lessons) {
  for (const p of l.prerequisites) if (!lessons.has(p) && !modules.some((m) => m.lessons.includes(p))) errors.push(`lesson ${lid}: unknown prerequisite ${p}`);
  for (const lab of l.labs) if (!labIds.has(lab)) errors.push(`lesson ${lid}: unknown lab ${lab}`);
}

// ---------- exams ----------
const exams = [];
const examBodies = new Map();
for (const f of list(path.join(CONTENT, 'exams'), '.yaml')) {
  const file = path.join(CONTENT, 'exams', f);
  const ex = loadYaml(file);
  if (!ex) continue;
  if (ex.id !== f.replace(/\.yaml$/, '')) err(file, 'id != file name');
  const domains = new Set((ex.domains ?? []).map((d) => d.id));
  checkQuestions(file, ex.questions, { domains });
  exams.push({ id: ex.id, title: ex.title, description: ex.description?.trim(), duration_minutes: ex.duration_minutes, pass_pct: ex.pass_pct ?? 70, domains: ex.domains, count: ex.questions?.length ?? 0 });
  examBodies.set(ex.id, ex);
}

// ---------- commands and glossary ----------
const commands = [];
for (const f of list(path.join(CONTENT, 'commands'), '.yaml')) {
  const file = path.join(CONTENT, 'commands', f);
  const c = loadYaml(file);
  if (!c) continue;
  if (c.id !== f.replace(/\.yaml$/, '')) err(file, 'id != file name');
  for (const [i, e] of (c.commands ?? []).entries()) {
    if (typeof e.cmd !== 'string' || typeof e.summary !== 'string') err(file, `command #${i + 1} needs string cmd and summary`);
    for (const k of ['example', 'notes']) if (e[k] !== undefined && typeof e[k] !== 'string') err(file, `command #${i + 1}: ${k} must be a string`);
  }
  commands.push(c);
}
let glossary = [];
const gfile = path.join(CONTENT, 'glossary.yaml');
if (fs.existsSync(gfile)) {
  glossary = loadYaml(gfile)?.terms ?? [];
  const seen = new Set();
  for (const t of glossary) {
    if (typeof t.term !== 'string' || typeof t.definition !== 'string') err(gfile, `term ${JSON.stringify(t.term)} needs string term and definition`);
    if (seen.has(t.term?.toLowerCase())) err(gfile, `duplicate term ${t.term}`);
    seen.add(t.term?.toLowerCase());
    if (t.lesson && !lessons.has(t.lesson)) warn(gfile, `${t.term}: unknown lesson ${t.lesson}`);
  }
}

// ---------- report and write ----------
for (const w of warnings) console.warn(`warn  ${w}`);
for (const e of errors) console.error(`ERROR ${e}`);
const totalWords = [...lessons.values()].reduce((s, l) => s + l.words, 0);
const totalQuestions = [...quizzes.values()].reduce((s, q) => s + q.questions.length, 0);
const summary = `${modules.length} modules, ${lessons.size} lessons (${totalWords.toLocaleString('en')} words), ${quizzes.size} quizzes (${totalQuestions} questions), ` +
  `${labs.length} labs, ${exams.length} exams, ${commands.reduce((s, c) => s + (c.commands?.length ?? 0), 0)} commands, ${glossary.length} glossary terms`;
if (errors.length) {
  console.error(`\n${errors.length} error(s). ${summary}`);
  process.exit(1);
}
console.log(`Content OK: ${summary}`);
if (CHECK_ONLY) process.exit(0);

fs.rmSync(OUT, { recursive: true, force: true });
for (const d of ['lessons', 'quizzes', 'exams', 'labs']) fs.mkdirSync(path.join(OUT, d), { recursive: true });
const write = (rel, data) => fs.writeFileSync(path.join(OUT, rel), JSON.stringify(data));
write('index.json', {
  generated: new Date().toISOString(),
  modules, lessons: [...lessons.values()], labs, exams, commands, glossary,
  quizzes: [...quizzes.values()].map((q) => ({ id: q.id, title: q.title, lesson: q.lesson, count: q.questions.length })),
});
for (const [id, body] of lessonBodies) write(`lessons/${id}.json`, { id, body, minutes: minutes(body) });
for (const [id, q] of quizzes) write(`quizzes/${id}.json`, q);
for (const [id, ex] of examBodies) write(`exams/${id}.json`, ex);
for (const [id, body] of labBodies) write(`labs/${id}.json`, { id, body });
