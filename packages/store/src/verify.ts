import type { ChangeEvent, DomainSnapshot } from '@observatory/core';
import { diffDomain } from './diff.js';

/**
 * A change event that claims something the domain used to publish has gone.
 *
 * These deserve a second look before they are recorded. `unknown` already
 * protects against a resolver that fails outright, but a resolver that answers
 * NOERROR with an incomplete answer set — which happens under sustained load —
 * looks exactly like a domain that withdrew a record. That produces a false
 * "weakening" event, which is the most damaging kind of wrong entry this
 * dataset can contain: weakening moves are rare, so the report surfaces every
 * one of them prominently.
 *
 * Disappearances are a tiny fraction of any crawl, so confirming them with a
 * second lookup costs very little and removes the whole class of error.
 */
export function isDisappearance(event: ChangeEvent): boolean {
  if (event.kind === 'first_seen') return false;
  if (event.kind === 'removed') return true;
  // `present` flipping true -> false is a removal expressed as a modification.
  return event.field.endsWith('.present') && event.from === true && event.to === false;
}

/** The domains in this change set that claim to have lost something. */
export function domainsClaimingDisappearance(events: readonly ChangeEvent[]): string[] {
  return [...new Set(events.filter(isDisappearance).map((e) => e.domain))];
}

export interface ConfirmResult {
  events: ChangeEvent[];
  snapshots: DomainSnapshot[];
  /** Change events dropped because a second lookup contradicted them. */
  retracted: number;
  /** Domains whose first answer turned out to be incomplete. */
  contradicted: string[];
}

/**
 * Re-checks every domain whose diff claims a record has gone, and drops the
 * claim when a second lookup finds the record still there.
 *
 * The I/O is supplied by the caller so the policy — which domains to re-check,
 * and how to merge the second opinion — can be tested without a network.
 *
 * A reprobe that fails returns undefined and the original result stands: a
 * failed confirmation is not evidence of anything, and inventing a second
 * opinion from a failure would be the same mistake in the opposite direction.
 */
export async function confirmDisappearances(
  previous: ReadonlyMap<string, DomainSnapshot>,
  diff: { events: ChangeEvent[]; snapshots: DomainSnapshot[] },
  reprobe: (snapshot: DomainSnapshot) => Promise<DomainSnapshot | undefined>,
): Promise<ConfirmResult> {
  const suspect = new Set(domainsClaimingDisappearance(diff.events));
  if (suspect.size === 0) {
    return { events: diff.events, snapshots: diff.snapshots, retracted: 0, contradicted: [] };
  }

  const events = diff.events.filter((e) => !suspect.has(e.domain));
  const snapshots = diff.snapshots.filter((s) => !suspect.has(s.domain));
  const contradicted: string[] = [];
  let retracted = 0;

  const affected = diff.snapshots.filter((s) => suspect.has(s.domain));
  const fresh = await Promise.all(affected.map(reprobe));

  for (const [index, original] of affected.entries()) {
    const chosen = fresh[index] ?? original;
    const redone = diffDomain(previous.get(original.domain), chosen);

    const before = diff.events.filter((e) => e.domain === original.domain).length;
    if (redone.events.length < before) {
      retracted += before - redone.events.length;
      contradicted.push(original.domain);
    }

    events.push(...redone.events);
    snapshots.push(redone.snapshot);
  }

  return { events, snapshots, retracted, contradicted };
}
