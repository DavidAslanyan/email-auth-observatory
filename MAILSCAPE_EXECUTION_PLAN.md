# mailscape — Build Execution Plan

> **You are building this from scratch.** This document is the complete specification. Read it fully before writing a single line of code. Execute phase by phase. Do not skip the acceptance checks — each phase's checks must pass before you move to the next.

---

## 0. Mission

`mailscape` is a **public, git-versioned time-series dataset of email authentication posture across the internet's most popular domains.**

Every domain that sends email publishes public DNS records (SPF, DMARC, DKIM, MTA-STS, BIMI, TLS-RPT) declaring how receivers should verify mail claiming to come from it. Anyone can query these. **Nobody keeps a public longitudinal record of how they change.**

This project crawls those records daily, commits what changed, and generates a human-readable daily report. Over months it accumulates something that does not currently exist publicly: a queryable history of how the internet's email security is evolving.

### What "done" means

A working v1 is:

1. A GitHub Actions cron that resolves email-auth records for the Tranco top 100k on a rotating schedule, unattended.
2. Data committed to the repo in a format that stays small and diffs cleanly.
3. A daily markdown report at `reports/YYYY-MM-DD.md` stating what changed, readable by a human with no context.
4. A static dashboard on GitHub Pages showing adoption trends and recent changes.
5. Tests covering every parser and the diff engine.

### The thing that makes it valuable

The **deltas**, not the snapshot. Anyone can scan DNS today. The product is being able to say *"1,200 domains tightened their DMARC policy this month"* or *"12 domains weakened to `p=none` on the same day, 9 of them on the same hosting provider — likely a provider-side default change."*

**That value is destroyed entirely by one class of bug:** recording a resolution failure as an absence. Read §1 before anything else.

---

## 1. Non-negotiable correctness rules

These are the rules that separate a trustworthy dataset from a worthless one. Every one of them has been chosen because violating it silently produces plausible-looking garbage. Do not "simplify" any of them.

### 1.1 The four-state rule (most important rule in this document)

A DNS lookup has **four** outcomes, never two. These must never collapse into a boolean:

| Outcome | Meaning | Recorded as |
|---|---|---|
| `NXDOMAIN` | The name does not exist | `nxdomain` — genuine absence |
| `NOERROR` + 0 answers (NODATA) | Name exists, no record of that type | `nodata` — genuine absence |
| `SERVFAIL` / `REFUSED` | Resolution broke | `unknown` — **we failed, not them** |
| Timeout / network error | We failed | `unknown` |

**Why this matters:** if a resolver hiccup is recorded as absence, one bad morning appears in the time series as *"8,000 domains dropped DMARC overnight"* — a completely fabricated finding, in a repo whose entire premise is that the deltas are trustworthy.

**Enforcement:**
- `unknown` MUST NOT produce a change event.
- On `unknown`, carry forward the previous known value into the new snapshot, and set a `stale: true` marker with the timestamp of last successful observation.
- Every crawl reports its `unknown_rate`. If it exceeds **2%**, the run is marked degraded and the aggregate for that day is flagged, not silently published.

### 1.2 TXT records arrive in chunks

DNS TXT records are transmitted as arrays of strings, each ≤255 bytes. Long SPF records and all DKIM public keys are **always** split. You must join the chunks with **no separator** before parsing:

```ts
const joined = txtRecord.map(chunk => chunk.toString('utf8')).join('');
```

Parsing `chunks[0]` alone is a bug that silently truncates ~15% of SPF records and 100% of DKIM keys.

### 1.3 Multiple records of the same type are a finding, not an error

A domain can publish two `v=spf1` TXT records. This is a misconfiguration (RFC 7208 says receivers must `permerror`), and **recording it is more interesting than hiding it.** Never take `records[0]` and move on. Record `count` and set a `multipleRecords: true` flag. Same for DMARC.

### 1.4 DKIM is a lower bound, never a boolean

DKIM selectors cannot be enumerated from DNS — you can only guess selector names. Therefore:

- The field is named `dkimSelectorsFound: string[]`. There is **no** `hasDkim` field. Ever.
- Absence of found selectors means "we found none with our wordlist," never "this domain has no DKIM."
- The README must state this limitation explicitly.

### 1.5 Freeze the Tranco list ID

Tranco publishes a new list daily and ~1–2% of membership churns. If you re-download "today's list" every morning, domains entering and leaving the ranking appear in your diff as changes — **contaminating every delta you publish with pure list churn.**

- Pin **one list ID per quarter**, stored in `data/tranco/list-id.txt`.
- Roll it over deliberately, as its own commit: `chore(data): roll to Tranco list <ID> (1,847 domains in, 1,612 out)`.
- The rollover commit must include a `data/tranco/rollovers.jsonl` entry recording which domains entered and left, so anyone analysing the history can exclude that boundary.
- Every snapshot and aggregate embeds the `listId` it was produced against.

### 1.6 Commit nothing when nothing changed

```bash
git add data reports
if git diff --staged --quiet; then
  echo "No changes to commit"
  exit 0
fi
```

A quiet day must be quiet. This single guard is what keeps the commit history honest and readable.

---

## 2. Tech stack

Chosen for speed of execution and low operational surface. Do not substitute without reason.

| Concern | Choice | Rationale |
|---|---|---|
| Runtime | **Node 22 LTS** | Native `fetch`, stable `node:test` alternative, good `dgram` perf |
| Language | **TypeScript 5.x, `strict: true`** | Non-negotiable |
| Monorepo | **pnpm workspaces** | Fastest install, strict dependency isolation, no build-orchestration overhead |
| Build | **tsdown** for packages, **Vite** for web | tsdown is fast and zero-config for library dual-format output. `tsc --build` is an acceptable fallback if tsdown gives trouble — do not spend more than 15 minutes on this choice |
| DNS | **`dns-packet` + `node:dgram`** | See §4.2 — Node's built-in `dns` module is unusable here |
| Rate limiting | **`bottleneck`** | Two instances, different configs (§4.2.4) |
| Validation | **`zod`** | Runtime validation of data files at read boundaries |
| Logging | **`pino`** | Structured JSON logs, pretty-printed locally |
| CLI | **`citty`** or hand-rolled arg parsing | Do not pull in a heavy CLI framework |
| Testing | **`vitest`** | Fast, native TS/ESM |
| Lint/format | **ESLint 9 flat config + Prettier** | |
| Web | **Vite + React 19 + TypeScript** | |
| Charts | **`recharts`** | |
| Hosting | **GitHub Pages** | |

**Module system: ESM throughout.** `"type": "module"` in every `package.json`. Use `node:` prefixes for builtins.

---

## 3. Repository structure

