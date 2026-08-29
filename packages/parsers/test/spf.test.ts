import { describe, expect, it } from 'vitest';
import { parseSpf } from '../src/spf.js';

function value(raw: string) {
  const r = parseSpf(raw);
  if (!r.ok) throw new Error(`expected parse to succeed, got: ${r.error}`);
  return r.value;
}

function error(raw: string) {
  const r = parseSpf(raw);
  if (r.ok) throw new Error('expected parse to fail');
  return r.error;
}

describe('parseSpf — version term', () => {
  it('accepts a bare version term', () => {
    const v = value('v=spf1');
    expect(v.lookupCount).toBe(0);
    expect(v.allQualifier).toBeUndefined();
  });

  it('accepts an uppercase version term because it is case-insensitive', () => {
    expect(value('V=SPF1 -all').allQualifier).toBe('-');
  });

  it('rejects a record with no version term', () => {
    expect(error('-all')).toMatch(/missing v=spf1/);
  });

  it('rejects a record where the version term is not first', () => {
    expect(error('-all v=spf1')).toMatch(/missing v=spf1/);
  });

  it('rejects a DMARC record handed to it by mistake', () => {
    expect(error('v=DMARC1; p=none')).toMatch(/missing v=spf1/);
  });

  it('rejects an empty string without throwing', () => {
    expect(error('')).toBe('empty record');
  });

  it('rejects a whitespace-only string without throwing', () => {
    expect(error('  \t ')).toBe('empty record');
  });
});

describe('parseSpf — all qualifier', () => {
  it('reads a hard fail', () => {
    expect(value('v=spf1 -all').allQualifier).toBe('-');
  });

  it('reads a soft fail', () => {
    expect(value('v=spf1 ~all').allQualifier).toBe('~');
  });

  it('reads a neutral result', () => {
    expect(value('v=spf1 ?all').allQualifier).toBe('?');
  });

  it('reads an explicit pass-all', () => {
    expect(value('v=spf1 +all').allQualifier).toBe('+');
  });

  it('treats a bare all as pass, since an absent qualifier means +', () => {
    expect(value('v=spf1 all').allQualifier).toBe('+');
  });

  it('leaves the qualifier absent when there is no all mechanism', () => {
    expect(
      value('v=spf1 include:_spf.example redirect=other.example').allQualifier,
    ).toBeUndefined();
  });

  it('takes the final all when a broken record publishes two', () => {
    expect(value('v=spf1 ~all -all').allQualifier).toBe('-');
  });

  it('is case-insensitive about the mechanism name', () => {
    expect(value('v=spf1 -ALL').allQualifier).toBe('-');
  });
});

describe('parseSpf — lookup counting', () => {
  it('counts include, a, mx, ptr and exists', () => {
    const v = value('v=spf1 include:a.example a mx ptr exists:%{i}.e.example -all');
    expect(v.lookupCount).toBe(5);
  });

  it('does not count ip4 or ip6', () => {
    expect(value('v=spf1 ip4:192.0.2.0/24 ip6:2001:db8::/32 -all').lookupCount).toBe(0);
  });

  it('does not count exp, per RFC 7208 section 4.6.4', () => {
    expect(value('v=spf1 exp=explain.example -all').lookupCount).toBe(0);
  });

  it('counts redirect as a lookup', () => {
    const v = value('v=spf1 redirect=other.example');
    expect(v.lookupCount).toBe(1);
    expect(v.hasRedirect).toBe(true);
  });

  it('reports hasRedirect false when no redirect modifier is present', () => {
    expect(value('v=spf1 -all').hasRedirect).toBe(false);
  });

  it('counts a mechanism with a domain argument once', () => {
    expect(value('v=spf1 a:mail.example mx:mail.example -all').lookupCount).toBe(2);
  });

  it('counts a mechanism with a CIDR suffix once', () => {
    expect(value('v=spf1 a/24 mx/24 -all').lookupCount).toBe(2);
  });

  it('does not flag a record at exactly the ten lookup limit', () => {
    const record = `v=spf1 ${'include:x.example '.repeat(10)}-all`;
    const v = value(record);
    expect(v.lookupCount).toBe(10);
    expect(v.exceedsLookupLimit).toBe(false);
  });

  it('flags a record that exceeds the ten lookup limit', () => {
    const record = `v=spf1 ${'include:x.example '.repeat(11)}-all`;
    const v = value(record);
    expect(v.lookupCount).toBe(11);
    expect(v.exceedsLookupLimit).toBe(true);
  });
});

