import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Employee, Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';
import { RlsContext, withRlsContext } from '../../common/prisma/rls-context';

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
  constructor(private readonly prisma: PrismaService) {}

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
}
