# Release safety: migrations, schema gating, emergency stop, rollback

Companion to [production-runbook.md](production-runbook.md). This file documents the
mechanisms that exist in code, so an operator can verify them rather than trust a summary.

Related: [deployment.md](deployment.md) · [post-remediation.md](post-remediation.md)

---

## 1. Applying migrations safely

The runner is `web/scripts/migrate.ts`. It does **not** import the application config, so
no `.env.local`, `.env`, or `.env.production` file can choose the target database. The
target must be injected into the process environment.

```bash
cd web

# Local disposable database
DATABASE_URL='postgresql://sendstack:sendstack@127.0.0.1:55432/sendstack_test' pnpm db:migrate

# Plan only, no writes
DATABASE_URL='…' pnpm db:migrate -- --dry-run

# Production: inject the protected URL into the process environment only.
# A non-local target also requires --confirm-target=<fingerprint> printed by a dry-run.
DATABASE_URL='…' pnpm db:migrate -- --dry-run
DATABASE_URL='…' pnpm db:migrate -- --confirm-target=<fingerprint>
```

### What the runner enforces

| Control | Behaviour |
| --- | --- |
| Explicit target | Refuses to start when `DATABASE_URL` is not injected |
| No dotenv fallback | Never reads `.env*`, so the target is always deliberate |
| Replica guard | Refuses when `pg_is_in_recovery()` is true |
| Fingerprint pin | `--expect-fingerprint=<hex10>` aborts on a different host, port, or database |
| Production confirmation | Non-local applies refuse to write without `--confirm-target` equal to that fingerprint |
| Dry-run | Performs no ledger creation, alteration, or checksum writes |
| Single runner | `pg_try_advisory_lock` refuses a concurrent run instead of queueing |
| Immutable history | Refuses when an applied migration file's checksum changed (`--allow-drift` to override deliberately) |
| Ledger integrity | Refuses when `schema_migrations` names a file absent from disk |
| Ordering | Refuses a pending migration that sorts before the latest applied one |
| Post-apply assertion | Verifies every required table, column, index, and constraint after applying |

The sanitized target fingerprint is `SHA-256(normalizedHost|port|databaseName)` truncated
to 10 hex characters. The host has any `-pooler` label removed. The database name in the
URL must match `current_database()`. Two servers that share a database name do not share
a fingerprint. The connection string is never printed. A fingerprint computed from
`current_database()` alone is not a target confirmation.

### Ledger columns

The runner owns three additive columns on `schema_migrations` (`checksum`,
`checksum_source`, `duration_ms`) and creates them with `ADD COLUMN IF NOT EXISTS`. Rows
applied before this runner existed get `checksum_source='baseline'` on first run: drift is
detectable from that point forward, not retroactively.

---

## 2. Schema gating in the running application

A deploy whose code is ahead of the database is detected instead of failing per request.

- `web/lib/schema-contract.ts` is the single declaration of the required schema.
- `GET /healthz` returns `503` with `code: database_migration_required` and the names of
  missing objects when the schema is behind; `200` with `database: "ready"` when it matches.
- `GET /api/production-readiness` includes a `schema` block and a `launch_job_cron` check,
  and `ready_for_live_sending` is false unless both pass.
- Any database error that reaches the API boundary is translated by
  `web/lib/db-errors.ts`. Clients receive fixed text plus a `code`; raw PostgreSQL text
  (for example `relation "…" does not exist`), SQLSTATEs, relation names, and constraint
  names are never returned. SQLSTATE is kept in server logs only, after redaction of
  connection strings, tokens, and email addresses.

Verify after any deploy:

```bash
curl -s https://<production-host>/healthz
# expect {"status":"ok",…,"database":"ready","schema_migrations_applied":6}
```

---

## 3. Emergency stop

Set `SENDSTACK_EMERGENCY_STOP=true` (or `1`) in the production environment and redeploy or
restart so the runtime picks it up. Enforced in four independent places:

