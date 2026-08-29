# Methodology

How mailscape collects its data, and — more importantly — what the data cannot
tell you. A dataset that is honest about its limits is worth trusting; one that
hides them gets discredited the first time somebody finds one.

## What is measured

For each domain, mailscape resolves:

| Record | Name queried | Type |
| --- | --- | --- |
| SPF | `<domain>` | TXT |
| DMARC | `_dmarc.<domain>` | TXT |
| BIMI | `default._bimi.<domain>` | TXT |
| MTA-STS | `_mta-sts.<domain>` | TXT |
| TLS-RPT | `_smtp._tls.<domain>` | TXT |
| MX | `<domain>` | MX |
| DKIM | `<selector>._domainkey.<domain>` | TXT |

For the ~2% of domains publishing an MTA-STS TXT record, a second pass fetches
`https://mta-sts.<domain>/.well-known/mta-sts.txt` to read the policy mode. That
pass runs after the DNS pass completes, so a slow web server can never stall the
crawl.

## The four-state rule

This is the rule the whole dataset rests on. A DNS lookup has **four** outcomes,
never two:

| Outcome | Meaning | Recorded as |
| --- | --- | --- |
| `NOERROR` with answers | The record exists | `ok` |
| `NOERROR`, no answers | Name exists, no record of that type | `nodata` |
| `NXDOMAIN` | The name does not exist | `nxdomain` |
| `SERVFAIL` / `REFUSED` / timeout / network error | **We** failed | `unknown` |

`nodata` and `nxdomain` are genuine absence. `unknown` is our failure, and it is
treated completely differently:

- An `unknown` result **never produces a change event.**
- The previous known value is **carried forward** into the new snapshot and
  marked `stale: true`, with `lastSeenAt` set to the timestamp of the last
  *successful* observation.
- Across consecutive failures, `lastSeenAt` keeps pointing at the last real
  observation, so two bad mornings in a row do not make month-old data look one
  day old.

Without this rule, a single resolver hiccup would appear in the time series as
"8,000 domains dropped DMARC overnight" — a fabricated finding in a dataset
whose entire premise is that the deltas are trustworthy.

Every crawl reports its `unknown_rate`. Above 2% the run is marked **degraded**:
the data is still published, but the aggregate carries `degraded: true` and the
daily report says so at the top.

## Resolution

Queries are built by hand over UDP with `dns-packet`, not through Node's `dns`
module. `dns.resolveTxt()` wraps c-ares and exposes neither the RCODE (so
`NODATA` and `SERVFAIL` become indistinguishable) nor the DNSSEC AD flag. Both
are load-bearing here.

Each query uses a random 16-bit transaction ID that is verified on the response,
sets EDNS0 with the DO bit, and retries over TCP when the truncation flag is
set — which large TXT answers and DKIM keys routinely trigger.

Resolution is tiered:

1. A local recursive resolver (`unbound`, config in `infra/unbound.conf`).
2. Cloudflare DoH.
3. Google DoH.

Escalation happens **only** on `unknown`. A `nodata` answer is a real
observation, and re-asking a second resolver would spend the entire fallback
budget on the large fraction of names that legitimately have no record. In
practice the DoH tiers handle well under 1% of lookups; if they ever handle more
than about 5%, the local resolver is broken and that is the thing to fix.

## Limitations

These are real and you should account for them.

### DKIM findings are a lower bound, always

DKIM selectors **cannot be enumerated from DNS.** You can only guess selector
names and see which ones answer. mailscape guesses from the domain's MX provider
where it recognises one, and from a short generic list otherwise.

So `dkim.selectorsFound: []` means **"none of the selectors we tried"**, never
"this domain has no DKIM." There is deliberately no `hasDkim` field anywhere in
this dataset, and you should not compute one. Any statistic of the form "X% of
domains use DKIM" derived from this data is wrong.

### SPF lookup counts are static, not recursive

RFC 7208 limits an SPF evaluation to 10 DNS-lookup-requiring terms. mailscape
counts the terms **in the record itself**: `include`, `a`, `mx`, `ptr`, `exists`
and `redirect`.

