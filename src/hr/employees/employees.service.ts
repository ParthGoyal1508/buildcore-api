import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, AuditEntityType, Employee, Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';
import { AuditLogService } from '../../auth/audit-log.service';
import { RlsContext, withRlsContext } from '../../common/prisma/rls-context';
import { EmployeeCodeService } from '../../settings/employee-code/employee-code.service';
import type { Caller } from '../biometrics/face-enrolment.service';
import type {
  CreateEmployeeDto,
  ListEmployeesQueryDto,
  RevealPiiDto,
} from './dto/create-employee.dto';
import type { UpdateEmployeeDto } from './dto/update-employee.dto';
import { PiiCipherService } from './pii-cipher.service';

/** The four regulated-PII fields, mapped to the columns that store them. */
const PII_COLUMNS = {
  aadhaar: 'aadhaarEncrypted',
  pan: 'panEncrypted',
  bankAccountNumber: 'bankAccountNumberEncrypted',
  // UAN is regulated PII but is not itself encrypted at rest: it is a
  // provident-fund account number that must be queryable for challan
  // reconciliation, and it carries no identity-document value on its own. It is
  // masked on read like the others.
  uan: 'uan',
} as const;

/** Employee shape as returned to admins: PII masked, encrypted columns removed. */
export type MaskedEmployee = Omit<
  Employee,
  'aadhaarEncrypted' | 'panEncrypted' | 'bankAccountNumberEncrypted'
> & {
  aadhaar: string | null;
  pan: string | null;
  bankAccountNumber: string | null;
  uan: string | null;
};

/**
 * Resolves the Employee record behind a request.
 *
 * Every `/my/*` endpoint goes through `requireByUserId()` rather than accepting an
 * employee identifier from the caller. That is the whole of FR-028's guarantee: if
 * the employee is only ever derived from the authenticated token, there is no
 * parameter for a caller to tamper with in order to read or write somebody else's
 * attendance, and no per-endpoint ownership check that can be forgotten later.
 */
