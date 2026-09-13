/**
 * Types for the pipeline's daily plan.
 *
 * The script is deliberately plain JavaScript with no imports: the job that
 * decides whether to run at all does a bare checkout, with no install and no
 * build, so it cannot depend on the workspace packages.
 */
export interface DayPlan {
  date: string;
  intensity: string;
  tier1: number[];
  tier2: number[];
  report: boolean;
}
export declare const TIER1_SLOTS: number;
export declare const TIER2_SLOTS: number;
export declare function isoWeek(date: Date): { isoYear: number; week: number };
export declare function restDaysOfWeek(date: Date): number[];
export declare function isRestDay(date: Date): boolean;
export declare function planFor(date: Date): DayPlan;
export declare function tier2ShardFor(date: Date, slot: number, shards?: number): number;
export declare function shouldRun(date: Date, kind: string, slot: number): boolean;
export declare function expectedCommits(date: Date): number;
