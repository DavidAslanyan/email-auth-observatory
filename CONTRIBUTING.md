# Contributing

The two most useful contributions are also the easiest, and both are one-line
additions to `packages/core/src/constants.ts`.

## Adding an MX provider mapping

Provider classification is what makes the cluster findings work — "40
mimecast-hosted domains changed policy on the same day" is only visible if we
know those forty domains are on Mimecast. The table is a suffix map, and it is
certainly incomplete.

1. Find the MX hostname suffix:

   ```bash
   dig +short MX example.com
   # 10 mx1.some-provider.net.
   ```

2. Add the **registrable suffix**, not the full hostname, to `MX_PROVIDERS`:

   ```ts
   'some-provider.net': 'some-provider',
   ```

   Matching is longest-suffix-wins, so a more specific entry can safely sit
   beneath a broader one.

3. Add a test case to `packages/parsers/test/mx.test.ts` asserting the
   classification, and run `pnpm --filter @mailscape/parsers test`.

Use a lowercase, hyphenated provider name that a human would recognise
(`amazon-ses`, not `AWS SES`). The name becomes a key in `byMxProvider`, so
changing it later breaks anyone's historical queries — pick carefully.

## Adding DKIM selectors for a provider

Selector probing is MX-conditional: we resolve MX first and then probe only the
selectors that provider is known to use. This is both cheaper and more accurate
than brute-forcing a generic list.

```ts
export const DKIM_SELECTORS_BY_PROVIDER: Record<string, string[]> = {
  'some-provider': ['sel1', 'sel2'],
};
```

Two rules:

- **An empty array means "do not guess", not "no selectors".** Amazon SES
  generates a distinct selector per verified identity, so it is mapped to `[]`
  and probing is skipped entirely rather than wasting lookups.
- Keep the list short. Every selector is one DNS query per domain, multiplied
  by every domain on that provider.

Verify a selector really is in use before adding it:

```bash
dig +short TXT sel1._domainkey.example.com
```

## Correcting the data

If a record looks wrong, it is usually one of three things, in order of
likelihood:

1. **It was correct when observed.** Records change. Check `crawledAt` and
   `stale` on the snapshot line before concluding anything.
2. **The value was carried forward.** `stale: true` means the lookup failed and
   the previous value was kept; `lastSeenAt` says when it was last really seen.
3. **A parser bug.** Open an issue with the raw record
   (`dig +short TXT _dmarc.example.com`) and what you expected. A failing test
   case in `packages/parsers/test/` is the fastest possible fix.

Please do not open issues asking for a domain's DKIM status to be "corrected" to
say it has DKIM. Selectors cannot be enumerated from DNS; a domain publishing
DKIM under a selector we did not guess is expected behaviour, not a bug. See
[the methodology](docs/METHODOLOGY.md#dkim-findings-are-a-lower-bound-always).

## Working on the code

```bash
pnpm install
pnpm -r build
pnpm test          # the full suite, no network
pnpm test:network  # the live DNS specs, opt-in
pnpm lint && pnpm typecheck
```

Things that will fail review:

- Collapsing the four lookup states into a boolean. `unknown` means *we* failed
  and must never be recorded as absence — this is the one bug that silently
  produces plausible-looking garbage.
- A `hasDkim` field, in any form.
- Emitting a change event when either side of a comparison is `unknown`.
- Committing full `rua`/`ruf` email addresses.
- Writing an unsorted snapshot file, which destroys git's delta compression.
- Adding a database. Files in git *are* the storage layer, and the versioning is
  the product.

Parsers are pure — string in, structured object out, no I/O — and that is
enforced by lint, not by convention. Branch coverage on
`packages/parsers/src` must stay at or above 90%, which is enforced in
`vitest.config.ts`.

Commits follow conventional commits. Automated data commits use the `data:`
prefix so they can be filtered out with
`git log --invert-grep --grep='^data:'` — please keep human commits off that
prefix.