```
mailscape/
├── .github/
│   └── workflows/
│       ├── ci.yml                  # lint + typecheck + test on PR/push
│       ├── crawl-tier1.yml         # top 1k, every 6h
│       ├── crawl-tier2.yml         # rotating 1/7 shard of the long tail, daily
│       ├── aggregate.yml           # rollups, after crawls
│       ├── report.yml              # daily human-readable report
│       └── deploy-web.yml          # build + publish Pages
│
├── packages/
│   ├── core/                       # types, constants, zod schemas. ZERO runtime deps.
│   │   ├── src/
│   │   │   ├── types.ts
│   │   │   ├── constants.ts
│   │   │   ├── schemas.ts
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── dns/                        # resolution layer. Knows nothing about email.
│   │   ├── src/
│   │   │   ├── udp-client.ts
│   │   │   ├── doh-client.ts
│   │   │   ├── resolver.ts         # tiered orchestration
│   │   │   ├── rcode.ts            # RCODE -> LookupStatus
│   │   │   ├── txt.ts              # chunk joining
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── parsers/                    # PURE functions. No I/O. No network. Heavily tested.
│   │   ├── src/
│   │   │   ├── spf.ts
│   │   │   ├── dmarc.ts
│   │   │   ├── bimi.ts
│   │   │   ├── mta-sts.ts
│   │   │   ├── tls-rpt.ts
│   │   │   ├── mx.ts               # provider classification
│   │   │   ├── tag-value.ts        # shared "k=v; k=v" tokenizer
│   │   │   └── index.ts
│   │   ├── test/
│   │   │   ├── fixtures/           # real records captured from real domains
│   │   │   └── *.test.ts
│   │   └── package.json
│   │
│   └── store/                      # persistence + diff + aggregate
│       ├── src/
│       │   ├── paths.ts
│       │   ├── jsonl.ts
│       │   ├── snapshot.ts
│       │   ├── diff.ts
│       │   ├── aggregate.ts
│       │   ├── report.ts
│       │   └── index.ts
│       └── package.json
│
├── apps/
│   ├── crawler/                    # the CLI. Thin orchestration only.
│   │   ├── src/
│   │   │   ├── cli.ts
│   │   │   ├── commands/
│   │   │   │   ├── fetch-list.ts
│   │   │   │   ├── crawl.ts
│   │   │   │   ├── aggregate.ts
│   │   │   │   └── report.ts
│   │   │   ├── probe.ts            # composes dns + parsers into one DomainSnapshot
│   │   │   └── config.ts
│   │   └── package.json
│   │
│   └── web/
│       ├── src/
│       │   ├── main.tsx
│       │   ├── App.tsx
│       │   ├── components/
│       │   ├── hooks/
│       │   ├── lib/
│       │   └── styles/
│       ├── public/
│       ├── index.html
│       ├── vite.config.ts
│       └── package.json
│
├── data/                           # COMMITTED. This is the product.
│   ├── tranco/
│   │   ├── list-id.txt
│   │   ├── domains.csv.gz
│   │   └── rollovers.jsonl
│   ├── snapshots/
│   │   └── latest/
│   │       ├── tier1.jsonl
│   │       └── tier2-shard-{0..6}.jsonl
│   ├── changes/
│   │   └── YYYY-MM-DD.jsonl
│   └── aggregates/
│       ├── latest.json
│       └── history.jsonl
│
├── reports/
│   └── YYYY-MM-DD.md
│
├── infra/
│   └── unbound.conf
│
├── docs/
│   ├── METHODOLOGY.md              # how data is collected, limitations
│   └── SCHEMA.md                   # field-by-field data dictionary
│
├── .gitattributes
├── .gitignore
├── .npmrc
├── eslint.config.js
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── vitest.config.ts
├── LICENSE                          # MIT for code
└── README.md
```

### Dependency direction (enforce this strictly)

```
core  ←  dns
core  ←  parsers
core  ←  store
core, dns, parsers, store  ←  apps/crawler
core  ←  apps/web
```

**`parsers` must never import `dns`.** **`core` must have zero runtime dependencies.** If you find yourself wanting to break these, you have put logic in the wrong place.

---

## 4. Module specifications

### 4.1 `@mailscape/core`

#### `types.ts`

```ts
export type LookupStatus = 'ok' | 'nodata' | 'nxdomain' | 'unknown';

export type ResolverTier = 'local' | 'doh-cloudflare' | 'doh-google';

export interface LookupMeta {
  status: LookupStatus;
  rcode: string;              // 'NOERROR' | 'NXDOMAIN' | 'SERVFAIL' | 'REFUSED' | 'TIMEOUT' | ...
  resolver: ResolverTier;
  elapsedMs: number;
  ad: boolean;                // DNSSEC Authenticated Data flag
  /** True when this value was carried forward from a previous crawl because
      the current lookup returned `unknown`. */
  stale?: boolean;
  lastSeenAt?: string;        // ISO, only when stale
}

export interface SpfState extends LookupMeta {
  present: boolean;
  raw?: string;
  multipleRecords: boolean;
  recordCount: number;
  allQualifier?: '+' | '-' | '~' | '?';   // the final `all` mechanism
  lookupCount?: number;                    // DNS-lookup-requiring mechanisms; >10 = invalid
  exceedsLookupLimit?: boolean;
  hasRedirect: boolean;
  includes: string[];
  parseError?: string;
}

export type DmarcPolicy = 'none' | 'quarantine' | 'reject';

export interface DmarcState extends LookupMeta {
  present: boolean;
  raw?: string;
  multipleRecords: boolean;
  p?: DmarcPolicy;
  sp?: DmarcPolicy;           // subdomain policy; defaults to `p` when absent
  pct?: number;               // 0-100, default 100
  adkim?: 'r' | 's';
  aspf?: 'r' | 's';
  fo?: string;
  ri?: number;
  ruaCount: number;           // number of aggregate report destinations
  rufCount: number;
  ruaHosts: string[];         // domains only, NOT full mailto addresses — see §4.1.1
  parseError?: string;
}

export interface BimiState extends LookupMeta {
  present: boolean;
  raw?: string;
  hasLogo: boolean;           // l= present and non-empty
  hasVmc: boolean;            // a= present (Verified Mark Certificate)
  declined: boolean;          // l= present but empty (explicit opt-out)
  parseError?: string;
}

export type MtaStsMode = 'enforce' | 'testing' | 'none';

export interface MtaStsState extends LookupMeta {
  present: boolean;           // TXT record at _mta-sts
  policyId?: string;
  policyFetched: boolean;
  mode?: MtaStsMode;
  maxAge?: number;
  mxPatternCount?: number;
  policyError?: string;
}

export interface TlsRptState extends LookupMeta {
  present: boolean;
  raw?: string;
  ruaCount: number;
  parseError?: string;
}

export interface MxState extends LookupMeta {
  present: boolean;
  hosts: string[];            // lowercased, trailing dot stripped, sorted
  provider?: string;          // 'google' | 'microsoft' | 'proofpoint' | ... | 'self-hosted' | 'unknown'
  isNullMx: boolean;          // single "." host = domain sends/receives no mail (RFC 7505)
}

export interface DkimState {
  status: LookupStatus;
  /** ALWAYS a lower bound. Absence proves nothing. */
  selectorsFound: string[];
  selectorsProbed: string[];
  probeStrategy: 'mx-conditional' | 'generic-fallback' | 'skipped';
}

export interface DomainSnapshot {
  domain: string;
  rank: number;
  listId: string;
  crawledAt: string;          // ISO 8601 UTC
  dnssec: 'signed' | 'unsigned' | 'unknown';
  spf: SpfState;
  dmarc: DmarcState;
  bimi: BimiState;
  mtaSts: MtaStsState;
  tlsRpt: TlsRptState;
  mx: MxState;
  dkim: DkimState;
}

export type ChangeKind = 'added' | 'removed' | 'modified' | 'first_seen';

export interface ChangeEvent {
  domain: string;
  rank: number;
  field: string;              // dotted path e.g. 'dmarc.p', 'mtaSts.mode'
  kind: ChangeKind;
  from: string | number | boolean | null;
  to: string | number | boolean | null;
  ts: string;                 // ISO
  /** Populated by the report generator for clustering, not by the differ. */
  mxProvider?: string;
}
```

