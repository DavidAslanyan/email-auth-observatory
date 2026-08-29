/**
 * Runtime validation at read boundaries. Types are trusted inside the process;
 * anything arriving from disk or the network is parsed through these first.
 *
 * Note on the plan's "core has zero runtime dependencies": zod is the single
 * exception, and it is one the plan itself creates by placing schemas.ts in
 * core. The intent of the rule — core depends on no other mailscape package and
 * pulls in nothing that does I/O — still holds.
 */
import { z } from 'zod';

export const lookupStatusSchema = z.enum(['ok', 'nodata', 'nxdomain', 'unknown']);
export const resolverTierSchema = z.enum(['local', 'doh-cloudflare', 'doh-google']);
export const dnssecStateSchema = z.enum(['signed', 'unsigned', 'unknown']);
export const dmarcPolicySchema = z.enum(['none', 'quarantine', 'reject']);
export const dmarcAlignmentSchema = z.enum(['r', 's']);
export const spfQualifierSchema = z.enum(['+', '-', '~', '?']);
export const mtaStsModeSchema = z.enum(['enforce', 'testing', 'none']);
export const dkimProbeStrategySchema = z.enum(['mx-conditional', 'generic-fallback', 'skipped']);
export const changeKindSchema = z.enum(['added', 'removed', 'modified', 'first_seen']);

const lookupMetaShape = {
  status: lookupStatusSchema,
  rcode: z.string(),
  resolver: resolverTierSchema,
  elapsedMs: z.number().nonnegative(),
  ad: z.boolean(),
  stale: z.boolean().optional(),
  lastSeenAt: z.string().optional(),
};

export const spfStateSchema = z.object({
  ...lookupMetaShape,
  present: z.boolean(),
  raw: z.string().optional(),
  multipleRecords: z.boolean(),
  recordCount: z.number().int().nonnegative(),
  allQualifier: spfQualifierSchema.optional(),
  lookupCount: z.number().int().nonnegative().optional(),
  exceedsLookupLimit: z.boolean().optional(),
  hasRedirect: z.boolean(),
  includes: z.array(z.string()),
  parseError: z.string().optional(),
});

export const dmarcStateSchema = z.object({
  ...lookupMetaShape,
  present: z.boolean(),
  raw: z.string().optional(),
  multipleRecords: z.boolean(),
  p: dmarcPolicySchema.optional(),
  sp: dmarcPolicySchema.optional(),
  pct: z.number().int().min(0).max(100).optional(),
  adkim: dmarcAlignmentSchema.optional(),
  aspf: dmarcAlignmentSchema.optional(),
  fo: z.string().optional(),
  ri: z.number().int().nonnegative().optional(),
  ruaCount: z.number().int().nonnegative(),
  rufCount: z.number().int().nonnegative(),
  ruaHosts: z.array(z.string()),
  parseError: z.string().optional(),
});

export const bimiStateSchema = z.object({
  ...lookupMetaShape,
  present: z.boolean(),
  raw: z.string().optional(),
  hasLogo: z.boolean(),
  hasVmc: z.boolean(),
  declined: z.boolean(),
  parseError: z.string().optional(),
});

export const mtaStsStateSchema = z.object({
  ...lookupMetaShape,
  present: z.boolean(),
  policyId: z.string().optional(),
  policyFetched: z.boolean(),
  mode: mtaStsModeSchema.optional(),
  maxAge: z.number().int().nonnegative().optional(),
  mxPatternCount: z.number().int().nonnegative().optional(),
  policyError: z.string().optional(),
});

export const tlsRptStateSchema = z.object({
  ...lookupMetaShape,
  present: z.boolean(),
  raw: z.string().optional(),
  ruaCount: z.number().int().nonnegative(),
  ruaHosts: z.array(z.string()),
  parseError: z.string().optional(),
});

export const mxStateSchema = z.object({
  ...lookupMetaShape,
  present: z.boolean(),
  hosts: z.array(z.string()),
  provider: z.string().optional(),
  isNullMx: z.boolean(),
});

export const dkimStateSchema = z.object({
  status: lookupStatusSchema,
  selectorsFound: z.array(z.string()),
  selectorsProbed: z.array(z.string()),
  probeStrategy: dkimProbeStrategySchema,
});

export const domainSnapshotSchema = z.object({
  domain: z.string().min(1),
  rank: z.number().int().positive(),
  listId: z.string().min(1),
  crawledAt: z.string().min(1),
  dnssec: dnssecStateSchema,
  spf: spfStateSchema,
  dmarc: dmarcStateSchema,
  bimi: bimiStateSchema,
  mtaSts: mtaStsStateSchema,
  tlsRpt: tlsRptStateSchema,
  mx: mxStateSchema,
  dkim: dkimStateSchema,
});

export const changeValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const changeEventSchema = z.object({
  domain: z.string().min(1),
  rank: z.number().int().nonnegative(),
  field: z.string().min(1),
  kind: changeKindSchema,
  from: changeValueSchema,
  to: changeValueSchema,
  ts: z.string().min(1),
  mxProvider: z.string().optional(),
});

const tallySchema = z.record(z.string(), z.number().int().nonnegative());

export const aggregateTotalsSchema = z.object({
  spf: z.object({
    present: z.number().int().nonnegative(),
    allQualifier: tallySchema,
    exceedsLookupLimit: z.number().int().nonnegative(),
  }),
  dmarc: z.object({
    present: z.number().int().nonnegative(),
    p: tallySchema,
    pctBelow100: z.number().int().nonnegative(),
  }),
  bimi: z.object({
    present: z.number().int().nonnegative(),
    hasVmc: z.number().int().nonnegative(),
    declined: z.number().int().nonnegative(),
  }),
  mtaSts: z.object({ present: z.number().int().nonnegative(), mode: tallySchema }),
  tlsRpt: z.object({ present: z.number().int().nonnegative() }),
  dnssec: tallySchema,
  mx: z.object({
    present: z.number().int().nonnegative(),
    isNullMx: z.number().int().nonnegative(),
  }),
});

export const aggregateSliceSchema = z.object({
  domainsObserved: z.number().int().nonnegative(),
  totals: aggregateTotalsSchema,
});

const aggregateBaseShape = {
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  listId: z.string().min(1),
  domainsObserved: z.number().int().nonnegative(),
  unknownRate: z.number().min(0).max(1),
  degraded: z.boolean(),
  totals: aggregateTotalsSchema,
  byRankBucket: z.record(z.string(), aggregateSliceSchema),
};

export const aggregateSchema = z.object({
  ...aggregateBaseShape,
  byTld: z.record(z.string(), aggregateSliceSchema),
  byMxProvider: z.record(z.string(), aggregateSliceSchema),
});

export const aggregateHistoryEntrySchema = z.object(aggregateBaseShape);

export const rolloverEntrySchema = z.object({
  ts: z.string().min(1),
  fromListId: z.string().nullable(),
  toListId: z.string().min(1),
  entered: z.array(z.string()),
  left: z.array(z.string()),
  enteredCount: z.number().int().nonnegative(),
  leftCount: z.number().int().nonnegative(),
});

export type RolloverEntry = z.infer<typeof rolloverEntrySchema>;
