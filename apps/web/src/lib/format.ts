import type { ChangeEvent } from './types.js';

/** Strength on the ordinal enforcement ramp. Absence is off-ramp on purpose. */
export type Strength = 'strong' | 'mid' | 'weak' | 'absent';

const STRENGTH: Record<string, Strength> = {
  reject: 'strong',
  quarantine: 'mid',
  none: 'weak',
  '-all': 'strong',
  '~all': 'mid',
  '?all': 'weak',
  '+all': 'weak',
  enforce: 'strong',
  testing: 'mid',
  signed: 'strong',
  unsigned: 'absent',
};

export function strengthOf(value: string | null | undefined): Strength {
  if (value === null || value === undefined) return 'absent';
  return STRENGTH[value] ?? 'absent';
}

export const STRENGTH_VAR: Record<Strength, string> = {
  strong: 'var(--enforce-strong)',
  mid: 'var(--enforce-mid)',
  weak: 'var(--enforce-weak)',
  absent: 'var(--absent)',
};

/**
 * Ink chosen for contrast against each ramp step. These resolve to CSS custom
 * properties that flip with the theme, because the ramp itself inverts in dark
 * mode — the strongest step is the darkest on light and the lightest on dark.
 */
export const STRENGTH_INK: Record<Strength, string> = {
  strong: 'ink-strong',
  mid: 'ink-mid',
  weak: 'ink-weak',
  absent: 'ink-absent',
};

/** `-` is how the record stores it; `-all` is how an engineer reads it. */
export function qualifierToken(qualifier: string | null): string | null {
  return qualifier === null ? null : `${qualifier}all`;
}

const QUALIFIER_MEANING: Record<string, string> = {
  '-all': 'hard fail — receivers should reject unlisted senders',
  '~all': 'soft fail — receivers should accept but mark unlisted senders',
  '?all': 'neutral — the record expresses no opinion',
  '+all': 'pass all — anyone may send as this domain',
};

export const qualifierMeaning = (token: string): string =>
  QUALIFIER_MEANING[token] ?? 'no all mechanism';

/** Names people recognise, not the paths the system stores. */
const FIELD_LABELS: Record<string, string> = {
  'dmarc.p': 'DMARC policy',
  'dmarc.sp': 'Subdomain policy',
  'dmarc.pct': 'Sampling rate',
  'dmarc.present': 'DMARC',
  'dmarc.adkim': 'DKIM alignment',
  'dmarc.aspf': 'SPF alignment',
  'spf.allQualifier': 'SPF enforcement',
  'spf.present': 'SPF',
  'spf.exceedsLookupLimit': 'SPF lookup limit',
  'mtaSts.mode': 'MTA-STS mode',
  'mtaSts.present': 'MTA-STS',
  'bimi.present': 'BIMI',
  'bimi.hasLogo': 'BIMI logo',
  'bimi.hasVmc': 'Verified mark',
  'tlsRpt.present': 'TLS reporting',
  'mx.provider': 'Mail provider',
  'mx.isNullMx': 'Null MX',
  dnssec: 'DNSSEC',
  domain: 'Domain',
};

export const fieldLabel = (field: string): string => FIELD_LABELS[field] ?? field;

export function valueLabel(v: ChangeEvent['from']): string {
  if (v === null) return 'none';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v);
}

const POLICY_RANK: Record<string, number> = { none: 0, quarantine: 1, reject: 2 };
const QUALIFIER_RANK: Record<string, number> = { '+all': 0, '?all': 1, '~all': 2, '-all': 3 };
const MODE_RANK: Record<string, number> = { none: 0, testing: 1, enforce: 2 };

const SCALES: Record<string, Record<string, number>> = {
  'dmarc.p': POLICY_RANK,
  'dmarc.sp': POLICY_RANK,
  'spf.allQualifier': QUALIFIER_RANK,
  'mtaSts.mode': MODE_RANK,
};

export type Direction = 'strengthening' | 'weakening' | 'neutral';

/** Mirrors the store's classifier so the table and the report agree. */
export function directionOf(event: ChangeEvent): Direction {
  const scale = SCALES[event.field];
  if (scale) {
    const from = typeof event.from === 'string' ? scale[event.from] : undefined;
    const to = typeof event.to === 'string' ? scale[event.to] : undefined;
    if (from === undefined || to === undefined) {
      if (to !== undefined) return 'strengthening';
      if (from !== undefined) return 'weakening';
      return 'neutral';
    }
    return to > from ? 'strengthening' : to < from ? 'weakening' : 'neutral';
  }

  if (event.field.endsWith('.present') || event.field === 'bimi.hasVmc') {
    if (event.to === true) return 'strengthening';
    if (event.to === false) return 'weakening';
  }
  if (event.field === 'spf.exceedsLookupLimit') {
    return event.to === true ? 'weakening' : 'strengthening';
  }
  if (event.field === 'dmarc.pct') {
    const from = typeof event.from === 'number' ? event.from : 0;
    const to = typeof event.to === 'number' ? event.to : 0;
    return to > from ? 'strengthening' : to < from ? 'weakening' : 'neutral';
  }
  return 'neutral';
}

export const DIRECTION_GLYPH: Record<Direction, string> = {
  strengthening: '▲',
  weakening: '▼',
  neutral: '•',
};

const nf = new Intl.NumberFormat('en');
export const num = (n: number): string => nf.format(n);

export function share(part: number, whole: number): string {
  if (whole === 0) return '—';
  return `${((part / whole) * 100).toFixed(1)}%`;
}

export const PROVIDER_LABELS: Record<string, string> = {
  'null-mx': 'Null MX',
  none: 'No MX',
  'self-hosted': 'Self-hosted',
  'amazon-ses': 'Amazon SES',
};

export const providerLabel = (p: string): string =>
  PROVIDER_LABELS[p] ?? p.charAt(0).toUpperCase() + p.slice(1);
