import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, AuditEntityType, Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { DEFAULT_CONDITION_GRADES } from '../../assets/constants/assets.constants';
import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { assertInScope, companyScope } from '../company-scope';
import {
  CreateConditionGradeDto,
  UpdateConditionGradeDto,
} from './dto/asset-masters.dto';

export interface ConditionGradeView {
  id: string;
  companyId: string;
  name: string;
  /** Ascending = worse. */
  sequence: number;
  isDamaged: boolean;
  isScrap: boolean;
  active: boolean;
  createdAt: Date;
}

/**
 * Condition-grade master (spec FR-015).
 *
 * The one master in this feature whose rows carry behaviour rather than just a
 * label: `isDamaged` and `isScrap` decide the status an asset lands in when it is
 * returned, inspected or received at that grade. That is why the ladder is a table —
 * "Good / Fair / Poor / Damaged / Scrap" is one company's vocabulary, and a company
 * that wants a sixth rung has to be able to say where on the ladder it sits.
 *
 * As with the other two masters, the "is this grade in use?" delete guard reads the
 * `assets` schema and so lives on that side of the boundary.
 */
@Injectable()
export class ConditionGradesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  async seedDefaultsForCompany(
    companyId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.conditionGrade.createMany({
      data: DEFAULT_CONDITION_GRADES.map((grade) => ({
        companyId,
        name: grade.name,
        sequence: grade.sequence,
        isDamaged: grade.isDamaged,
        isScrap: grade.isScrap,
      })),
      skipDuplicates: true,
    });
  }

  private normalise(name: string): string {
    return name.trim().toUpperCase();
  }

  /**
   * A grade cannot mean both "send it for repair" and "write it off" — the return
   * mapping in FR-015 would have two answers and no way to choose. Rejected at 400
   * rather than resolved by precedence, because a precedence rule here would be a
   * silent reinterpretation of what an admin configured.
   */
  private assertOutcomeExclusive(state: {
    isDamaged: boolean;
    isScrap: boolean;
  }): void {
    if (state.isDamaged && state.isScrap) {
      throw new BadRequestException(
        'A condition grade cannot be both isDamaged and isScrap — an asset ' +
          'returned at that grade would have two destinations.',
      );
    }
  }

  private toView(
    row: Prisma.ConditionGradeGetPayload<object>,
  ): ConditionGradeView {
    return {
      id: row.id,
      companyId: row.companyId,
      name: row.name,
      sequence: row.sequence,
      isDamaged: row.isDamaged,
      isScrap: row.isScrap,
      active: row.active,
      createdAt: row.createdAt,
    };
  }

  /** Every grade in scope, best first — the order a dropdown wants and the order
   * the transfer discrepancy check compares in. */
  async findAll(
    caller: AuthenticatedUser,
    companyId?: string,
  ): Promise<ConditionGradeView[]> {
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.conditionGrade.findMany({
          where: companyScope(caller, companyId),
          orderBy: [{ sequence: 'asc' }, { name: 'asc' }],
        }),
    );
    return rows.map((row) => this.toView(row));
  }

  async getGrade(
    caller: AuthenticatedUser,
    gradeId: string,
  ): Promise<ConditionGradeView | null> {
    const row = await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.conditionGrade.findUnique({ where: { id: gradeId } }),
    );
    if (!row) return null;
    if (
      !rlsContextFor(caller).isSuperAdmin &&
      row.companyId !== caller.companyId
    ) {
      return null;
    }
    return this.toView(row);
  }

  async getGradesByIds(
    caller: AuthenticatedUser,
    gradeIds: string[],
  ): Promise<Map<string, ConditionGradeView>> {
    const unique = [...new Set(gradeIds)];
    if (unique.length === 0) return new Map();
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.conditionGrade.findMany({
          where: { id: { in: unique }, ...companyScope(caller) },
        }),
    );
    return new Map(rows.map((row) => [row.id, this.toView(row)]));
  }

  async create(
    caller: AuthenticatedUser,
    dto: CreateConditionGradeDto,
    ipAddress: string,
    requestedCompanyId?: string,
  ): Promise<ConditionGradeView> {
    const scope = companyScope(caller, requestedCompanyId);
    const companyId = scope.companyId ?? caller.companyId;
    if (!companyId) {
      throw new BadRequestException(
        'companyId is required for a cross-company caller.',
      );
    }
    const name = this.normalise(dto.name);
    this.assertOutcomeExclusive({
      isDamaged: dto.isDamaged ?? false,
      isScrap: dto.isScrap ?? false,
    });

    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const clash = await tx.conditionGrade.findFirst({
          where: { companyId, name },
        });
        if (clash) {
          throw new ConflictException(
            `A condition grade named ${name} already exists.`,
          );
        }
        return tx.conditionGrade.create({
          data: {
            companyId,
            name,
            sequence: dto.sequence,
            ...(dto.isDamaged !== undefined
              ? { isDamaged: dto.isDamaged }
              : {}),
            ...(dto.isScrap !== undefined ? { isScrap: dto.isScrap } : {}),
          },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.CONDITION_GRADE,
      action: AuditAction.CREATE,
      entityId: created.id,
      companyId,
      ipAddress,
      changes: {
        name: created.name,
        sequence: created.sequence,
        isDamaged: created.isDamaged,
        isScrap: created.isScrap,
      },
    });
    return this.toView(created);
  }

  async update(
    caller: AuthenticatedUser,
    gradeId: string,
    dto: UpdateConditionGradeDto,
    ipAddress: string,
  ): Promise<ConditionGradeView> {
    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.conditionGrade.findUnique({
          where: { id: gradeId },
        });
        if (!existing) throw new NotFoundException('Condition grade not found');
        assertInScope(caller, existing, 'Condition grade');

        const name = dto.name ? this.normalise(dto.name) : undefined;
        if (name && name !== existing.name) {
          const clash = await tx.conditionGrade.findFirst({
            where: { companyId: existing.companyId, name },
          });
          if (clash) {
            throw new ConflictException(
              `A condition grade named ${name} already exists.`,
            );
          }
        }

        this.assertOutcomeExclusive({
          isDamaged: dto.isDamaged ?? existing.isDamaged,
          isScrap: dto.isScrap ?? existing.isScrap,
        });

        return tx.conditionGrade.update({
          where: { id: gradeId },
          data: {
            ...(name ? { name } : {}),
            ...(dto.sequence !== undefined ? { sequence: dto.sequence } : {}),
            ...(dto.isDamaged !== undefined
              ? { isDamaged: dto.isDamaged }
              : {}),
            ...(dto.isScrap !== undefined ? { isScrap: dto.isScrap } : {}),
            ...(dto.active !== undefined ? { active: dto.active } : {}),
          },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.CONDITION_GRADE,
      action: AuditAction.UPDATE,
      entityId: updated.id,
      companyId: updated.companyId,
      ipAddress,
      changes: { ...dto },
    });
    return this.toView(updated);
  }

  /** Deletes a grade. The caller must already have established that nothing is
   * graded at it. */
  async remove(
    caller: AuthenticatedUser,
    gradeId: string,
    ipAddress: string,
  ): Promise<void> {
    const removed = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.conditionGrade.findUnique({
          where: { id: gradeId },
        });
        if (!existing) throw new NotFoundException('Condition grade not found');
        assertInScope(caller, existing, 'Condition grade');
        await tx.conditionGrade.delete({ where: { id: gradeId } });
        return existing;
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.CONDITION_GRADE,
      action: AuditAction.DELETE,
      entityId: gradeId,
      companyId: removed.companyId,
      ipAddress,
      changes: { name: removed.name },
    });
  }
}