##### 4.1.1 Privacy rule for `rua`

DMARC `rua=` tags contain email addresses, frequently individual mailboxes (`security@`, but also `john.doe@`). **Do not commit full addresses to a public dataset.** Store only the *domain part*, deduplicated. Record the count separately. This is enough to answer the interesting question ("which DMARC vendors are gaining share?") without publishing a harvestable address list.

#### `constants.ts`

```ts
export const RECORD_PREFIXES = {
  dmarc: '_dmarc',
  bimi: 'default._bimi',
  mtaSts: '_mta-sts',
  tlsRpt: '_smtp._tls',
} as const;

export const TIMEOUTS = {
  localMs: 5_000,
  dohMs: 10_000,
} as const;

export const RETRY = {
  localAttempts: 2,
  dohAttempts: 1,
} as const;

/** MX hostname suffix -> provider identity. Longest-suffix match wins. */
export const MX_PROVIDERS: Record<string, string> = {
  'aspmx.l.google.com': 'google',
  'googlemail.com': 'google',
  'google.com': 'google',
  'mail.protection.outlook.com': 'microsoft',
  'outlook.com': 'microsoft',
  'pphosted.com': 'proofpoint',
  'ppe-hosted.com': 'proofpoint',
  'mimecast.com': 'mimecast',
  'mimecast.co.za': 'mimecast',
  'zoho.com': 'zoho',
  'zoho.eu': 'zoho',
  'messagingengine.com': 'fastmail',
  'yandex.net': 'yandex',
  'qq.com': 'tencent',
  'amazonaws.com': 'amazon-ses',
  'secureserver.net': 'godaddy',
  'emailsrvr.com': 'rackspace',
  'barracudanetworks.com': 'barracuda',
  'antispamcloud.com': 'spamexperts',
  'hostedemail.com': 'openxchange',
  'improvmx.com': 'improvmx',
  'migadu.com': 'migadu',
  'protonmail.ch': 'proton',
  'zohomail.eu': 'zoho',
};

/**
 * DKIM selectors known to be used by each provider.
 * MX-conditional probing: resolve MX first, probe only the relevant selectors.
 * This turns a 15-lookup brute force into 1-3 lookups WITH a higher hit rate.
 */
export const DKIM_SELECTORS_BY_PROVIDER: Record<string, string[]> = {
  google: ['google'],
  microsoft: ['selector1', 'selector2'],
  zoho: ['zoho', 'zmail'],
  proofpoint: ['pps', 'selector1'],
  mimecast: ['mimecast'],
  fastmail: ['fm1', 'fm2', 'fm3'],
  yandex: ['mail'],
  'amazon-ses': [],           // SES uses per-identity generated selectors; not enumerable
  godaddy: ['default'],
  proton: ['protonmail', 'protonmail2', 'protonmail3'],
  migadu: ['key1', 'key2'],
  improvmx: [],
};

/** Used only when MX provider is unknown/self-hosted. Deliberately short. */
export const DKIM_GENERIC_SELECTORS = [
  'default', 'selector1', 'selector2', 'dkim', 's1', 's2', 'k1', 'mail',
];

export const UNKNOWN_RATE_DEGRADED_THRESHOLD = 0.02;
```

---

### 4.2 `@mailscape/dns`

#### 4.2.1 Why not `node:dns`

Node's `dns.resolveTxt()` wraps c-ares and does not expose:
- the **RCODE** (so you cannot distinguish `NODATA` from `SERVFAIL` — see §1.1)
- the **AD flag** (so you lose DNSSEC entirely)

Both are load-bearing for this project. Build raw queries instead.

#### 4.2.2 `udp-client.ts`

```ts
import dgram from 'node:dgram';
import dnsPacket from 'dns-packet';
```

Requirements:
- Random 16-bit transaction ID per query; **verify the ID on the response** and discard mismatches.
- `recursionDesired: true`.
- EDNS0 with `flags: dnsPacket.DNSSEC_OK` so the resolver returns DNSSEC status; read `flag_ad` off the response.
- Per-query timeout from `TIMEOUTS.localMs`, implemented with `AbortSignal.timeout()` or an explicit timer that **always** clears in a `finally`.
- **Always close the socket** in a `finally` block. A leaked socket per query will exhaust file descriptors around query ~1000 and the crawl will die 40 minutes in with a confusing `EMFILE`.
- Handle truncation: if `flag_tc` is set, retry the same query over **TCP** (`node:net`, 2-byte length prefix). Large TXT/DKIM responses hit this.

**Implementation note on sockets:** one ephemeral UDP socket per query, at concurrency ≤100, is correct and simple. Do **not** build a socket pool with an in-flight transaction map for v1 — it is a meaningful source of bugs for a perf win you do not yet need. Revisit only if profiling shows socket setup dominating.

#### 4.2.3 `rcode.ts`

```ts
export function toLookupStatus(rcode: string, answerCount: number): LookupStatus {
  switch (rcode) {
    case 'NOERROR':  return answerCount > 0 ? 'ok' : 'nodata';
    case 'NXDOMAIN': return 'nxdomain';
    case 'SERVFAIL':
    case 'REFUSED':
    case 'NOTIMP':
    case 'TIMEOUT':
    case 'NETWORK_ERROR':
      return 'unknown';
    default:
      return 'unknown';
  }
}
```

This function is the enforcement point for §1.1. **Write its unit tests first.**

#### 4.2.4 `resolver.ts` — tiered resolution

```
query(name, type)
  ├─ Tier 1: local unbound @ 127.0.0.1:53, up to RETRY.localAttempts
  │     └─ status !== 'unknown' → return
  ├─ Tier 2: Cloudflare DoH  (https://cloudflare-dns.com/dns-query, accept: application/dns-json)
  │     └─ status !== 'unknown' → return, mark resolver: 'doh-cloudflare'
  ├─ Tier 3: Google DoH      (https://dns.google/resolve)
  │     └─ status !== 'unknown' → return, mark resolver: 'doh-google'
  └─ all failed → return { status: 'unknown', rcode: <last>, resolver: 'local' }
```

Two `bottleneck` limiters:

```ts
// Local recursion: high concurrency, no minTime. You are hitting thousands of
// different authoritative servers, not one endpoint.
const localLimiter = new Bottleneck({ maxConcurrent: 100 });

// DoH fallback: this IS one endpoint. Be conservative — it should only ever
// see 1-3% of traffic. If it sees more, the local resolver is broken; fix that
// rather than raising these numbers.
const dohLimiter = new Bottleneck({ maxConcurrent: 10, minTime: 20 });
```

Expose a `getStats()` returning per-tier counts and the running `unknown_rate`, for the run summary.

#### 4.2.5 `txt.ts`

```ts
/** DNS TXT records are arrays of <=255-byte chunks. Join with NO separator. */
export function joinTxtChunks(data: Buffer[] | Buffer): string {
  const chunks = Array.isArray(data) ? data : [data];
  return chunks.map(c => c.toString('utf8')).join('');
}
```

---

### 4.3 `@mailscape/parsers`

**Every function in this package is pure:** string in, structured object out. No network, no filesystem, no clock, no randomness. This is what makes them trivially testable and it is where most of the project's real logic lives.

Each parser returns a discriminated result rather than throwing:

