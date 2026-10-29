import { EquipmentStatus, ProjectStatus } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { ProjectDocumentExpiryRule } from '../../projects/documents/project-document.reminder-rule';
import { DocumentTypesService } from '../../settings/reference-data/document-types.service';
import {
  EquipmentDocumentExpiryRule,
  EquipmentRegistrationExpiryRule,
  EquipmentServiceDueRule,
} from './plant-reminder.rules';

/**
 * 049: each rule asks the database only for records still in service — machines not scrapped or
 * sold, projects not completed. The behaviour end to end (reversal, the bell, the ledger) is in
 * `test/no-reminders-closed.e2e-spec.ts`; this pins the query each rule sends.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
function fakePrisma(tx: Record<string, any>): PrismaService {
  return {
    $transaction: (fn: (t: any) => Promise<unknown>) =>
      fn({ ...tx, $executeRaw: jest.fn(), $executeRawUnsafe: jest.fn() }),
  } as unknown as PrismaService;
}

const ctx = { isSuperAdmin: true } as const;
const disposed = {
  status: { notIn: [EquipmentStatus.scrapped, EquipmentStatus.sold] },
};

describe('049 reminder rules skip closed records', () => {
  it('machine documents: only machines in service', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    await new EquipmentDocumentExpiryRule(
      fakePrisma({ equipmentDocument: { findMany } }),
    ).evaluate(ctx);
    expect(findMany.mock.calls[0][0].where.equipment).toEqual(disposed);
  });

  it('registration papers: only machines in service', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    await new EquipmentRegistrationExpiryRule(
      fakePrisma({ equipmentRegistrationItem: { findMany } }),
    ).evaluate(ctx);
    expect(findMany.mock.calls[0][0].where.equipment).toEqual(disposed);
  });

  it('service due: only machines in service', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    await new EquipmentServiceDueRule(
      fakePrisma({ serviceSchedule: { findMany } }),
    ).evaluate(ctx);
    expect(findMany.mock.calls[0][0].where.equipment).toEqual(disposed);
  });

  it('project documents: not completed projects, on hold still reminded', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    await new ProjectDocumentExpiryRule(
      fakePrisma({ projectDocument: { findMany } }),
      {} as DocumentTypesService,
    ).evaluate(ctx);
    const filter = findMany.mock.calls[0][0].where.project.status.notIn;
    expect(filter).toEqual([ProjectStatus.completed]);
    expect(filter).not.toContain(ProjectStatus.on_hold);
  });
});
