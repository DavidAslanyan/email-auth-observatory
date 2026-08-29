# Schema

Field-by-field dictionary for everything under `data/`. Every file is
newline-delimited JSON except `data/aggregates/latest.json`.

All schemas are enforced at read time by zod; the definitions live in
`packages/core/src/schemas.ts` and are the authority if this document and the
code ever disagree.

## Layout

```
data/
├── tranco/
│   ├── list-id.txt          the pinned Tranco list ID, one line
│   ├── domains.csv.gz       rank,domain for ranks 1..100000, gzipped
│   └── rollovers.jsonl      one line per list rollover
├── snapshots/latest/
│   ├── tier1.jsonl          ranks 1-1000, one DomainSnapshot per line
│   ├── tier1.meta.json      run timestamp, list id, resolver for that shard
│   └── tier2-shard-{0..27}.jsonl  (+ matching .meta.json)
├── changes/
│   └── YYYY-MM-DD.jsonl     one ChangeEvent per line
└── aggregates/
    ├── latest.json          one Aggregate object
    └── history.jsonl        one AggregateHistoryEntry per day
```

Snapshot files are **sorted by domain** and overwritten in place. They are not
versioned per-day: the git history is the time series, and `data/changes/` is
the index into it.

### Why some fields are in a sidecar

Each shard has a `<shard>.meta.json` holding
`{ shard, crawledAt, domains, listId, resolver }`, and the records omit what it
already says.

A shard is written by exactly one crawl, so the run timestamp describes the
file, not each of its lines. Repeating it per record changed **every** line on
every crawl — measured at 949 of 1,000 lines rewritten for 51 real changes —
which defeats git's delta compression just as thoroughly as an unsorted file
does, and the git history *is* the dataset, so that cost compounds forever.
With the timestamp in the sidecar, two consecutive crawls of unchanged domains
produce a byte-identical file.

The same argument applies to values that are identical on essentially every
record. Measured on a real 20.6 MB shard, `resolver` repeated six times per
domain cost 2.37 MB, `rcode` a further 1.8 MB, and `listId` 0.23 MB — a fifth of
the file restating three facts 14,131 times. So:

- `listId` and `resolver` live in the sidecar; a record carries them only when
  it differs from the run (a lookup that fell through to another resolver tier).
- `rcode` is omitted when `status` is `ok`, because it is `NOERROR` by
  definition then. **Any other rcode is always stored** — `SERVFAIL` is
  precisely the thing that must survive, since it is *why* a value is unknown.
- `ad` is omitted when false.

Together this is 21% off every shard, and off every future diff.

This is a storage encoding only. Readers get all of it back on every record, so
anything consuming `DomainSnapshot` sees the shape documented below. If you are
parsing the JSONL directly, read the sidecar first. Records that were carried
forward still carry their own `lastSeenAt`, which is the per-record timing that
actually matters.

Per-lookup latency is deliberately not stored for the same reason; it appears
as median and p95 in each run's summary instead.

## Shared: `LookupMeta`

Every record state embeds these fields.