```ts
export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };
```

#### `tag-value.ts` — shared tokenizer

DMARC, BIMI, MTA-STS TXT, and TLS-RPT all use `key=value; key=value` syntax. Write **one** tokenizer:

- Split on `;`
- Trim whitespace around keys and values
- Split each pair on the **first** `=` only (values contain `=`, especially in URIs and base64 keys)
- Ignore empty trailing segments (trailing `;` is legal and common)
- Preserve original tag order (the DMARC spec requires `v` first)
- Return `Map<string, string>` plus the ordered key list

#### `dmarc.ts`

Rules, per RFC 7489:
- Record must begin with `v=DMARC1` — and `v` must be the **first** tag. A record where it is not is invalid and must be reported as `parseError`, not silently accepted.
- `p` is required. Valid: `none`, `quarantine`, `reject`. Case-insensitive.
- `sp` optional; when absent, subdomain policy **inherits** `p`. Store the raw value (`undefined` when absent) — do **not** eagerly copy `p` into `sp`, or you destroy your ability to detect when someone explicitly adds an `sp` tag later.
- `pct` integer 0–100, default 100. Out-of-range = `parseError`.
- `adkim`/`aspf`: `r` (relaxed, default) or `s` (strict).
- `ri` integer, default 86400.
- `rua`/`ruf`: comma-separated URIs. Count them; extract **domain parts only** per §4.1.1.
- Unknown tags are ignored, not errors.

**Fixtures to test against** (capture real ones, but include these hand-written cases):
- Minimal valid: `v=DMARC1; p=none`
- Full: all tags populated
- `pct=0` (policy declared but applied to nothing — a real and interesting state)
- Missing `p`
- `v=DMARC1` not first
- Lowercase `v=dmarc1` (must be **rejected** — the version tag is case-sensitive per spec)
- Trailing semicolon
- Duplicate tags (first wins)
- Whitespace chaos: `v=DMARC1 ;  p = reject ;pct=100`

#### `spf.ts`

Per RFC 7208:
- Must begin with `v=spf1` (case-insensitive for `spf1`).
- Tokenize on whitespace.
- Mechanisms: `all`, `include`, `a`, `mx`, `ptr`, `ip4`, `ip6`, `exists`.
- Qualifiers: `+` (default), `-`, `~`, `?` — prefix on any mechanism.
- Modifiers: `redirect=`, `exp=`.
- **Count DNS-lookup-requiring terms**: `include`, `a`, `mx`, `ptr`, `exists`, `redirect`. The limit is **10**; exceeding it makes the record invalid in practice. Set `exceedsLookupLimit`. (Note: this is a static count of terms in *this* record, not a recursive resolution of nested includes. Document that limitation in `docs/METHODOLOGY.md` — a recursive count is a v2 feature.)
- Extract the qualifier on the final `all` mechanism. `-all` is strict, `~all` soft-fail, `?all` neutral, `+all` is effectively "anyone may send as us" and is worth flagging.
- Record `includes[]` — this reveals third-party sender ecosystems and is one of the more interesting derived datasets.

#### `mx.ts`

- Lowercase, strip trailing dot, sort by preference then name.
- **Null MX** (RFC 7505): a single MX with exchange `.` and preference 0 means the domain explicitly receives no mail. Set `isNullMx`. This is a *good* configuration and must not be counted as "missing MX."
- Provider classification: longest-suffix match against `MX_PROVIDERS`. Unmatched but present → `self-hosted`.

#### `mta-sts.ts`

Two stages:
1. **TXT** at `_mta-sts.<domain>`: `v=STSv1; id=<policy-id>`. Parse with the shared tokenizer.
2. **Policy fetch** — only if stage 1 succeeded (~2% of domains, so the cost is negligible): `GET https://mta-sts.<domain>/.well-known/mta-sts.txt`

Policy file is **not** tag-value — it is line-oriented `key: value`:
```
version: STSv1
mode: enforce
mx: mail.example.com
mx: *.example.net
max_age: 604800
```
- `mx` repeats; collect into an array.
- `mode` ∈ `enforce` | `testing` | `none`. **`mode` is the interesting field** — `testing` means the policy is published but not enforced, and the `testing → enforce` transition is exactly the kind of change this project exists to capture.
- Set a 10s fetch timeout, follow at most 3 redirects, and treat any failure as `policyError` with `policyFetched: false`. Never let a slow HTTPS fetch stall the DNS crawl — run policy fetches in a **separate pass** after the DNS pass completes.

#### `bimi.ts`

`v=BIMI1; l=<https url>; a=<https url>`
- `l=` present and non-empty → `hasLogo`
- `l=` present and **empty** → `declined: true` (explicit opt-out, distinct from absent)
- `a=` present → `hasVmc`

#### `tls-rpt.ts`

`v=TLSRPTv1; rua=mailto:...` — count destinations, apply §4.1.1 domain-only rule.

---

### 4.4 `@mailscape/store`

#### `paths.ts`

Every path in the project is constructed here. No string concatenation of paths anywhere else in the codebase.

```ts
export const paths = {
  root: (): string => ...,
  trancoListId: () => 'data/tranco/list-id.txt',
  trancoDomains: () => 'data/tranco/domains.csv.gz',
  trancoRollovers: () => 'data/tranco/rollovers.jsonl',
  snapshot: (shard: string) => `data/snapshots/latest/${shard}.jsonl`,
  changes: (date: string) => `data/changes/${date}.jsonl`,
  aggregateLatest: () => 'data/aggregates/latest.json',
  aggregateHistory: () => 'data/aggregates/history.jsonl',
  report: (date: string) => `reports/${date}.md`,
};
```

#### `jsonl.ts`

- Streaming line-by-line reads (`node:readline` over a read stream). **Never `JSON.parse(readFileSync(...))` on a snapshot file** — tier2 shards are ~14k lines and full snapshots will exceed available memory as the project grows.
- Writes go to a temp file then `fs.rename()` — atomic, so a crashed run never leaves a half-written snapshot that the next run reads as truth.
- Validate each line against its zod schema on read; on failure, log and skip the line rather than aborting the whole run.

#### `snapshot.ts` — sharding

```ts
/** Stable across Tranco list rollovers because it hashes the domain, not the rank. */
export function shardFor(domain: string, shards = 7): number {
  let h = 2166136261;                       // FNV-1a
  for (let i = 0; i < domain.length; i++) {
    h ^= domain.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % shards;
}
```

- **Tier 1** = ranks 1–1000. Crawled every 6 hours. Written to `tier1.jsonl`.
- **Tier 2** = ranks 1001–100000, split into 7 shards by `shardFor()`. One shard per day, rotating on `dayOfYear % 7`.

Snapshot files are **sorted by domain** before writing. This is what makes git's delta compression effective — an unsorted file produces a full-file diff every run and the repo will balloon.

#### `diff.ts` — the change engine

This is the second-most-important file in the project after `rcode.ts`. Rules:

```
for each domain in newSnapshot:
  prev = previousSnapshot[domain]

  if (!prev):
    emit { kind: 'first_seen' }
    // Do NOT emit per-field 'added' events for a domain we've never seen.
    // Otherwise every Tranco rollover floods the changes file.
    continue

  for each tracked field:
    if (new.status === 'unknown'):
      carry forward prev value; set stale=true, lastSeenAt=prev.crawledAt
      emit NOTHING                                    // §1.1
      continue

    if (prev.status === 'unknown'):
      take new value; clear stale
      emit NOTHING     // we didn't know before, so this isn't an observed change
      continue

    if (prev.value === undefined && new.value !== undefined) emit 'added'
    else if (prev.value !== undefined && new.value === undefined) emit 'removed'
    else if (prev.value !== new.value) emit 'modified'
```

