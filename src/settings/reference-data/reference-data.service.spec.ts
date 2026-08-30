import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  ReferenceDataService,
  ReferenceResource,
} from './reference-data.service';
import { formatTimeOfDay, parseTimeOfDay } from './time-of-day';
import { callerFor, createPrismaMock } from '../testing/prisma-mock';

const caller = callerFor('company-1');

function build(
  resource: ReferenceResource,
  delegate: Record<string, jest.Mock>,
) {
  const prisma = createPrismaMock({ [resource]: delegate });
  const auditLog = { record: jest.fn() };
  const service = new ReferenceDataService(prisma as never, auditLog as never);
  return { service, prisma, auditLog };
}

describe.each<[ReferenceResource, string]>([
  ['department', 'DEPARTMENT'],
  ['designation', 'DESIGNATION'],
])('ReferenceDataService — %s (FR-018)', (resource, entityType) => {
  it("creates a row scoped to the caller's own company", async () => {
    const create = jest
      .fn()
      .mockResolvedValue({ id: 'r1', companyId: 'company-1' });
    const { service, auditLog } = build(resource, {
      findFirst: jest.fn().mockResolvedValue(null),
      create,
    });

    await service.create(resource, caller, { name: '  Civil  ' }, '127.0.0.1');

    expect(create).toHaveBeenCalledWith({
      data: { companyId: 'company-1', name: 'Civil' },
    });
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({ entityType, action: 'CREATE' }),
    );
  });

  it('ignores a companyId in the body from a non-cross-company caller', async () => {
    const create = jest
      .fn()
      .mockResolvedValue({ id: 'r1', companyId: 'company-1' });
    const { service } = build(resource, {
      findFirst: jest.fn().mockResolvedValue(null),
      create,
    });

    await service.create(
      resource,
      caller,
      { companyId: 'someone-elses-company', name: 'Civil' },
      '127.0.0.1',
    );

    // Pinned to the caller's own company — a body field can never widen scope.
    expect(create).toHaveBeenCalledWith({
      data: { companyId: 'company-1', name: 'Civil' },
    });
  });

  it('409s on a duplicate name within the same company', async () => {
    const { service } = build(resource, {
      findFirst: jest.fn().mockResolvedValue({ id: 'existing' }),
      create: jest.fn(),
    });

    await expect(
      service.create(resource, caller, { name: 'Civil' }, '127.0.0.1'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('404s when editing something that does not exist', async () => {
    const { service } = build(resource, {
      findUnique: jest.fn().mockResolvedValue(null),
    });

    await expect(
      service.update(resource, caller, 'nope', { name: 'x' }, '127.0.0.1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('deletes and audits', async () => {
    const del = jest.fn();
    const { service, auditLog } = build(resource, {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 'r1', companyId: 'company-1' }),
      delete: del,
    });

    await service.remove(resource, caller, 'r1', '127.0.0.1');

    expect(del).toHaveBeenCalledWith({ where: { id: 'r1' } });
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({ entityType, action: 'DELETE' }),
    );
  });
});

describe('ReferenceDataService — shift (FR-022)', () => {
  it('stores HH:mm times as time-of-day values and returns them formatted', async () => {
    const create = jest.fn().mockResolvedValue({
      id: 's1',
      companyId: 'company-1',
      name: 'General',
      inTime: parseTimeOfDay('09:00'),
      outTime: parseTimeOfDay('18:00'),
      graceMinutes: 10,
    });
    const { service } = build('shift', {
      findFirst: jest.fn().mockResolvedValue(null),
      create,
    });

    const result = await service.create(
      'shift',
      caller,
      { name: 'General', inTime: '09:00', outTime: '18:00', graceMinutes: 10 },
      '127.0.0.1',
    );

    expect(create).toHaveBeenCalledWith({
      data: {
        companyId: 'company-1',
        name: 'General',
        inTime: parseTimeOfDay('09:00'),
        outTime: parseTimeOfDay('18:00'),
        graceMinutes: 10,
      },
    });
    expect(result).toMatchObject({ inTime: '09:00', outTime: '18:00' });
  });

  it('409s on a duplicate shift name within the company', async () => {
    const { service } = build('shift', {
      findFirst: jest.fn().mockResolvedValue({ id: 'existing' }),
      create: jest.fn(),
    });

    await expect(
      service.create(
        'shift',
        caller,
        { name: 'General', inTime: '09:00', outTime: '18:00' },
        '127.0.0.1',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('time-of-day', () => {
  it('round-trips without letting the local zone shift the value', () => {
    for (const value of ['00:00', '09:00', '13:45', '23:59']) {
      expect(formatTimeOfDay(parseTimeOfDay(value))).toBe(value);
    }
  });
});
