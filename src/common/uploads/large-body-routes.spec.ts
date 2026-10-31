import { ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';

import { collectLargeBodyRoutes, largeBodyMatcher } from './large-body';

/**
 * The upload body limit reaches every upload route, and nothing else (036 B8).
 *
 * Built from the real application's controllers — the same derivation `configureApp` runs at
 * boot — so this fails when an upload route's DTO stops marking its file field, or when a route
 * that is not an upload starts taking the large limit. The list below is the audit trail: adding
 * an upload route means adding it here.
 */
const UPLOAD_ROUTES = [
  'PATCH /labour/payment-sheets/lines/:lineId/disburse',
  'PATCH /my/reimbursements/:id',
  'PATCH /recruitment/onboarding/items/:id/verify',
  'POST /assets/:id/documents',
  'POST /company-documents',
  'POST /hr/attendance/import/commit',
  'POST /hr/attendance/import/validate',
  'POST /hr/employees/:employeeId/documents',
  'POST /hr/payroll/runs/:id/transaction-sheet',
  // 051: the Opening Stock and Vendor Rates sheets.
  'POST /inventory/opening-stock/import/confirm',
  'POST /inventory/opening-stock/import/validate',
  'POST /inventory/payments/:id/proof',
  'POST /inventory/purchases',
  'POST /inventory/purchases/:id/complete',
  'POST /inventory/site-entries',
  'POST /inventory/vendor-rates/import/confirm',
  'POST /inventory/vendor-rates/import/validate',
  'POST /labour/attendance/punch',
  'POST /labour/muster-attendance/site-photos',
  'POST /labour/workers',
  'POST /labour/workers/:id/face-enrolment',
  'POST /letters/:id/countersigned',
  'POST /my/face-enrol',
  'POST /my/face-enrol/re-enrolment-complete',
  'POST /my/punch',
  'POST /my/reimbursements',
  'POST /nocs',
  'POST /partners/contractors/:id/documents',
  'POST /plant/equipment/:id/dispose',
  'POST /plant/equipment/:id/documents',
  'POST /plant/equipment/:id/photos',
  'POST /plant/equipment/import',
  'POST /plant/maintenance/:id/job-card/final-bill',
  'POST /plant/maintenance/:id/job-card/payments',
  'POST /projects/:id/boq/estimate-import/validate',
  'POST /projects/:id/boq/import/validate',
  'POST /projects/:projectId/documents',
  'POST /projects/bank-guarantees/guarantees/:id/documents',
  'POST /projects/bill-package-debits/:debitId/signed-copy',
  'POST /projects/bill-packages/:packageId/certified-copy/read',
  'POST /projects/bill-packages/:packageId/certify',
  'POST /projects/client-bills/:id/certify',
  'POST /projects/document-uploads',
  'POST /projects/dwr/:dwrId/attachments',
  'POST /recruitment/candidates/:id/resume',
  'POST /signatories',
  'PUT /plant/maintenance/:id/job-card/quotation',
  'PUT /settings/companies/:id/letterhead',
  'PUT /settings/companies/:id/logo',
  'PUT /signatories/:id',
];

jest.setTimeout(60_000);

describe('large body routes, from the real controllers (036 B8)', () => {
  let routes: string[];
  let isLarge: (method: string, path: string) => boolean;

  beforeAll(async () => {
    // Building the whole application constructs services that refuse to start without their
    // secrets (the blob store's key, the JWT secrets). CI has no .env, and this suite stores and
    // signs nothing, so placeholders do. Set before the application is imported, because its
    // configuration is read at import.
    process.env.STORAGE_ENCRYPTION_KEY ||= '0'.repeat(64);
    process.env.JWT_ACCESS_SECRET ||= 'large-body-routes-spec-access';
    process.env.JWT_REFRESH_SECRET ||= 'large-body-routes-spec-refresh';
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AppModule } = require('../../app.module');
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const found = collectLargeBodyRoutes(module.get(ModulesContainer));
    routes = found.map((r) => `${r.method} ${r.path}`);
    isLarge = largeBodyMatcher(found);
    await module.close();
  });

  it('is exactly the known upload routes', () => {
    expect([...new Set(routes)].sort()).toEqual([...UPLOAD_ROUTES].sort());
  });

  it.each([
    ['POST', '/auth/login'],
    ['POST', '/projects'],
    ['PATCH', '/settings/companies/abc'],
    ['POST', '/payroll/loans'],
  ])('keeps %s %s on the default limit', (method, path) => {
    expect(isLarge(method, path)).toBe(false);
  });
});