**Tracked fields** (the dotted paths that produce change events):
```
spf.present, spf.allQualifier, spf.exceedsLookupLimit
dmarc.present, dmarc.p, dmarc.sp, dmarc.pct, dmarc.adkim, dmarc.aspf
bimi.present, bimi.hasLogo, bimi.hasVmc
mtaSts.present, mtaSts.mode
tlsRpt.present
mx.provider, mx.isNullMx
dnssec
```

Deliberately **not** tracked as change events (too noisy, stored in snapshot only): `spf.raw`, `dmarc.ruaHosts`, `mx.hosts`, `dkim.selectorsFound`, `mtaSts.policyId`.

#### `aggregate.ts`

Output schema (`data/aggregates/latest.json`):

```json
{
  "date": "2026-08-24",
  "listId": "K2XJW",
  "domainsObserved": 15286,
  "unknownRate": 0.011,
  "degraded": false,
  "totals": {
    "spf":    { "present": 12403, "allQualifier": { "-all": 3201, "~all": 8102, "?all": 512, "+all": 88 }, "exceedsLookupLimit": 431 },
    "dmarc":  { "present": 9812, "p": { "none": 5102, "quarantine": 2201, "reject": 2509 }, "pctBelow100": 340 },
    "bimi":   { "present": 412, "hasVmc": 288, "declined": 19 },
    "mtaSts": { "present": 1204, "mode": { "enforce": 802, "testing": 371, "none": 31 } },
    "tlsRpt": { "present": 1876 },
    "dnssec": { "signed": 2103, "unsigned": 13001, "unknown": 182 },
    "mx":     { "present": 14002, "isNullMx": 421 }
  },
  "byTld": { "com": { "...same shape..." } },
  "byMxProvider": { "google": { "...same shape..." } },
  "byRankBucket": { "1-1000": {}, "1001-10000": {}, "10001-100000": {} }
}
```

Append the same object (minus the `byTld`/`byMxProvider` breakdowns, to keep the file small) as one line to `data/aggregates/history.jsonl`. **This file is what makes the web dashboard's trend charts a single fetch with zero server-side work.**

Aggregation must be computed over **all** shards (read `tier1.jsonl` + all 7 tier2 shards from `latest/`), not just the shard crawled today. Domains not crawled today still count — their last known state is what's in `latest/`.

#### `report.ts` — the daily human-readable report

This file generates the artifact that makes the repo worth reading. It reads `data/changes/YYYY-MM-DD.jsonl` and `data/aggregates/latest.json` and produces `reports/YYYY-MM-DD.md`.

**Notability rules — what makes a change worth naming:**

1. **High-rank movers.** Any domain with `rank <= 1000` changing `dmarc.p`, `mtaSts.mode`, or `spf.allQualifier` is named individually.
2. **Weakening moves are always notable.** `reject → quarantine`, `reject → none`, `quarantine → none`, `enforce → testing`, `-all → ~all`. These are rarer than strengthening and more interesting. Always list them, at any rank.
3. **Clusters.** ≥5 domains sharing an `mxProvider` making the *same* field change on the *same* day is a probable provider-side default change. This is the highest-value finding the project produces — surface it prominently with the provider named.
4. **First-time adopters.** Count of domains going from `dmarc.present: false → true`, broken down by MX provider.
5. **Anomalies.** `unknownRate` above threshold; any single authoritative nameserver responsible for >100 `unknown` results (indicates their outage, not a real change).

Report template:

```markdown
# {date}

**{n} changes** across {m} domains observed.
{degraded ? '> ⚠️ Elevated unknown rate ({pct}%) — some results carried forward. See Anomalies.' : ''}

## Enforcement moves
- {cluster findings first, with provider named}
- {high-rank individual movers}
- {aggregate counts: "47 domains raised pct to 100"}

## Weakening
{always present if any exist, even one}

## First-time adopters
- {n} domains published DMARC for the first time
- {top provider breakdown}

## Anomalies
{unknown clusters, nameserver-level failures}

---
*Generated from Tranco list `{listId}`. Methodology: [docs/METHODOLOGY.md](../docs/METHODOLOGY.md).*
```

**If there are zero notable changes, write a short report saying so.** Do not pad it. A one-line report on a quiet day is more credible than manufactured prose.

---

### 4.5 `apps/crawler`

Thin. All logic lives in packages; this app only orchestrates and handles I/O boundaries.

#### `probe.ts`

Composes one `DomainSnapshot` for one domain:

```
1. MX lookup            (needed first — drives DKIM selector choice)
2. In parallel:
     TXT @ apex                    -> SPF
     TXT @ _dmarc.<d>              -> DMARC
     TXT @ default._bimi.<d>       -> BIMI
     TXT @ _mta-sts.<d>            -> MTA-STS
     TXT @ _smtp._tls.<d>          -> TLS-RPT
3. DKIM: selectors chosen from MX provider (§4.1 constants)
     TXT @ <selector>._domainkey.<d>
4. DNSSEC: AD flag from any successful response
```

MTA-STS **policy fetches are deferred** to a second pass over the ~2% of domains with a TXT record, so HTTPS latency never blocks the DNS pass.

#### CLI commands

```bash
mailscape fetch-list [--list-id <id>]   # download + gzip Tranco, write list-id.txt
mailscape crawl --tier 1                 # top 1000
mailscape crawl --tier 2 --shard 3       # one long-tail shard
mailscape crawl --tier 2 --auto          # shard = dayOfYear % 7
mailscape crawl --limit 100 --dry-run    # local dev: no writes
mailscape aggregate
mailscape report [--date YYYY-MM-DD]
```

Every command:
- Writes a **run summary** to stdout as structured JSON and, when `GITHUB_STEP_SUMMARY` is set, appends a markdown table to it. Seeing per-run stats in the Actions UI is worth the 10 lines it costs.
- Exits non-zero on hard failure (list unavailable, no writable data dir), zero on soft degradation (elevated unknown rate — flagged in data, not a crash).

#### Checkpointing

Write progress to `data/tmp/checkpoint-{shard}.json` every 500 domains (gitignored). On startup, if a checkpoint exists for today's run, resume from it. GitHub runners get killed; a 5-hour crawl that loses everything at hour 4 is unacceptable.

---

### 4.6 `apps/web`

**Build this last.** It is the least important part of the project and the most tempting to start with. Do not start with it.

#### Data loading

`deploy-web.yml` copies `data/aggregates/*`, the last 30 `data/changes/*.jsonl`, and the last 30 `reports/*.md` into `apps/web/public/data/` before `vite build`. **No runtime fetching of raw.githubusercontent.com** — build-time copy means no CORS, no rate limits, and the deployed site is a versioned artifact.

#### Pages

1. **Overview** — current adoption rates for each mechanism; sparkline trends from `history.jsonl`.
2. **Trends** — a real chart: DMARC policy distribution over time, stacked area. `mtaSts.mode` over time.
3. **Changes** — filterable table of recent `ChangeEvent`s. Filter by field, provider, direction (strengthening/weakening).
4. **Reports** — rendered list of daily markdown reports.
5. **Domain lookup** — type a domain, see its current state from the snapshot. Client-side only; ship a pre-built index for tier1 domains, and for the long tail show "not in current shard, last observed {date}".

