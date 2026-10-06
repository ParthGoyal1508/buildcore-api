-- 028 FR-005. One store for a deduction.
--
-- Until now there were two, and only one of them reached the document a subcontractor receives.
-- A deduction typed on the RA bill sheet landed on `RABill.advanceRecovery` / `otherDeductions`;
-- the abstract and the rendered PDF read the ten `BillPackage` adjustment columns and have never
-- looked at those two. So the figure was recorded correctly and the bill went out understating
-- what had been taken, with nothing on screen saying the two disagreed.
--
-- This moves what the bill rows hold into the package that prints them.
--
-- `advanceRecovery` lands on `mobilizationAdvance` and `otherDeductions` on `otherRecoveries`:
-- of the ten adjustment columns these are the two whose meaning matches, and the abstract prints
-- both. Mapping either onto a named recovery it is not — diesel, a civil debit, theft withheld —
-- would put a figure under a heading nobody chose for it.
--
-- **Added to, never replaced.** A package may already carry its own figure in these columns, and
-- overwriting it would discard a number somebody entered deliberately through the adjustments
-- screen. Addition is the only safe composition of two stores that were both in use.
UPDATE "projects"."BillPackage" p
SET "mobilizationAdvance" = p."mobilizationAdvance" + b."advanceRecovery",
    "otherRecoveries"     = p."otherRecoveries"     + b."otherDeductions"
FROM "projects"."RABill" b
WHERE p."raBillId" = b."id"
  AND (b."advanceRecovery" <> 0 OR b."otherDeductions" <> 0);

-- The columns on `RABill` are NOT dropped, and that is the decision rather than an omission
-- (research §2).
--
-- A bill composed through the sheet before packages existed has no package to migrate into — the
-- join above simply does not reach it. Dropping its columns would delete a figure a person can
-- read on screen today and leave nothing able to answer where it went. They stay, readable, with
-- input closed at the DTO; a later feature may retire them once every bill has a package.
