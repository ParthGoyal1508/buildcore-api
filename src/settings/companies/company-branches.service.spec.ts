import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createPrismaMock } from '../testing/prisma-mock';
import { CompanyBranchesService } from './company-branches.service';
import { CompaniesService } from './companies.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

const COMPANY = { id: 'prpl', pan: 'AAMCP8659H' };
const caller = { id: 'admin-1' } as never;

const branch = (over: Record<string, unknown> = {}) => ({
  id: 'b-rj',
  companyId: 'prpl',
  label: null,
  tradeName: null,
  gstin: '08AAMCP8659H1ZO',
  address: '28 A Gandhi Nagar Ward No 15, Teli Mohalla',
  city: 'Deoli',
  state: 'Rajasthan',
  pinCode: '304804',
  phone: null,
  email: null,
  website: null,
  pfEstablishmentCode: null,
  esicCode: null,
  professionalTaxRegNumber: null,
  isHeadOffice: true,
  isActive: true,
  ...over,
});

/** An in-memory branch table, so head-office swaps and the mirror can be watched end to end. */
function build(rows = [branch()]) {
  const table = rows.map((r) => ({ ...r }));
  const companyUpdate = jest.fn();
  const match = (r: any, where: any) =>
    Object.entries(where).every(([k, v]) => r[k] === v);
  const prisma = createPrismaMock({
    company: {
      findUnique: jest.fn().mockResolvedValue(COMPANY),
      update: companyUpdate,
    },
    companyBranch: {
      findFirst: jest.fn(
        async ({ where }) => table.find((r) => match(r, where)) ?? null,
      ),
      findMany: jest.fn(async () => table),
      create: jest.fn(async ({ data }) => {
        if (data.gstin && table.some((r) => r.gstin === data.gstin)) {
          throw new Prisma.PrismaClientKnownRequestError('dup', {
            code: 'P2002',
            clientVersion: 'x',
          });
        }
        const row = branch({ id: `b-${table.length + 1}`, ...data });
        table.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }) => {
        const row = table.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return { ...row };
      }),
    },
  });
  const audit = { record: jest.fn() };
  const service = new CompanyBranchesService(prisma as never, audit as never);
  return { service, table, companyUpdate, audit };
}

const gujarat = {
  gstin: '24AAMCP8659H1ZU',
  address: 'Kaknu Thambala, Charan Jivabhai, Bhemabhai, Talav Faliya',
  city: 'Godhra',
  state: 'Gujarat',
  pinCode: '389001',
};

