import { ConflictException } from '@nestjs/common';
import { EquipmentStatus } from '@prisma/client';

/** Statuses a disposal sets. A machine in either is out of service for good, unless reversed. */
export const DISPOSED_STATUSES: EquipmentStatus[] = [
  EquipmentStatus.scrapped,
  EquipmentStatus.sold,
];

/**
 * Refuses new work against a scrapped or sold machine (2026-10-17) — a schedule, a job, a logbook
 * or fuel entry. Its history stays readable; nothing new is recorded against a machine the company
 * no longer has, unless the disposal is reversed.
 */
export function assertInService(machine: {
  code: string;
  status: EquipmentStatus;
}) {
  if (DISPOSED_STATUSES.includes(machine.status)) {
    throw new ConflictException({
      code: 'EQUIPMENT_DISPOSED',
      message: `${machine.code} is ${machine.status} and no longer in service.`,
    });
  }
}
