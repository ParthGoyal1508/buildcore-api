import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AuditAction, AuditEntityType, Prisma } from '@prisma/client';

import { SalaryRevisionsService } from '../salary-revisions/salary-revisions.service';
import { EmployeesService } from './employees.service';
import { PiiCipherService } from './pii-cipher.service';

/**
 * Reversible stand-in for the real AES-GCM cipher.
 *
 * The cipher itself is already covered by blob-cipher.spec.ts; what matters here is
 * that the service encrypts on the way in, masks on the way out, and decrypts only
 * on the audited reveal path.
 */
const fakeCipher = {
  encrypt: (v: string | null | undefined) => (v ? `enc(${v})` : null),
  decrypt: (v: string | null | undefined) =>
    v ? String(v).replace(/^enc\(|\)$/g, '') : null,
  mask: (v: string | null | undefined) =>
    v ? PiiCipherService.maskValue(String(v).replace(/^enc\(|\)$/g, '')) : null,
} as unknown as PiiCipherService;

const CALLER = {
  userId: 'user-1',
  companyId: 'co-1',
  ipAddress: '10.0.0.1',
  rls: { companyId: 'co-1', isSuperAdmin: false },
} as never;

/** Minimal employee row with the fields the service actually reads. */
const employeeRow = (over: Record<string, unknown> = {}) => ({
  id: 'emp-1',
  companyId: 'co-1',
  employeeCode: 'ACME-0001',
  pfApplicable: false,
  esicApplicable: false,
  uan: null,
  pfNumber: null,
  esicNumber: null,
  aadhaarEncrypted: null,
  panEncrypted: null,
  bankAccountNumberEncrypted: null,
  ...over,
});

function build(txOverrides: Record<string, unknown> = {}) {
  const employee = {
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    updateMany: jest.fn(),
    ...txOverrides,
  };
  // withRlsContext opens a transaction and issues two set_config statements via
  // the `$executeRaw` template tag before handing the client to the callback, so
  // the stub has to provide both.
  const salaryRevision = {
    create: jest.fn(async ({ data }) => ({ id: 'rev-1', ...data })),
  };
  const prisma = {
    $transaction: jest.fn(async (cb: (tx: unknown) => unknown) =>
      cb({
        employee,
        salaryRevision,
        $executeRaw: jest.fn().mockResolvedValue(undefined),
      }),
    ),
  } as never;

  const auditLog = { record: jest.fn().mockResolvedValue(undefined) };
  const referenceData = {
    getShift: jest.fn().mockResolvedValue({
      companyId: 'co-1',
      name: 'Night',
      inTime: '20:00',
      outTime: '08:00',
      graceMinutes: 0,
    }),
  };
  const codes = {
    getNextEmployeeCode: jest.fn().mockResolvedValue('ACME-0007'),
  };

  // The real revisions service, so the revision an employee edit records is the one the
  // revisions endpoint would have recorded — not a stub's idea of it.
  const salaryRevisions = new SalaryRevisionsService(
    prisma,
    auditLog as never,
    { get: () => ({ timezone: 'Asia/Kolkata' }) } as never,
  );

  const service = new EmployeesService(
    prisma,
    fakeCipher,
    codes as never,
    auditLog as never,
    salaryRevisions,
    referenceData as never,
    // 041: every employee is on a branch; these tests do not care which.
    {
      branchForNewRecord: jest.fn().mockResolvedValue('branch-head-office'),
      assertActiveBranch: jest.fn().mockResolvedValue(undefined),
    } as never,
  );
  return {
    service,
    employee,
    auditLog,
    codes,
    salaryRevision,
    salaryRevisions,
    referenceData,
  };
}

