<div align="center">

# Email Auth Observatory

**How the internet's email security actually changes — recorded every day.**

Anyone can scan DNS today. Nobody keeps the history.
This does, and publishes every change it sees.

[**Live dashboard**](https://davidaslanyan.github.io/email-auth-observatory/) ·
[Latest report](reports/) ·
[Schema](docs/SCHEMA.md) ·
[Methodology](docs/METHODOLOGY.md)

[![CI](https://github.com/DavidAslanyan/email-auth-observatory/actions/workflows/ci.yml/badge.svg)](https://github.com/DavidAslanyan/email-auth-observatory/actions/workflows/ci.yml)
[![Crawl](https://github.com/DavidAslanyan/email-auth-observatory/actions/workflows/crawl-tier1.yml/badge.svg)](https://github.com/DavidAslanyan/email-auth-observatory/actions/workflows/crawl-tier1.yml)
[![Code: MIT](https://img.shields.io/badge/code-MIT-blue.svg)](LICENSE)
[![Data: CC BY 4.0](https://img.shields.io/badge/data-CC%20BY%204.0-green.svg)](data/LICENSE)

</div>

---

## Why this exists

Every domain that sends email publishes public DNS records — SPF, DMARC, DKIM,
MTA-STS, BIMI, TLS-RPT — declaring how receivers should treat mail claiming to
be from it.

Checking one domain is easy. **Knowing what changed, and when, is not.** That
history is where the real signal lives: a provider flipping a default moves
thousands of domains overnight, and nobody sees it because nobody is watching
every day.

So this crawls the top 100,000 domains, commits what changed, and writes it up
in plain English.

## What the history catches

A yes/no checker says these domains have email authentication. Read the record
and they don't.

| Looks like | Actually |
| --- | --- |
| `oraclecloud.com` publishes DMARC | `p=quarantine; pct=0` — a policy applied to **zero percent** of mail |
| `facebook.com` publishes MTA-STS | `mode: testing` — published, **not enforced**. So are `mail.ru`, `office.com`, `yahoo.com` |
| `icloud.com` publishes BIMI | `l=` is **empty** — an explicit opt-out, the opposite of adoption |
| 4,032 domains sit at DMARC `reject` | **347 apply it to less than 100%** of their mail |

Five domains in the ranking publish `v=spf1 +all` — *anyone may send as us*.

The point isn't the snapshot. It's being able to say **"12 domains weakened to
`p=none` today, 9 of them on the same provider"** — which is a fact about the
industry, not about any one company.

## Today's numbers

From the crawl of `2026-08-29`, across **18,672 domains** observed so far:

| Mechanism | Adoption | Detail |
| --- | ---: | --- |
| SPF | 71% | 6,013 hard-fail · 6,549 soft-fail · 5 pass-all |
| DMARC | 59% | 4,032 reject · 3,112 quarantine · 3,926 monitor-only |
| MTA-STS | 2% | 176 enforcing · **145 still testing** |
| BIMI | 5% | 593 with a verified mark · 9 explicit opt-outs |
| TLS-RPT | 2% | 461 domains accept TLS reports |
| DNSSEC | 9% | 1,615 signed zones |

Coverage grows toward 100,000 as the shard rotation completes.

## Use the data

Plain JSON and JSONL in this repo. No API, no server, no auth — on purpose.

**Current totals**

```bash
curl -s https://raw.githubusercontent.com/DavidAslanyan/email-auth-observatory/main/data/aggregates/latest.json \
  | jq '{date, domains: .domainsObserved, dmarc: .totals.dmarc.p}'
```

**Everyone who weakened their DMARC policy on a given day**

```bash
curl -s https://raw.githubusercontent.com/DavidAslanyan/email-auth-observatory/main/data/changes/2026-08-29.jsonl \
  | jq -c 'select(.field == "dmarc.p" and .from == "reject")'
```

**Policies published but barely applied**

```bash
jq -c 'select(.dmarc.pct != null and .dmarc.pct < 100)
       | {domain, p: .dmarc.p, pct: .dmarc.pct}' \
  data/snapshots/latest/tier1.jsonl
```

**The whole adoption time series, one file**

```bash
curl -s https://raw.githubusercontent.com/DavidAslanyan/email-auth-observatory/main/data/aggregates/history.jsonl \
  | jq -c '{date, reject: .totals.dmarc.p.reject}'
```

> Snapshot records omit values held once per shard in `<shard>.meta.json`.
> Read that alongside, or use the store — [SCHEMA.md](docs/SCHEMA.md) explains.

## How it works

```
Tranco top 100k  (list ID pinned per quarter, so ranking churn is not "change")
        │
        ▼
   crawler ──────► raw DNS queries, four-state results, never a boolean
        │
        ▼
   snapshots/  ──► diff ──► changes/YYYY-MM-DD.jsonl
                     │
                     ├──► aggregates/  ──► the dashboard
                     └──► reports/     ──► what changed, in English
```

Three rules carry the whole thing:

- **A failed lookup is not an absence.** `SERVFAIL` is recorded as `unknown`,
  never as "no record". It produces no change event, and the last known value is
  carried forward and marked stale. Without this, one bad morning at the
  resolver publishes as *"8,000 domains dropped DMARC overnight"*.
- **A claimed disappearance is confirmed before it's recorded.** A resolver can
  answer `NOERROR` with an incomplete answer set, which looks exactly like a
  domain withdrawing a record. It happened; now every one gets a second look.
- **A quiet day stays quiet.** Nothing is committed when nothing changed.

## What this can't tell you

A dataset that hides its limits gets discredited the first time someone finds
one. So:

- **DKIM findings are a lower bound, always.** Selectors can't be enumerated
  from DNS — only guessed. There is deliberately no `hasDkim` field, and **any
  "X% of domains use DKIM" figure derived from this data is wrong.**
- **SPF lookup counts are static.** We count terms in the record, not nested
  `include:` chains — so `exceedsLookupLimit` under-reports.
- **The long tail is observed fortnightly.** The top 1,000 twice a day; the rest
  on a 28-shard rotation. Changes are dated when *observed*, not when they
  happened.
- **Some values are remembered, not seen.** Anything marked `stale: true` was
  carried forward. Filter `stale !== true` for directly-observed data only.
- **Tranco rollovers are a boundary.** The list ID is pinned per quarter;
  `data/tranco/rollovers.jsonl` names exactly which domains entered and left.
  Exclude those dates from trends.
- **Reporting addresses are redacted.** `rua=` tags name real mailboxes, so only
  the domain is kept. "Which DMARC vendor is gaining share?" is answerable.
  "Who is the contact here?" deliberately is not.

## Run it yourself

```bash
pnpm install && pnpm -r build
pnpm observatory fetch-list                     # pins a Tranco list
pnpm observatory crawl --tier 1 --limit 100     # ~100 domains in seconds
pnpm observatory aggregate && pnpm observatory report
```

Every tunable is an environment variable — see `apps/crawler/src/config.ts`.

## Cite it

```bibtex
@misc{email_auth_observatory,
  title        = {Email Auth Observatory: a longitudinal dataset of email authentication posture},
  author       = {Aslanyan, David},
  year         = {2026},
  howpublished = {\url{https://github.com/DavidAslanyan/email-auth-observatory}},
  note         = {Dataset licensed CC BY 4.0}
}
```

Rankings derive from **Tranco**, which must be cited independently:

> V. Le Pochat, T. Van Goethem, S. Tajalizadehkhoob, M. Korczyński and
> W. Joosen, "Tranco: A Research-Oriented Top Sites Ranking Hardened Against
> Manipulation", *NDSS 2019*. <https://tranco-list.eu/>

## Contributing

The most useful contributions are the smallest: a new MX provider mapping or a
DKIM selector list, both one-line additions to
`packages/core/src/constants.ts`. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

Code is **MIT**. The dataset — everything under `data/` and `reports/` — is
**CC BY 4.0**. Licensed separately on purpose: the data is meant to be reused
and cited on its own terms.