It does **not** recursively resolve nested `include:` chains, which is where
real records actually breach the limit. So `exceedsLookupLimit` under-reports:
a record with 6 includes that each expand to 3 more is over the limit in
practice and is not flagged here. Recursive counting is a v2 feature.

### The long tail is observed weekly, not daily

- **Tier 1** (ranks 1–1,000) is crawled every 6 hours.
- **Tier 2** (ranks 1,001–100,000) is split into 7 shards by an FNV-1a hash of
  the domain name, and one shard is crawled per day.

So a change to a rank-50,000 domain is detected within 7 days, not within 24
hours, and its change event is dated when it was *observed*, not when it
happened. Shards hash the domain rather than the rank so that a domain stays in
the same shard across list rollovers.

### `unknown` carry-forward means some values are remembered, not observed

Any field with `stale: true` was carried forward from an earlier crawl because
the current lookup failed. Its `lastSeenAt` says when it was last really
observed. If you need only directly-observed data, filter on `stale !== true`.

### The Tranco list is pinned, and rollovers are a boundary

Tranco publishes a new list daily and 1–2% of membership churns. Re-downloading
"today's list" each morning would make domains entering and leaving the ranking
appear as changes, contaminating every delta with pure list churn.

So **one list ID is pinned per quarter**, recorded in `data/tranco/list-id.txt`
and embedded in every snapshot and aggregate. Rollovers happen deliberately, as
their own commit, and each one appends an entry to
`data/tranco/rollovers.jsonl` naming exactly which domains entered and left.
**Exclude those dates when analysing trends across a rollover boundary.**

A domain seen for the first time produces a single `first_seen` event and no
per-field `added` events, so a rollover does not look like thousands of
simultaneous adoptions.

### Only the last DNS label is used as the "TLD"

`byTld` uses the final label, so `bbc.co.uk` is filed under `uk`, not `co.uk`.
Distinguishing registrable suffixes needs a public suffix list. This is adequate
for separating national ecosystems and inadequate for anything finer.

### Reporting addresses are redacted

DMARC `rua=`/`ruf=` and TLS-RPT `rua=` tags routinely name individual mailboxes.
This is a public dataset, so the mailbox is dropped and only the domain is kept:
`ruaHosts` holds domains only, and the stored raw record reads
`rua=mailto:<redacted>@vendor.example`. Destination **counts** are preserved, so
"which DMARC vendors are gaining share?" is still answerable; "who is the DMARC
contact at this company?" deliberately is not.

### Multiple records are recorded, not resolved

A domain publishing two `v=spf1` records is misconfigured — RFC 7208 requires
receivers to `permerror`. mailscape records `multipleRecords: true` and
`recordCount`, and parses the first record. It does not pretend the domain has a
working SPF policy, and it does not hide the misconfiguration.

## Where the crawl runs

Crawls run on GitHub-hosted runners with a local `unbound` recursive resolver
started in the job (see `infra/unbound.conf` and `.github/workflows/`). Running
our own recursion, rather than hammering a public resolver, is what keeps the
DoH tier inside its budget and what makes authentic `NXDOMAIN`/`NODATA`
distinctions visible rather than a public resolver's cached approximation.

If GitHub-hosted runners ever throttle high-volume outbound UDP/53, the fallback
is a small VPS running the same CLI on cron. That is arguably the better
architecture anyway — a warm resolver cache across runs and no six-hour job
limit — and this document will be updated to say which is in use.

## Reproducing this

Everything here runs from the CLI in this repository:

```bash
pnpm install && pnpm -r build
pnpm mailscape fetch-list                  # pins a Tranco list
pnpm mailscape crawl --tier 1              # top 1,000
pnpm mailscape aggregate
pnpm mailscape report
```

Point the resolver somewhere other than a local unbound with
`MAILSCAPE_RESOLVER_HOST`. Every tunable is an environment variable; see
`apps/crawler/src/config.ts`.
