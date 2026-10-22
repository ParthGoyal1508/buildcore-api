import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { LetterRecordSources } from '../../letters/letter-record-sources';

/**
 * A project, as the work order, LOI and purchase order read it (2026-10-14).
 *
 * Those three are issued from a project's Letters tab with the project as their subject, and their
 * templates name the project and its client. Nothing answered for a project, so every one printed
 * "Letter of intent for ." — `letters` may not read this module's tables (`letters-boundary.spec`),
 * so `projects` registers the record instead, as `hr` does for an employee.
 *
 * Money is returned already written out (`Rs 3,06,98,559.85`): the letter prints it, and the
 * generic formatter would drop the currency and the paise.
 */
@Injectable()
export class ProjectLetterSource implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sources: LetterRecordSources,
  ) {}

  onModuleInit(): void {
    this.sources.register('project', (caller, id) => this.record(caller, id));
    // 041: a work order or LOI is addressed to its work order, not its project, and is issued
    // from the branch of the project it is on. Only the branch is answered; no template reads it.
    this.sources.register('work_order', (caller, id) =>
      this.workOrderBranch(caller, id),
    );
  }

  private async workOrderBranch(
    caller: AuthenticatedUser,
    workOrderId: string,
  ): Promise<Record<string, unknown> | null> {
    const workOrder = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.workOrder.findFirst({
          where: { id: workOrderId },
          select: { project: { select: { branchId: true } } },
        }),
    );
    return workOrder ? { branchId: workOrder.project.branchId } : null;
  }

  async record(
    caller: AuthenticatedUser,
    projectId: string,
  ): Promise<Record<string, unknown> | null> {
    const project = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.project.findFirst({
          where: { id: projectId },
          select: {
            name: true,
            code: true,
            location: true,
            contractValue: true,
            orderNumber: true,
            startDate: true,
            expectedEndDate: true,
            cgstApplicable: true,
            branchId: true,
            client: { select: { name: true, address: true } },
          },
        }),
    );
    if (!project) return null;
    return {
      name: project.name,
      code: project.code,
      location: project.location ?? '',
      contractValue: `Rs ${project.contractValue
        .toNumber()
        .toLocaleString('en-IN', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}`,
      orderNumber: project.orderNumber ?? '',
      startDate: project.startDate,
      expectedEndDate: project.expectedEndDate ?? '',
      // Flat, as the employee record is: a declared path into a nested `client.name` reads
      // nothing in the shape the letters registry resolves (`standard-letter-templates.spec`).
      clientName: project.client?.name ?? '',
      clientAddress: project.client?.address ?? '',
      // The project's GST choice (2026-10-14), so a work order splits its tax the way every
      // bill on the project does.
      gstOnBills: project.cgstApplicable ? 'CGST + SGST' : 'IGST',
      // 041: the branch the project bills from — the GSTIN and address its work orders print.
      branchId: project.branchId,
    };
  }
}
