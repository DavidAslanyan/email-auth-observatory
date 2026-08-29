/**
 * Types for the run-schedule script.
 *
 * The script is deliberately plain JavaScript with no imports: the workflow job
 * that decides whether to run at all does a bare checkout, with no install and
 * no build, so it cannot depend on the workspace packages. This declaration
 * gives the tests the same type safety as the rest of the codebase.
 */
export declare function isoWeek(date: Date): { isoYear: number; week: number };
export declare function isQuietDay(date: Date): boolean;
