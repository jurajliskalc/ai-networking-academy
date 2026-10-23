// Types for stack-variants.mjs (imported by the app and by tests).
export type Stack = 'inbox' | 'doca';
export const STACKS: Stack[];
export const DEFAULT_STACK: Stack;
export const STACK_LABELS: Record<Stack, string>;
export const STACK_HINTS: Record<Stack, string>;
export const CAPTURE_HW: Record<Stack, string>;
export function captureLabel(stack: Stack): string;
export function parseFenceMeta(meta: string | null | undefined): { stack: Stack | null; real: Stack | null; errors: string[] };
export function checkGroup(stacks: string[]): string[];
export function scanStackFences(body: string): {
  fences: { line: number; indent: string; lang: string; stack: Stack | null; real: Stack | null }[];
  groups: { line: number; stacks: Stack[] }[];
  errors: string[];
};
export interface StackVariant { cmd?: string; example?: string; notes?: string; real?: boolean }
export function checkCommandStacks(entry: { real?: unknown; stacks?: unknown }): string[];
export function commandForStack(
  entry: { cmd: string; example?: string; notes?: string; real?: Stack; stacks?: Partial<Record<Stack, StackVariant>> },
  stack: Stack,
): { cmd: string; example?: string; notes?: string; real: Stack | null };
export function extractVerified(body: string): { items: { title: string; text: string; heading: string; line: number }[]; errors: string[] };
