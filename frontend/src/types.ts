export interface Link { title: string; url: string }
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
export interface HandsOnLab {
  id: string;
  kind: 'handson';
  title: string;
  level: number;
  estimated_minutes: number;
  environment: string;
  lessons: string[];
  files: string | null;
  verified: boolean;
  toc: TocEntry[];
}
export type Lab = SimLab | HandsOnLab;

export interface CommandEntry { cmd: string; platform?: string; summary: string; example?: string; notes?: string; tags?: string[] }
export interface CommandGroup { id: string; title: string; description?: string; commands: CommandEntry[] }
export interface GlossaryTerm { term: string; expansion?: string; definition: string; lesson?: string }

export interface ContentIndex {
  generated: string;
  modules: Module[];
  lessons: LessonMeta[];
  quizzes: QuizMeta[];
  labs: Lab[];
  exams: ExamMeta[];
  commands: CommandGroup[];
  glossary: GlossaryTerm[];
}
