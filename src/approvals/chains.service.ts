import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, AuditEntityType, Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../auth/audit-log.service';
import { RlsContext, withRlsContext } from '../common/prisma/rls-context';
import { APPROVAL_CHAIN_UNSATISFIABLE } from './approval-error-codes';
import { labelForSlot, SLOT_FINAL } from './approval-slots';
import {
  ACTION_ATTENDANCE_EXCEPTION,
  ACTION_PAYROLL_RUN,
  DEFAULT_ATTENDANCE_EXCEPTION_LEVELS,
  DEFAULT_DIRECTOR_FINAL_LEVELS,
  DEFAULT_PAYROLL_RUN_LEVELS,
  DIRECTOR_FINAL_SEEDED_ACTIONS,
} from './default-chains';

/** One level as supplied when defining or replacing a chain. */
export interface ChainLevelInput {
  position: number;
  slotKey: string;
  isFinalAuthority?: boolean;
  label?: string | null;
}

export interface UpsertChainInput {
  companyId: string;
  actionType: string;
  isFinalAuthorityRequired?: boolean;
  levels: ChainLevelInput[];
}

/** A chain with its levels, ordered. */
export type ChainWithLevels = Prisma.ApprovalChainGetPayload<{
  include: { levels: true };
}>;

/**
 * Chain and slot-mapping definition (016 FR-001, FR-001a, FR-021b).
 *
 * This service owns *who is allowed to approve what*, which is why the guard in
 * `putSlotMapping` is the most important method in the file rather than a validation
 * nicety: it is the only thing standing between a routine settings edit and a chain that
 * can never complete.
 */
