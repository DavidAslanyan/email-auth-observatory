#!/usr/bin/env node
/**
 * Checks every stored snapshot record against the schema.
 *
 * Reads through the store rather than parsing the JSONL, because that is the
 * real contract: records omit values held once per shard in the sidecar, and
 * only readSnapshot restores them. Parsing the files directly would test the
 * storage encoding instead of the data, and would fail for the wrong reason
 * every time that encoding changes.
 *
 * Exits non-zero if any record fails, so CI can gate on it.
 */
import { domainSnapshotSchema } from '@mailscape/core';
import { readSnapshot, allShardNames } from '@mailscape/store';

let total = 0;
let bad = 0;
const listIds = new Set();

for (const shard of allShardNames()) {
  for await (const snapshot of readSnapshot(shard)) {
    total += 1;
    listIds.add(snapshot.listId);
    const result = domainSnapshotSchema.safeParse(snapshot);
    if (!result.success) {
      bad += 1;
      if (bad <= 3) console.error('INVALID', snapshot.domain, result.error.issues[0]);
    }
  }
}

console.log(`schema-invalid records : ${bad} / ${total}`);
console.log(`distinct listIds       : ${[...listIds].join(', ')}`);
console.log(`every record has listId: ${listIds.has(undefined) ? 'NO' : 'yes'}`);

if (bad > 0 || listIds.has(undefined)) process.exitCode = 1;
