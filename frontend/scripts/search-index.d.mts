// Types for search-index.mjs (imported by tests/search.test.ts).
export type SearchDoc = [number, string, string];
export type SearchEntry = [number, string, string, string, string];
export interface SearchIndexFile { v: 1; types: string[]; c: string[]; d: SearchDoc[]; e: SearchEntry[] }
export const TYPES: string[];
export const SNIPPET_CHARS: number;
export const COMMON_SHARE: number;
export function slug(s: string): string;
export function headingText(h: string): string;
export function tokenize(s: string): string[];
export function stripMarkdown(md: string): string;
export function splitSections(md: string): { heading: string; anchor: string; text: string }[];
export function snippet(text: string, max?: number): string;
export function keywords(text: string, exclude?: string): string;
export function buildSearchIndex(c: Record<string, unknown>): SearchIndexFile;
export function parseWidgetRegistry(src: string): { id: string; title: string; summary: string }[];