#### Design brief

Before writing any component, produce a **design token plan**: 4–6 named hex values, typefaces for display / body / data roles, a layout concept, and one signature element. Review it against the brief, then build from it exactly.

- **Subject:** internet infrastructure measurement. The vernacular is zone files, `dig` output, RFC documents, monospace records, resolver traces.
- **Audience:** email security engineers, deliverability consultants, infrastructure researchers. They read `dig` output for a living. They want density and precision, not marketing.
- **The page's one job:** make a trend legible at a glance, and make an individual record inspectable in one click.

**Explicit anti-defaults — do not produce any of these:**
- Cream background (`#F4F1EA`-ish) + high-contrast serif display + terracotta accent (`#D97757`-ish).
- Near-black background with a single acid-green or vermilion accent. This is the lazy "terminal" answer and the subject matter makes it the *most* likely default here — reject it specifically.
- Broadsheet layout with hairline rules, zero border-radius, dense newspaper columns.

Take one real aesthetic risk and justify it in a comment. Spend boldness in **one** place — the signature element — and keep everything else quiet.

**Quality floor, unannounced:** responsive to mobile, visible keyboard focus states, `prefers-reduced-motion` respected, semantic HTML, chart data available as a table for screen readers.

**Copy rules:** active voice, sentence case, no filler. Name things as the user recognises them ("policy", "enforcement"), not as the system stores them ("dmarc.p"). Empty states direct the user to an action. Errors say what happened and what to do, and never apologise.

---

## 5. Phased execution

Each phase ends with acceptance checks. **Do not proceed until they pass.** Commit at the end of each phase with a conventional-commit message.

---

### Phase 0 — Scaffold

**Goal:** an empty monorepo where `pnpm -r build && pnpm -r test && pnpm lint` all succeed.

Tasks:
1. `git init`, Node 22 via `.nvmrc`, `pnpm-workspace.yaml` covering `packages/*` and `apps/*`.
2. Root `package.json` with scripts: `build`, `test`, `lint`, `typecheck`, `format`.
3. `tsconfig.base.json`:
   ```jsonc
   {
     "compilerOptions": {
       "target": "ES2023",
       "lib": ["ES2023"],
       "module": "NodeNext",
       "moduleResolution": "NodeNext",
       "strict": true,
       "noUncheckedIndexedAccess": true,
       "exactOptionalPropertyTypes": true,
       "noImplicitOverride": true,
       "noFallthroughCasesInSwitch": true,
       "isolatedModules": true,
       "verbatimModuleSyntax": true,
       "skipLibCheck": true,
       "declaration": true,
       "sourceMap": true
     }
   }
   ```
   `noUncheckedIndexedAccess` will make you handle `undefined` on array access. Keep it on — it catches real bugs in the parsers.
4. ESLint 9 flat config + `typescript-eslint` strict + Prettier. Rules to enable explicitly:
   - `@typescript-eslint/no-floating-promises` (error) — critical in a concurrency-heavy codebase
   - `@typescript-eslint/switch-exhaustiveness-check` (error) — makes `LookupStatus` handling provably total
   - `no-console` (error, allow `warn`/`error`) — use `pino`
   - `import/no-cycle` (error)
5. `vitest.config.ts` at root with workspace projects.
6. `.gitattributes`:
   ```
   * text=auto eol=lf
   *.jsonl text eol=lf
   *.csv text eol=lf
   data/tranco/domains.csv.gz binary
   ```
7. `.gitignore`: `node_modules`, `dist`, `.turbo`, `data/tmp`, `*.log`, `.DS_Store`, `apps/web/public/data`
8. `husky` + `lint-staged` pre-commit: format + lint staged files only.
9. `LICENSE` — MIT for code. Add `data/LICENSE` — **CC BY 4.0** for the dataset. Licensing code and data separately is the correct move for a dataset project and signals seriousness.
10. Empty placeholder `package.json` in each of the 6 workspace packages.

**Acceptance:**
```bash
pnpm install && pnpm -r build && pnpm -r test && pnpm lint && pnpm typecheck
```
All green. Commit: `chore: scaffold pnpm monorepo with strict TS, eslint, vitest`

---

### Phase 1 — `core` + `parsers` (no network at all)

**Goal:** every record format parses correctly, proven by tests, with zero I/O written yet.

This phase is pure functions and unit tests. It is the highest-value phase and the one most likely to be rushed. Do not rush it.

Tasks:
1. Implement all of `core/src/types.ts`, `constants.ts`, `schemas.ts` (zod mirrors of the types).
2. Implement `parsers/src/tag-value.ts` **first**, with its own tests.
3. Implement `dmarc.ts`, `spf.ts`, `bimi.ts`, `mta-sts.ts`, `tls-rpt.ts`, `mx.ts`.
4. Build `test/fixtures/` — capture real records with `dig` from at least 30 real domains spanning: Google-hosted, Microsoft-hosted, self-hosted, a bank, a government domain, a domain with null MX, a domain with a broken SPF exceeding 10 lookups, a domain with BIMI+VMC, a domain with MTA-STS in `testing` mode. **Real data surfaces edge cases you will not imagine.**
5. Write tests for every case listed under §4.3, plus the fixtures.

**Acceptance:**
- `pnpm --filter @mailscape/parsers test` — all pass.
- Coverage on `packages/parsers/src` **≥ 90% branches**. Enforce it in `vitest.config.ts` thresholds.
- Every parser handles: empty string, whitespace-only, missing version tag, wrong version tag, duplicate tags, trailing semicolon, mixed case — without throwing.

Commit: `feat(parsers): SPF, DMARC, BIMI, MTA-STS, TLS-RPT and MX parsing`

---

### Phase 2 — `dns`

**Goal:** resolve a single domain's records from the command line, with correct status classification.

Tasks:
1. `rcode.ts` + tests **first**. This is §1.1's enforcement point.
2. `txt.ts` + tests (including a >255 byte record that must be joined).
3. `udp-client.ts` — with TCP fallback on truncation.
4. `doh-client.ts` — Cloudflare + Google JSON APIs. Note their response shape differs from wire format; normalise both to the same internal type.
5. `resolver.ts` — tiered orchestration + bottleneck limiters + stats.
6. Integration test (network-dependent, tagged so CI can skip it): resolve `google.com`, `github.com`, and a known-NXDOMAIN name, assert correct statuses.
7. **Manually verify the four-state rule against reality:**
   - a domain with DMARC → `ok`
   - a domain without DMARC → `nodata`
   - `_dmarc.thisdoesnotexist-mailscape.invalid` → `nxdomain`
   - point the resolver at an unreachable IP → `unknown`, not `nodata`

**Acceptance:** step 7 passes by hand. If `unknown` and `nodata` are ever confused, stop and fix before continuing — nothing downstream is meaningful until this is right.

Commit: `feat(dns): raw UDP resolver with DoH fallback and four-state status`

---

### Phase 3 — crawl + store

**Goal:** `mailscape crawl --tier 1 --limit 100` produces a valid snapshot file locally.