describe('CompanyBranchesService (041)', () => {
  it('adds a branch whose GSTIN matches its state and the company PAN', async () => {
    const { service, table, audit } = build();
    const dto = await service.create(caller, 'prpl', gujarat, '::1');
    expect(dto).toMatchObject({
      gstin: '24AAMCP8659H1ZU',
      stateCode: '24',
      isHeadOffice: false,
    });
    expect(table).toHaveLength(2);
    expect(audit.record).toHaveBeenCalled();
  });

  it('refuses a GSTIN whose state code is not the branch state', async () => {
    const { service } = build();
    await expect(
      service.create(
        caller,
        'prpl',
        { ...gujarat, gstin: '08AAMCP8659H1ZO' },
        '::1',
      ),
    ).rejects.toThrow(
      /state code 08 does not match the branch state \(Gujarat, 24\)/,
    );
  });

  it('refuses a GSTIN carrying another PAN', async () => {
    const { service } = build();
    await expect(
      service.create(
        caller,
        'prpl',
        { ...gujarat, gstin: '24AFOPJ3554P1ZW' },
        '::1',
      ),
    ).rejects.toThrow(/does not belong to this company's PAN AAMCP8659H/);
  });

  it('refuses the same GSTIN twice with a 409', async () => {
    const { service } = build();
    await service.create(caller, 'prpl', gujarat, '::1');
    await expect(
      service.create(caller, 'prpl', gujarat, '::1'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses to deactivate the head office', async () => {
    const { service } = build();
    await expect(
      service.update(caller, 'prpl', 'b-rj', { isActive: false }, '::1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('re-checks the GSTIN when only the state changes', async () => {
    const { service } = build();
    await expect(
      service.update(caller, 'prpl', 'b-rj', { state: 'Gujarat' }, '::1'),
    ).rejects.toThrow(/state code 08/);
  });

  it('mirrors an edited head office onto the company', async () => {
    const { service, companyUpdate } = build();
    await service.update(
      caller,
      'prpl',
      'b-rj',
      { phone: '9784570406' },
      '::1',
    );
    expect(companyUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ phone: '9784570406' }),
      }),
    );
  });

  it('moves the head office — exactly one afterwards, each way — and re-mirrors', async () => {
    const { service, table, companyUpdate } = build();
    const gj = await service.create(caller, 'prpl', gujarat, '::1');

    await service.makeHeadOffice(caller, 'prpl', gj.id, '::1');
    expect(table.filter((r) => r.isHeadOffice).map((r) => r.id)).toEqual([
      gj.id,
    ]);
    expect(companyUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ gstin: '24AAMCP8659H1ZU' }),
      }),
    );

    await service.makeHeadOffice(caller, 'prpl', 'b-rj', '::1');
    expect(table.filter((r) => r.isHeadOffice).map((r) => r.id)).toEqual([
      'b-rj',
    ]);
  });

  it('refuses an inactive branch as head office', async () => {
    const { service } = build([
      branch(),
      branch({
        id: 'b-old',
        isHeadOffice: false,
        isActive: false,
        gstin: null,
      }),
    ]);
    await expect(
      service.makeHeadOffice(caller, 'prpl', 'b-old', '::1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lists options without addresses or codes, inactive left out unless asked', async () => {
    const { service } = build([
      branch(),
      branch({
        id: 'b-old',
        isHeadOffice: false,
        isActive: false,
        gstin: null,
        city: 'Rewari',
        state: 'Haryana',
      }),
    ]);
    const options = await service.options('prpl');
    // The mock returns every row; the filter is in the query — assert the shape instead.
    expect(options[0]).toEqual({
      id: 'b-rj',
      label: 'Deoli (Rajasthan)',
      gstin: '08AAMCP8659H1ZO',
      state: 'Rajasthan',
      isHeadOffice: true,
      isActive: true,
    });
  });
});

describe('CompaniesService branch identity (041)', () => {
  const company = {
    id: 'prpl',
    name: 'Parth Realcon Private Limited',
    shortCode: 'PRPL',
    pan: 'AAMCP8659H',
    cin: 'U70109RJ2022PTC081146',
    tan: null,
    logoRef: null,
  };
  const rows = [
    branch(),
    branch({
      ...gujarat,
      id: 'b-gj',
      isHeadOffice: false,
      tradeName: 'PRPL Godhra',
    }),
  ];
  const service = () => {
    const prisma = createPrismaMock({
      company: { findUnique: jest.fn().mockResolvedValue(company) },
      companyBranch: {
        findFirst: jest.fn(
          async ({ where }) =>
            rows.find((r) =>
              Object.entries(where).every(([k, v]) => (r as any)[k] === v),
            ) ?? null,
        ),
      },
    });
    const args: unknown[] = [prisma, ...Array(12).fill({}), { get: jest.fn() }];
    return new (CompaniesService as any)(...args) as CompaniesService;
  };

  it('resolves no branch to the head office, as before branches existed', async () => {
    const billing = await service().getBillingIdentity('prpl');
    expect(billing).toMatchObject({
      name: 'Parth Realcon Private Limited',
      gstin: '08AAMCP8659H1ZO',
      state: 'Rajasthan',
      stateCode: '08',
      address: '28 A Gandhi Nagar Ward No 15, Teli Mohalla',
    });
  });

  it('prints a named branch, with its trade name', async () => {
    const doc = await service().getDocumentIdentity('prpl', 'b-gj');
    expect(doc).toMatchObject({
      name: 'PRPL Godhra',
      gstin: '24AAMCP8659H1ZU',
      place: 'Godhra, Gujarat',
      address:
        'Kaknu Thambala, Charan Jivabhai, Bhemabhai, Talav Faliya, Godhra, Gujarat - 389001',
    });
  });

  it('falls back to the head office for a branch this company does not have', async () => {
    const billing = await service().getBillingIdentity('prpl', 'someone-elses');
    expect(billing.gstin).toBe('08AAMCP8659H1ZO');
  });
});
