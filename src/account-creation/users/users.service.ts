import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AuditAction,
  AuditEntityType,
  Permission,
  Prisma,
  UserStatus,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';
import { AuditLogService } from '../../auth/audit-log.service';
import type { EmailConfig } from '../../common/configs/config.interface';
import { RlsContext, withRlsContext } from '../../common/prisma/rls-context';
import { EmployeesService } from '../../hr/employees/employees.service';
import { EmailService } from '../../shared/email/email.service';
import { INVITE_TOKEN_TTL_HOURS } from '../constants/account-creation.constants';
import { TokenService } from '../invites/token.service';
import { CreateUserDto } from './dto/create-user.dto';
import { allocateUsername, isUsernameConflict } from './username';

/** One row of the account list (data-model.md). */
export interface AccountListRow {
  id: string;
  email: string;
  username: string | null;
  status: UserStatus;
  roleName: string | null;
  companyName: string | null;
  displayName: string;
  employeeId: string | null;
  inviteExpiresAt: string | null;
  lastLoginAt: string | null;
}

export interface CreatedUser {
  id: string;
  email: string;
  status: UserStatus;
  /**
   * The account exists even when the invite could not be sent. Reported rather than
   * thrown so the admin knows to resend instead of retrying a create that would now
   * fail on a duplicate email.
   */
  emailDispatchFailed: boolean;
}