Tasks:
1. `store/src/paths.ts`, `jsonl.ts`, `snapshot.ts` (+ `shardFor` tests — assert stable distribution across 7 shards on 10k sample domains, each shard within ±5% of 1/7).
2. `store/src/diff.ts` + **exhaustive tests**. Test matrix must cover every combination of `{prev status} × {new status}` and assert that `unknown` in either position emits no event.
3. `apps/crawler/src/probe.ts`, `config.ts`, `cli.ts`, `commands/fetch-list.ts`, `commands/crawl.ts`.
4. Tranco fetch: download from `https://tranco-list.eu/download/{listId}/full`, gzip, write `list-id.txt`. If no `--list-id` given and none exists, resolve the latest via the API and **pin it**.
5. Checkpointing.
6. `infra/unbound.conf`:
   ```
   server:
     interface: 127.0.0.1
     port: 53
     access-control: 127.0.0.0/8 allow
     qname-minimisation: yes
     auto-trust-anchor-file: "/var/lib/unbound/root.key"
     cache-min-ttl: 0
     cache-max-ttl: 3600
     num-threads: 4
     msg-cache-size: 128m
     rrset-cache-size: 256m
     outgoing-range: 8192
     num-queries-per-thread: 4096
     do-not-query-localhost: no
     hide-identity: yes
     hide-version: yes
   ```

**Acceptance:**
```bash
sudo unbound -c infra/unbound.conf -d &
pnpm mailscape fetch-list
pnpm mailscape crawl --tier 1 --limit 100
```
- `data/snapshots/latest/tier1.jsonl` exists, 100 lines, sorted by domain, every line validates against the zod schema.
- `unknownRate` < 2%.
- Run it a second time: `data/changes/{today}.jsonl` is created and is **empty or near-empty** (nothing should have changed in 5 minutes). If it is full of changes, the diff engine is broken — fix before continuing.

Commit: `feat(crawler): tiered crawl with sharding, checkpointing and change detection`

---

### Phase 4 — aggregate + report

**Goal:** `mailscape aggregate && mailscape report` produce a readable markdown report.

Tasks:
1. `store/src/aggregate.ts` + tests over a synthetic snapshot.
2. `store/src/report.ts` + tests: given a fixture changes file, assert the report names clusters, lists weakening moves, and handles the zero-change case gracefully.
3. Wire up the CLI commands.
4. Write `docs/SCHEMA.md` (field-by-field data dictionary) and `docs/METHODOLOGY.md` (how data is collected; **state the limitations honestly** — DKIM lower bound, static SPF lookup count, shard rotation meaning long-tail domains are observed weekly not daily, `unknown` carry-forward).

**Acceptance:** report generated from a real 1000-domain crawl reads as something a human would actually want to read. If it reads like generated filler, the notability rules in §4.4 are not being applied — fix them.

Commit: `feat(store): aggregation and daily report generation`

---

### Phase 5 — CI/CD

**Goal:** the whole thing runs unattended.

#### Contribution attribution — get this right

GitHub counts a commit toward the contribution graph when **all** of these hold:
- The commit's **author email** matches a **verified** email on the account.
- The commit is on the **default branch** or `gh-pages`.
- The repo is **not a fork**.

The *pusher* is irrelevant to the graph. So `GITHUB_TOKEN` is fine for attribution as long as you set the author correctly:

```yaml
- name: Configure git identity
  run: |
    git config user.name  "${{ vars.COMMIT_NAME }}"
    git config user.email "${{ vars.COMMIT_EMAIL }}"   # must be verified on the account
```

**However:** commits pushed with the default `GITHUB_TOKEN` do **not** trigger other workflows (GitHub blocks this to prevent recursion). So `aggregate.yml` will not fire on a push from `crawl.yml`. Choose one:
- **(a)** Use `workflow_run` triggers to chain them. Simplest, no secrets. **Prefer this.**
- **(b)** Push with a fine-grained PAT (`contents: write`) stored as a secret.
- **(c)** Offset the cron schedules and accept the coupling.

#### Concurrency and push collisions

Six workflows writing to one branch **will** collide. Every data-writing workflow gets:

```yaml
concurrency:
  group: mailscape-data-write
  cancel-in-progress: false      # queue, never cancel — a cancelled crawl loses data
```

And a push retry loop:
```bash
for i in 1 2 3 4 5; do
  git pull --rebase --autostash origin main && git push origin main && exit 0
  sleep $((RANDOM % 10 + 5))
done
echo "::error::Failed to push after 5 attempts"; exit 1
```

#### Workflow schedules

| Workflow | Schedule | Commits/day |
|---|---|---|
| `crawl-tier1.yml` | `0 */6 * * *` | 4 |
| `crawl-tier2.yml` | `30 2 * * *` | 1 |
| `aggregate.yml` | `workflow_run` after crawls | 1 |
| `report.yml` | `0 6 * * *` | 1 |
| `deploy-web.yml` | `workflow_run` after aggregate | 0 (Pages branch) |

Every workflow needs `permissions: contents: write` and `workflow_dispatch` for manual runs.

#### Crawl job skeleton

```yaml
jobs:
  crawl:
    runs-on: ubuntu-latest
    timeout-minutes: 330            # under the 360 hard limit, leaves room to commit
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm -r build
      - name: Start unbound
        run: |
          sudo apt-get update && sudo apt-get install -y unbound
          sudo unbound-anchor -a /var/lib/unbound/root.key || true
          sudo unbound -c "$GITHUB_WORKSPACE/infra/unbound.conf"
          sleep 2
          dig @127.0.0.1 google.com +short          # smoke test — fail fast
      - run: pnpm mailscape crawl --tier 1
      - name: Commit
        run: |
          git config user.name  "${{ vars.COMMIT_NAME }}"
          git config user.email "${{ vars.COMMIT_EMAIL }}"
          git add data
          git diff --staged --quiet && { echo "No changes"; exit 0; }
          git commit -m "data: tier1 crawl $(date -u +%FT%H:%MZ)"
          # ... push retry loop ...
```

#### Runner network caveat — verify early

**Before building the full pipeline, confirm GitHub-hosted runners permit high-volume outbound UDP/53.** Run a throwaway workflow that resolves 1,000 domains through local unbound and reports the `unknown_rate`. If it is elevated or the job hangs, outbound DNS is being throttled.

Fallback: run the crawl on a small VPS via a self-hosted runner or a cron + `git push`. This is arguably the better architecture anyway (warm resolver cache across runs, no 6-hour limit), so do not treat it as a defeat. Document whichever you choose in `docs/METHODOLOGY.md`.

**Acceptance:** trigger every workflow via `workflow_dispatch`. All succeed. A commit lands, authored by the configured email. Verify the commit appears on the contribution graph within ~5 minutes.

Commit: `ci: scheduled crawl, aggregate, report and deploy workflows`

---

### Phase 6 — web dashboard

Follow §4.6. Design tokens planned and critiqued **before** any component is written.

**Acceptance:** Lighthouse accessibility ≥ 95. Works at 375px. Keyboard-navigable. Deployed and reachable at the Pages URL. Charts render from real committed data, not mocks.

Commit: `feat(web): adoption dashboard on GitHub Pages`

---

### Phase 7 — documentation and launch

1. **`README.md`** — the single most important file for whether anyone takes this seriously:
   - What it is, in two sentences, above the fold.
   - A **real finding** from the actual data, immediately. Not "coming soon."
   - Link to the dashboard, latest report, and `SCHEMA.md`.
   - "How to use this data" with a copy-pasteable example (`curl` the aggregate JSON; `jq` a changes file).
   - **Limitations**, stated plainly and prominently. DKIM lower bound. Weekly long-tail cadence. `unknown` carry-forward. Static SPF lookup counting. A dataset that is honest about its limits is trusted; one that hides them gets discredited the first time someone finds one.
   - Citation block (BibTeX) — costs nothing, signals the dataset is meant to be cited, and researchers actually use it.
   - Tranco attribution and citation, as their license requires.
