import { describe, expect, it } from 'vitest';
import { flagBoolean, flagNumber, flagString, parseArgs } from '../src/args.js';

describe('parseArgs', () => {
  it('reads the command', () => {
    expect(parseArgs(['crawl']).command).toBe('crawl');
  });

  it('reads a flag with a separate value', () => {
    expect(flagNumber(parseArgs(['crawl', '--tier', '2']), 'tier')).toBe(2);
  });

  it('reads a flag written with an equals sign', () => {
    expect(flagNumber(parseArgs(['crawl', '--tier=2']), 'tier')).toBe(2);
  });

  it('treats a flag followed by another flag as boolean', () => {
    const args = parseArgs(['crawl', '--auto', '--tier', '2']);
    expect(flagBoolean(args, 'auto')).toBe(true);
    expect(flagNumber(args, 'tier')).toBe(2);
  });

  it('treats a trailing flag as boolean', () => {
    expect(flagBoolean(parseArgs(['crawl', '--dry-run']), 'dry-run')).toBe(true);
  });

  it('accepts an explicit --flag=true', () => {
    expect(flagBoolean(parseArgs(['crawl', '--dry-run=true']), 'dry-run')).toBe(true);
  });

  it('reports an absent boolean flag as false', () => {
    expect(flagBoolean(parseArgs(['crawl']), 'dry-run')).toBe(false);
  });

  it('returns undefined for an absent string flag', () => {
    expect(flagString(parseArgs(['crawl']), 'list-id')).toBeUndefined();
  });

  it('returns undefined for a non-numeric value', () => {
    expect(flagNumber(parseArgs(['crawl', '--tier', 'two']), 'tier')).toBeUndefined();
  });

  it('reads a string flag', () => {
    expect(flagString(parseArgs(['report', '--date', '2026-08-29']), 'date')).toBe('2026-08-29');
  });

  it('collects extra positional arguments', () => {
    expect(parseArgs(['crawl', 'extra', 'more']).positional).toEqual(['extra', 'more']);
  });

  it('returns no command for an empty argv', () => {
    expect(parseArgs([]).command).toBeUndefined();
  });

  it('accepts zero as a shard value rather than treating it as absent', () => {
    expect(flagNumber(parseArgs(['crawl', '--shard', '0']), 'shard')).toBe(0);
  });

  it('does not read a boolean flag as a string', () => {
    expect(flagString(parseArgs(['crawl', '--dry-run']), 'dry-run')).toBeUndefined();
  });
});
