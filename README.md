# mailscape

A public, git-versioned time-series dataset of email authentication posture —
SPF, DMARC, DKIM, MTA-STS, BIMI and TLS-RPT — across the internet's most popular
domains. Anyone can scan DNS today; **nobody keeps a public longitudinal record
of how it changes**, and the changes are the interesting part.

[Dashboard](https://davidaslanyan.github.io/mailscape/) ·
[Latest report](reports/) ·
[Schema](docs/SCHEMA.md) ·
[Methodology](docs/METHODOLOGY.md)

---

## A finding, from the actual data

From the crawl of 2026-08-29 (Tranco list `N2Q8W`, top 1,000 domains):

> **`oraclecloud.com` publishes `v=DMARC1; p=quarantine; pct=0`.**
>
> A quarantine policy applied to zero percent of mail. The record exists, every
> "does this domain have DMARC?" checker says yes, and it instructs receivers to
> do nothing at all.

It is not alone in the shape of the problem. Among the top 1,000 domains on that
day:

| What a naive scan counts as adoption | What is actually happening |
| --- | --- |
| 32 domains publish MTA-STS | **12 of them are in `testing` mode** — the policy is published but not enforced (`facebook.com`, `office.com`, `office365.com`, `mail.ru`, `ikea.com`, …) |
| 724 domains publish DMARC | **10 apply it at less than 100%**, including `branch.io` at `p=reject; pct=5` and `oraclecloud.com` at `pct=0` |
| 163 domains publish BIMI | **2 are explicit opt-outs** — `icloud.com` and `me.com` publish `l=` with an empty value, which means "do not show an indicator for me" |
| 439 domains sit at DMARC `reject` | **14 of them publish no SPF record at all** |

Every one of those is a state that a boolean `hasDmarc` / `hasMtaSts` field
erases. This dataset is built so they survive.

The other half of the point is time. A single day tells you `pct=0` exists; a
year of days tells you whether `oraclecloud.com` ever turns it up, and whether
the twelve testing-mode MTA-STS policies ever reach `enforce`.

## What makes this worth keeping

The **deltas**, not the snapshot. The daily report exists to say things like:

> **8 mimecast-hosted domains** moved DMARC policy `none` to `quarantine` on the
> same day, which points to a provider-side default change rather than 8
> independent decisions.

A provider changing a default moves thousands of domains at once and is
invisible unless somebody is watching every day and recording what moved.

## How to use the data

Everything is plain JSON and JSONL in this repository. There is no API, no
server and no auth, on purpose.

**Current totals:**

```bash
curl -s https://raw.githubusercontent.com/DavidAslanyan/mailscape/main/data/aggregates/latest.json \
  | jq '{date, domains: .domainsObserved, dmarc: .totals.dmarc.p, mtaSts: .totals.mtaSts.mode}'
```

**Every domain that weakened its DMARC policy on a given day:**

```bash
curl -s https://raw.githubusercontent.com/DavidAslanyan/mailscape/main/data/changes/2026-08-29.jsonl \
  | jq -c 'select(.field == "dmarc.p" and .from == "reject")'
```

**Domains publishing a policy they apply to almost nothing:**

```bash
jq -c 'select(.dmarc.pct != null and .dmarc.pct < 100) | {domain, p: .dmarc.p, pct: .dmarc.pct}' \
  data/snapshots/latest/tier1.jsonl
```

**The whole adoption time series, as one file:**

```bash
curl -s https://raw.githubusercontent.com/DavidAslanyan/mailscape/main/data/aggregates/history.jsonl \
  | jq -c '{date, reject: .totals.dmarc.p.reject}'
```

Only human commits, with the automated data commits filtered out:

```bash
git log --invert-grep --grep='^data:'
```

## Limitations

Read these before drawing a conclusion. A dataset that is honest about its
limits is worth trusting; one that hides them gets discredited the first time
somebody finds one. [The methodology](docs/METHODOLOGY.md) goes further.

- **DKIM findings are a lower bound, always.** DKIM selectors cannot be
  enumerated from DNS — they can only be guessed. `selectorsFound: []` means
  "none of the selectors we tried", never "this domain has no DKIM". There is
  deliberately no `hasDkim` field anywhere in this dataset, and **any statistic
  of the form "X% of domains use DKIM" derived from this data is wrong.**
- **SPF lookup counts are static, not recursive.** We count the
  lookup-requiring terms in the record itself. We do not expand nested
  `include:` chains, which is where records actually breach the RFC 7208 limit
  of ten. `exceedsLookupLimit` therefore under-reports.
- **The long tail is observed weekly, not daily.** The top 1,000 are crawled
  every six hours; ranks 1,001–100,000 are split across seven shards, one per
  day. A change to a rank-50,000 domain is detected within seven days, and its
  event is dated when it was *observed*, not when it happened.
- **Some values are remembered, not observed.** When a lookup fails we record
  `unknown`, carry the previous value forward and mark it `stale: true` with the
  timestamp of the last successful observation. A failure never produces a change
  event. Filter on `stale !== true` for directly-observed data only.
- **Tranco rollovers are a boundary.** The list ID is pinned per quarter so
  membership churn cannot contaminate the deltas. Each rollover is recorded in
  `data/tranco/rollovers.jsonl` with the exact domains that entered and left.
  **Exclude those dates when analysing a trend across the boundary.**
- **`byTld` uses the last DNS label**, so `bbc.co.uk` is filed under `uk`.
  Distinguishing registrable suffixes needs a public suffix list.
- **Crawls on GitHub Actions resolve over DoH, not our own recursion.**
  GitHub-hosted runners throttle sustained outbound UDP/53 — measured: mid-crawl,
  a root server and `1.1.1.1` both time out — so a local `unbound` there answers
  a few hundred queries and then cannot reach anything. RCODEs, the DNSSEC AD
  flag and TXT chunking all survive, but answers may come from a shared cache
  rather than the authoritative server. [The methodology](docs/METHODOLOGY.md#where-the-crawl-runs)
  has the numbers and the self-hosted setup that avoids it.
- **Reporting addresses are redacted.** DMARC and TLS-RPT `rua=` tags name real
  mailboxes. Only the domain is kept, so "which DMARC vendors are gaining
  share?" is answerable and "who is the DMARC contact here?" deliberately is not.

## How it works

```
Tranco list (pinned per quarter)
      |
      v
crawler  --  DoH on GitHub Actions (Cloudflare, then Google)
      |      raw UDP/53 through local unbound on a self-hosted runner
      v
snapshots/latest/*.jsonl   sorted by domain, overwritten in place
      |                    (run timestamp in a sidecar, so an unchanged
      |                     crawl produces a byte-identical file)
      |
      v
diff  --  emits change events; NEVER when a lookup failed
      |
      +--> changes/YYYY-MM-DD.jsonl   (append-only)
      +--> aggregates/               (rolled up over every shard)
      +--> reports/YYYY-MM-DD.md     (human-readable)
```

Queries are built by hand over `node:dgram` rather than through Node's `dns`
module, because `dns.resolveTxt()` exposes neither the RCODE nor the DNSSEC AD
flag — and without the RCODE you cannot tell `NODATA` from `SERVFAIL`. That
distinction is the whole ballgame: if a resolver hiccup is recorded as absence,
one bad morning shows up in the time series as *"8,000 domains dropped DMARC
overnight"*, which is a fabricated finding in a dataset whose entire premise is
that the deltas are trustworthy.

Run it yourself:

```bash
pnpm install && pnpm -r build
pnpm mailscape fetch-list                     # pins a Tranco list
pnpm mailscape crawl --tier 1 --limit 100     # 100 domains, about 7 seconds
pnpm mailscape aggregate
pnpm mailscape report
```

Point the resolver anywhere with `MAILSCAPE_RESOLVER_HOST=1.1.1.1` if you are
not running a local recursive resolver. Every tunable is an environment
variable; see `apps/crawler/src/config.ts`.

## Citation

```bibtex
@misc{mailscape,
  title        = {mailscape: a longitudinal dataset of email authentication posture},
  author       = {{mailscape contributors}},
  year         = {2026},
  howpublished = {\url{https://github.com/DavidAslanyan/mailscape}},
  note         = {Dataset licensed CC BY 4.0}
}
```

Domain rankings derive from the **Tranco** list, which must be cited
independently:

> V. Le Pochat, T. Van Goethem, S. Tajalizadehkhoob, M. Korczyński and
> W. Joosen, "Tranco: A Research-Oriented Top Sites Ranking Hardened Against
> Manipulation", *NDSS 2019*. <https://tranco-list.eu/>

## Contributing

The most useful contributions are new MX provider mappings and DKIM selector
lists — both are one-line additions to `packages/core/src/constants.ts`. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

Code is **MIT** ([LICENSE](LICENSE)). The dataset — everything under `data/` and
`reports/` — is **CC BY 4.0** ([data/LICENSE](data/LICENSE)). Licensing them
separately is deliberate: the data is meant to be reused and cited on its own
terms.
