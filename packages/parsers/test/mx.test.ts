import { describe, expect, it } from 'vitest';
import { classifyHost, parseMx } from '../src/mx.js';

describe('parseMx — normalisation', () => {
  it('lowercases hosts and strips the trailing dot', () => {
    const v = parseMx([{ preference: 10, exchange: 'ASPMX.L.GOOGLE.COM.' }]);
    expect(v.hosts).toEqual(['aspmx.l.google.com']);
  });

  it('sorts by preference', () => {
    const v = parseMx([
      { preference: 20, exchange: 'b.example' },
      { preference: 10, exchange: 'a.example' },
    ]);
    expect(v.hosts).toEqual(['a.example', 'b.example']);
  });

  it('breaks a preference tie by name so the snapshot is stable', () => {
    const v = parseMx([
      { preference: 10, exchange: 'z.example' },
      { preference: 10, exchange: 'a.example' },
    ]);
    expect(v.hosts).toEqual(['a.example', 'z.example']);
  });

  it('drops a host that normalises to nothing when others remain', () => {
    const v = parseMx([
      { preference: 10, exchange: 'a.example' },
      { preference: 20, exchange: '.' },
    ]);
    expect(v.hosts).toEqual(['a.example']);
    expect(v.isNullMx).toBe(false);
  });

  it('strips repeated trailing dots', () => {
    expect(parseMx([{ preference: 10, exchange: 'a.example..' }]).hosts).toEqual(['a.example']);
  });

  it('trims surrounding whitespace', () => {
    expect(parseMx([{ preference: 10, exchange: '  a.example  ' }]).hosts).toEqual(['a.example']);
  });
});

describe('parseMx — null MX', () => {
  it('recognises a single dot exchange as an explicit null MX', () => {
    // RFC 7505. This is a correct configuration, not a missing MX.
    const v = parseMx([{ preference: 0, exchange: '.' }]);
    expect(v.isNullMx).toBe(true);
    expect(v.hosts).toEqual([]);
  });

  it('recognises a null MX published with a non-zero preference', () => {
    expect(parseMx([{ preference: 10, exchange: '.' }]).isNullMx).toBe(true);
  });

  it('assigns no provider to a null MX, because there is no provider', () => {
    expect(parseMx([{ preference: 0, exchange: '.' }]).provider).toBeUndefined();
  });

  it('does not treat an absent MX set as a null MX', () => {
    const v = parseMx([]);
    expect(v.isNullMx).toBe(false);
    expect(v.hosts).toEqual([]);
    expect(v.provider).toBeUndefined();
  });

  it('does not treat a dot alongside a real host as a null MX', () => {
    const v = parseMx([
      { preference: 0, exchange: '.' },
      { preference: 10, exchange: 'a.example' },
    ]);
    expect(v.isNullMx).toBe(false);
  });
});

describe('classifyHost — longest-suffix match', () => {
  it('matches an exact suffix entry', () => {
    expect(classifyHost('aspmx.l.google.com')).toBe('google');
  });

  it('matches a subdomain of a suffix entry', () => {
    expect(classifyHost('alt1.aspmx.l.google.com')).toBe('google');
  });

  it('prefers the longer of two overlapping suffixes', () => {
    // Both `outlook.com` and `mail.protection.outlook.com` are in the table.
    expect(classifyHost('example-com.mail.protection.outlook.com')).toBe('microsoft');
  });

  it('does not match a suffix that is only a substring of the host', () => {
    expect(classifyHost('notgoogle.com')).toBeUndefined();
  });

  it('returns undefined for an unrecognised host', () => {
    expect(classifyHost('mail.some-university.edu')).toBeUndefined();
  });
});

describe('parseMx — provider classification', () => {
  it('classifies a Google-hosted domain', () => {
    const v = parseMx([
      { preference: 1, exchange: 'aspmx.l.google.com.' },
      { preference: 5, exchange: 'alt1.aspmx.l.google.com.' },
    ]);
    expect(v.provider).toBe('google');
  });

  it('classifies a Microsoft-hosted domain', () => {
    const v = parseMx([{ preference: 0, exchange: 'example-com.mail.protection.outlook.com.' }]);
    expect(v.provider).toBe('microsoft');
  });

  it('reports self-hosted when hosts are present but match nothing known', () => {
    const v = parseMx([{ preference: 10, exchange: 'mx1.some-university.edu' }]);
    expect(v.provider).toBe('self-hosted');
  });

  it('keeps a known provider when a self-run backup MX sits alongside it', () => {
    const v = parseMx([
      { preference: 1, exchange: 'aspmx.l.google.com' },
      { preference: 50, exchange: 'backup.selfrun.example' },
    ]);
    expect(v.provider).toBe('google');
  });

  it('picks the majority provider in a mixed set', () => {
    const v = parseMx([
      { preference: 1, exchange: 'mx1.pphosted.com' },
      { preference: 5, exchange: 'mx2.pphosted.com' },
      { preference: 10, exchange: 'aspmx.l.google.com' },
    ]);
    expect(v.provider).toBe('proofpoint');
  });

  it('breaks a provider tie with the lowest-preference host', () => {
    const v = parseMx([
      { preference: 1, exchange: 'mx.mimecast.com' },
      { preference: 10, exchange: 'aspmx.l.google.com' },
    ]);
    expect(v.provider).toBe('mimecast');
  });
});

describe('parseMx — provider majority beats first match', () => {
  it('prefers the majority provider over the lowest-preference one', () => {
    // mimecast appears first but google appears twice, so google wins.
    const v = parseMx([
      { preference: 1, exchange: 'mx.mimecast.com' },
      { preference: 10, exchange: 'aspmx.l.google.com' },
      { preference: 20, exchange: 'alt1.aspmx.l.google.com' },
    ]);
    expect(v.provider).toBe('google');
  });
});
