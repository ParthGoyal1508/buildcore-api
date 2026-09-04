import { ConflictException } from '@nestjs/common';
import { EquipmentStatus, MaintenanceStatus, Prisma } from '@prisma/client';

import {
  callerFor,
  createPrismaMock,
} from '../../settings/testing/prisma-mock';
import { MaintenanceService } from './maintenance.service';

const caller = callerFor('co-1');
const decimal = (n: number) => new Prisma.Decimal(n);

const jobRow = (over: Record<string, unknown> = {}) => ({
  id: 'job-1',
  companyId: 'co-1',
  equipmentId: 'eq-1',
  type: 'breakdown',
  description: 'Hydraulic hose burst',
  openedAt: new Date(),
  closedAt: null,
  closingReading: null,
  partsDescription: null,
  labourCost: decimal(2000),
  partsCost: decimal(4500),
  totalCost: null,
  linkedServiceScheduleId: null,
  status: MaintenanceStatus.open,
  createdAt: new Date(),
  updatedAt: new Date(),
  equipment: { code: 'BC-EQP-0001', name: 'JCB 3DX' },
  serviceBills: [],
  ...over,
});

const build = (
  options: {
    existingOpenJob?: unknown;
    job?: Record<string, unknown>;
    schedule?: Record<string, unknown> | null;
    currentReading?: number;
  } = {},
) => {
  const equipmentUpdates: Record<string, unknown>[] = [];
  const scheduleUpdates: Record<string, unknown>[] = [];

  const prisma = createPrismaMock({
    equipment: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'eq-1',
        companyId: 'co-1',
        code: 'BC-EQP-0001',
        currentReading: decimal(options.currentReading ?? 1200),
      }),
      update: jest.fn(async ({ data }: never) => {
        equipmentUpdates.push(data as Record<string, unknown>);
        return {};
      }),
    },
    maintenanceJob: {
      findFirst: jest.fn().mockResolvedValue(options.existingOpenJob ?? null),
      findUnique: jest.fn().mockResolvedValue(jobRow(options.job ?? {})),
      create: jest.fn(async ({ data }: never) =>
        jobRow(data as Record<string, unknown>),
      ),
      update: jest.fn(async ({ data }: never) =>
        jobRow({
          ...(options.job ?? {}),
          ...(data as Record<string, unknown>),
        }),
      ),
    },
    serviceSchedule: {
      findUnique: jest.fn().mockResolvedValue(
        options.schedule === null
          ? null
          : {
              id: 'sched-1',
              equipmentId: 'eq-1',
              intervalHours: decimal(250),
              intervalKm: null,
              ...(options.schedule ?? {}),
            },
      ),
      update: jest.fn(async ({ data }: never) => {
        scheduleUpdates.push(data as Record<string, unknown>);
        return {};
      }),
    },
  });

  const service = new MaintenanceService(
    prisma as never,
    { record: jest.fn() } as never,
  );
  return { service, equipmentUpdates, scheduleUpdates };
};

describe('MaintenanceService — equipment status is job-owned (FR-002)', () => {
  it('puts the machine under maintenance when a job opens', async () => {
    const { service, equipmentUpdates } = build();

    await service.create(
      caller,
      { equipmentId: 'eq-1', type: 'breakdown', description: 'Hose burst' },
      '10.0.0.1',
    );

    expect(equipmentUpdates[0]).toEqual({
      status: EquipmentStatus.under_maintenance,
    });
  });

  it('refuses a second open job on the same machine', async () => {
    const { service } = build({ existingOpenJob: { id: 'job-existing' } });

    await expect(
      service.create(
        caller,
        { equipmentId: 'eq-1', type: 'breakdown', description: 'Again' },
        '10.0.0.1',
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('returns the machine to service when the job closes', async () => {
    const { service, equipmentUpdates } = build({ currentReading: 1200 });

    await service.close(caller, 'job-1', { closingReading: 1215 }, '10.0.0.1');

    expect(equipmentUpdates[0]).toMatchObject({
      status: EquipmentStatus.active,
      currentReading: 1215,
    });
  });

  it('refuses to close a job that is already closed', async () => {
    const { service } = build({ job: { status: MaintenanceStatus.closed } });

    await expect(
      service.close(caller, 'job-1', { closingReading: 1300 }, '10.0.0.1'),
    ).rejects.toThrow(ConflictException);
  });
});

describe('MaintenanceService.close — meter and schedule effects', () => {
  it('never winds the meter backwards', async () => {
    const { service, equipmentUpdates } = build({ currentReading: 1400 });

    // A closing reading below the current one is a typo, not a rewound meter —
    // accepting it would silently un-due every service schedule on the machine.
    await service.close(caller, 'job-1', { closingReading: 900 }, '10.0.0.1');

    expect(equipmentUpdates[0]).toEqual({ status: EquipmentStatus.active });
  });

  it('discharges a linked schedule and moves its next due reading forward', async () => {
    const { service, scheduleUpdates } = build({
      job: { linkedServiceScheduleId: 'sched-1' },
    });

    await service.close(caller, 'job-1', { closingReading: 1250 }, '10.0.0.1');

    // Closing a scheduled service without moving `lastDoneReading` would leave the
    // schedule permanently overdue and every reminder after it wrong.
    expect(scheduleUpdates[0]).toEqual({
      lastDoneReading: 1250,
      nextDueReading: 1500,
    });
  });

  it('leaves schedules alone when the job was not linked to one', async () => {
    const { service, scheduleUpdates } = build();

    await service.close(caller, 'job-1', { closingReading: 1250 }, '10.0.0.1');

    expect(scheduleUpdates).toHaveLength(0);
  });
});

describe('MaintenanceService total cost (US11 scenario 6)', () => {
  it('adds parts, labour and verified service bills', async () => {
    const { service } = build({
      job: {
        partsCost: decimal(4500),
        labourCost: decimal(2000),
        serviceBills: [
          { netPayable: decimal(18000), status: 'verified', deletedAt: null },
        ],
      },
    });

    const job = await service.findOne(caller, 'job-1');
    expect(job.totalCost).toBe(24500);
  });

  it('excludes unverified and soft-deleted service bills', async () => {
    const { service } = build({
      job: {
        partsCost: decimal(4500),
        labourCost: decimal(2000),
        serviceBills: [
          {
            netPayable: decimal(18000),
            status: 'pending_verification',
            deletedAt: null,
          },
          {
            netPayable: decimal(9000),
            status: 'verified',
            deletedAt: new Date(),
          },
        ],
      },
    });

    // An unverified invoice is a claim, not a cost — the same rule the P&L applies
    // to hire bills.
    const job = await service.findOne(caller, 'job-1');
    expect(job.serviceBillCost).toBe(0);
    expect(job.totalCost).toBe(6500);
  });
});
