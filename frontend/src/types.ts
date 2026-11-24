import type { SourceKind } from '../scripts/source-kinds.mjs';

/** A further-reading reference; `kind` says what sort of source it is (scripts/source-kinds.mjs). */
export interface Link { title: string; url: string; kind: SourceKind }
export interface TocEntry { depth: number; text: string }

export interface Module {
  id: string;
  order: number;
  title: string;
  level: number;
  summary: string;
  lessons: string[];
}

export interface LessonMeta {
  id: string;
  module: string;
  title: string;
  level: number;
  minutes: number;
  objectives: string[];
  prerequisites: string[];
  quiz: string;
  widgets: string[];
  labs: string[];
  tags: string[];
  further_reading: Link[];
  words: number;
  toc: TocEntry[];
}

export interface Option { id: string; text: string; correct?: boolean; explanation: string }
export interface Question {
  id: string;
  type: 'single' | 'multi' | 'scenario';
  prompt: string;
  options: Option[];
  explanation?: string;
  tags?: string[];
  domain?: string;
}
export interface Quiz { id: string; title: string; lesson: string; pass_pct: number; questions: Question[] }
export interface QuizMeta { id: string; title: string; lesson: string; count: number }

export interface Domain { id: string; title: string }
export interface ExamMeta { id: string; title: string; description: string; duration_minutes: number; pass_pct: number; domains: Domain[]; count: number }
export interface Exam extends ExamMeta { questions: Question[] }

export interface SimCheck { description: string; check: string; args?: Record<string, unknown> }
export interface SimLab {
  id: string;
  kind: 'sim';
  title: string;
  level: number;
  estimated_minutes: number;
  lessons: string[];
  summary?: string;
  start?: string;
  ticket: string;
  faults: Record<string, unknown>[];
  hints: string[];
  diagnosis: { prompt: string; options: Option[] };
  checks: SimCheck[];
  solution: string;
}
export type Fabric = 'any' | 'roce' | 'ib';
export interface HandsOnLab {
  id: string;
  kind: 'handson';
  title: string;
  level: number;
  estimated_minutes: number;
  environment: 'linux-vm' | 'containerlab' | 'hardware';
  lessons: string[];
  files: string | null;
  verified: boolean;
  summary: string;
  /** 0 = virtual (VM/containerlab), 1-3 = real hardware tiers. */
  tier: number;
  fabric: Fabric;
  requires: string[];
  changes_config: boolean;
  toc: TocEntry[];
}
export type Lab = SimLab | HandsOnLab;

export type DriverStack = 'inbox' | 'doca';
export interface CommandVariant { cmd?: string; example?: string; notes?: string; real?: boolean }
/** `real`: the example is a real capture on the reference hardware with that stack; `stacks`: per-stack variants. */
export interface CommandEntry { cmd: string; platform?: string; summary: string; example?: string; notes?: string; tags?: string[]; real?: DriverStack; stacks?: Partial<Record<DriverStack, CommandVariant>> }
/** A `> [!VERIFIED]` callout, collected by build-content.mjs for the "Verified on hardware" page. */
export interface VerifiedNote { kind: 'lesson' | 'lab' | 'guide'; id: string; page: string; module?: string; title: string; text: string; heading: string; anchor: string }
export interface CommandGroup { id: string; title: string; description?: string; commands: CommandEntry[] }
export interface GlossaryTerm { term: string; expansion?: string; definition: string; lesson?: string }

export interface HwTier { id: number; title: string; summary: string; gear: string }
export interface HwRequirement { id: string; title: string; description: string }
export interface HwVariable { name: string; group: string; label: string; default?: string; derived?: string; choices?: string[]; help?: string }
export interface HwGuide { id: string; title: string; order: number; summary: string; words: number; toc: TocEntry[] }
export interface HardwareMeta { tiers: HwTier[]; requirements: HwRequirement[]; variables: HwVariable[]; guides: HwGuide[] }

export interface ContentIndex {
  generated: string;
  modules: Module[];
  lessons: LessonMeta[];
  quizzes: QuizMeta[];
  labs: Lab[];
  exams: ExamMeta[];
  commands: CommandGroup[];
  glossary: GlossaryTerm[];
  hardware: HardwareMeta;
  verifiedNotes: VerifiedNote[];
}
