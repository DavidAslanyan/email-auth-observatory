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

- **Tier 1** (ranks 1–1,000) is crawled twice a day.
- **Tier 2** (ranks 1,001–100,000) is split into 28 shards by an FNV-1a hash of
  the domain name, and two shards are crawled per day.

So a change to a rank-50,000 domain is detected within about a fortnight, not
within 24 hours, and its change event is dated when it was *observed*, not when
it happened. Shards hash the domain rather than the rank so that a domain stays
in the same shard across list rollovers.

These cadences are deliberately modest. Crawling on GitHub Actions means
resolving over a free public DoH endpoint (see below), and the honest constraint
is that this project is a guest there. Smaller, more frequent shards also spread
the load: the same coverage arrives as several short bursts a day rather than
one sustained hour at full rate.

### DKIM is probed on a slower cadence than everything else

DKIM selector probing was measured at **57% of every DNS query the crawl made** —
more than SPF, DMARC, BIMI, MTA-STS, TLS-RPT and MX combined. It is also the one
field that is a lower bound by definition, and selectors rotate on the order of
months while DMARC policy changes weekly.

So selectors are re-probed every 60 days, when a domain is first seen, or when
its mail provider changes — the event that would actually change them. In
between, the previous result is carried forward and marked `probeStrategy:
"cached"`, with `probedAt` recording when it was really queried.

Probing is skipped entirely for domains publishing no MX, no SPF and no DMARC:
they are not sending mail, so there is nothing to sign. Measured on a real
shard, those 3,035 domains cost 24,280 lookups and yielded DKIM on 10 of them.

Together these took a warm long-tail observation from 11.3 lookups per domain to
6.0 — the six that are actually the subject of this dataset.

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

Crawls run on GitHub-hosted runners, and **they resolve over DoH, not over a
local recursive resolver.** That is a deliberate choice forced by a measured
constraint, and it is the one place where this project does not do what its own
design would prefer.

### What was measured

The plan for this project called for running our own `unbound` and keeping the
DoH tier at 1-3% of traffic. On a GitHub-hosted runner that is not possible.
A 1,000-domain crawl with a correctly configured local unbound produced:

```
lookups 11069   local 557 (5.0%)   doh-cloudflare 10482   doh-google 30
unknown rate 0.22%
```

unbound was healthy — `unbound-checkconf` clean, service active, 65,536 file
descriptors available, DNSSEC validating with the AD flag set on a signed zone.
It answered the first few hundred queries and then stopped being able to reach
anything. Mid-crawl, from the same runner:

```
dig @198.41.0.4 . NS      ;; communications error to 198.41.0.4#53: timed out
dig @1.1.1.1 google.com   ;; communications error to 1.1.1.1#53: timed out
```

A root server and a public resolver, both unreachable on UDP/53. **GitHub-hosted
runners throttle sustained outbound UDP/53.** Nothing about the resolver
configuration can fix that.

### What that changes, and what it does not

Note the trap in the numbers above: the unknown rate was a healthy 0.22%. The
crawl looked fine. It was only wrong about *who answered* — the DoH tier was
silently carrying 95% of a crawl that claimed to be locally resolved. The
resolver check therefore gates on the tier mix as well as the unknown rate,
because the unknown rate alone cannot detect this.

Resolving over Cloudflare's DoH endpoint (falling back to Google) preserves what
this dataset depends on:

- **RCODEs are exact.** The JSON API returns `Status`, so `NODATA`, `NXDOMAIN`
  and `SERVFAIL` remain distinguishable — the four-state rule is intact.
- **DNSSEC is preserved.** The `AD` flag is returned per response.
- **TXT chunking is preserved.** Chunked records arrive as adjacent quoted
  strings and are joined with no separator, exactly as on the wire path.

What is lost is real: answers may be served from a shared cache rather than
fetched from the authoritative server, so a record changed minutes ago can be
observed late, and TTL-boundary effects are the resolver's rather than ours. The
dataset also depends on one operator's availability. Change events are dated
when **observed**, which already accounts for this.

Because DoH is the only tier on these runners rather than a fallback, its
limiter is raised from the conservative default to a sustained ~100 queries per
second. That is a declared architecture decision, not a workaround for a
misconfigured resolver — the distinction matters, because raising the DoH
limiter to hide a broken local resolver is precisely the anti-pattern this
project warns against.

### The better architecture, if you want it

A self-hosted runner or a small VPS has no such restriction, and it is the
preferred setup:

- real recursion, so answers come from authoritative servers
- a warm cache across runs, which makes repeat crawls much faster
- no six-hour job limit

Everything needed is already in the repository. `infra/unbound.conf` is the
resolver config, and the workflows take a switch:

```yaml
- uses: ./.github/actions/resolver
  with:
    local: true
```

Point a self-hosted runner at the repository, flip that input, and run
**Verify resolver** with `local: true`. It asserts that the local tier really is
carrying the crawl rather than quietly handing off to DoH.

## Reproducing this

Everything here runs from the CLI in this repository:

```bash
pnpm install && pnpm -r build
pnpm observatory fetch-list                  # pins a Tranco list
pnpm observatory crawl --tier 1              # top 1,000
pnpm observatory aggregate
pnpm observatory report
```

Point the resolver somewhere other than a local unbound with
`MAILSCAPE_RESOLVER_HOST`. Every tunable is an environment variable; see
`apps/crawler/src/config.ts`.
