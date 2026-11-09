# Update-card PIN regression tests

Latest forward-only patch: `20261105000400_fix_legacy_pin_cooldown.sql`.
Real PostgreSQL regression results and full local suite: `LEGACY-PIN-FIX.md`.
The earlier migration file below is retained unchanged as historical preparation.

Run only against a new disposable LOCAL PostgreSQL database with pgcrypto
available. Do not use a production connection string. No customer data is needed.

From the repository root, using psql configured for that local database:

```powershell
psql -X -v ON_ERROR_STOP=1 -f supabase/tests/update_card_review_url_fixture.sql
psql -X -v ON_ERROR_STOP=1 -f supabase/migrations/20261104000200_fix_update_card_pin_verification.sql
psql -X -v ON_ERROR_STOP=1 -f supabase/tests/update_card_review_url.sql
```

The bootstrap creates only the minimal tables and pgcrypto schema in an empty
database. It is not a production migration. The regression tests insert synthetic
data and roll back their transaction, including all simulated expiry changes.
If psql reports an error, the run failed; closing the connection rolls back the
open test transaction. The migration and bootstrap remain in the disposable DB.

Coverage: NULL PIN rejected before writes, incorrect PIN rejected, failures 1–4
remain unlocked, failure 5 locks for exactly 15 minutes, requests during a lock
do not increment or extend it, exact-expiry failure starts at 1, the next lock
requires five new failures, correct legacy bcrypt PIN succeeds after expiry,
success resets attempts, existing hash/business data remain unchanged, missing
hash fails closed, and existing URL validation remains in effect.

The migration changes only the existing RPC body. CREATE OR REPLACE retains its
signature, owner, and existing execution grants; SECURITY DEFINER and empty
search_path are retained. No PIN rehash, data rewrite, API/activation changes,
or URL routing changes are performed. NULL requests now return false before
creating/incrementing attempts; API rate limiting is outside this patch.

Before production application, run these tests locally, then verify against an
isolated staging schema with the actual roles/RLS. Review function owner/grants
before and after; also verify concurrent requests serialize on the per-card
attempt row. The single-session test does not prove concurrent behavior, though
the existing INSERT ON CONFLICT and SELECT FOR UPDATE are preserved.

Production application is a separate manual step and is not authorized by this
test procedure. No migration has been applied to production by this change.
