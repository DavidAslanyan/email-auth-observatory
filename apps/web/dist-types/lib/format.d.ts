import type { ChangeEvent } from './types.js';
/** Strength on the ordinal enforcement ramp. Absence is off-ramp on purpose. */
export type Strength = 'strong' | 'mid' | 'weak' | 'absent';
export declare function strengthOf(value: string | null | undefined): Strength;
export declare const STRENGTH_VAR: Record<Strength, string>;
/**
 * Ink chosen for contrast against each ramp step. These resolve to CSS custom
 * properties that flip with the theme, because the ramp itself inverts in dark
 * mode — the strongest step is the darkest on light and the lightest on dark.
 */
export declare const STRENGTH_INK: Record<Strength, string>;
/** `-` is how the record stores it; `-all` is how an engineer reads it. */
export declare function qualifierToken(qualifier: string | null): string | null;
export declare const qualifierMeaning: (token: string) => string;
export declare const fieldLabel: (field: string) => string;
export declare function valueLabel(v: ChangeEvent['from']): string;
export type Direction = 'strengthening' | 'weakening' | 'neutral';
/** Mirrors the store's classifier so the table and the report agree. */
export declare function directionOf(event: ChangeEvent): Direction;
export declare const DIRECTION_GLYPH: Record<Direction, string>;
export declare const num: (n: number) => string;
export declare function share(part: number, whole: number): string;
export declare const PROVIDER_LABELS: Record<string, string>;
export declare const providerLabel: (p: string) => string;
