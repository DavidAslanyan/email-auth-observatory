---
name: Data correction
about: Report a record that appears wrong in the dataset
title: 'data: '
labels: data-correction
---

**Domain**:

**What the dataset says** — the relevant part of its line in
`data/snapshots/latest/`:

```json
```

**What DNS says right now**:

```
$ dig +short TXT _dmarc.example.com
```

**Before filing, please check:**

- [ ] `crawledAt` on that line — the record may have changed since it was observed.
- [ ] `stale` on that record — if `true`, the lookup failed and the previous
      value was carried forward; `lastSeenAt` says when it was last really seen.
- [ ] This is not a DKIM "false negative". Selectors cannot be enumerated from
      DNS, so a domain publishing DKIM under a selector we did not guess is
      expected rather than a bug.