describe('EmployeesService — statutory tab validation (T020)', () => {
  it('rejects PF applicable without a UAN', async () => {
    const { service } = build();
    await expect(
      service.create(CALLER, 'co-1', {
        pfApplicable: true,
        pfNumber: 'PF-1',
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects PF applicable without a PF number', async () => {
    const { service } = build();
    await expect(
      service.create(CALLER, 'co-1', {
        pfApplicable: true,
        uan: '123456789012',
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects ESIC applicable without an ESIC number', async () => {
    const { service } = build();
    await expect(
      service.create(CALLER, 'co-1', { esicApplicable: true } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a consistent statutory tab', async () => {
    const { service, employee } = build();
    employee.create.mockResolvedValue(
      employeeRow({
        pfApplicable: true,
        uan: '123456789012',
        pfNumber: 'PF-1',
      }),
    );
    await expect(
      service.create(CALLER, 'co-1', {
        pfApplicable: true,
        uan: '123456789012',
        pfNumber: 'PF-1',
      } as never),
    ).resolves.toBeDefined();
  });

  it('validates the MERGED record on update, not just the patch body', async () => {
    // The patch turns PF on without supplying a UAN, and the stored record has
    // none either — only looking at both together catches this.
    const { service, employee } = build();
    employee.findFirst.mockResolvedValue(employeeRow());
    await expect(
      service.update(CALLER, 'emp-1', { pfApplicable: true } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('allows a patch that turns PF on when the stored record already has the numbers', async () => {
    const { service, employee } = build();
    employee.findFirst.mockResolvedValue(
      employeeRow({ uan: '123456789012', pfNumber: 'PF-1' }),
    );
    employee.update.mockResolvedValue(employeeRow({ pfApplicable: true }));
    await expect(
      service.update(CALLER, 'emp-1', { pfApplicable: true } as never),
    ).resolves.toBeDefined();
  });
});

describe('EmployeesService — PII handling', () => {
  it('encrypts PII on create and never stores it in the clear', async () => {
    const { service, employee } = build();
    employee.create.mockResolvedValue(employeeRow());
    await service.create(CALLER, 'co-1', {
      aadhaar: '123456789012',
      pan: 'ABCDE1234F',
    } as never);

    const data = employee.create.mock.calls[0][0].data;
    expect(data.aadhaarEncrypted).toBe('enc(123456789012)');
    expect(data.panEncrypted).toBe('enc(ABCDE1234F)');
    // The plaintext keys must not survive into the column set at all.
    expect(data).not.toHaveProperty('aadhaar');
    expect(data).not.toHaveProperty('pan');
  });

  it('returns masked PII and drops the encrypted columns entirely', async () => {
    const { service, employee } = build();
    employee.findFirst.mockResolvedValue(
      employeeRow({
        aadhaarEncrypted: 'enc(123456789012)',
        uan: '100200300400',
      }),
    );
    const out = await service.getMasked(CALLER, 'emp-1');
    expect(out.aadhaar).toBe('XXXXXXXX9012');
    expect(out.uan).toBe('XXXXXXXX0400');
    expect(out).not.toHaveProperty('aadhaarEncrypted');
  });

  it('never writes PII values into the audit log on update', async () => {
    const { service, employee, auditLog } = build();
    employee.findFirst.mockResolvedValue(employeeRow());
    employee.update.mockResolvedValue(employeeRow());
    await service.update(CALLER, 'emp-1', { aadhaar: '999988887777' } as never);

    const entry = auditLog.record.mock.calls[0][0];
    expect(entry.changes).toEqual({ fields: ['aadhaar'] });
    expect(JSON.stringify(entry)).not.toContain('999988887777');
  });
});

describe('EmployeesService — audited PII reveal', () => {
  it('returns the decrypted value and records a READ before returning it', async () => {
    const { service, employee, auditLog } = build();
    employee.findFirst.mockResolvedValue(
      employeeRow({ aadhaarEncrypted: 'enc(123456789012)' }),
    );

    const out = await service.revealPii(CALLER, 'emp-1', {
      field: 'aadhaar',
    } as never);

    expect(out).toEqual({ field: 'aadhaar', value: '123456789012' });
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: AuditEntityType.EMPLOYEE,
        action: AuditAction.READ,
        entityId: 'emp-1',
        accountId: 'user-1',
        changes: { revealedField: 'aadhaar' },
      }),
    );
  });

  it('fails the request when the access cannot be recorded', async () => {
    // An unlogged disclosure is worse than a failed request.
    const { service, employee, auditLog } = build();
    employee.findFirst.mockResolvedValue(
      employeeRow({ aadhaarEncrypted: 'enc(123456789012)' }),
    );
    auditLog.record.mockRejectedValue(new Error('audit sink down'));

    await expect(
      service.revealPii(CALLER, 'emp-1', { field: 'aadhaar' } as never),
    ).rejects.toThrow('audit sink down');
  });

  it('404s for an employee outside the caller company', async () => {
    const { service, employee, auditLog } = build();
    employee.findFirst.mockResolvedValue(null);
    await expect(
      service.revealPii(CALLER, 'other', { field: 'pan' } as never),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(auditLog.record).not.toHaveBeenCalled();
  });
});

describe('EmployeesService — salary edits are revisions (2026-10-14)', () => {
  const D = (n: number) => new Prisma.Decimal(n);
  const PAY = {
    basic: D(20000),
    hra: D(8000),
    conveyanceAllowance: D(1600),
    siteAllowance: null,
    specialAllowance: D(400),
  };

  it('records a revision dated today with the old heads and the merged new ones', async () => {
    const { service, employee, salaryRevision, salaryRevisions, auditLog } =
      build();
    employee.findFirst.mockResolvedValue(employeeRow(PAY));
    employee.update.mockResolvedValue(
      employeeRow({ ...PAY, basic: D(22000), siteAllowance: D(500) }),
    );

    await service.update(CALLER, 'emp-1', {
      basic: 22000,
      siteAllowance: 500,
    } as never);

    expect(salaryRevision.create).toHaveBeenCalledTimes(1);
    const data = salaryRevision.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      companyId: 'co-1',
      employeeId: 'emp-1',
      effectiveFrom: new Date(salaryRevisions.today()),
      previousBasic: D(20000),
      previousHra: D(8000),
      previousConveyance: D(1600),
      previousSiteAllowance: null,
      previousSpecialAllowance: D(400),
      // Untouched heads carry over; the changed ones are the merged values.
      basic: D(22000),
      hra: D(8000),
      conveyance: D(1600),
      siteAllowance: D(500),
      specialAllowance: D(400),
      createdByUserId: 'user-1',
    });
    expect(auditLog.record.mock.calls[0][0].changes).toEqual({
      fields: ['basic', 'siteAllowance'],
      salaryRevisionId: 'rev-1',
    });
  });

  it('records nothing when the salary fields are sent unchanged', async () => {
    const { service, employee, salaryRevision } = build();
    employee.findFirst.mockResolvedValue(employeeRow(PAY));
    employee.update.mockResolvedValue(employeeRow(PAY));

    await service.update(CALLER, 'emp-1', { basic: 20000 } as never);

    expect(salaryRevision.create).not.toHaveBeenCalled();
  });

  it('records nothing for an edit that does not touch pay', async () => {
    const { service, employee, salaryRevision } = build();
    employee.findFirst.mockResolvedValue(employeeRow(PAY));
    employee.update.mockResolvedValue(employeeRow(PAY));

    await service.update(CALLER, 'emp-1', { firstName: 'Asha' } as never);

    expect(salaryRevision.create).not.toHaveBeenCalled();
  });

  it('allows a second revision on the same day', async () => {
    const { service, employee, salaryRevision } = build();
    employee.findFirst.mockResolvedValue(employeeRow(PAY));
    employee.update.mockResolvedValueOnce(
      employeeRow({ ...PAY, basic: D(21000) }),
    );
    await service.update(CALLER, 'emp-1', { basic: 21000 } as never);

    employee.findFirst.mockResolvedValue(
      employeeRow({ ...PAY, basic: D(21000) }),
    );
    employee.update.mockResolvedValueOnce(
      employeeRow({ ...PAY, basic: D(23000) }),
    );
    await service.update(CALLER, 'emp-1', { basic: 23000 } as never);

    expect(salaryRevision.create).toHaveBeenCalledTimes(2);
    expect(salaryRevision.create.mock.calls[1][0].data).toMatchObject({
      previousBasic: D(21000),
      basic: D(23000),
    });
  });

  it('does not record the initial salary at create as a revision', async () => {
    const { service, employee, salaryRevision } = build();
    employee.create.mockResolvedValue(employeeRow(PAY));
    await service.create(CALLER, 'co-1', { basic: 20000 } as never);
    expect(salaryRevision.create).not.toHaveBeenCalled();
  });
});

describe('EmployeesService — bulk shift change (036)', () => {
  it('moves every listed employee and records one audit entry', async () => {
    const { service, employee, auditLog } = build();
    employee.updateMany.mockResolvedValue({ count: 2 });
    employee.count.mockResolvedValue(2);

    await expect(
      service.bulkSetShift(CALLER, 'co-1', {
        shiftId: 'shift-night',
        employeeIds: ['emp-1', 'emp-2', 'emp-1'],
      }),
    ).resolves.toEqual({ updated: 2, shiftId: 'shift-night' });

    expect(employee.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['emp-1', 'emp-2'] }, companyId: 'co-1' },
      data: { shiftId: 'shift-night' },
    });
    expect(auditLog.record).toHaveBeenCalledTimes(1);
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: AuditEntityType.EMPLOYEE,
        action: AuditAction.UPDATE,
        companyId: 'co-1',
        changes: expect.objectContaining({
          event: 'bulk_shift_change',
          shiftName: 'Night',
          count: 2,
        }),
      }),
    );
  });

  it("refuses another company's shift", async () => {
    const { service, referenceData, employee } = build();
    referenceData.getShift.mockResolvedValue({
      companyId: 'co-2',
      name: 'Night',
    });
    await expect(
      service.bulkSetShift(CALLER, 'co-1', {
        shiftId: 'shift-other',
        employeeIds: ['emp-1'],
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(employee.updateMany).not.toHaveBeenCalled();
  });

  it('moves nobody when any id is not an active employee of the company', async () => {
    const { service, employee, auditLog } = build();
    employee.count.mockResolvedValue(1);
    await expect(
      service.bulkSetShift(CALLER, 'co-1', {
        shiftId: 'shift-night',
        employeeIds: ['emp-1', 'emp-left'],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(employee.updateMany).not.toHaveBeenCalled();
    expect(auditLog.record).not.toHaveBeenCalled();
  });
});
