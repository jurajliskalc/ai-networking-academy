// Types for source-kinds.mjs (imported by the app and by tests).
export type SourceKind = 'standard' | 'vendor' | 'source' | 'paper' | 'article';
export const SOURCE_KINDS: Record<SourceKind, string>;
export const SOURCE_KIND_HINTS: Record<SourceKind, string>;
export function hostOf(url: string): string;
export function sourceKind(url: string): SourceKind | null;