/** Everything a call needs about who is asking. */
export interface AdminCaller {
  userId: string;
  companyId: string | null;
  ipAddress: string;
  rls: RlsContext;
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);
  private readonly appBaseUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly email: EmailService,
    private readonly employees: EmployeesService,
    private readonly auditLog: AuditLogService,
    configService: ConfigService,
  ) {
    this.appBaseUrl = configService.get<EmailConfig>('email').appBaseUrl;
  }

  /** The link an invite carries. */
  private setPasswordUrl(rawToken: string): string {
    return `${this.appBaseUrl.replace(/\/+$/, '')}/set-password/${rawToken}`;
  }

  /**
   * Creates a `pending` account and dispatches its invite.
   *
   * The database work is one transaction; the email is sent after it commits. That
   * ordering is deliberate — an email is not transactional, so sending inside the
   * transaction risks delivering an invite for an account that then rolls back, and
   * a live set-password link for a user that does not exist is far worse than an
   * account whose invite needs resending.
   */
  async create(caller: AdminCaller, dto: CreateUserDto): Promise<CreatedUser> {
    const role = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.role.findUnique({ where: { id: dto.roleId } }),
    );
    if (!role) {
      throw new BadRequestException('That role does not exist.');
    }

    // "Super Admin" is a capability, not a name: 001's 2026-08-28 redesign replaced
    // the hardcoded role check with CROSS_COMPANY_ACCESS, so any role carrying that
    // permission is the cross-company case.
    const isCrossCompany = role.permissions.includes(
      Permission.CROSS_COMPANY_ACCESS,
    );
    if (isCrossCompany && dto.companyId) {
      throw new BadRequestException(
        'A cross-company role is not scoped to a single company, so companyId must be omitted.',
      );
    }
    if (!isCrossCompany && !dto.companyId) {
      throw new BadRequestException('companyId is required for this role.');
    }

    // Exactly one source for the name shown in the account list.
    if (dto.employeeId && dto.displayName) {
      throw new BadRequestException(
        'Provide either employeeId or displayName, not both — a linked employee already supplies the name.',
      );
    }
    if (!dto.employeeId && !dto.displayName) {
      throw new BadRequestException(
        'Provide either employeeId (to link an existing employee) or displayName.',
      );
    }

    await this.assertEmailAvailable(caller.rls, dto.email);

    const expiresAt = new Date(Date.now() + INVITE_TOKEN_TTL_HOURS * 3_600_000);
    const token = this.tokens.generate();

    const created = await this.insertUser(caller, dto, token.hash, expiresAt);

    // After commit — see the note above.
    let emailDispatchFailed = false;
    try {
      await this.email.sendInviteEmail({
        to: dto.email,
        setPasswordUrl: this.setPasswordUrl(token.raw),
        isResend: false,
        expiresAt,
      });
    } catch (error) {
      emailDispatchFailed = true;
      this.logger.error(
        `Invite email failed for ${
          dto.email
        }; the account exists and can be re-invited. ${
          (error as Error).message
        }`,
      );
    }

    await this.auditLog.record({
      entityType: AuditEntityType.USER_ACCOUNT,
      action: AuditAction.CREATE,
      entityId: created.id,
      // The raw token is deliberately absent: an audit row must never become a
      // second copy of a live credential-setting link.
      changes: {
        email: dto.email,
        roleId: dto.roleId,
        companyId: dto.companyId ?? null,
        employeeLinked: Boolean(dto.employeeId),
        emailDispatchFailed,
      } as Prisma.InputJsonValue,
      accountId: caller.userId,
      companyId: dto.companyId ?? caller.companyId,
      ipAddress: caller.ipAddress,
    });

    return {
      id: created.id,
      email: created.email,
      status: created.status,
      emailDispatchFailed,
    };
  }

  /**
   * Distinct messages for an active versus a deactivated collision (spec US1 AC6):
   * "already exists" sends an admin looking for an account they cannot see, whereas
   * knowing it is deactivated tells them to reactivate instead of re-inviting.
   */
  private async assertEmailAvailable(
    ctx: RlsContext,
    email: string,
  ): Promise<void> {
    // Email uniqueness is global, so this looks past the caller's company scope on
    // purpose — otherwise an admin would be told an address is free and then hit a
    // raw unique-constraint error on insert.
    const existing = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) =>
        tx.user.findUnique({
          where: { email },
          select: { status: true },
        }),
    );
    if (!existing) {
      return;
    }
    if (existing.status === UserStatus.deactivated) {
      throw new ConflictException(
        'An account with that email exists but is deactivated. Reactivate it instead of creating a new one.',
      );
    }
    if (existing.status === UserStatus.pending) {
      throw new ConflictException(
        'That email already has a pending invite. Resend the invite instead of creating another account.',
      );
    }
    throw new ConflictException('An account with that email already exists.');
  }

  /** The transactional half of `create()`, retried once on a username collision. */
  private async insertUser(
    caller: AdminCaller,
    dto: CreateUserDto,
    tokenHash: string,
    expiresAt: Date,
    retry = 0,
  ): Promise<{ id: string; email: string; status: UserStatus }> {
    try {
      return await withRlsContext(this.prisma, caller.rls, async (tx) => {
        const username = await allocateUsername(tx, dto.email);
        const user = await tx.user.create({
          data: {
            email: dto.email,
            username,
            // No password: that is what `pending` means. The column is nullable
            // precisely so this row can exist before one is chosen.
            password: null,
            displayName: dto.displayName ?? null,
            companyId: dto.companyId ?? null,
            status: UserStatus.pending,
          },
          select: { id: true, email: true, status: true },
        });

        await tx.userRole.create({
          data: {
            userId: user.id,
            roleId: dto.roleId,
            companyId: dto.companyId ?? null,
          },
        });

        if (dto.employeeId) {
          // Inside the same transaction, so a failed link rolls the account back
          // rather than leaving an invited user nobody meant to create.
          await this.employees.linkEmployeeToUser(
            caller.rls,
            dto.employeeId,
            user.id,
            tx,
          );
        }

        await tx.inviteToken.create({
          data: { userId: user.id, tokenHash, expiresAt },
        });

        return user;
      });
    } catch (error) {
      // The username check inside the transaction is advisory — two concurrent
      // invites to similar addresses can both see the same candidate as free. The
      // unique index settles it, and a single retry picks the next suffix.
      if (isUsernameConflict(error) && retry < 3) {
        return this.insertUser(caller, dto, tokenHash, expiresAt, retry + 1);
      }
      throw error;
    }
  }

  /*
   * NOTE — findAllForCompany, updateRoleOrStatus, deleteAccount, countByRoleId,
   * clearRoleAssignment and countActiveSuperAdmins are deliberately NOT here.
   *
   * research.md §8 asked for them "owned here", on the stated assumption that
   * feature 001 had never built them. It had: `src/users/users.service.ts`
   * implements all six, and both `settings/users-admin` and `settings/roles`
   * already call it. Adding a second copy produced two implementations of the same
   * operations, and FR-008's pending-account guard was written into the copy that
   * nothing calls — so the rule was unenforced on the only path that reaches it.
   *
   * The guard now lives on the implementation those callers actually use. This
   * module owns what is genuinely its own: creating an invited account, and
   * re-issuing its invite.
   */

  /**
   * Issues a fresh invite for a still-pending account (US3).
   *
   * The prior token is not deleted — the invite history stays auditable (FR-014).
   * It stops working because validation only ever accepts the newest row for a user,
   * which keeps "is this invite current?" derived from the data rather than tracked
   * in a flag that could disagree with it.
   */
  async resendInvite(
    caller: AdminCaller,
    userId: string,
  ): Promise<{ emailDispatchFailed: boolean }> {
    const user = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.user.findFirst({
        where: { id: userId },
        select: { id: true, email: true, status: true, companyId: true },
      }),
    );
    if (!user) {
      throw new NotFoundException('Account not found');
    }
    if (user.status !== UserStatus.pending) {
      throw new ConflictException(
        user.status === UserStatus.active
          ? 'That account is already active, so there is no invite to resend.'
          : 'That account is deactivated. Reactivate it instead of resending an invite.',
      );
    }

    const expiresAt = new Date(Date.now() + INVITE_TOKEN_TTL_HOURS * 3_600_000);
    const token = this.tokens.generate();
    await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.inviteToken.create({
        data: { userId: user.id, tokenHash: token.hash, expiresAt },
      }),
    );

    let emailDispatchFailed = false;
    try {
      await this.email.sendInviteEmail({
        to: user.email,
        setPasswordUrl: this.setPasswordUrl(token.raw),
        isResend: true,
        expiresAt,
      });
    } catch (error) {
      emailDispatchFailed = true;
      this.logger.error(
        `Invite resend failed for ${user.email}. ${(error as Error).message}`,
      );
    }

    await this.auditLog.record({
      entityType: AuditEntityType.USER_ACCOUNT,
      action: AuditAction.UPDATE,
      entityId: user.id,
      changes: {
        resentInvite: true,
        emailDispatchFailed,
      } as Prisma.InputJsonValue,
      accountId: caller.userId,
      companyId: user.companyId,
      ipAddress: caller.ipAddress,
    });

    return { emailDispatchFailed };
  }
}