| Location | Effect |
| --- | --- |
| `lib/providers/resend.ts` (`liveSendAllowed`) | Every provider HTTP call fails closed |
| `lib/api-router.ts` (test send, launch) | Returns `403 SENDSTACK_EMERGENCY_STOP is enabled.` |
| `lib/launch-jobs.ts` (`runLaunchWorkerTick`) | Returns without claiming any job |
| `lib/launch-jobs.ts` (`preflightIrreversibleOp`) | Parks the job (`pending` + `next_retry_at`), releasing the lease |
| `lib/delivery-health.ts` | Adds a blocking reason, so readiness reports launch-blocked |

The stop is **reversible by design**: it parks in-flight jobs rather than terminalizing
them, so clearing the variable resumes the launch with no database repair. Reserved daily
volume is intentionally retained while parked, because the send may still proceed.

Regression coverage: `tests/pg-integration.test.ts` and
`tests/pg-launch-safety.test.ts` assert that no job is claimed, nothing becomes terminal,
and the launch resumes once the stop is cleared.

To test without sending: set the variable in a preview or local environment, then confirm
`POST /api/campaigns/:id/test-send` returns 403 and readiness reports launch-blocked.

---

## 3a. Duplicate-send invariants in the launch worker

Resend honours `Idempotency-Key` only on `POST /emails` and `POST /emails/batch` — **not**
on `POST /broadcasts/{id}/send`. The provider therefore offers no protection against a
second broadcast submission, and these invariants in `lib/launch-jobs.ts` are the only
thing preventing a duplicate delivery to an entire audience. Do not relax them.

1. **The lease fence is pinned at claim time.** `leaseFenceOf` captures
   `(lease_owner, lease_generation)` when the job is claimed, and every reload re-applies
   it with `withFence`. Refreshing the fence from the database would make each
   compare-and-swap compare the database against itself, letting a worker that lost its
   lease keep writing.
2. **The submit path is a one-way door.** Only `pending` and `running` may advance to
   `ready_to_submit`. `submitting`, `submission_unknown`, and `reconciling` all mean a
   send may already have reached Resend, so they return immediately and recover only
   through the reconcile branch.
3. **A provider `draft` after a submit attempt is ambiguous, not safe.** It escalates to
   `manual_review` with terminal reason `submit_attempted_provider_reports_draft` and a
   durable health block. An operator must confirm in the Resend dashboard before any
   resend.
4. **Every provider call is time-bounded** (`SENDSTACK_PROVIDER_TIMEOUT_MS`, default
   8000 ms). An unbounded call holds the lease past expiry, which is precisely the window
   in which a second worker can claim the same job.

Regression coverage lives in `tests/pg-launch-safety.test.ts`. Each test was verified to
fail against the previous implementation with a real duplicate send recorded.

---

## 4. Rollback

Schema changes `0005` and `0006` are additive; there is no destructive down-migration by
design. Recovery order:

1. Redeploy the previous known-good build (application-level rollback).
2. If data corruption is suspected, restore from the verified backup taken before the
   migration, then fix forward.
3. Never delete production history to resolve a schema problem.

Note that a rollback to a build older than `0006` will fail its own `/healthz` schema check
against a `0006` database only if that older build declares a different contract; the
contract lives with the code, so each build validates against its own expectations.

---

## 4a. Hobby worker ticks

Production on Vercel Hobby does not run a cron. `pnpm launch-jobs:tick` (from `web/`) performs one authenticated request and stops. Do not wrap it in a timer, retry daemon, or external scheduler. A continuous schedule is a Vercel Pro decision and is not part of the canary window.

## 5. Backup handling

The pre-migration backup is a custom-format `pg_dump`, stored outside the repository with
`0600` permissions inside a `0700` directory, and its restore was verified by loading it
into a disposable PostgreSQL 18 instance and comparing row counts.

It contains live production data in plaintext. Before production sending:

- Move it into approved encrypted storage, or encrypt it with the approved key-management
  process. Do not invent an ad-hoc key.
- Record a retention and deletion policy.
- Keep at least one verified recovery artifact at all times.
- Confirm the managed provider's own restore-point strategy (retention window and how to
  restore) and record it, since a single logical dump is not a backup strategy.
