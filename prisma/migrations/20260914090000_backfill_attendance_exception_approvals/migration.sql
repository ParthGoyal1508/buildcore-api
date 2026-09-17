-- Backfill historical attendance-exception resolutions as completed approvals
-- (016 T027, research.md §7).
--
-- Before feature 016 a flagged punch was resolved by one person in one step, recorded on
-- `hr.PunchRecord` as `exceptionResolution` + `resolvedByUserId` + `resolvedAt`. Those
-- rows are turned into completed, single-level `ApprovalInstance`s here so that old work
-- and new work render through ONE path. The alternative is an interface that carries a
-- second code path for pre-016 rows forever, and "forever" is not an exaggeration:
-- nothing would ever remove it.
--
-- Nothing is deleted or altered on `PunchRecord`. The existing columns stay exactly as
-- they are — they remain the derived convenience the read paths already query, and this
-- migration only adds the spine's record of what happened.
--
-- Idempotent throughout (`NOT EXISTS` / `ON CONFLICT DO NOTHING`), because a migration
-- that cannot be re-run safely is one nobody dares re-run.

-- ── 1. One inactive legacy chain per affected company ────────────────────────
--
-- A backfilled instance needs a real chain to point at — `chainId` is NOT NULL and a
-- foreign key. This chain is created INACTIVE, which does three things at once: it
-- accepts no new items, it is invisible to the FR-021b unsatisfiable-chain guard (which
-- reads active chains only), and it cannot collide with the live
-- `attendance_exception` chain on the `(companyId, actionType) WHERE "isActive"` partial
-- unique index.
INSERT INTO "shared"."ApprovalChain"
  ("id", "companyId", "actionType", "isFinalAuthorityRequired", "isActive", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  e."companyId",
  'attendance_exception_legacy',
  false,
  false,
  now(),
  now()
FROM "hr"."PunchRecord" p
JOIN "hr"."Employee" e ON e."id" = p."employeeId"
WHERE p."exceptionResolution" IN ('confirmed', 'rejected')
GROUP BY e."companyId"
ON CONFLICT DO NOTHING;

-- Its single level. `slotKey` is 'final' and the label says plainly what this is, so a
-- reader looking at old history is not left wondering which level "1" was.
INSERT INTO "shared"."ApprovalLevel"
  ("id", "chainId", "companyId", "position", "slotKey", "isFinalAuthority", "label", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  c."id",
  c."companyId",
  1,
  'final',
  true,
  'Resolved (before approval chains)',
  now(),
  now()
FROM "shared"."ApprovalChain" c
WHERE c."actionType" = 'attendance_exception_legacy'
  AND NOT EXISTS (
    SELECT 1 FROM "shared"."ApprovalLevel" l WHERE l."chainId" = c."id"
  );

-- ── 2. One completed instance per historical resolution ──────────────────────
--
-- `state` mirrors the verdict that was actually recorded. `originatorUserId` is the
-- employee's own account — `hr.Employee.userId` is NOT NULL, so every punch has one.
--
-- `subject` is composed here for the same reason the application composes it at submit
-- time: the spine has no relation to `PunchRecord` and cannot read it later
-- (research.md §1). If it is not written now, it can never be filled in.
INSERT INTO "shared"."ApprovalInstance"
  ("id", "companyId", "chainId", "entityType", "entityId", "subject", "href",
   "currentPosition", "state", "originatorUserId", "round", "returnCount",
   "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  e."companyId",
  c."id",
  'attendance_exception',
  p."id",
  COALESCE(NULLIF(TRIM(CONCAT_WS(' ', e."firstName", e."lastName")), ''), e."employeeCode")
    || ' — ' || to_char(p."punchDate", 'DD Mon YYYY')
    || ', resolved before approval chains',
  '/dashboard/hr/attendance/exceptions/' || p."id",
  1,
  (CASE p."exceptionResolution"
     WHEN 'confirmed' THEN 'approved'
     ELSE 'rejected'
   END)::"shared"."ApprovalState",
  e."userId",
  1,
  0,
  COALESCE(p."resolvedAt", p."createdAt"),
  COALESCE(p."resolvedAt", p."createdAt")
FROM "hr"."PunchRecord" p
JOIN "hr"."Employee" e ON e."id" = p."employeeId"
JOIN "shared"."ApprovalChain" c
  ON c."companyId" = e."companyId"
 AND c."actionType" = 'attendance_exception_legacy'
WHERE p."exceptionResolution" IN ('confirmed', 'rejected')
  AND NOT EXISTS (
    SELECT 1 FROM "shared"."ApprovalInstance" i
    WHERE i."entityType" = 'attendance_exception' AND i."entityId" = p."id"
  );

-- ── 3. The decision that settled each one ────────────────────────────────────
--
-- Only where the resolver is known. A row whose `resolvedByUserId` is null gets an
-- instance with no decision history, which is the truthful outcome: the verdict was
-- recorded but who reached it was not. Inventing an actor to make the history look
-- complete would put a name against a judgement that person may never have made.
INSERT INTO "shared"."ApprovalDecision"
  ("id", "approvalInstanceId", "companyId", "round", "position", "actorUserId",
   "action", "reason", "decidedAt")
SELECT
  gen_random_uuid()::text,
  i."id",
  i."companyId",
  1,
  1,
  p."resolvedByUserId",
  (CASE p."exceptionResolution"
     WHEN 'confirmed' THEN 'approve'
     ELSE 'reject'
   END)::"shared"."ApprovalDecisionAction",
  'Recorded before approval chains; no reason was captured at the time.',
  COALESCE(p."resolvedAt", p."createdAt")
FROM "hr"."PunchRecord" p
JOIN "shared"."ApprovalInstance" i
  ON i."entityType" = 'attendance_exception' AND i."entityId" = p."id"
WHERE p."exceptionResolution" IN ('confirmed', 'rejected')
  AND p."resolvedByUserId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "shared"."ApprovalDecision" d
    WHERE d."approvalInstanceId" = i."id"
  );
