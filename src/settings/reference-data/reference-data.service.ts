import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, AuditEntityType, Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';
import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { assertInScope, companyScope } from '../company-scope';
import { formatTimeOfDay, parseTimeOfDay } from './time-of-day';

/** The three name-keyed reference resources this service covers. Document Types are
 * deliberately not here: they carry their own flag derivation, per-company seeding
 * and `(companyId, code)` key, so they get a dedicated service. */
export type ReferenceResource = 'department' | 'designation' | 'shift';

interface ResourceSpec {
  entityType: AuditEntityType;
  label: string;
}

const RESOURCES: Record<ReferenceResource, ResourceSpec> = {
  department: { entityType: AuditEntityType.DEPARTMENT, label: 'Department' },
  designation: {
    entityType: AuditEntityType.DESIGNATION,
    label: 'Designation',
  },
  shift: { entityType: AuditEntityType.SHIFT, label: 'Shift' },
};

export interface ShiftFields {
  inTime?: string;
  outTime?: string;
  graceMinutes?: number;
}

/**
 * Shared CRUD for Department, Designation and Shift (FR-018, FR-022).
 *
 * All three are per-company, name-unique, audited, and refuse deletion while an
 * Employee still references them — identical logic differing only in which table it
 * touches, so it is parameterized by resource rather than written out three times.
 */
