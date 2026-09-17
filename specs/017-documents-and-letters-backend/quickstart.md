# Quickstart: Documents and Letters (017, backend)

**Date**: 2026-09-15 · Contract: [contracts/documents-and-letters.md](./contracts/documents-and-letters.md)

Validation passes for this feature. Each one is a claim that can fail — written so that running it
tells you something you did not already know, rather than confirming what the code obviously does.

## Prerequisites

```bash
# Postgres reachable at localhost:5432; DATABASE_URL composed in .env
npx prisma migrate dev        # applies the 017 migrations
npm run build && node dist/main
```

A seeded company with at least one project, one vendor and one employee. Local admin credentials are
in the repo's own seed, not here.

---

## Pass 1 — The eight required kinds, and the seven you have

Upload seven of the eight required company documents, leaving one out.

`GET /company-documents` must report the missing one **by name**, not as a count. A completeness
figure that says "7 of 8" without saying which is missing sends somebody to compare two lists by eye.

## Pass 2 — An expiring kind cannot be uploaded without a date

Upload a labour licence with no `expiresAt`. Expect `400 DOCUMENT_EXPIRY_REQUIRED` (FR-004). Then
upload one expiring inside the reminder window and confirm the reminder appears through the **existing**
reminder engine — not through a new notification path.

## Pass 3 — Renewal retains the old certificate

Upload a replacement GST certificate. The previous one must remain retrievable (FR-006), and exactly
one row must be current. Verify in the database that the superseded row still exists rather than
trusting the API's response.

## Pass 4 — Project readiness costs one query, not one per project

Open the project list for a company with **50** projects. In the API log, count queries against the
project-document table: expect **one**.

This is the pass most likely to be skipped and the one whose absence costs most. It will not be
noticed in development, where three projects hide an N+1 perfectly.

## Pass 5 — Aadhaar cannot be rendered into a letter

Define a letter template whose body references the Aadhaar document type as a variable. Issuing must
fail with `DOCUMENT_TYPE_RESTRICTED` (FR-024).

**Then check the harder half**: define a *new* letter kind (FR-011 permits this without a code
change) and try the same thing. It must fail identically. If it does not, the restriction was written
into the kinds that existed at build time rather than into the resolver, and it will not survive the
next kind somebody adds.

## Pass 6 — A work order cannot be issued before the director approves

Issue a work order for a vendor. Expect `409 APPROVAL_NOT_COMPLETE` while the 016 chain is pending.
Approve as the director, reissue, and confirm it succeeds.

Then confirm the gate is 016's and not a copy: grep the letters module for a second implementation of
the take-effect logic. Finding one means FR-015a was satisfied in wording only.

## Pass 7 — A reissued letter does not rewrite history

Issue a letter with signatory A. Replace A's signature graphic in settings. Download the original
letter.

It must render with the signature **as applied at issue** (FR-013, research §5). If replacing a
graphic retroactively changes letters already sent, the record is not a record.

## Pass 8 — A kind in use cannot be deleted

Delete a letter kind that has issued letters. Expect `409 LETTER_KIND_IN_USE` (FR-022), and confirm
the refusal comes from the foreign key rather than only from a service check — a service check alone
loses the race that a concurrent issue creates.

## Pass 9 — RLS actually isolates, proven by a non-superuser

**Do not skip this because the policies look right.**

A Postgres superuser bypasses row-level security *unconditionally* — `ENABLE` and `FORCE` do not
apply to them. Every RLS assertion in this repository before 016 ran under a superuser and was
therefore vacuous.

Create a `NOSUPERUSER NOBYPASSRLS` role, grant it the five new tables, and issue raw SQL with **no
WHERE clause**. Expect zero rows from another tenant. Then prove the test is not vacuous: disable the
policy, confirm rows *do* appear, and restore `ENABLE` + `FORCE`. Template:
`test/approvals-rls.e2e-spec.ts`.

## Pass 10 — The boundary holds in both directions

Add a query from `src/letters/` to a `partners` table and confirm the boundary test fails. Then add
one from a business module into `shared.IssuedLetter` and confirm it fails too.

Checking only the direction you happened to think of is how a boundary guard passes while the
boundary leaks. 016 applied this discipline twice; `src/approvals/spine-boundary.spec.ts` is the
template.

---

## What these passes cannot cover

- **Whether the client meant an image.** Pass 7 proves the image is frozen correctly; it cannot prove
  a signature image is what the client wanted. That was settled by clarification on 2026-09-15, and
  if it was settled wrongly, FR-016 and User Story 4 are rewritten rather than extended.
- **Whether eight kinds is the right eight.** The set is configuration (Principle III), so a wrong
  set is a data change, not a code change.
- **Load.** Pass 4 proves the query count at 50 projects. It says nothing about concurrent uploads,
  and NFR-001's 150-user target remains unverified across this product.
