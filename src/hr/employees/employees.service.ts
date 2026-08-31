import { Injectable, ForbiddenException } from '@nestjs/common';
import { Employee } from '@prisma/client';
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
}