@Injectable()
export class ReferenceDataService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  async findAll(
    resource: ReferenceResource,
    caller: AuthenticatedUser,
    companyId?: string,
  ): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        this.delegate(tx, resource).findMany({
          where: companyScope(caller, companyId),
          orderBy: { name: 'asc' },
        }),
    );
    return rows.map((row) => this.toView(resource, row));
  }

  async create(
    resource: ReferenceResource,
    caller: AuthenticatedUser,
    dto: { companyId?: string; name: string } & ShiftFields,
    ipAddress: string,
  ): Promise<Record<string, unknown>> {
    const companyId = this.companyIdFor(caller, dto.companyId);
    const name = dto.name.trim();

    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        await this.assertNameFree(tx, resource, companyId, name);
        return this.delegate(tx, resource).create({
          data: {
            companyId,
            name,
            ...this.shiftData(resource, dto),
          },
        });
      },
    );

    await this.auditLog.record({
      entityType: RESOURCES[resource].entityType,
      action: AuditAction.CREATE,
      entityId: created.id,
      accountId: caller.id,
      companyId,
      ipAddress,
    });
    return this.toView(resource, created);
  }

  async update(
    resource: ReferenceResource,
    caller: AuthenticatedUser,
    id: string,
    dto: { name?: string } & ShiftFields,
    ipAddress: string,
  ): Promise<Record<string, unknown>> {
    const { before, updated } = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await this.delegate(tx, resource).findUnique({
          where: { id },
        });
        if (!existing) {
          throw new NotFoundException(
            `${RESOURCES[resource].label} ${id} not found`,
          );
        }
        assertInScope(caller, existing, `${RESOURCES[resource].label} ${id}`);

        const name = dto.name?.trim();
        if (name && name !== existing.name) {
          await this.assertNameFree(tx, resource, existing.companyId, name);
        }

        const row = await this.delegate(tx, resource).update({
          where: { id },
          data: {
            ...(name ? { name } : {}),
            ...this.shiftData(resource, dto),
          },
        });
        return { before: existing, updated: row };
      },
    );

    await this.auditLog.record({
      entityType: RESOURCES[resource].entityType,
      action: AuditAction.UPDATE,
      entityId: id,
      changes: { before, after: updated } as unknown as Prisma.InputJsonValue,
      accountId: caller.id,
      companyId: updated.companyId,
      ipAddress,
    });
    return this.toView(resource, updated);
  }

  async remove(
    resource: ReferenceResource,
    caller: AuthenticatedUser,
    id: string,
    ipAddress: string,
  ): Promise<void> {
    const removed = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await this.delegate(tx, resource).findUnique({
          where: { id },
        });
        if (!existing) {
          throw new NotFoundException(
            `${RESOURCES[resource].label} ${id} not found`,
          );
        }
        assertInScope(caller, existing, `${RESOURCES[resource].label} ${id}`);

        if (await this.isReferencedByEmployee(resource, id)) {
          throw new ConflictException(
            `${RESOURCES[resource].label} is still referenced by an employee record`,
          );
        }

        await this.delegate(tx, resource).delete({ where: { id } });
        return existing;
      },
    );

    await this.auditLog.record({
      entityType: RESOURCES[resource].entityType,
      action: AuditAction.DELETE,
      entityId: id,
      accountId: caller.id,
      companyId: removed.companyId,
      ipAddress,
    });
  }

  /**
   * Deletion guard for FR-018/FR-022.
   *
   * The Employees module does not exist yet, and Principle I forbids reaching into
   * another module's schema directly, so there is nothing to ask — this returns
   * `false` (nothing references it) until that module lands and exports a real
   * check, which then plugs in here and nowhere else.
   */
  private async isReferencedByEmployee(
    _resource: ReferenceResource,
    _id: string,
  ): Promise<boolean> {
    return false;
  }

  private async assertNameFree(
    tx: Prisma.TransactionClient,
    resource: ReferenceResource,
    companyId: string,
    name: string,
  ): Promise<void> {
    const clash = await this.delegate(tx, resource).findFirst({
      where: { companyId, name },
      select: { id: true },
    });
    if (clash) {
      throw new ConflictException(
        `A ${RESOURCES[
          resource
        ].label.toLowerCase()} named "${name}" already exists for this company`,
      );
    }
  }

  /** Shift carries three fields the other two don't; folded in here so the CRUD
   * paths above stay resource-agnostic. */
  private shiftData(
    resource: ReferenceResource,
    dto: ShiftFields,
  ): Record<string, unknown> {
    if (resource !== 'shift') {
      return {};
    }
    return {
      ...(dto.inTime !== undefined
        ? { inTime: parseTimeOfDay(dto.inTime) }
        : {}),
      ...(dto.outTime !== undefined
        ? { outTime: parseTimeOfDay(dto.outTime) }
        : {}),
      ...(dto.graceMinutes !== undefined
        ? { graceMinutes: dto.graceMinutes }
        : {}),
    };
  }

  private toView(
    resource: ReferenceResource,
    row: Record<string, unknown>,
  ): Record<string, unknown> {
    if (resource !== 'shift') {
      return row;
    }
    return {
      ...row,
      inTime: formatTimeOfDay(row.inTime as Date),
      outTime: formatTimeOfDay(row.outTime as Date),
    };
  }

  /** A cross-company caller must name the company; everyone else is pinned to their
   * own, so a companyId in the request body can never widen their scope. */
  private companyIdFor(caller: AuthenticatedUser, requested?: string): string {
    const ctx = rlsContextFor(caller);
    if (ctx.isSuperAdmin) {
      const companyId = requested ?? caller.companyId;
      if (!companyId) {
        throw new NotFoundException(
          'companyId is required for a cross-company caller',
        );
      }
      return companyId;
    }
    if (!caller.companyId) {
      throw new NotFoundException('Caller has no company assigned');
    }
    return caller.companyId;
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  /** The three delegates share the shape this service uses, but Prisma types them
   * as unrelated interfaces, so the parameterization needs one cast to stay
   * table-agnostic. */
  private delegate(
    tx: Prisma.TransactionClient,
    resource: ReferenceResource,
  ): any {
    switch (resource) {
      case 'department':
        return tx.department;
      case 'designation':
        return tx.designation;
      case 'shift':
        return tx.shift;
    }
  }

  /**
   * A shift's scheduled length in hours — what `hr` measures overtime against
   * (spec FR-009, research.md §9).
   *
   * Exported rather than letting `hr` read `settings.Shift` directly (Principle I),
   * and returned as a duration rather than as the raw in/out times so the caller
   * never has to re-derive the overnight-shift arithmetic below.
   */
  async getShiftDurationHours(shiftId: string): Promise<number> {
    const shift = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) =>
        tx.shift.findUnique({
          where: { id: shiftId },
          select: { inTime: true, outTime: true },
        }),
    );
    if (!shift) {
      throw new NotFoundException('Shift not found');
    }
    return shiftDurationHours(shift.inTime, shift.outTime);
  }
}

/**
 * Hours between two wall-clock times, handling a shift that crosses midnight.
 *
 * `inTime`/`outTime` are Postgres `time` values, which Prisma surfaces as Dates on
 * an arbitrary epoch day — so only their time-of-day components are meaningful, and
 * subtracting the Dates directly would be wrong. A night shift (22:00 → 06:00)
 * yields a negative difference, which means it ended the following day, so a full
 * day is added rather than reporting a negative shift length.
 */
export function shiftDurationHours(inTime: Date, outTime: Date): number {
  const MS_PER_HOUR = 3_600_000;
  const MS_PER_DAY = 86_400_000;
  const timeOfDayMs = (d: Date) =>
    d.getUTCHours() * MS_PER_HOUR +
    d.getUTCMinutes() * 60_000 +
    d.getUTCSeconds() * 1000;

  const delta = timeOfDayMs(outTime) - timeOfDayMs(inTime);
  return (delta > 0 ? delta : delta + MS_PER_DAY) / MS_PER_HOUR;
}
