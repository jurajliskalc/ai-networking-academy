// Types for doc-stats.mjs (imported by tests/doc-stats.test.ts).
export type RepoStats = Record<string, number>;
export interface Claim { stat: string; re: RegExp; per?: number; scale?: number; required?: string[] }
export const ROOT: string;
export const DOCS: string[];
export const CLAIMS: Claim[];
export function repoStats(): RepoStats;
export function checkDocs(stats: RepoStats, docs?: string[], readDoc?: (rel: string) => string): { problems: string[]; checked: number };