2. **`CONTRIBUTING.md`** — how to add an MX provider mapping or a DKIM selector. These are the natural first contributions from strangers.
3. Repo topics: `dns`, `email-security`, `dmarc`, `spf`, `dkim`, `mta-sts`, `dataset`, `open-data`.
4. GitHub Discussions on. Issue templates for "provider mapping" and "data correction".

---

## 6. Code quality standards

Apply throughout, not as a cleanup pass.

**Types**
- `strict: true`, no `any`. If you truly need an escape hatch use `unknown` and narrow.
- No non-null assertions (`!`). If the type says it might be undefined, handle it.
- Discriminated unions over optional-field soup. `ParseResult<T>` over `{ value?: T; error?: string }`.
- Parse at boundaries with zod; trust types internally.

**Errors**
- Parsers return `ParseResult`, never throw. Malformed DNS records are *expected input*, not exceptional.
- I/O throws; callers catch at the command level and decide degrade-vs-fail.
- Never swallow an error silently. Log with context (domain, record type, resolver tier) or rethrow.
- Custom error classes with a `code` field, so handling is on `code` not message string matching.

**Functions**
- One job each. If a name needs "and", split it.
- Pure by default. Push I/O to the edges: `probe.ts` and `commands/*` do I/O; nothing in `parsers` does.
- Prefer explicit parameter objects over 4+ positional args.

**Naming**
- Say what it is: `unknownRate` not `rate`. `dkimSelectorsFound` not `dkim`.
- Booleans read as assertions: `isNullMx`, `exceedsLookupLimit`, `policyFetched`.
- No abbreviations except established domain ones (`mx`, `spf`, `dmarc`, `ttl`, `rcode`).

**Comments**
- Comment **why**, never what. `// FNV-1a: stable across list rollovers because it hashes the domain, not the rank` is useful. `// hash the domain` is noise.
- Every non-obvious spec compliance decision gets an RFC reference: `// RFC 7489 §6.3: sp defaults to p when absent`.

**Testing**
- Parsers and diff: exhaustive unit tests, ≥90% branch coverage, enforced.
- Test names describe behaviour: `'records SERVFAIL as unknown, not absent'`, not `'test rcode 2'`.
- One assertion concept per test.
- Use real captured fixtures, not only synthetic strings.
- Network tests tagged and excluded from CI's default run.

**Commits**
- Conventional commits: `feat|fix|chore|docs|test|refactor|ci(scope): subject`.
- Automated data commits use the `data:` prefix so they are trivially filterable: `git log --invert-grep --grep='^data:'` shows only human work.
- One logical change per commit.

**Config**
- All tunables in `apps/crawler/src/config.ts`, overridable by env var, with documented defaults. No magic numbers scattered through the code.

---

## 7. Anti-patterns — do not do these

These are the specific mistakes most likely to occur while executing this plan.

1. **Do not use `dns.promises` / `dns.resolveTxt()`.** No RCODE, no AD flag. §4.2.1.
2. **Do not collapse the four states into a boolean.** The single most damaging possible bug. §1.1.
3. **Do not add a database.** Files in git *are* the storage layer, and the versioning is the product. SQLite, Postgres, Mongo — all wrong here.
4. **Do not commit full snapshots as new files per day.** The repo will exceed a gigabyte within months. Overwrite `latest/`, append changes-only.
5. **Do not write unsorted snapshot files.** Kills git delta compression.
6. **Do not build the web app first.** It is Phase 6 for a reason.
7. **Do not add a server, API, or auth.** It is a static dataset. Zero operational surface is a feature.
8. **Do not invent dependencies.** Every package named in §2 exists. If you want one that is not listed, justify it or do without.
9. **Do not over-abstract.** No `AbstractRecordParserFactory`. Six parsers, six files, one shared tokenizer.
10. **Do not use `axios`, `node-fetch`, or `got`.** Node 22 has `fetch`.
11. **Do not raise the DoH limiter to paper over local resolver problems.** If DoH is handling >5% of traffic, unbound is misconfigured. Fix the cause.
12. **Do not commit `data/tmp/`.** Checkpoints are ephemeral.
13. **Do not backdate commits with `GIT_COMMITTER_DATE`.** It is visible in the raw commit objects and it is fabrication, not scheduling.
14. **Do not publish full `rua`/`ruf` email addresses.** §4.1.1.
15. **Do not let one crawl produce 8 sliced commits.** Multiple commits per day should come from genuinely distinct jobs on distinct schedules — which the architecture already provides. Artificial slicing is visible and undermines the whole point.

---

## 8. Final verification checklist

Before declaring v1 done, verify every line:

**Correctness**
- [ ] `unknown` never produces a change event — proven by a test.
- [ ] `nodata` and `nxdomain` are distinguished in stored data.
- [ ] TXT chunks >255 bytes are joined correctly — proven by a test.
- [ ] Multiple SPF records are recorded, not silently reduced to the first.
- [ ] No `hasDkim` field exists anywhere in the codebase.
- [ ] Tranco list ID is pinned and embedded in every snapshot and aggregate.
- [ ] Null MX is recorded as a valid configuration, not a missing MX.
- [ ] `sp` absent is stored as absent, not eagerly copied from `p`.

**Pipeline**
- [ ] A full tier-1 crawl completes in under 30 minutes with `unknownRate` < 2%.
- [ ] Two consecutive crawls minutes apart produce a near-empty changes file.
- [ ] Nothing is committed when nothing changed.
- [ ] A killed crawl resumes from its checkpoint.
- [ ] Snapshot writes are atomic (temp + rename).

**CI**
- [ ] Every workflow runs green via `workflow_dispatch`.
- [ ] Commits are authored by the verified email and appear on the contribution graph.
- [ ] Concurrent workflows queue rather than collide.
- [ ] The push retry loop is exercised and works.

**Quality**
- [ ] `pnpm lint && pnpm typecheck && pnpm test` all pass.
- [ ] Parser branch coverage ≥ 90%.
- [ ] No `any`, no `!` assertions, no `console.log`.
- [ ] No circular imports; dependency direction from §3 holds.

**Publication**
- [ ] README states limitations prominently.
- [ ] `docs/SCHEMA.md` documents every field.
- [ ] `docs/METHODOLOGY.md` explains collection and its honest limits.
- [ ] Code is MIT, data is CC BY 4.0, Tranco is attributed.
- [ ] Dashboard is live and renders real data.
- [ ] At least one daily report exists that a stranger would find interesting.

---

## 9. Notes for the executing model

- **Work in phase order.** Each phase's acceptance checks are a gate, not a suggestion.
- **When the plan and your instinct disagree, follow the plan** — most rules here exist because the obvious approach produces silent data corruption. If you believe a rule is genuinely wrong, say so explicitly and explain why rather than quietly deviating.
- **Where the plan is silent, use judgement** and note the decision in the commit message.
- **Run the tests constantly.** This project's failure mode is not a crash — it is plausible-looking wrong data. Tests are the only defence.
- **Prefer boring code.** The interesting part of this project is the dataset, not the implementation.
