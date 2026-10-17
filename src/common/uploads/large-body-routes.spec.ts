import { ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../app.module';
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
  'POST /inventory/payments/:id/proof',
  'POST /inventory/purchases',
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
  'POST /projects/:id/boq/estimate-import/validate',
  'POST /projects/:id/boq/import/validate',
  'POST /projects/:projectId/documents',
  'POST /projects/bill-package-debits/:debitId/signed-copy',
  'POST /projects/bill-packages/:packageId/certified-copy/read',
  'POST /projects/bill-packages/:packageId/certify',
  'POST /projects/client-bills/:id/certify',
  'POST /projects/document-uploads',
  'POST /projects/dwr/:dwrId/attachments',
  'POST /projects/ra-bills/:raBillId/signed-copy',
  'POST /recruitment/candidates/:id/resume',
  'POST /signatories',
  'PUT /settings/companies/:id/letterhead',
  'PUT /settings/companies/:id/logo',
  'PUT /signatories/:id',
];

jest.setTimeout(60_000);

describe('large body routes, from the real controllers (036 B8)', () => {
  let routes: string[];
  let isLarge: (method: string, path: string) => boolean;

  beforeAll(async () => {
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