describe('parseSpf — includes', () => {
  it('records include domains in order', () => {
    const v = value('v=spf1 include:_spf.google.com include:sendgrid.net -all');
    expect(v.includes).toEqual(['_spf.google.com', 'sendgrid.net']);
  });

  it('lowercases include domains so the diff is not case-noisy', () => {
    expect(value('v=spf1 include:SPF.Example -all').includes).toEqual(['spf.example']);
  });

  it('keeps a repeated include, because the duplication is itself the finding', () => {
    const v = value('v=spf1 include:a.example include:a.example -all');
    expect(v.includes).toEqual(['a.example', 'a.example']);
    expect(v.lookupCount).toBe(2);
  });

  it('counts a malformed include with no domain but records no domain for it', () => {
    const v = value('v=spf1 include -all');
    expect(v.lookupCount).toBe(1);
    expect(v.includes).toEqual([]);
  });

  it('returns an empty include list when there are none', () => {
    expect(value('v=spf1 ip4:192.0.2.1 -all').includes).toEqual([]);
  });
});

describe('parseSpf — syntax tolerance', () => {
  it('tolerates runs of whitespace between terms', () => {
    const v = value('v=spf1    include:a.example \t  -all');
    expect(v.lookupCount).toBe(1);
    expect(v.allQualifier).toBe('-');
  });

  it('tolerates leading and trailing whitespace', () => {
    expect(value('  v=spf1 -all  ').allQualifier).toBe('-');
  });

  it('ignores an unknown mechanism rather than failing', () => {
    const v = value('v=spf1 frobnicate:x -all');
    expect(v.allQualifier).toBe('-');
    expect(v.lookupCount).toBe(0);
  });

  it('ignores an unknown modifier rather than failing', () => {
    expect(value('v=spf1 ra=postmaster -all').lookupCount).toBe(0);
  });

  it('parses a long real-world-shaped record', () => {
    const v = value(
      'v=spf1 ip4:192.0.2.0/24 ip4:198.51.100.0/24 include:_spf.google.com ' +
        'include:servers.mcsv.net include:spf.protection.outlook.com a:mail.example ' +
        'mx ~all',
    );
    expect(v.lookupCount).toBe(5);
    expect(v.exceedsLookupLimit).toBe(false);
    expect(v.allQualifier).toBe('~');
    expect(v.includes).toHaveLength(3);
  });
});

describe('parseSpf — term shapes that are neither mechanism nor modifier', () => {
  it('ignores a token that is only a qualifier', () => {
    expect(value('v=spf1 - -all').allQualifier).toBe('-');
  });

  it('ignores a token starting with a digit, which no mechanism may', () => {
    expect(value('v=spf1 4all -all').lookupCount).toBe(0);
  });

  it('ignores a bare equals sign', () => {
    expect(value('v=spf1 = -all').allQualifier).toBe('-');
  });

  it('ignores a modifier whose name is not a legal modifier name', () => {
    expect(value('v=spf1 1bad=x -all').lookupCount).toBe(0);
  });

  it('treats a qualified term containing = as a mechanism, not a modifier', () => {
    // `+redirect=x` has a qualifier, so it is a (bogus) mechanism and must not
    // be counted as a redirect modifier.
    const v = value('v=spf1 +redirect=other.example -all');
    expect(v.hasRedirect).toBe(false);
  });

  it('counts a qualified lookup mechanism', () => {
    expect(value('v=spf1 ?include:a.example -all').lookupCount).toBe(1);
  });

  it('ignores a repeated version term appearing mid-record', () => {
    expect(value('v=spf1 v=spf1 -all').lookupCount).toBe(0);
  });

  it('ignores an unknown modifier with a dotted name', () => {
    expect(value('v=spf1 my.mod=value -all').lookupCount).toBe(0);
  });
});
