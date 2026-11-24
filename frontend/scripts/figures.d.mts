// Types for figures.mjs (imported by tests; the app only renders its output, see src/components/Figure.tsx).
import type { FigureData } from '../src/components/Figure';

export class FigureError extends Error { line: number }
export interface FlowModel {
  kind: 'flow'; title: string; dir: 'TB' | 'LR' | 'RL';
  nodes: { id: string; label: string; shape: 'rect' | 'decision' | 'cylinder'; group: string | null }[];
  edges: { from: string; to: string; style: 'arrow' | 'line' | 'dotted'; label: string }[];
  groups: { id: string; title: string; parent: string | null }[];
}
export interface SequenceModel {
  kind: 'sequence'; title: string;
  actors: { id: string; label: string }[];
  steps: ({ type: 'message'; from: string; to: string; dashed: boolean; text: string } | { type: 'note'; over: string[]; text: string })[];
}
export type FigureModel = FlowModel | SequenceModel;
export const TARGET_WIDTH: number;
export function textWidth(text: string, face: 'sans500' | 'sans600' | 'mono500' | 'mono600', size: number, tracking?: number): number;
export function wrapText(label: string, face: 'sans500' | 'sans600' | 'mono500' | 'mono600', size: number, max: number): string[];
export function parseFigure(source: string): FigureModel;
export function figureTexts(model: FigureModel): string[];
export function figureAlt(model: FigureModel): string;
export function crossings(edges: { points: [number, number][] }[]): number;
export function layoutFigure(model: FigureModel, vars?: Record<string, string>): Promise<Omit<FigureData, 'v' | 'alt'>>;
export function compileFigure(source: string, vars?: Record<string, string>): Promise<FigureData>;
export function figureSources(body: string): string[];
export function compileFigures(body: string, vars?: Record<string, string>): Promise<string>;
