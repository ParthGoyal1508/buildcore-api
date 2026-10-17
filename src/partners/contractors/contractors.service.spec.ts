import { HttpException } from '@nestjs/common';

import { createPrismaMock } from '../../settings/testing/prisma-mock';
import {
  ContractorsService,
  EXPIRY_WARNING_DAYS,
  expiryWarningFor,
} from './contractors.service';

describe('expiryWarningFor (FR-005 document expiry)', () => {
  const now = new Date('2026-09-03T00:00:00Z');

  it('warns for a document expiring inside the window', () => {
    const soon = new Date('2026-09-20T00:00:00Z');
    expect(expiryWarningFor(soon, now)).toBe(true);
  });

  it('warns for one that has already expired', () => {
    // Past expiry is more urgent than imminent expiry, not less — a rule that only
    // looked forward would stop warning the moment the licence actually lapsed.
    expect(expiryWarningFor(new Date('2026-08-01T00:00:00Z'), now)).toBe(true);
  });

  it('does not warn beyond the window', () => {
    const far = new Date(now);
    far.setDate(far.getDate() + EXPIRY_WARNING_DAYS + 1);
    expect(expiryWarningFor(far, now)).toBe(false);
  });

  it('warns exactly on the boundary', () => {
    const boundary = new Date(now);
    boundary.setDate(boundary.getDate() + EXPIRY_WARNING_DAYS);
    expect(expiryWarningFor(boundary, now)).toBe(true);
  });

  it('does not warn when there is no expiry date', () => {
    // A permanent registration is not "expiring today"; treating a null date as an
    // expiry would flag every document that legitimately has none.
    expect(expiryWarningFor(null, now)).toBe(false);
  });
});

describe('ContractorsService documents (036 N4)', () => {
  const PDF = Buffer.from('%PDF-1.4\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n');
  const caller = {
    id: 'u1',
    companyId: 'company-1',
    permissions: [],
  } as never;

  function build(docCompanyId = 'company-1') {
    const created: Record<string, unknown>[] = [];
    const prisma = createPrismaMock({
      contractorProfile: {
        findUnique: jest.fn(async () => ({
          id: 'cp-1',
          companyId: 'company-1',
        })),
      },
      contractorDocument: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return { id: 'doc-1', uploadedAt: new Date(), ...data };
        }),
        findUnique: jest.fn(async () => ({
          id: 'doc-1',
          documentType: 'labour_licence',
          fileRef: 'stored-ref',
          fileName: 'Licence.pdf',
          contractorProfile: { companyId: docCompanyId },
        })),
      },
    });
    const storage = {
      put: jest.fn(async () => 'stored-ref'),
      get: jest.fn(async () => PDF),
      delete: jest.fn(async () => undefined),
    };
    const auditLog = { record: jest.fn(async () => undefined) };
    const service = new ContractorsService(
      prisma as never,
      auditLog as never,
      storage as never,
    );
    return { service, storage, created };
  }

  const status = (p: Promise<unknown>) =>
    p.then(
      () => 0,
      (e: HttpException) => e.getStatus(),
    );

  const upload = (file: Buffer, contentType = 'image/png') => ({
    documentType: 'labour_licence' as never,
    file: file.toString('base64'),
    fileName: 'Licence.pdf',
    contentType,
  });

  it('stores the detected type, not the type the client claimed', async () => {
    const { service, storage } = build();
    await service.uploadDocument(caller, 'cp-1', upload(PDF), '127.0.0.1');
    expect(storage.put).toHaveBeenCalledWith(
      'contractor-documents',
      PDF,
      'application/pdf',
    );
  });

  it('refuses a file outside the allow-list with 415', async () => {
    const { service, storage } = build();
    const exe = Buffer.from('MZ\x90\x00\x03\x00\x00\x00 not a document');
    expect(
      await status(service.uploadDocument(caller, 'cp-1', upload(exe), 'ip')),
    ).toBe(415);
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('serves the stored file with its sniffed type and the uploaded name', async () => {
    const { service } = build();
    const file = await service.documentFile(caller, 'doc-1');
    expect(file.contentType).toBe('application/pdf');
    expect(file.filename).toBe('Licence.pdf');
    expect(file.buffer.equals(PDF)).toBe(true);
  });

  it('answers 404 for a document in another company', async () => {
    const { service, storage } = build('company-2');
    expect(await status(service.documentFile(caller, 'doc-1'))).toBe(404);
    expect(storage.get).not.toHaveBeenCalled();
  });
});
