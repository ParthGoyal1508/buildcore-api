import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Ip,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@prisma/client';

import { AuthenticatedUser } from '../auth/authenticated-user';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { UserEntity } from '../common/decorators/user.decorator';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { rlsContextFor } from '../common/prisma/rls-context';
import { DEFAULT_SLOT_ORDER, SLOT_LABELS } from './approval-slots';
import { ApprovalService } from './approvals.service';
import { ChainsService } from './chains.service';
import { ApprovalQueueQueryDto } from './dto/approval-queue-query.dto';
import {
  PutSlotMappingDto,
  UpsertApprovalChainDto,
} from './dto/approval-chain.dto';
import { DecideApprovalDto } from './dto/decide-approval.dto';
import { ReassignApprovalDto } from './dto/reassign-approval.dto';

/**
 * The approval spine's HTTP surface (016 T043–T046, contracts Part 2).
 *
 * **There is no `APPROVALS` permission and there deliberately never will be.** The right
 * to decide comes from holding the role a chain's level is mapped to, resolved per item
 * by the service. A permission value would be a second source of truth about who may
 * approve, and the two would disagree the first time somebody changed one without the
 * other — silently, and in favour of whichever was checked first.
 *
 * The settings endpoints are the exception, and for a different reason: defining a chain
 * is not approving anything, so it is guarded by `SETTINGS` like every other
 * configuration screen.
 */
@ApiTags('Approvals')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('approvals')
export class ApprovalsController {
  constructor(
    private readonly approvals: ApprovalService,
    private readonly chains: ChainsService,
  ) {}

  // ───────────────────────────────────────────────────────────────────────────
  // The queue (T044)
  //
  // Literal routes are declared before the parameterised ones below. With the paths
  // these endpoints actually use no collision is possible — they differ in segment
  // count — but that is a property of today's paths, not a rule anybody enforces, and
  // the ordering costs nothing.
  // ───────────────────────────────────────────────────────────────────────────

  @Get('queue')
  @ApiOperation({
    summary:
      'Everything awaiting a decision from the caller, across every module',
    description:
      'Excludes items the caller has already decided on this round — a queue that ' +
      'lists work you are forbidden to action teaches people to ignore the queue. ' +
      '`subject` and `href` come from the owning module, because the spine holds no ' +
      'relation through which to read the item itself.',
  })
  async queue(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ApprovalQueueQueryDto,
  ) {
    return this.approvals.queueFor(caller, {
      limit: query.limit,
      cursor: query.cursor ?? null,
    });
  }