@Injectable()
export class ChainsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /** Every chain defined for a company, levels included, in position order. */
  async listChains(
    ctx: RlsContext,
    companyId: string,
  ): Promise<ChainWithLevels[]> {
    return withRlsContext(this.prisma, ctx, (tx) =>
      tx.approvalChain.findMany({
        where: { companyId },
        include: { levels: { orderBy: { position: 'asc' } } },
        orderBy: { actionType: 'asc' },
      }),
    );
  }

  /**
   * The active chain for `(companyId, actionType)`, or null.
   *
   * Null is a configuration fault for the caller to report as such, not an empty result
   * to shrug at — `ApprovalService.submit` turns it into
   * `APPROVAL_CHAIN_NOT_CONFIGURED` (FR-001b).
   */
  async findActiveChain(
    ctx: RlsContext,
    companyId: string,
    actionType: string,
  ): Promise<ChainWithLevels | null> {
    return withRlsContext(this.prisma, ctx, (tx) =>
      tx.approvalChain.findFirst({
        where: { companyId, actionType, isActive: true },
        include: { levels: { orderBy: { position: 'asc' } } },
      }),
    );
  }

  /**
   * Creates or replaces a chain definition and its levels.
   *
   * Replacing levels wholesale rather than patching them individually keeps positions
   * contiguous by construction — a chain with a hole at position 2 would stall every item
   * that reached it, and reconciling partial edits into a valid ordering is exactly the
   * kind of arithmetic that is wrong once and then wrong forever.
   *
   * An in-flight item keeps the chain it entered, because `ApprovalInstance.chainId`
   * points at the chain row and the levels are read through it. Superseding a chain
   * therefore means deactivating the old row and writing a new one; editing levels in
   * place would retroactively change what an item already part-way through must satisfy.
   */
  async upsertChain(
    ctx: RlsContext,
    input: UpsertChainInput,
    actor: { userId: string; ipAddress: string },
  ): Promise<ChainWithLevels> {
    this.assertLevelsWellFormed(input.levels, input.isFinalAuthorityRequired);

    const chain = await withRlsContext(this.prisma, ctx, async (tx) => {
      const existing = await tx.approvalChain.findFirst({
        where: {
          companyId: input.companyId,
          actionType: input.actionType,
          isActive: true,
        },
      });

      if (existing) {
        // Deactivate rather than mutate: items already travelling this chain must keep
        // the shape they entered. The partial unique index on (companyId, actionType)
        // WHERE isActive is what makes this the only way to supersede a chain.
        await tx.approvalChain.update({
          where: { id: existing.id },
          data: { isActive: false },
        });
      }

      return tx.approvalChain.create({
        data: {
          companyId: input.companyId,
          actionType: input.actionType,
          isFinalAuthorityRequired: input.isFinalAuthorityRequired ?? false,
          levels: {
            create: input.levels.map((level) => ({
              companyId: input.companyId,
              position: level.position,
              slotKey: level.slotKey,
              isFinalAuthority: level.isFinalAuthority ?? false,
              label: level.label ?? null,
            })),
          },
        },
        include: { levels: { orderBy: { position: 'asc' } } },
      });
    });

    // A new chain may be unsatisfiable under the mappings already in place — the guard
    // has to run in both directions, or defining the chain second slips past the check
    // that defining the mapping second would have caught.
    await this.assertChainSatisfiable(ctx, input.companyId, chain);

    await this.audit.record({
      entityType: AuditEntityType.APPROVAL_CHAIN_CONFIG,
      action: AuditAction.UPDATE,
      entityId: chain.id,
      changes: {
        actionType: chain.actionType,
        levels: chain.levels.map((l) => ({
          position: l.position,
          slotKey: l.slotKey,
        })),
        supersededActiveChain: true,
      },
      accountId: actor.userId,
      companyId: input.companyId,
      ipAddress: actor.ipAddress,
    });

    return chain;
  }

  /**
   * Seeds a new company's default chains (016 T022).
   *
   * Called by `CompaniesService` inside its own creation transaction, the same way
   * document types, item categories and asset grades are seeded — so `tx` is the
   * caller's, not one this service opens.
   *
   * **Only the `final` slot is mapped.** The shape of authority is knowable because the
   * client described it (Employer → HR → Director, Note 2), and `final` resolves to
   * Super Admin because the client said so on 2026-09-13. The other two are *not*
   * guessable: neither "HR Office" nor "Site Incharge" exists as a role in this system,
   * and that absence is exactly what the role-slot indirection was introduced to handle
   * (research.md §2). Inventing a mapping would hand the right to approve attendance to
   * whichever role happened to sound closest.
   *
   * The consequence is deliberate and visible: until an administrator maps the first two
   * slots, a decision at those levels is refused with `APPROVAL_SLOT_UNMAPPED` — a
   * configuration fault naming the settings screen that fixes it, which is what FR-001b
   * exists for. A silent default would be worse than a loud gap.
   *
   * `superAdminRoleId` is passed in rather than looked up: `settings.Role` belongs to the
   * settings module, and the spine reading it would be the cross-schema query Principle I
   * forbids. The caller already knows it.
   */
  async seedDefaultsForCompany(
    companyId: string,
    tx: Prisma.TransactionClient,
    opts: { superAdminRoleId?: string | null } = {},
  ): Promise<void> {
    const seeds: [string, ChainLevelInput[]][] = [
      [ACTION_ATTENDANCE_EXCEPTION, DEFAULT_ATTENDANCE_EXCEPTION_LEVELS],
      [ACTION_PAYROLL_RUN, DEFAULT_PAYROLL_RUN_LEVELS],
      // FR-018's remaining action types, each a director-only chain (T048). Seeded even
      // though no module submits into them yet: without the chain, feature 017's first
      // work order would be refused as a configuration fault in every company at once,
      // and the remedy would be a settings visit per company rather than a deployment.
      ...DIRECTOR_FINAL_SEEDED_ACTIONS.map(
        (actionType): [string, ChainLevelInput[]] => [
          actionType,
          DEFAULT_DIRECTOR_FINAL_LEVELS,
        ],
      ),
    ];

    for (const [actionType, levels] of seeds) {
      const existing = await tx.approvalChain.findFirst({
        where: { companyId, actionType },
        select: { id: true },
      });
      // Idempotent per chain: the backfill migration and this seeder can both reach a
      // company, and a company seeded before the payroll chain existed must still get it.
      if (existing) continue;

      await tx.approvalChain.create({
        data: {
          companyId,
          actionType,
          isFinalAuthorityRequired: true,
          levels: {
            create: levels.map((level) => ({
              companyId,
              position: level.position,
              slotKey: level.slotKey,
              isFinalAuthority: level.isFinalAuthority ?? false,
              label: level.label ?? null,
            })),
          },
        },
      });
    }

    if (opts.superAdminRoleId) {
      await tx.roleSlotMapping.upsert({
        where: { companyId_slotKey: { companyId, slotKey: SLOT_FINAL } },
        create: {
          companyId,
          slotKey: SLOT_FINAL,
          roleId: opts.superAdminRoleId,
        },
        update: {},
      });
    }
  }

  /** Every slot mapping for a company. */
  async listSlotMappings(ctx: RlsContext, companyId: string) {
    return withRlsContext(this.prisma, ctx, (tx) =>
      tx.roleSlotMapping.findMany({
        where: { companyId },
        orderBy: { slotKey: 'asc' },
      }),
    );
  }

  /** The role a slot resolves to for this company, or null when unmapped. */
  async resolveSlot(
    ctx: RlsContext,
    companyId: string,
    slotKey: string,
  ): Promise<string | null> {
    const mapping = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.roleSlotMapping.findUnique({
        where: { companyId_slotKey: { companyId, slotKey } },
      }),
    );
    return mapping?.roleId ?? null;
  }

  /**
   * Binds a slot to a role for a company (FR-001a) — **refusing any mapping that would
   * make an active chain unsatisfiable** (FR-021b, T009).
   *
   * The guard runs here, when the mapping is written, and not when somebody tries to
   * approve something. That placement is the entire value of it. Under FR-021a one person
   * may not decide twice on an item, so a chain with two levels resolving to the same
   * role cannot complete wherever a single person holds that role — and the symptom is
   * not an error message. It is a payroll run that stops moving, noticed days later by
   * whoever was waiting to be paid.
   *
   * Both conflicting levels are named in the refusal, because "this mapping conflicts"
   * without saying with what leaves an administrator to diff chain definitions by hand.
   */
  async putSlotMapping(
    ctx: RlsContext,
    input: { companyId: string; slotKey: string; roleId: string },
    actor: { userId: string; ipAddress: string },
  ) {
    const conflict = await this.findSlotConflict(ctx, input);
    if (conflict) {
      throw new BadRequestException({
        statusCode: 400,
        message: conflict,
        code: APPROVAL_CHAIN_UNSATISFIABLE,
      });
    }

    const mapping = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.roleSlotMapping.upsert({
        where: {
          companyId_slotKey: {
            companyId: input.companyId,
            slotKey: input.slotKey,
          },
        },
        create: input,
        update: { roleId: input.roleId },
      }),
    );

    await this.audit.record({
      entityType: AuditEntityType.APPROVAL_CHAIN_CONFIG,
      action: AuditAction.UPDATE,
      entityId: mapping.id,
      changes: { slotKey: input.slotKey, roleId: input.roleId },
      accountId: actor.userId,
      companyId: input.companyId,
      ipAddress: actor.ipAddress,
    });

    return mapping;
  }

  /**
   * The FR-021b check, expressed as a question so both callers can ask it.
   *
   * Returns a human-readable description of the conflict, or null when the proposed
   * mapping is safe. Reads every active chain for the company and asks: under the
   * mappings that would exist after this write, does any chain have two levels resolving
   * to one role?
   */
  private async findSlotConflict(
    ctx: RlsContext,
    proposed: { companyId: string; slotKey: string; roleId: string },
  ): Promise<string | null> {
    const { chains, mappings } = await withRlsContext(
      this.prisma,
      ctx,
      async (tx) => ({
        chains: await tx.approvalChain.findMany({
          where: { companyId: proposed.companyId, isActive: true },
          include: { levels: { orderBy: { position: 'asc' } } },
        }),
        mappings: await tx.roleSlotMapping.findMany({
          where: { companyId: proposed.companyId },
        }),
      }),
    );

    // The mapping table as it would be *after* this write, which is the state the chains
    // have to be satisfiable under. Checking against the current table would pass a
    // mapping that only becomes a conflict once saved.
    const resolved = new Map(mappings.map((m) => [m.slotKey, m.roleId]));
    resolved.set(proposed.slotKey, proposed.roleId);

    for (const chain of chains) {
      const seen = new Map<
        string,
        { position: number; slotKey: string; label: string }
      >();
      for (const level of chain.levels) {
        const roleId = resolved.get(level.slotKey);
        if (!roleId) continue; // Unmapped is a different fault (FR-001b), not this one.

        const clash = seen.get(roleId);
        if (clash) {
          return (
            `Chain "${chain.actionType}" would become unsatisfiable: level ` +
            `${clash.position} (${clash.label}) and level ${level.position} ` +
            `(${labelForSlot(
              level.slotKey,
              level.label,
            )}) would both resolve to the ` +
            `same role. One person cannot approve the same item twice, so any item ` +
            `entering this chain would stall at level ${level.position} whenever a ` +
            `single person holds that role.`
          );
        }
        seen.set(roleId, {
          position: level.position,
          slotKey: level.slotKey,
          label: labelForSlot(level.slotKey, level.label),
        });
      }
    }

    return null;
  }

  /** The same guard applied to a chain being defined against existing mappings. */
  private async assertChainSatisfiable(
    ctx: RlsContext,
    companyId: string,
    chain: ChainWithLevels,
  ): Promise<void> {
    const mappings = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.roleSlotMapping.findMany({ where: { companyId } }),
    );
    const resolved = new Map(mappings.map((m) => [m.slotKey, m.roleId]));

    const seen = new Map<string, { position: number; label: string }>();
    for (const level of chain.levels) {
      const roleId = resolved.get(level.slotKey);
      if (!roleId) continue;
      const clash = seen.get(roleId);
      if (clash) {
        throw new BadRequestException({
          statusCode: 400,
          message:
            `Chain "${chain.actionType}" is unsatisfiable as defined: level ` +
            `${clash.position} (${clash.label}) and level ${level.position} ` +
            `(${labelForSlot(
              level.slotKey,
              level.label,
            )}) resolve to the same role ` +
            `under this company's current slot mappings.`,
          code: APPROVAL_CHAIN_UNSATISFIABLE,
        });
      }
      seen.set(roleId, {
        position: level.position,
        label: labelForSlot(level.slotKey, level.label),
      });
    }
  }

  /**
   * Positions must be 1-based and contiguous, and at most one level may be the final
   * authority.
   *
   * A gap is not a cosmetic problem: `currentPosition` is advanced by one on every
   * approval, so a chain numbered 1, 2, 4 leaves every item parked at 3 forever, waiting
   * for a level that does not exist.
   */
  private assertLevelsWellFormed(
    levels: ChainLevelInput[],
    isFinalAuthorityRequired = false,
  ): void {
    if (levels.length === 0) {
      throw new BadRequestException('A chain must have at least one level.');
    }

    const positions = levels.map((l) => l.position).sort((a, b) => a - b);
    const expected = positions.map((_, i) => i + 1);
    if (positions.join(',') !== expected.join(',')) {
      throw new BadRequestException(
        `Chain levels must be numbered 1..${levels.length} with no gaps; got ` +
          `${positions.join(
            ', ',
          )}. A gap parks every item at the missing level.`,
      );
    }

    const slots = levels.map((l) => l.slotKey);
    if (new Set(slots).size !== slots.length) {
      throw new BadRequestException(
        'A slot may not appear twice in one chain — the second level could never be ' +
          'decided by anyone who had not already decided at the first.',
      );
    }

    const finals = levels.filter((l) => l.isFinalAuthority);
    if (finals.length > 1) {
      throw new BadRequestException(
        'At most one level may be the final authority.',
      );
    }

    // FR-018, T049. A chain declared director-final with no director level would
    // complete without one — and complete *cleanly*, with every level approved, which is
    // the worst version of the failure: nothing looks wrong. Refused at definition time
    // for the same reason as FR-021b's guard.
    if (isFinalAuthorityRequired && finals.length === 0) {
      throw new BadRequestException(
        'A chain that requires final authority must have a level marked as the final ' +
          'authority. Without one it would complete with every level approved and no ' +
          'director having seen it.',
      );
    }

    // And it must be the last level. A director gate in the middle lets levels below it
    // act *after* the final word has been given, which is not what "final" means — and
    // FR-018 asks that the action be held until the director approves, not merely that a
    // director appear somewhere in its history.
    if (finals.length === 1 && finals[0].position !== levels.length) {
      throw new BadRequestException(
        `The final authority must be the last level (position ${levels.length}); it is ` +
          `at position ${finals[0].position}. A level below the director would decide ` +
          `after the final word had already been given.`,
      );
    }
  }

  /** One chain by id, levels included. Null when it does not exist for this tenant. */
  async getChain(
    ctx: RlsContext,
    chainId: string,
  ): Promise<ChainWithLevels | null> {
    return withRlsContext(this.prisma, ctx, (tx) =>
      tx.approvalChain.findUnique({
        where: { id: chainId },
        include: { levels: { orderBy: { position: 'asc' } } },
      }),
    );
  }

  /** Deactivates a chain. In-flight items continue under it. */
  async deactivateChain(ctx: RlsContext, chainId: string): Promise<void> {
    const chain = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.approvalChain.findUnique({ where: { id: chainId } }),
    );
    if (!chain) throw new NotFoundException('Approval chain not found.');

    await withRlsContext(this.prisma, ctx, (tx) =>
      tx.approvalChain.update({
        where: { id: chainId },
        data: { isActive: false },
      }),
    );
  }
}
