---
name: Provider mapping
about: Add or correct an MX provider or DKIM selector mapping
title: 'provider: '
labels: provider-mapping
---

**Provider name** (lowercase, hyphenated, as a human would recognise it):

**MX hostname suffix** — output of `dig +short MX <a domain using it>`:

```
```

**DKIM selectors**, if known — output of `dig +short TXT <selector>._domainkey.<domain>`:

```
```

Leave the selector list empty if the provider generates a distinct selector per
identity (like Amazon SES); we skip probing entirely in that case rather than
wasting lookups.

**Domains that use it**, so the mapping can be verified:
