# Quickstart: Validating the Partners Backend

## Prerequisites

- Seeded company (002), admin session. `@nestjs/schedule` wired (first consumer in this codebase).
- Migrations applied: `partners` schema (9 new tables), `settings.Company.bocwCessRate` additive
  column, `Permission` enum extended with `VENDORS`/`CONTRACTORS`/`BOCW`.

---

## Scenario 1 — Vendor Categories and Vendors (US1 & US2)

1. `POST /partners/vendor-categories` with `{ name: "Earthwork" }`. **Expected**: 201.
2. `POST /partners/vendor-categories` with same name. **Expected**: 409 (duplicate).
3. `POST /partners/vendors` with type `subcontractor`, two contacts, and `categoryIds` including
   the new category. **Expected**: 201 with auto-generated code (e.g. `VEN-001`).
4. `GET /partners/vendors?type=subcontractor`. **Expected**: the vendor in results with
   `dealsIn: ["Earthwork"]` and `primaryContact` populated.
5. `PATCH /partners/vendors/:id` with a new `contacts` array (1 contact, replacing both).
   **Expected**: 200; `GET /partners/vendors/:id` shows exactly 1 contact.
6. `GET /partners/vendors/:id/tds`. **Expected**: `{ tdsSection, tdsRate }` — no other fields.
7. `DELETE /partners/vendor-categories/:id` for the "Earthwork" category (still linked to vendor).
   **Expected**: 409 conflict.

---

## Scenario 2 — Contractor Vault (US3)

1. `POST /partners/contractors` with `vendorId` from Scenario 1 and registration numbers.
   **Expected**: 201, `complianceStatus: "non_compliant"` (no history yet).
2. `POST /partners/contractors/:id` with wrong `vendorId` (type=material). **Expected**: 400
   ("Vendor must be of type subcontractor or labour_contractor").
3. `POST /partners/contractors/:id/documents` (multipart) with `documentType: "labour_license"`
   and an `expiresAt` 20 days from today. **Expected**: 201.
4. `GET /partners/contractors/:id`. **Expected**: document row with `expiryWarning: true`.

---

## Scenario 3 — Monthly Compliance + complianceStatus recompute (US4)

1. `POST /partners/compliance` with PF data only (no ESIC). **Expected**: 201, `status: "partial"`.
2. `GET /partners/contractors/:id`. **Expected**: `complianceStatus: "partially_compliant"`
   (last month has only PF submitted — master PRD §7.7.2 rule).
3. `PATCH /partners/compliance/:id` adding ESIC data. **Expected**: 200, `status: "submitted"`.
4. `GET /partners/contractors/:id`. **Expected**: `complianceStatus: "compliant"` (both PF+ESIC
   submitted for the last concluded month).
5. `PATCH /partners/compliance/:id/verify`. **Expected**: 200, `status: "verified"`,
   `verifiedByUserId` set.
6. `PATCH /partners/compliance/:id` after verify. **Expected**: 409 (verified records immutable).
7. Seed a contractor with no compliance record for last month.
   `GET /partners/contractors/:id`. **Expected**: `complianceStatus: "non_compliant"`.

---

## Scenario 4 — RAG Matrix (US5)

1. With 2 contractors and mixed compliance history, `GET /partners/rag?fy=2025-26`.
   **Expected**: `rows` has 2 entries; cells for past months reflect correct statuses; future
   months show `status: "gray"` with `complianceId: null`.
2. Deactivate one vendor (`PATCH /partners/vendors/:id { active: false }`).
   `GET /partners/rag?fy=2025-26`. **Expected**: only 1 row (active contractor only).

---

## Scenario 5 — BOCW Cess (US6)

1. `GET /partners/bocw`. **Expected**: projects listed with `cessLiability = contractValue × 0.01`
   (default rate); `totalPaid: 0`, `status: "pending"`.
2. `POST /partners/bocw/:projectId/payments` with `amountPaid: 30000`.
   **Expected**: 201; next `GET /partners/bocw` shows `totalPaid: 30000`, `status: "partial"`.
3. Record a payment equal to the remaining balance.
   **Expected**: `status: "paid"`, Record Payment action disabled.

---

## Scenario 6 — getSubcontractorCostByProject (US7)

1. Call `PartnersService.getSubcontractorCostByProject(projectId, { from, to })` in a test.
   **Expected**: returns 0 (stub — ProjectsService.getWorkOrderTotalByProject not yet implemented).
2. Verify the method is exported from `PartnersModule` so `ProjectsModule` can inject it without
   a circular dependency error on app startup.
