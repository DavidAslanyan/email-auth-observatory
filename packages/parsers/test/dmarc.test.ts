import { describe, expect, it } from 'vitest';
import { parseDmarc } from '../src/dmarc.js';

function value(raw: string) {
  const r = parseDmarc(raw);
  if (!r.ok) throw new Error(`expected parse to succeed, got: ${r.error}`);
  return r.value;
}

function error(raw: string) {
  const r = parseDmarc(raw);
  if (r.ok) throw new Error('expected parse to fail');
  return r.error;
}

describe('parseDmarc — version tag', () => {
  it('accepts the minimal valid record', () => {
    expect(value('v=DMARC1; p=none').p).toBe('none');
  });

  it('rejects a lowercase v=dmarc1 because the version value is case-sensitive', () => {
    expect(error('v=dmarc1; p=none')).toMatch(/invalid version/);
  });

  it('rejects a record whose v tag is not first', () => {
    expect(error('p=reject; v=DMARC1')).toMatch(/not first/);
  });

  it('rejects a record with no v tag', () => {
    expect(error('p=reject')).toMatch(/missing v tag/);
  });

  it('rejects an SPF record handed to it by mistake', () => {
    expect(error('v=spf1 -all')).toMatch(/missing v tag|invalid version/);
  });

  it('rejects an empty string without throwing', () => {
    expect(error('')).toBe('empty record');
  });

  it('rejects a whitespace-only string without throwing', () => {
    expect(error('   \t  ')).toBe('empty record');
  });
});

describe('parseDmarc — policy', () => {
  it('rejects a record with no p tag', () => {
    expect(error('v=DMARC1; rua=mailto:a@b.example')).toMatch(/missing required p tag/);
  });

  it('accepts every valid policy', () => {
    expect(value('v=DMARC1; p=none').p).toBe('none');
    expect(value('v=DMARC1; p=quarantine').p).toBe('quarantine');
    expect(value('v=DMARC1; p=reject').p).toBe('reject');
  });

  it('normalises policy case because tag values here are case-insensitive', () => {
    expect(value('v=DMARC1; p=REJECT').p).toBe('reject');
  });

  it('rejects an unrecognised policy rather than guessing', () => {
    expect(error('v=DMARC1; p=block')).toMatch(/invalid p value/);
  });
});

describe('parseDmarc — subdomain policy', () => {
  it('stores sp as absent when the tag is absent, never copying p into it', () => {
    // RFC 7489 section 6.3 says sp inherits p, but materialising that here would
    // hide the day a domain explicitly publishes sp.
    expect(value('v=DMARC1; p=reject').sp).toBeUndefined();
  });

  it('stores sp when explicitly published', () => {
    expect(value('v=DMARC1; p=reject; sp=none').sp).toBe('none');
  });

  it('rejects an invalid sp value', () => {
    expect(error('v=DMARC1; p=reject; sp=maybe')).toMatch(/invalid sp value/);
  });
});

describe('parseDmarc — pct', () => {
  it('stores pct as absent when the tag is absent', () => {
    expect(value('v=DMARC1; p=reject').pct).toBeUndefined();
  });

  it('records pct=0, a policy declared but applied to nothing', () => {
    expect(value('v=DMARC1; p=reject; pct=0').pct).toBe(0);
  });

  it('records pct=100', () => {
    expect(value('v=DMARC1; p=reject; pct=100').pct).toBe(100);
  });

  it('rejects pct above 100', () => {
    expect(error('v=DMARC1; p=reject; pct=101')).toMatch(/invalid pct/);
  });

  it('rejects a negative pct', () => {
    expect(error('v=DMARC1; p=reject; pct=-1')).toMatch(/invalid pct/);
  });

  it('rejects a fractional pct', () => {
    expect(error('v=DMARC1; p=reject; pct=50.5')).toMatch(/invalid pct/);
  });

  it('rejects a non-numeric pct', () => {
    expect(error('v=DMARC1; p=reject; pct=all')).toMatch(/invalid pct/);
  });
});