@Injectable()
export class EmployeesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pii: PiiCipherService,
    private readonly employeeCode: EmployeeCodeService,
    private readonly auditLog: AuditLogService,
  ) {}

  /** The employee record for an account, or null if the account has none. */
  async getByUserId(ctx: RlsContext, userId: string): Promise<Employee | null> {
    return withRlsContext(this.prisma, ctx, (tx) =>
      tx.employee.findFirst({ where: { userId } }),
    );
  }

  /**
   * The caller's own employee record, or 403.
   *
   * Not 404: the account authenticated successfully and the resource it is asking
   * about is itself, so "we could not find you" would describe the situation
   * misleadingly. An authenticated user with no employee record is a provisioning
   * gap — someone has a login but was never onboarded as an employee — and the
   * message says so, because the person hitting this needs to know who to ask.
   */
  async requireByUserId(ctx: RlsContext, userId: string): Promise<Employee> {
    const employee = await this.getByUserId(ctx, userId);
    if (!employee) {
      throw new ForbiddenException(
        'No employee record is linked to this account. Ask an administrator to complete your employee onboarding.',
      );
    }
    return employee;
  }

  /** Look up an employee by id — for admin-side flows that legitimately act on
   * someone else's record, where RLS still confines the result to the caller's
   * company. */
  async getById(ctx: RlsContext, employeeId: string): Promise<Employee | null> {
    return withRlsContext(this.prisma, ctx, (tx) =>
      tx.employee.findFirst({ where: { id: employeeId } }),
    );
  }

  /**
   * Employee records for a batch of accounts, keyed by userId.
   *
   * Batched rather than looked up per row because the account list calls this once
   * for a whole page — a per-row lookup is the classic N+1, and it is the account
   * list that would pay for it.
   */
  async getByUserIds(
    ctx: RlsContext,
    userIds: string[],
  ): Promise<Map<string, { id: string; employeeCode: string }>> {
    if (userIds.length === 0) {
      return new Map();
    }
    const employees = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.employee.findMany({
        where: { userId: { in: userIds } },
        select: { id: true, employeeCode: true, userId: true },
      }),
    );
    return new Map(
      employees.map((e) => [
        e.userId,
        { id: e.id, employeeCode: e.employeeCode },
      ]),
    );
  }

  /**
   * Employees with no user account yet — the picker an admin uses when inviting
   * someone (feature 010).
   *
   * Exported from `hr` rather than letting account-creation query `hr.Employee`
   * itself: Principle I routes every cross-module read through the owning module's
   * service, and this is the only place that knows an "unlinked" employee is one
   * whose `userId` is null.
   */
  async getUnlinkedEmployees(
    ctx: RlsContext,
    companyId: string,
    search?: string,
  ): Promise<{ id: string; employeeCode: string }[]> {
    const term = search?.trim();
    return withRlsContext(this.prisma, ctx, (tx) =>
      tx.employee.findMany({
        where: {
          companyId,
          userId: null,
          ...(term
            ? { employeeCode: { contains: term, mode: 'insensitive' as const } }
            : {}),
        },
        select: { id: true, employeeCode: true },
        orderBy: { employeeCode: 'asc' },
        // Bounded because this backs a type-ahead: an unbounded list would ship
        // every unlinked employee in the company on the first keystroke.
        take: 50,
      }),
    );
  }

  /**
   * Points an employee record at a newly created account (feature 010).
   *
   * This is the only writer of `Employee.userId` anywhere in the system — 003
   * defined the column but nothing ever populated it, because linking is what
   * account creation does.
   *
   * Runs inside the caller's transaction when one is supplied, so the link and the
   * User insert either both land or neither does. A link written against a user
   * that was subsequently rolled back would point at nothing.
   */
  async linkEmployeeToUser(
    ctx: RlsContext,
    employeeId: string,
    userId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const run = async (client: Prisma.TransactionClient) => {
      const employee = await client.employee.findFirst({
        where: { id: employeeId },
        select: { id: true, userId: true },
      });
      if (!employee) {
        throw new NotFoundException('Employee not found');
      }
      if (employee.userId) {
        // 409 rather than overwriting: silently repointing an employee at a second
        // account would leave the first one orphaned and still able to log in.
        throw new ConflictException(
          'That employee is already linked to a user account.',
        );
      }
      await client.employee.update({
        where: { id: employeeId },
        data: { userId },
      });
    };

    if (tx) {
      await run(tx);
      return;
    }
    await withRlsContext(this.prisma, ctx, run);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Admin employee master (005 US1)
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Strips the encrypted columns and replaces them with masked, readable values.
   *
   * Every admin read path goes through this. `PiiMaskingInterceptor` sits over the
   * controller as a second net, but the service is the one that decides what a
   * caller is entitled to see — an interceptor that has to un-leak a value the
   * service already handed out is working too late.
   */
  private toMasked(employee: Employee): MaskedEmployee {
    const {
      aadhaarEncrypted,
      panEncrypted,
      bankAccountNumberEncrypted,
      ...rest
    } = employee;
    return {
      ...rest,
      aadhaar: this.pii.mask(aadhaarEncrypted),
      pan: this.pii.mask(panEncrypted),
      bankAccountNumber: this.pii.mask(bankAccountNumberEncrypted),
      uan: rest.uan ? PiiCipherService.maskValue(rest.uan) : null,
    };
  }

  /**
   * Rejects a statutory tab that claims a contribution applies without the number
   * it would be filed against.
   *
   * Re-checked here rather than left to the DTO because a PATCH may carry the
   * number without the flag, or the flag without the number — only the merged
   * record can answer the question. Accepting an inconsistent pair here would
   * defer the failure to challan generation, where it is far more expensive.
   */
  private assertStatutoryConsistent(
    merged: Pick<
      Employee,
      'pfApplicable' | 'uan' | 'pfNumber' | 'esicApplicable' | 'esicNumber'
    >,
  ): void {
    if (merged.pfApplicable && (!merged.uan || !merged.pfNumber)) {
      throw new BadRequestException(
        'uan and pfNumber are required when pfApplicable is true.',
      );
    }
    if (merged.esicApplicable && !merged.esicNumber) {
      throw new BadRequestException(
        'esicNumber is required when esicApplicable is true.',
      );
    }
  }

  /** Splits a DTO into plain columns plus the three encrypted PII columns. */
  private toColumns(dto: CreateEmployeeDto | UpdateEmployeeDto) {
    const { aadhaar, pan, bankAccountNumber, ...plain } = dto;
    const encrypted: Record<string, string | null> = {};
    if (aadhaar !== undefined)
      encrypted.aadhaarEncrypted = this.pii.encrypt(aadhaar);
    if (pan !== undefined) encrypted.panEncrypted = this.pii.encrypt(pan);
    if (bankAccountNumber !== undefined)
      encrypted.bankAccountNumberEncrypted = this.pii.encrypt(bankAccountNumber);

    // Date-only strings arrive as ISO strings; Prisma wants Date for @db.Date.
    const dateFields = [
      'dob',
      'dateOfJoining',
      'probationEndDate',
      'confirmationDate',
      'offerLetterIssuedDate',
      'appointmentLetterIssuedDate',
      'ndaSignedDate',
    ] as const;
    const dates: Record<string, Date | null> = {};
    for (const f of dateFields) {
      const v = (plain as Record<string, unknown>)[f];
      if (v !== undefined) {
        dates[f] = v === null ? null : new Date(v as string);
        delete (plain as Record<string, unknown>)[f];
      }
    }

    return { ...plain, ...dates, ...encrypted };
  }

  /** Creates an employee, allocating its code from Settings' per-company series. */
  async create(
    caller: Caller,
    companyId: string,
    dto: CreateEmployeeDto,
  ): Promise<MaskedEmployee> {
    this.assertStatutoryConsistent({
      pfApplicable: dto.pfApplicable ?? false,
      uan: dto.uan ?? null,
      pfNumber: dto.pfNumber ?? null,
      esicApplicable: dto.esicApplicable ?? false,
      esicNumber: dto.esicNumber ?? null,
    });

    const employeeCode = await this.employeeCode.getNextEmployeeCode(
      companyId,
      caller.rls,
    );

    const created = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.employee.create({
        data: {
          ...(this.toColumns(dto) as Prisma.EmployeeUncheckedCreateInput),
          companyId,
          employeeCode,
        },
      }),
    );

    await this.auditLog.record({
      entityType: AuditEntityType.EMPLOYEE,
      action: AuditAction.CREATE,
      entityId: created.id,
      accountId: caller.userId,
      companyId,
      ipAddress: caller.ipAddress,
    });

    return this.toMasked(created);
  }

  /** Updates an employee. `companyId` is deliberately not updatable — see US8. */
  async update(
    caller: Caller,
    employeeId: string,
    dto: UpdateEmployeeDto,
  ): Promise<MaskedEmployee> {
    const existing = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.employee.findFirst({ where: { id: employeeId } }),
    );
    if (!existing) throw new NotFoundException('Employee not found');

    this.assertStatutoryConsistent({
      pfApplicable: dto.pfApplicable ?? existing.pfApplicable,
      uan: dto.uan ?? existing.uan,
      pfNumber: dto.pfNumber ?? existing.pfNumber,
      esicApplicable: dto.esicApplicable ?? existing.esicApplicable,
      esicNumber: dto.esicNumber ?? existing.esicNumber,
    });

    const updated = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.employee.update({
        where: { id: employeeId },
        data: this.toColumns(dto) as Prisma.EmployeeUncheckedUpdateInput,
      }),
    );

    // The changed field *names* only — never the values. A before/after snapshot
    // of an employee record would copy Aadhaar and bank details into the audit
    // log, which is exactly the data the encryption above exists to contain.
    await this.auditLog.record({
      entityType: AuditEntityType.EMPLOYEE,
      action: AuditAction.UPDATE,
      entityId: employeeId,
      changes: { fields: Object.keys(dto) },
      accountId: caller.userId,
      companyId: existing.companyId,
      ipAddress: caller.ipAddress,
    });

    return this.toMasked(updated);
  }

  /** Paginated, filterable employee list. Masked PII throughout. */
  async list(
    caller: Caller,
    companyId: string,
    query: ListEmployeesQueryDto,
  ): Promise<{
    items: MaskedEmployee[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const term = query.search?.trim();

    const where: Prisma.EmployeeWhereInput = {
      companyId,
      // Active-only by default: a list that silently included leavers would
      // overstate headcount everywhere it is used.
      isActive: query.isActive ?? true,
      ...(query.departmentId ? { departmentId: query.departmentId } : {}),
      ...(query.siteId ? { siteId: query.siteId } : {}),
      ...(term
        ? {
            OR: [
              { employeeCode: { contains: term, mode: 'insensitive' as const } },
              { firstName: { contains: term, mode: 'insensitive' as const } },
              { lastName: { contains: term, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [items, total] = await withRlsContext(
      this.prisma,
      caller.rls,
      async (tx) =>
        Promise.all([
          tx.employee.findMany({
            where,
            orderBy: { employeeCode: 'asc' },
            skip: (page - 1) * pageSize,
            take: pageSize,
          }),
          tx.employee.count({ where }),
        ]),
    );

    return { items: items.map((e) => this.toMasked(e)), total, page, pageSize };
  }

  /** Single employee, masked. Composition of the detail tabs is US1 T019. */
  async getMasked(
    caller: Caller,
    employeeId: string,
  ): Promise<MaskedEmployee> {
    const employee = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.employee.findFirst({ where: { id: employeeId } }),
    );
    if (!employee) throw new NotFoundException('Employee not found');
    return this.toMasked(employee);
  }

  /**
   * Moves an employee to another company (US8, FR-007).
   *
   * The employee's `companyId` changes, which is what makes them administrable by
   * the destination company. Their pre-transfer attendance and leave stay visible
   * to the company they actually worked for — not by copying a tenant key onto
   * those rows, but because the RLS policy consults the `EmployeeTransfer` record
   * this writes (migration 20260902032000).
   *
   * A new employee code is allocated from the destination company's own series
   * unless retention is requested: a code carries the source company's short code
   * as its prefix, so keeping it means the employee's identifier permanently
   * disagrees with the company they are in. Sometimes that is what the business
   * wants, which is why it is a toggle rather than a rule.
   */
  async transfer(
    caller: Caller,
    employeeId: string,
    dto: {
      toCompanyId: string;
      transferDate: string;
      reason: string;
      retainCode?: boolean;
    },
  ): Promise<{
    employeeId: string;
    fromCompanyId: string;
    toCompanyId: string;
    employeeCode: string;
    codeRetained: boolean;
  }> {
    const employee = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.employee.findFirst({ where: { id: employeeId } }),
    );
    if (!employee) throw new NotFoundException('Employee not found');

    if (employee.companyId === dto.toCompanyId) {
      throw new ConflictException(
        'That employee is already in the destination company.',
      );
    }
    if (!employee.isActive) {
      throw new BadRequestException(
        'An inactive employee cannot be transferred; reactivate them first.',
      );
    }

    const retain = dto.retainCode ?? false;
    // Allocated before the transaction: the sequence is its own atomic
    // UPDATE ... RETURNING, and holding a write transaction open across it would
    // serialise every concurrent transfer behind this one.
    const newCode = retain
      ? employee.employeeCode
      : await this.employeeCode.getNextEmployeeCode(dto.toCompanyId, caller.rls);

    const fromCompanyId = employee.companyId;

    await withRlsContext(this.prisma, caller.rls, async (tx) => {
      // Written first, and inside the same transaction, because the RLS policy
      // that preserves pre-transfer visibility reads this row. If the update
      // landed without it, the source company would lose sight of its own history
      // for as long as the gap lasted.
      await tx.employeeTransfer.create({
        data: {
          employeeId,
          fromCompanyId,
          toCompanyId: dto.toCompanyId,
          transferDate: new Date(`${dto.transferDate}T00:00:00.000Z`),
          reason: dto.reason.trim(),
          codeRetained: retain,
          newEmployeeCode: retain ? null : newCode,
          transferredByUserId: caller.userId,
        },
      });

      await tx.employee.update({
        where: { id: employeeId },
        data: { companyId: dto.toCompanyId, employeeCode: newCode },
      });
    });

    await this.auditLog.record({
      entityType: AuditEntityType.EMPLOYEE_TRANSFER,
      action: AuditAction.CREATE,
      entityId: employeeId,
      changes: {
        fromCompanyId,
        toCompanyId: dto.toCompanyId,
        codeRetained: retain,
        employeeCode: newCode,
      },
      accountId: caller.userId,
      companyId: fromCompanyId,
      ipAddress: caller.ipAddress,
    });

    return {
      employeeId,
      fromCompanyId,
      toCompanyId: dto.toCompanyId,
      employeeCode: newCode,
      codeRetained: retain,
    };
  }

  /**
   * Returns one PII field in the clear, and records who looked at it.
   *
   * One field per call on purpose: "reveal this employee's Aadhaar" is an
   * accountable act, and an endpoint that returned all four at once would make the
   * audit trail unable to distinguish a payroll clerk checking a bank account from
   * someone harvesting identity documents.
   *
   * The audit write happens before the value is returned, so a failure to record
   * the access fails the request rather than quietly disclosing an unlogged value.
   */
  async revealPii(
    caller: Caller,
    employeeId: string,
    dto: RevealPiiDto,
  ): Promise<{ field: string; value: string | null }> {
    const employee = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.employee.findFirst({ where: { id: employeeId } }),
    );
    if (!employee) throw new NotFoundException('Employee not found');

    await this.auditLog.record({
      entityType: AuditEntityType.EMPLOYEE,
      action: AuditAction.READ,
      entityId: employeeId,
      changes: { revealedField: dto.field },
      accountId: caller.userId,
      companyId: employee.companyId,
      ipAddress: caller.ipAddress,
    });

    const column = PII_COLUMNS[dto.field];
    const stored = employee[column] as string | null;
    const value =
      column === 'uan' ? (stored ?? null) : this.pii.decrypt(stored);

    return { field: dto.field, value };
  }
}
