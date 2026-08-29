/**
 * Minimal argument parsing. A CLI with five commands and eight flags does not
 * need a framework, and every dependency here is one more thing that can break
 * a scheduled crawl at 2am.
 */
export interface ParsedArgs {
  command: string | undefined;
  flags: Map<string, string | boolean>;
  positional: string[];
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  const positional: string[] = [];
  let command: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) continue;

    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        flags.set(body.slice(0, eq), body.slice(eq + 1));
        continue;
      }
      const next = argv[i + 1];
      // A flag followed by another flag is a boolean, not a flag with a value.
      if (next === undefined || next.startsWith('--')) {
        flags.set(body, true);
      } else {
        flags.set(body, next);
        i += 1;
      }
      continue;
    }

    if (command === undefined) command = token;
    else positional.push(token);
  }

  return { command, flags, positional };
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

export function flagNumber(args: ParsedArgs, name: string): number | undefined {
  const raw = flagString(args, name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function flagBoolean(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true || args.flags.get(name) === 'true';
}