| Field | Type | Meaning |
| --- | --- | --- |
| `status` | `ok` \| `nodata` \| `nxdomain` \| `unknown` | See [the four-state rule](METHODOLOGY.md#the-four-state-rule). `unknown` means *we* failed. |
| `rcode` | string | `NOERROR`, `NXDOMAIN`, `SERVFAIL`, `REFUSED`, `TIMEOUT`, `NETWORK_ERROR`, … |
| `resolver` | `local` \| `doh-cloudflare` \| `doh-google` | Which tier answered. |
| `ad` | boolean | DNSSEC Authenticated Data flag. |
| `stale` | boolean? | Present and `true` when this value was carried forward because the lookup returned `unknown`. |
| `lastSeenAt` | string? | ISO 8601 timestamp of the last **successful** observation. Only present when `stale`. |

**Filter on `stale !== true` if you want only directly-observed values.**

## `DomainSnapshot`

One per line in `data/snapshots/latest/*.jsonl`.

| Field | Type | Meaning |
| --- | --- | --- |
| `domain` | string | Lowercased apex domain. |
| `rank` | number | Tranco rank in the pinned list. |
| `listId` | string | The pinned Tranco list ID this was crawled against. |
| `crawledAt` | string | ISO 8601 UTC. Stored once per shard in the sidecar, not on each line — see above. |
| `dnssec` | `signed` \| `unsigned` \| `unknown` | `signed` if any response carried AD. `unknown` only when every lookup failed. |

### `spf`

| Field | Type | Meaning |
| --- | --- | --- |
| `present` | boolean | At least one `v=spf1` TXT record exists. |
| `raw` | string? | The record as published. |
| `multipleRecords` | boolean | More than one `v=spf1` record — a misconfiguration (RFC 7208 §4.5), recorded rather than hidden. |
| `recordCount` | number | How many `v=spf1` records were found. |
| `allQualifier` | `+` \| `-` \| `~` \| `?` ? | Qualifier on the final `all`. Absent when the record has no `all`. `+all` means anyone may send as this domain. |
| `lookupCount` | number? | Count of DNS-lookup-requiring terms **in this record**. Not recursive — see [limitations](METHODOLOGY.md#spf-lookup-counts-are-static-not-recursive). |
| `exceedsLookupLimit` | boolean? | `lookupCount > 10`. Under-reports, by the same limitation. |
| `hasRedirect` | boolean | A `redirect=` modifier is present. |
| `includes` | string[] | Domains named by `include:`, in record order. Reveals third-party sender ecosystems. |
| `parseError` | string? | Why the record did not parse. |

### `dmarc`

Optional tags are stored **exactly as published**. Absent means the tag was not
there, never "the default applied" — otherwise the day a domain explicitly
writes `pct=100` would be invisible.

| Field | Type | Meaning |
| --- | --- | --- |
| `present` | boolean | A `v=DMARC1` record exists at `_dmarc`. |
| `raw` | string? | The record, with mailbox names redacted. |
| `multipleRecords` | boolean | More than one DMARC record. |
| `p` | `none` \| `quarantine` \| `reject` ? | Published policy. |
| `sp` | same ? | Subdomain policy. **Absent means absent**; RFC 7489 §6.3 says it inherits `p`, but that is the reader's job, not the dataset's. |
| `pct` | number? | 0–100. Absent means the RFC default of 100. |
| `adkim` / `aspf` | `r` \| `s` ? | Alignment mode. Absent means the default, `r`. |
| `fo` | string? | Failure reporting options, verbatim. |
| `ri` | number? | Aggregate report interval in seconds. Absent means 86400. |
| `ruaCount` / `rufCount` | number | Number of reporting destinations. |
| `ruaHosts` | string[] | **Domains only**, deduplicated and sorted. Mailbox names are never stored. |
| `parseError` | string? | Why the record did not parse. |

### `bimi`

| Field | Type | Meaning |
| --- | --- | --- |
| `present` | boolean | A `v=BIMI1` record exists at `default._bimi`. |
| `raw` | string? | The record as published. |
| `hasLogo` | boolean | `l=` present and non-empty. |
| `hasVmc` | boolean | `a=` present and non-empty: a Verified Mark Certificate is published. |
| `declined` | boolean | `l=` present but **empty** — an explicit opt-out, which is a different fact from having no BIMI record. |

### `mtaSts`

| Field | Type | Meaning |
| --- | --- | --- |
| `present` | boolean | A `v=STSv1` TXT record exists at `_mta-sts`. |
| `policyId` | string? | The `id=` value. Changes whenever the policy is republished. |
| `policyFetched` | boolean | The HTTPS policy file was fetched and parsed. |
| `mode` | `enforce` \| `testing` \| `none` ? | From the policy file. **The interesting field**: `testing` means published but not enforced, and `testing → enforce` is exactly the transition worth watching. |
| `maxAge` | number? | Policy lifetime in seconds. |
| `mxPatternCount` | number? | How many `mx:` patterns the policy lists. |
| `policyError` | string? | Why the policy could not be fetched or parsed. A record with `present: true` and `policyFetched: false` is published but unreadable. |

### `tlsRpt`

| Field | Type | Meaning |
| --- | --- | --- |
| `present` | boolean | A `v=TLSRPTv1` record exists at `_smtp._tls`. |
| `raw` | string? | The record, with mailbox names redacted. |
| `ruaCount` | number | Number of reporting destinations. |
| `ruaHosts` | string[] | Domains only. |

### `mx`

| Field | Type | Meaning |
| --- | --- | --- |
| `present` | boolean | At least one MX record exists. |
| `hosts` | string[] | Lowercased, trailing dot stripped, sorted by preference then name. Empty for a null MX. |
| `provider` | string? | Longest-suffix match against the known-provider table; `self-hosted` when hosts exist but match nothing known. Absent for a null MX or no MX. |
| `isNullMx` | boolean | RFC 7505: a single `.` exchange, meaning the domain deliberately receives no mail. **This is a correct configuration, not a missing MX.** Do not count it as absence. |

### `dkim`

| Field | Type | Meaning |
| --- | --- | --- |
| `status` | LookupStatus | `unknown` only when every selector probe failed. |
| `selectorsFound` | string[] | Selectors that answered. **A lower bound, always.** |
| `selectorsProbed` | string[] | Which selectors were tried. |
| `probeStrategy` | `mx-conditional` \| `generic-fallback` \| `skipped` \| `cached` | `mx-conditional` used the provider's known selectors. `skipped` means either the provider generates per-identity selectors that cannot be guessed, or the domain publishes no MX, SPF or DMARC and so sends no mail. `cached` means the selectors were carried forward — see `probedAt`. |
| `probedAt` | string? | When the selectors were last actually queried. DKIM probing was 57% of every query the crawl made, and selectors rotate on the order of months, so they are re-probed every 60 days, on first sighting, or when the mail provider changes — the event that would actually change them. |

There is deliberately **no `hasDkim` field.** See
[limitations](METHODOLOGY.md#dkim-findings-are-a-lower-bound-always).

## `ChangeEvent`

One per line in `data/changes/YYYY-MM-DD.jsonl`.

| Field | Type | Meaning |
| --- | --- | --- |
| `domain` | string | |
| `rank` | number | Rank at the time of observation. |
| `field` | string | Dotted path, e.g. `dmarc.p`, `mtaSts.mode`. |
| `kind` | `added` \| `removed` \| `modified` \| `first_seen` | |
| `from` / `to` | string \| number \| boolean \| null | `null` means the field was absent on that side. |
| `ts` | string | ISO 8601 — when the change was **observed**, not when it happened. |
| `mxProvider` | string? | Added by the report generator for clustering. Not written by the differ. |

**A `first_seen` event is emitted alone**, with `field: "domain"`. A domain
entering the dataset produces no per-field `added` events, so a Tranco rollover
does not read as thousands of simultaneous adoptions.

### Tracked fields

Only these produce change events:

```
spf.present, spf.allQualifier, spf.exceedsLookupLimit
dmarc.present, dmarc.p, dmarc.sp, dmarc.pct, dmarc.adkim, dmarc.aspf
bimi.present, bimi.hasLogo, bimi.hasVmc
mtaSts.present, mtaSts.mode
tlsRpt.present
mx.provider, mx.isNullMx
dnssec
```

`spf.raw`, `dmarc.ruaHosts`, `mx.hosts`, `dkim.selectorsFound` and
`mtaSts.policyId` are stored in snapshots but deliberately **not** diffed: they
churn constantly and would bury the signal.

**No change event is ever emitted when either side has `status: "unknown"`.**

## `Aggregate`

`data/aggregates/latest.json`, one object.

| Field | Type | Meaning |
| --- | --- | --- |
| `date` | string | `YYYY-MM-DD`, UTC. |
| `listId` | string | The pinned Tranco list. |
| `domainsObserved` | number | Domains across **all** shards, not just today's. |
| `unknownRate` | number | Share of the dataset that is carried-forward rather than freshly observed. |
| `degraded` | boolean | `unknownRate` exceeded 2%. Treat that day's deltas with suspicion. |
| `totals` | AggregateTotals | Counts across the whole dataset. |
| `byTld` | map | Same shape, keyed by last DNS label. |
| `byMxProvider` | map | Same shape, keyed by provider; `null-mx` and `none` are their own keys. |
| `byRankBucket` | map | Keyed `1-1000`, `1001-10000`, `10001-100000`. |

### `AggregateTotals`

```jsonc
{
  "spf":    { "present": 764, "allQualifier": { "-all": 436, "~all": 274, "?all": 19 },
              "exceedsLookupLimit": 0 },
  "dmarc":  { "present": 724, "p": { "none": 120, "quarantine": 164, "reject": 439 },
              "pctBelow100": 10 },
  "bimi":   { "present": 163, "hasVmc": 123, "declined": 2 },
  "mtaSts": { "present": 32, "mode": { "enforce": 19, "testing": 12 } },
  "tlsRpt": { "present": 42 },
  "dnssec": { "signed": 106, "unsigned": 893, "unknown": 1 },
  "mx":     { "present": 700, "isNullMx": 9 }
}
```

Note `mtaSts.present` can exceed the sum of `mtaSts.mode`: a domain publishing
the TXT record whose policy file could not be fetched is counted as present with
no mode.

`data/aggregates/history.jsonl` holds one of these per day with `byTld` and
`byMxProvider` removed, so the whole time series is a single small fetch.

## `RolloverEntry`

One per line in `data/tranco/rollovers.jsonl`.

| Field | Type | Meaning |
| --- | --- | --- |
| `ts` | string | ISO 8601. |
| `fromListId` | string \| null | `null` on the first pin. |
| `toListId` | string | |
| `entered` / `left` | string[] | Domains crossing the boundary. Empty `entered` on the first pin, where the list file is itself the record. |
| `enteredCount` / `leftCount` | number | |

**Exclude rollover dates when analysing trends across the boundary**: on that
day, membership churn is indistinguishable from real change.