describe('parseDmarc — alignment and interval', () => {
  it('stores adkim and aspf when published', () => {
    const v = value('v=DMARC1; p=reject; adkim=s; aspf=s');
    expect(v.adkim).toBe('s');
    expect(v.aspf).toBe('s');
  });

  it('stores relaxed alignment explicitly when published', () => {
    expect(value('v=DMARC1; p=reject; adkim=r').adkim).toBe('r');
  });

  it('normalises alignment case', () => {
    expect(value('v=DMARC1; p=reject; adkim=S').adkim).toBe('s');
  });

  it('leaves alignment absent when not published', () => {
    const v = value('v=DMARC1; p=reject');
    expect(v.adkim).toBeUndefined();
    expect(v.aspf).toBeUndefined();
  });

  it('rejects an invalid adkim value', () => {
    expect(error('v=DMARC1; p=reject; adkim=x')).toMatch(/invalid adkim/);
  });

  it('rejects an invalid aspf value', () => {
    expect(error('v=DMARC1; p=reject; aspf=strict')).toMatch(/invalid aspf/);
  });

  it('stores ri when published', () => {
    expect(value('v=DMARC1; p=reject; ri=3600').ri).toBe(3600);
  });

  it('rejects a non-numeric ri', () => {
    expect(error('v=DMARC1; p=reject; ri=daily')).toMatch(/invalid ri/);
  });
});

describe('parseDmarc — reporting destinations', () => {
  it('counts rua destinations', () => {
    const v = value('v=DMARC1; p=none; rua=mailto:a@x.example,mailto:b@y.example');
    expect(v.ruaCount).toBe(2);
  });

  it('stores only the domain part of rua, never the mailbox', () => {
    const v = value('v=DMARC1; p=none; rua=mailto:john.doe@reports.example');
    expect(v.ruaHosts).toEqual(['reports.example']);
    expect(JSON.stringify(v)).not.toContain('john.doe');
  });

  it('deduplicates rua hosts while still counting every destination', () => {
    const v = value('v=DMARC1; p=none; rua=mailto:a@rep.example,mailto:b@rep.example');
    expect(v.ruaCount).toBe(2);
    expect(v.ruaHosts).toEqual(['rep.example']);
  });

  it('counts ruf destinations without storing their hosts', () => {
    const v = value('v=DMARC1; p=none; ruf=mailto:f@forensic.example');
    expect(v.rufCount).toBe(1);
    expect(JSON.stringify(v)).not.toContain('forensic.example');
  });

  it('reports zero destinations when neither tag is present', () => {
    const v = value('v=DMARC1; p=none');
    expect(v.ruaCount).toBe(0);
    expect(v.rufCount).toBe(0);
    expect(v.ruaHosts).toEqual([]);
  });

  it('counts an unparseable rua destination but stores no host for it', () => {
    const v = value('v=DMARC1; p=none; rua=not-a-uri');
    expect(v.ruaCount).toBe(1);
    expect(v.ruaHosts).toEqual([]);
  });

  it('handles an rua size limit suffix', () => {
    const v = value('v=DMARC1; p=none; rua=mailto:a@rep.example!10m');
    expect(v.ruaHosts).toEqual(['rep.example']);
  });
});

describe('parseDmarc — syntax tolerance', () => {
  it('tolerates whitespace chaos', () => {
    const v = value('v=DMARC1 ;  p = reject ;pct=100');
    expect(v.p).toBe('reject');
    expect(v.pct).toBe(100);
  });

  it('tolerates a trailing semicolon', () => {
    expect(value('v=DMARC1; p=none;').p).toBe('none');
  });

  it('takes the first of a duplicated tag', () => {
    expect(value('v=DMARC1; p=none; p=reject').p).toBe('none');
  });

  it('ignores unknown tags', () => {
    const v = value('v=DMARC1; p=reject; foo=bar; np=none');
    expect(v.p).toBe('reject');
  });

  it('ignores an empty fo tag', () => {
    expect(value('v=DMARC1; p=reject; fo=').fo).toBeUndefined();
  });

  it('stores fo verbatim when published', () => {
    expect(value('v=DMARC1; p=reject; fo=1:d:s').fo).toBe('1:d:s');
  });

  it('parses a fully populated record', () => {
    const v = value(
      'v=DMARC1; p=reject; sp=quarantine; pct=50; adkim=s; aspf=s; fo=1; ri=3600; ' +
        'rua=mailto:agg@rep.example; ruf=mailto:f@rep.example',
    );
    expect(v).toEqual({
      p: 'reject',
      sp: 'quarantine',
      pct: 50,
      adkim: 's',
      aspf: 's',
      fo: '1',
      ri: 3600,
      ruaCount: 1,
      rufCount: 1,
      ruaHosts: ['rep.example'],
    });
  });
});

describe('parseDmarc — numeric overflow', () => {
  it('rejects an ri larger than a safe integer rather than storing a rounded value', () => {
    expect(error('v=DMARC1; p=none; ri=99999999999999999999')).toMatch(/invalid ri/);
  });

  it('rejects a negative ri', () => {
    expect(error('v=DMARC1; p=none; ri=-1')).toMatch(/invalid ri/);
  });
});
