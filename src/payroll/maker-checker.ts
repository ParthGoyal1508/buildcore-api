import { ForbiddenException } from '@nestjs/common';
import type { PrismaService } from 'nestjs-prisma';

import { withRlsContext } from '../common/prisma/rls-context';
import type { Caller } from '../hr/biometrics/face-enrolment.service';

/**
 * Maker-checker for money that leaves on approval — salary advances and loans (036 F19).
 *
 * Decision 4: **block, with no company override.** Two people are refused:
 *
 *   * **The maker** — whoever recorded it. Approval is meant to be a second pair of eyes; the
 *     same pair twice is not one.
 *   * **The payee** — the employee it is for, through their login. Somebody holding the `PAYROLL`
 *     permission is usually an employee too, and approving an advance to yourself is the case the
 *     control exists for.
 *
 * `403` with `SELF_APPROVAL`, the code reimbursement claims already use, so the web app has one
 * refusal to recognise. A system actor (`userId` null) is neither, and is not refused here.
 *
 * Rows recorded before 036 have their maker backfilled from the audit log by the migration; one the
 * audit log did not know has a null maker and is checked for the payee only.
 */
export async function assertNotMakerOrPayee(
  prisma: PrismaService,
  caller: Caller,
  record: {
    createdByUserId: string | null;
    employeeId: string;
    noun: 'advance' | 'loan';
  },
): Promise<void> {
  if (!caller.userId) return;
  if (record.createdByUserId && record.createdByUserId === caller.userId) {
    throw new ForbiddenException({
      statusCode: 403,
      code: 'SELF_APPROVAL',
      message: `You recorded this ${record.noun}, so someone else must approve it.`,
    });
  }
  const payee = await withRlsContext(prisma, caller.rls, (tx) =>
    tx.employee.findFirst({
      where: { id: record.employeeId },
      select: { userId: true },
    }),
  );
  if (payee?.userId && payee.userId === caller.userId) {
    throw new ForbiddenException({
      statusCode: 403,
      code: 'SELF_APPROVAL',
      message: `This ${record.noun} is for you, so someone else must approve it.`,
    });
  }
}
