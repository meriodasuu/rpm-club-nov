# Rental evidence and draw transaction contract

Rental writers already hold account/rental row locks when their SQL trigger takes:

```sql
SELECT pg_advisory_xact_lock(hashtextextended('giveaway-rental-evidence',0));
```

Draw takes the same evidence lock before calculating its snapshot. While holding it,
draw must use ordinary MVCC SELECTs for rentals, giveaway_rental_events, users,
loyalty_accounts and tier history. It must not use FOR UPDATE, FOR SHARE,
FOR KEY SHARE or any UPDATE/DELETE on those source rows, nor call a service that
acquires their locks. Otherwise a writer holding an account lock and waiting for
evidence can deadlock with draw waiting for that account lock.

Draw writes only giveaway/snapshot/winner, award and outbox rows. Reward issuance
must not call loyalty credit/account-mutating helpers inside this transaction.
Any future reward type that needs such a mutation needs a different lock protocol
or separate idempotent post-draw work. Foreign key effects must also be reviewed
when adding award writes: they must not introduce a dependency on locks held by a
writer waiting for evidence. Current rental update writers lock accounts/rentals,
not the referenced user keys.

With READ COMMITTED, acquire the evidence lock in its own SQL statement, then read
the evidence in later statements. Do not take a repeatable-read snapshot before
waiting for the lock. The lock waits for earlier evidence writers to commit; a
writer blocked behind draw has not recorded its new evidence yet. Ordinary reads
see its previously committed state and do not wait for its row locks.

The time cutoff remains changed_at < ends_at (write time after evidence lock, not
commit time), with changed_at DESC,id DESC selecting the latest event per rental.
The two-connection integration test in giveaways-rental-times.integration.test.ts
reproduces a writer holding both row locks, verifies that its UPDATE is blocked by
draw's evidence lock using pg_blocking_pids, completes MVCC reads, then commits
draw and verifies that the writer completes.
