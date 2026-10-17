import { HttpException } from '@nestjs/common';
import { AccessLevel, Permission } from '@prisma/client';

import { createPrismaMock } from '../settings/testing/prisma-mock';
import { NocsService } from './nocs.service';

const PDF = Buffer.from('%PDF-1.4\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n');

const caller = (levels: AccessLevel[], extra: Record<string, unknown> = {}) =>
  ({
    id: 'u1',
    companyId: 'company-1',
    permissions: [Permission.PROJECTS],
    grants: levels.map((level) => ({ permission: Permission.PROJECTS, level })),
    ...extra,
  } as never);

function build(subjectFound = true) {
  const created: Record<string, unknown>[] = [];
  const prisma = createPrismaMock({
    workOrder: {
      findFirst: jest.fn(async () => (subjectFound ? { id: 'wo-1' } : null)),
    },
    nocDocument: {
      findMany: jest.fn(async () => []),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: 'noc-1', createdAt: new Date(), issuedOn: null, ...data };
      }),
      findUnique: jest.fn(async () => ({
        id: 'noc-1',
        companyId: 'company-1',
        subjectType: 'work_order',
        fileRef: 'ref',
      })),
      delete: jest.fn(async () => undefined),
    },
  });
  const storage = {
    put: jest.fn(async () => 'stored-ref'),
    delete: jest.fn(async () => undefined),
  };
  const letters = { letterExists: jest.fn(async () => subjectFound) };
  const service = new NocsService(
    prisma as never,
    storage as never,
    letters as never,
  );
  return { service, prisma, storage, created };
}

const upload = (file: Buffer, extra: Record<string, unknown> = {}) => ({
  subjectType: 'work_order' as const,
  subjectId: 'wo-1',
  file: file.toString('base64'),
  contentType: 'image/png',
  ...extra,
});

const status = (p: Promise<unknown>) =>
  p.then(
    () => 0,
    (e: HttpException) => e.getStatus(),
  );

describe('NocsService (036 B16, B4, B5)', () => {
  it('refuses a read-only holder an upload and a delete, but lets them read', async () => {
    const { service } = build();
    const readOnly = caller([AccessLevel.read]);

    expect(await status(service.upload(readOnly, upload(PDF)))).toBe(403);
    expect(await status(service.remove(readOnly, 'noc-1'))).toBe(403);
    expect(
      await status(
        service.list(readOnly, {
          subjectType: 'work_order',
          subjectId: 'wo-1',
        }),
      ),
    ).toBe(0);
  });

  it('refuses a subject that is not in the company', async () => {
    const { service, storage } = build(false);
    expect(
      await status(
        service.upload(
          caller([AccessLevel.read, AccessLevel.write]),
          upload(PDF),
        ),
      ),
    ).toBe(404);
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('refuses HTML however it is labelled, with 415', async () => {
    const { service } = build();
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    expect(
      await status(
        service.upload(
          caller([AccessLevel.read, AccessLevel.write]),
          upload(html),
        ),
      ),
    ).toBe(415);
  });

  it('stores the detected type, not the declared one, under the selected company', async () => {
    const { service, storage, prisma, created } = build();
    const switched = caller([AccessLevel.read, AccessLevel.write], {
      companyId: 'home-A',
      selectedCompanyId: 'company-1',
      permissions: [Permission.PROJECTS, Permission.CROSS_COMPANY_ACCESS],
    });

    await service.upload(switched, upload(PDF));

    expect(storage.put).toHaveBeenCalledWith(
      'noc-documents',
      PDF,
      'application/pdf',
    );
    expect(created[0]).toMatchObject({
      companyId: 'company-1',
      mimeType: 'application/pdf',
    });
    expect(prisma.tx.workOrder.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'wo-1', companyId: 'company-1' },
      }),
    );
  });
});
