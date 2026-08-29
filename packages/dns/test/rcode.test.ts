/**
 * The four-state rule, plan section 1.1. This is the single most important
 * behaviour in the project: if a resolver failure is ever recorded as absence,
 * one bad morning appears in the time series as thousands of domains dropping
 * DMARC overnight — a fabricated finding in a dataset whose whole premise is
 * that the deltas can be trusted.
 */
import { describe, expect, it } from 'vitest';
import { RCODE_NAMES, isFailure, toLookupStatus } from '../src/rcode.js';

describe('toLookupStatus — genuine presence', () => {
  it('records NOERROR with answers as ok', () => {
    expect(toLookupStatus('NOERROR', 1)).toBe('ok');
  });

  it('records NOERROR with many answers as ok', () => {
    expect(toLookupStatus('NOERROR', 12)).toBe('ok');
  });
});

describe('toLookupStatus — genuine absence', () => {
  it('records NOERROR with zero answers as nodata, meaning the name exists but the record does not', () => {
    expect(toLookupStatus('NOERROR', 0)).toBe('nodata');
  });

  it('records NXDOMAIN as nxdomain, meaning the name itself does not exist', () => {
    expect(toLookupStatus('NXDOMAIN', 0)).toBe('nxdomain');
  });

  it('keeps nodata and nxdomain distinct rather than merging them into "absent"', () => {
    expect(toLookupStatus('NOERROR', 0)).not.toBe(toLookupStatus('NXDOMAIN', 0));
  });
});

describe('toLookupStatus — our failure, never theirs', () => {
  it('records SERVFAIL as unknown, not absent', () => {
    expect(toLookupStatus('SERVFAIL', 0)).toBe('unknown');
  });

  it('records REFUSED as unknown, not absent', () => {
    expect(toLookupStatus('REFUSED', 0)).toBe('unknown');
  });

  it('records NOTIMP as unknown, not absent', () => {
    expect(toLookupStatus('NOTIMP', 0)).toBe('unknown');
  });

  it('records a timeout as unknown, not absent', () => {
    expect(toLookupStatus('TIMEOUT', 0)).toBe('unknown');
  });

  it('records a network error as unknown, not absent', () => {
    expect(toLookupStatus('NETWORK_ERROR', 0)).toBe('unknown');
  });

  it('records FORMERR as unknown', () => {
    expect(toLookupStatus('FORMERR', 0)).toBe('unknown');
  });

  it('records an unrecognised rcode as unknown rather than assuming absence', () => {
    expect(toLookupStatus('SOMETHING_NEW', 0)).toBe('unknown');
  });

  it('records an empty rcode as unknown', () => {
    expect(toLookupStatus('', 0)).toBe('unknown');
  });

  it('never returns nodata for any failure rcode, however many answers are claimed', () => {
    // A SERVFAIL carrying a nonzero answer count is nonsense; it must still not
    // be read as data.
    for (const rcode of ['SERVFAIL', 'REFUSED', 'NOTIMP', 'TIMEOUT', 'NETWORK_ERROR']) {
      expect(toLookupStatus(rcode, 5)).toBe('unknown');
      expect(toLookupStatus(rcode, 0)).toBe('unknown');
    }
  });
});

describe('toLookupStatus — exhaustiveness', () => {
  it('maps every rcode this project can observe to a defined status', () => {
    for (const name of Object.values(RCODE_NAMES)) {
      expect(['ok', 'nodata', 'nxdomain', 'unknown']).toContain(toLookupStatus(name, 0));
    }
  });

  it('is case-sensitive by design, since rcode names are produced internally', () => {
    expect(toLookupStatus('servfail', 0)).toBe('unknown');
  });
});

describe('RCODE_NAMES', () => {
  it('maps the numeric rcodes that appear on the wire', () => {
    expect(RCODE_NAMES[0]).toBe('NOERROR');
    expect(RCODE_NAMES[1]).toBe('FORMERR');
    expect(RCODE_NAMES[2]).toBe('SERVFAIL');
    expect(RCODE_NAMES[3]).toBe('NXDOMAIN');
    expect(RCODE_NAMES[4]).toBe('NOTIMP');
    expect(RCODE_NAMES[5]).toBe('REFUSED');
  });
});

describe('isFailure', () => {
  it('treats only unknown as a failure worth retrying at the next tier', () => {
    expect(isFailure('unknown')).toBe(true);
    expect(isFailure('ok')).toBe(false);
    expect(isFailure('nodata')).toBe(false);
    expect(isFailure('nxdomain')).toBe(false);
  });

  it('does not retry a nodata answer, which is a real observation', () => {
    // Escalating a legitimate NODATA to the DoH tier would waste the fallback
    // budget on ~40% of all lookups.
    expect(isFailure('nodata')).toBe(false);
  });
});