  @Get('queue/count')
  @ApiOperation({
    summary: 'How many items await the caller, for the navigation badge',
    description:
      'A separate endpoint from the queue itself because the badge appears on every ' +
      'screen and must not pull a page of rows to render a number (web FR-012).',
  })
  async queueCount(@UserEntity() caller: AuthenticatedUser) {
    return { count: await this.approvals.queueCountFor(caller) };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Chain configuration (T046) — SETTINGS, not approval authority
  // ───────────────────────────────────────────────────────────────────────────

  @Get('chains')
  @RequirePermissions(Permission.SETTINGS)
  @ApiOperation({
    summary: 'Every approval chain defined for the caller’s company',
    description:
      'Includes deactivated chains, because an item already travelling one keeps the ' +
      'chain it entered and an administrator needs to be able to see what that was.',
  })
  async listChains(@UserEntity() caller: AuthenticatedUser) {
    return this.chains.listChains(rlsContextFor(caller), caller.companyId);
  }

  @Post('chains')
  @RequirePermissions(Permission.SETTINGS)
  @ApiOperation({
    summary: 'Define or replace the chain for an action type',
    description:
      'Replaces any active chain for the same action type rather than editing it: an ' +
      'item part-way through keeps the chain it entered, so editing levels in place ' +
      'would retroactively change what it must satisfy.',
  })
  async createChain(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: UpsertApprovalChainDto,
    @Ip() ipAddress: string,
  ) {
    return this.chains.upsertChain(
      rlsContextFor(caller),
      { companyId: caller.companyId, ...dto },
      { userId: caller.id, ipAddress },
    );
  }

  @Put('chains/:id')
  @RequirePermissions(Permission.SETTINGS)
  @ApiOperation({
    summary: 'Replace one chain, identified by id',
    description:
      'The action type in the body must match the chain’s own. Changing it would not ' +
      'be an edit of this chain but the creation of a different one, leaving the ' +
      'original active and unmentioned.',
  })
  async replaceChain(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpsertApprovalChainDto,
    @Ip() ipAddress: string,
  ) {
    const ctx = rlsContextFor(caller);
    const existing = await this.chains.getChain(ctx, id);
    if (!existing) throw new NotFoundException('Approval chain not found.');
    if (existing.actionType !== dto.actionType) {
      throw new BadRequestException(
        `This chain governs "${existing.actionType}". To define a chain for ` +
          `"${dto.actionType}", create one instead of replacing this.`,
      );
    }
    return this.chains.upsertChain(
      ctx,
      { companyId: existing.companyId, ...dto },
      { userId: caller.id, ipAddress },
    );
  }

  @Delete('chains/:id')
  @RequirePermissions(Permission.SETTINGS)
  @HttpCode(204)
  @ApiOperation({
    summary: 'Deactivate a chain',
    description:
      'Deactivation, not deletion. Items already travelling the chain continue under ' +
      'it, and the decisions recorded against it must stay readable.',
  })
  async deactivateChain(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ipAddress: string,
  ) {
    await this.chains.deactivateChain(rlsContextFor(caller), id, {
      userId: caller.id,
      ipAddress,
    });
  }

  @Get('slot-mappings')
  @RequirePermissions(Permission.SETTINGS)
  @ApiOperation({
    summary: 'Which role each slot resolves to for this company',
    description:
      'Returns every canonical slot, mapped or not, so an unmapped slot is visible as ' +
      'a gap on the settings screen rather than as an absent row nobody notices. An ' +
      'unmapped slot is the one failure mode of this feature that never resolves ' +
      'itself: until `first_approver` and `hr` are bound, nothing on those chains can ' +
      'be decided by anybody.\n\n' +
      'Role *names* are deliberately not resolved here. `Role` lives in the `settings` ' +
      'schema and the spine may not read it (Constitution Principle I); the settings ' +
      'screen already holds the role list it needs to render these ids.',
  })
  async listSlotMappings(@UserEntity() caller: AuthenticatedUser) {
    const mappings = await this.chains.listSlotMappings(
      rlsContextFor(caller),
      caller.companyId,
    );
    const byKey = new Map(mappings.map((m) => [m.slotKey, m]));

    // Canonical slots first, in chain order, then any the company has defined beyond
    // them — `slotKey` is free text precisely so that is possible.
    const extra = mappings
      .map((m) => m.slotKey)
      .filter((key) => !DEFAULT_SLOT_ORDER.includes(key as never));

    return {
      slots: [...DEFAULT_SLOT_ORDER, ...extra].map((slotKey) => ({
        slotKey,
        label: SLOT_LABELS[slotKey] ?? slotKey,
        roleId: byKey.get(slotKey)?.roleId ?? null,
      })),
    };
  }

  @Put('slot-mappings')
  @RequirePermissions(Permission.SETTINGS)
  @ApiOperation({
    summary: 'Bind one slot to a role',
    description:
      'Refuses a mapping that would leave an active chain unsatisfiable — two of its ' +
      'levels resolving to the same role — and names both conflicting levels ' +
      '(FR-021b). The refusal happens here, at the settings edit, because the failure ' +
      'it prevents is silent: under FR-021a such a chain simply stops moving, and ' +
      'nobody finds out until whoever was waiting to be paid asks why.',
  })
  async putSlotMapping(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: PutSlotMappingDto,
    @Ip() ipAddress: string,
  ) {
    return this.chains.putSlotMapping(
      rlsContextFor(caller),
      { companyId: caller.companyId, ...dto },
      { userId: caller.id, ipAddress },
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Deciding and history (T043, T045)
  // ───────────────────────────────────────────────────────────────────────────

  @Post(':instanceId/decide')
  @ApiOperation({
    summary: 'Record one decision on one item',
    description:
      'No permission guards this: authority is the chain’s slot mapping, resolved per ' +
      'item. Every refusal carries a distinguishable `code` — they have different ' +
      'remedies and the interface must say which — and every refusal is written to the ' +
      'audit log as `APPROVAL_REFUSED` (FR-003).',
  })
  async decide(
    @UserEntity() caller: AuthenticatedUser,
    @Param('instanceId') instanceId: string,
    @Body() dto: DecideApprovalDto,
    @Ip() ipAddress: string,
  ) {
    return this.approvals.decide(
      { instanceId, action: dto.action, reason: dto.reason ?? null },
      caller,
      ipAddress,
    );
  }

  @Post(':instanceId/reassign')
  @RequirePermissions(Permission.SETTINGS)
  @ApiOperation({
    summary: 'Hand a pending item to another holder of its current level',
    description:
      'Guarded by `SETTINGS` rather than by the chain, because reassignment is an ' +
      'administrative act and not an approval: the service already refuses the person ' +
      'the item is awaiting (`APPROVAL_REASSIGN_FORBIDDEN`), so the current approver was ' +
      'never a candidate for this right. The target does **not** have to hold the ' +
      'level’s role, and that breadth is deliberate — the stall FR-019 exists to clear ' +
      'is a level whose only holder already decided earlier in the chain, which a holder ' +
      'check would make permanent. A mandatory reason, an audit entry naming actor and ' +
      'level, and FR-021a still applying to the delegate are what bound it instead.',
  })
  async reassign(
    @UserEntity() caller: AuthenticatedUser,
    @Param('instanceId') instanceId: string,
    @Body() dto: ReassignApprovalDto,
    @Ip() ipAddress: string,
  ) {
    return this.approvals.reassign(
      instanceId,
      dto.toUserId,
      dto.reason,
      caller,
      ipAddress,
    );
  }

  @Post(':entityType/:entityId/resubmit')
  @ApiOperation({
    summary: 'Send a returned item back up its chain, as a new round',
    description:
      'Only the person who raised the item may resubmit it, which the service enforces. ' +
      'Keyed by entity rather than by instance id deliberately: `returned` is a live ' +
      'state holding the item’s chain slot, so there is exactly one instance this can ' +
      'mean, and looking it up by entity makes a stale instance id impossible to act on. ' +
      'Without this route a returned item has no exit — the partial unique index forbids ' +
      'a replacement instance while one is live (FR-005, FR-020).',
  })
  async resubmit(
    @UserEntity() caller: AuthenticatedUser,
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
  ) {
    return this.approvals.resubmit(
      entityType,
      entityId,
      caller.companyId,
      caller.id,
      caller,
    );
  }

  @Get(':entityType/:entityId/history')
  @ApiOperation({
    summary: 'The full decision history for one item, oldest first',
    description:
      'Readable by anyone holding the permission the owning module declared for this ' +
      'kind of item, and by the people who took part in the chain regardless of it — ' +
      'whoever raised the item must be able to read why it was rejected. Anyone else ' +
      'is refused with `APPROVAL_VIEW_FORBIDDEN` (FR-009).',
  })
  async history(
    @UserEntity() caller: AuthenticatedUser,
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
  ) {
    return this.approvals.historyOf(entityType, entityId, caller);
  }
}
