import { Injectable, NotFoundException } from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  CodeSeriesType,
  JobCardPaymentMode,
  JobCardStatus,
  Prisma,
  SparePartMovementType,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { actorNamesFor } from '../../common/actor-name';
import { CashPolicyService } from '../../common/cash/cash-policy';
import {
  type FormDocument,
  type FormFormat,
  type FormRow,
  type RenderedForm,
  dotDate,
  fileSafe,
  inr,
  qty,
  reading,
  renderFormFile,
} from '../../common/form-document';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { CodeSeriesService } from '../../settings/code-series/code-series.service';
import { assertInScope } from '../../settings/company-scope';
import { PlantRefsService } from '../plant-refs.service';
import {
  EDITABLE_STATUSES,
  changedUnderneath,
  effectiveJobCardStatus,
  inStatus,
  notEditable,
} from './job-card-workflow';
import {
  JOB_CARD_CHECKS,
  JOB_CARD_CONDITIONS,
  JOB_CARD_PRIORITIES,
  JOB_CARD_RESULTS,
  JOB_CARD_STATUSES,
  JOB_CARD_TYPES,
  type JobCardDto,
} from './dto/job-card.dto';

/** A job card as stored and returned: the DTO's fields, all optional. */
export type JobCard = Omit<JobCardDto, 'inspections' | 'parts' | 'signOff'> & {
  inspections?: NonNullable<JobCardDto['inspections']>;
  parts?: NonNullable<JobCardDto['parts']>;
  signOff?: NonNullable<JobCardDto['signOff']>;
};

/**
 * Where the card stands in its approval-and-payment workflow (039). Null on a card not yet saved.
 * Files are named, never linked: they are fetched through the card's download routes.
 */
export interface JobCardWorkflow {
  status: JobCardStatus;
  /** Head Office's correction remarks while the card is `returned` (or why it was rejected). */
  returnRemarks: string | null;
  quotation: {
    amount: number | null;
    fileName: string | null;
    hasFile: boolean;
  };
  finalBill: {
    billNumber: string | null;
    billDate: string | null;
    amount: number | null;
    fileName: string | null;
    uploadedAt: Date | null;
    uploadedByName: string | null;
  } | null;
  /** Paid so far — without cash while the company hides cash (038). */
  paidTotal: number;
  /** Bill amount less `paidTotal`; null until there is a bill. */
  balance: number | null;
}

/** The card with its number, the machine's own details filled in, and the parts drawn from store. */
export interface JobCardView {
  jobId: string | null;
  jobCardNo: string | null;
  equipmentId: string;
  /** The heading under the company name — the project the machine is working. */
  projectHeading: string | null;
  card: JobCard;
  storeParts: {
    description: string;
    partNo: string;
    quantity: number;
    unit: string;
    rate: number;
    amount: number;
  }[];
  workflow: JobCardWorkflow | null;
}

/** Job cards and maintenance jobs share the plant module's own short infix. */
const JOB_CARD_INFIX = 'JC';

/**
 * The vehicle / machinery maintenance job card (2026-10-15) — the client's six-section form: job
 * card and equipment details, the complaint, inspection and work carried out, spare parts used,
 * testing and handover, and the sign-off.
 *
 * A card belongs to a maintenance job and is numbered from the `JOB_CARD` series the first time it
 * is saved. Section 1's machine fields fill themselves from the machine — name, asset code,
 * registration, make and model, meter reading, operator and where it is deployed — and anything
 * typed over them is kept. Parts drawn from the spare-parts store against the job print on the card
 * beside the parts typed on it, so the card shows everything the repair used.
 */
@Injectable()
export class JobCardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly refs: PlantRefsService,
    private readonly codeSeries: CodeSeriesService,
    private readonly auditLog: AuditLogService,
    private readonly cash: CashPolicyService,
  ) {}

  /** Section 1 as the machine fills it — for a card being started before the job exists. */
  async prefill(
    caller: AuthenticatedUser,
    equipmentId: string,
  ): Promise<JobCardView> {
    const machine = await this.machine(caller, equipmentId);
    return {
      jobId: null,
      jobCardNo: null,
      equipmentId,
      projectHeading: machine.projectHeading,
      card: { ...machine.defaults, date: today() },
      storeParts: [],
      workflow: null,
    };
  }

  async get(caller: AuthenticatedUser, jobId: string): Promise<JobCardView> {
    const job = await this.job(caller, jobId);
    const machine = await this.machine(caller, job.equipmentId);
    const stored = (job.card ?? {}) as JobCard;
    return {
      jobId: job.id,
      jobCardNo: job.jobCardNo,
      equipmentId: job.equipmentId,
      projectHeading: machine.projectHeading,
      card: {
        ...machine.defaults,
        date: job.openedAt.toISOString().slice(0, 10),
        complaint: job.description,
        priority: job.type === 'breakdown' ? 'Breakdown' : 'Routine',
        jobType: job.type === 'scheduled' ? 'Preventive' : 'Corrective',
        ...withoutBlanks(stored),
      },
      storeParts: job.partMovements.map((m) => ({
        description: m.sparePart.name,
        partNo: m.sparePart.partNumber,
        quantity: Number(m.quantity),
        unit: m.sparePart.unitOfMeasure,
        rate: Number(m.rate),
        amount: Number(m.amount),
      })),
      workflow: await this.workflow(job),
    };
  }

  /**
   * Saves the card, numbering it the first time.
   *
   * Only while it is site's to change (039): a draft, or a card Head Office sent back for
   * correction. Once submitted the card is what Head Office is deciding on, and after approval it
   * is what the workshop is paid against — changing it then would change a figure somebody has
   * already agreed to. The first save records `created`; later saves record `edited` with the
   * fields that changed, which is enough for the history without copying the card into it.
   */
  async save(
    caller: AuthenticatedUser,
    jobId: string,
    card: JobCardDto,
    ipAddress: string,
  ): Promise<JobCardView> {
    const job = await this.job(caller, jobId);
    const status = effectiveJobCardStatus(job);
    if (status && !EDITABLE_STATUSES.includes(status))
      throw notEditable(status);
    const isNew = status === null;

    // The machine's details as they stand when the card is first saved are written into it, so
    // the card keeps the odometer it was opened at rather than following the machine forward.
    const machine = job.card
      ? null
      : await this.machine(caller, job.equipmentId);
    const stored = { ...(machine?.defaults ?? {}), ...withoutBlanks(card) };
    const changed = isNew
      ? []
      : changedFields((job.card ?? {}) as JobCard, stored as JobCard);
    await withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
      const jobCardNo =
        job.jobCardNo ??
        (await this.codeSeries.next(
          tx,
          job.companyId,
          CodeSeriesType.JOB_CARD,
          JOB_CARD_INFIX,
          async (candidate) =>
            !!(await tx.maintenanceJob.findFirst({
              where: { companyId: job.companyId, jobCardNo: candidate },
              select: { id: true },
            })),
        ));
      // Conditional on the status read above, so a save cannot land on a card submitted meanwhile.
      const updated = await tx.maintenanceJob.updateMany({
        where: {
          id: jobId,
          ...(isNew ? { jobCardStatus: null } : inStatus(status)),
        },
        data: {
          jobCardNo,
          card: JSON.parse(JSON.stringify(stored)) as Prisma.InputJsonObject,
          // A pre-039 card (null status) becomes an explicit draft on its first write.
          jobCardStatus: status ?? JobCardStatus.draft,
        },
      });
      if (updated.count === 0) throw changedUnderneath();
      if (isNew || changed.length > 0) {
        await tx.jobCardEvent.create({
          data: {
            companyId: job.companyId,
            maintenanceJobId: jobId,
            kind: isNew ? 'created' : 'edited',
            fromStatus: status,
            toStatus: status ?? JobCardStatus.draft,
            detail: isNew ? { jobCardNo } : { fields: changed },
            actorUserId: caller.id,
          },
        });
      }
    });
    await this.auditLog.record({
      entityType: AuditEntityType.MAINTENANCE_JOB,
      action: AuditAction.UPDATE,
      entityId: jobId,
      accountId: caller.id,
      companyId: job.companyId,
      ipAddress,
      changes: isNew ? { jobCard: 'created' } : { jobCardFields: changed },
    });
    return this.get(caller, jobId);
  }

  async document(
    caller: AuthenticatedUser,
    jobId: string,
    format: FormFormat,
  ): Promise<RenderedForm> {
    const view = await this.get(caller, jobId);
    const job = await this.job(caller, jobId);
    const company = await this.refs.documentCompany(job.companyId);
    return renderFormFile(
      buildJobCardForm(view, company),
      format,
      fileSafe(
        `Job Card ${
          view.jobCardNo ??
          `${view.card.assetNo ?? 'Machine'} ${view.card.date ?? ''}`.trim()
        }`,
      ),
    );
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async job(caller: AuthenticatedUser, jobId: string) {
    const job = await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.maintenanceJob.findUnique({
        where: { id: jobId },
        include: {
          partMovements: {
            where: {
              type: SparePartMovementType.consumption,
              deletedAt: null,
              reversedBy: null,
            },
            include: { sparePart: true },
            orderBy: { createdAt: 'asc' },
          },
          jobCardPayments: { select: { amount: true, mode: true } },
        },
      }),
    );
    if (!job) throw new NotFoundException('Maintenance job not found');
    assertInScope(caller, job, 'Maintenance job');
    return job;
  }

  private async workflow(
    job: Awaited<ReturnType<JobCardService['job']>>,
  ): Promise<JobCardWorkflow | null> {
    const status = effectiveJobCardStatus(job);
    if (!status) return null;
    // 038: while the company hides cash, a cash payment does not exist — not in the total either.
    const cashHidden = await this.cash.isHidden(job.companyId);
    const paidTotal =
      job.jobCardPayments
        .filter((p) => !(cashHidden && p.mode === JobCardPaymentMode.cash))
        .reduce((sum, p) => sum + Math.round(Number(p.amount) * 100), 0) / 100;
    const billAmount =
      job.finalBillAmount === null ? null : Number(job.finalBillAmount);
    const uploader = job.finalBillUploadedBy
      ? (await actorNamesFor(this.prisma, [job.finalBillUploadedBy])).get(
          job.finalBillUploadedBy,
        ) ?? null
      : null;
    return {
      status,
      returnRemarks: job.jobCardReturnRemarks,
      quotation: {
        amount:
          job.quotationAmount === null ? null : Number(job.quotationAmount),
        fileName: job.quotationFileName,
        hasFile: job.quotationFileRef !== null,
      },
      finalBill: job.finalBillFileRef
        ? {
            billNumber: job.finalBillNumber,
            billDate: job.finalBillDate?.toISOString().slice(0, 10) ?? null,
            amount: billAmount,
            fileName: job.finalBillFileName,
            uploadedAt: job.finalBillUploadedAt,
            uploadedByName: uploader,
          }
        : null,
      paidTotal,
      balance:
        billAmount === null
          ? null
          : Math.round((billAmount - paidTotal) * 100) / 100,
    };
  }

  /** What section 1 reads off the machine, and the project heading. */
  private async machine(caller: AuthenticatedUser, equipmentId: string) {
    const found = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const equipment = await tx.equipment.findUnique({
          where: { id: equipmentId },
        });
        if (!equipment) throw new NotFoundException('Equipment not found');
        assertInScope(caller, equipment, 'Equipment');
        const lastLog = await tx.logbookEntry.findFirst({
          where: { equipmentId, operatorId: { not: null } },
          orderBy: { date: 'desc' },
          select: { operatorId: true },
        });
        return { equipment, lastOperatorId: lastLog?.operatorId ?? null };
      },
    );
    const { equipment } = found;
    const [siteName, project, operatorName] = await Promise.all([
      equipment.deployedSiteId
        ? this.refs
            .siteNames(caller, [equipment.deployedSiteId])
            .then((m) => m.get(equipment.deployedSiteId!) ?? null)
        : Promise.resolve(null),
      equipment.deployedSiteId
        ? this.refs.projectOfSite(caller, equipment.deployedSiteId)
        : Promise.resolve(null),
      equipment.operatorName
        ? Promise.resolve(equipment.operatorName)
        : found.lastOperatorId
        ? this.refs
            .employeeNames(caller, [found.lastOperatorId])
            .then((m) => m.get(found.lastOperatorId!) ?? null)
        : Promise.resolve(null),
    ]);
    const defaults: JobCard = {
      machineName: equipment.name,
      assetNo: equipment.code,
      registrationNo: equipment.registrationNo ?? undefined,
      makeModel:
        [equipment.make, equipment.model].filter(Boolean).join(' ') ||
        undefined,
      meterReading: `${reading(Number(equipment.currentReading))} ${
        equipment.meterType === 'km' ? 'km' : 'hrs'
      }`,
      operator: operatorName ?? undefined,
      location: siteName ?? undefined,
    };
    return {
      defaults,
      projectHeading: project
        ? [project.name, project.location].filter(Boolean).join(', ')
        : null,
    };
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The card's top-level fields whose value differs between two saves — for the `edited` event. */
export function changedFields(before: JobCard, after: JobCard): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys]
    .filter(
      (key) =>
        JSON.stringify(before[key as keyof JobCard] ?? null) !==
        JSON.stringify(after[key as keyof JobCard] ?? null),
    )
    .sort();
}

/** A stored card's fields, dropping empty strings so they do not hide the machine's own values. */
function withoutBlanks(card: JobCard): JobCard {
  return Object.fromEntries(
    Object.entries(card).filter(
      ([, value]) => value !== '' && value !== null && value !== undefined,
    ),
  ) as JobCard;
}

/** The card as the client's format lays it out. */
export function buildJobCardForm(
  view: JobCardView,
  company: { name: string; address: string | null; logo: Buffer | null },
): FormDocument {
  const c = view.card;
  const one = (value: string | undefined) => (value ? [value] : []);
  const inspections: FormRow[] = (c.inspections ?? []).map((row, i) => [
    String(i + 1),
    row.fault ?? '',
    row.action ?? '',
    row.quotationAmount === undefined ? '' : inr(row.quotationAmount),
    row.startTime ?? '',
    row.finishTime ?? '',
  ]);
  const parts: FormRow[] = [
    ...view.storeParts.map((p) => ({
      ...p,
      description: `${p.description} (from store)`,
    })),
    ...(c.parts ?? []).map((p) => ({
      description: p.description ?? '',
      partNo: p.partNo ?? '',
      quantity: p.quantity ?? 0,
      unit: p.unit ?? '',
      rate: p.rate ?? 0,
      amount:
        p.quantity !== undefined && p.rate !== undefined
          ? Math.round(p.quantity * p.rate * 100) / 100
          : 0,
    })),
  ].map((p, i) => [
    String(i + 1),
    p.description,
    p.partNo,
    p.quantity ? qty(p.quantity) : '',
    p.unit,
    p.rate ? inr(p.rate) : '',
    p.amount ? inr(p.amount) : '',
  ]);
  const partsTotal =
    view.storeParts.reduce((s, p) => s + p.amount, 0) +
    (c.parts ?? []).reduce((s, p) => s + (p.quantity ?? 0) * (p.rate ?? 0), 0);
  const sign = (name: string | undefined) => [
    `Name: ${name ?? ''}`,
    'Signature:',
    'Date / Time:',
  ];

  return {
    company,
    subHeading: view.projectHeading ? [view.projectHeading.toUpperCase()] : [],
    title: 'VEHICLE / MACHINERY MAINTENANCE JOB CARD',
    caption:
      'Workshop / Plant Maintenance • Service, Repair & Preventive Maintenance Record',
    accent: 'navy',
    landscape: true,
    sheetName: view.jobCardNo ?? 'Job Card',
    footer: `${company.name}${
      view.projectHeading ? ` • ${view.projectHeading}` : ''
    } • Maintenance Record`,
    blocks: [
      { kind: 'bar', text: '1. JOB CARD & EQUIPMENT DETAILS' },
      {
        kind: 'fields',
        columns: 4,
        fields: [
          { label: 'Job Card No.:', value: view.jobCardNo ?? '' },
          { label: 'Date:', value: dotDate(c.date) },
          {
            label: 'Priority:',
            options: [...JOB_CARD_PRIORITIES],
            selected: one(c.priority),
          },
          {
            label: 'Job Type:',
            options: [...JOB_CARD_TYPES],
            selected: one(c.jobType),
          },
          { label: 'Department:', value: c.department },
          { label: 'Requested By:', value: c.requestedBy },
          { label: 'Location / Camp:', value: c.location },
          { label: 'Contact:', value: c.contact },
          { label: 'Vehicle / Machine Name:', value: c.machineName },
          { label: 'Asset / Fleet No.:', value: c.assetNo },
          { label: 'Registration No.:', value: c.registrationNo },
          { label: 'Make / Model:', value: c.makeModel },
          { label: 'Remarks', value: c.remarks },
          { label: 'Hour Meter / Odometer:', value: c.meterReading },
          { label: 'Fuel Level:', value: c.fuelLevel },
          { label: 'Operator / Driver:', value: c.operator },
        ],
      },
      { kind: 'bar', text: '2. COMPLAINT / JOB REQUEST' },
      {
        kind: 'fields',
        columns: 1,
        fields: [
          { label: 'Reported Problem / Complaint:', value: c.complaint },
        ],
      },
      {
        kind: 'fields',
        columns: 3,
        fields: [
          {
            label: 'Machine Condition:',
            options: [...JOB_CARD_CONDITIONS],
            selected: one(c.machineCondition),
          },
          { label: 'Breakdown Start:', value: c.breakdownStart },
          { label: 'Reported To:', value: c.reportedTo },
        ],
      },
      { kind: 'bar', text: '3. INSPECTION, DIAGNOSIS & WORK CARRIED OUT' },
      {
        kind: 'table',
        columns: [
          { label: 'Sr.', width: 3, align: 'center' },
          { label: 'Inspection / Fault Found', width: 24 },
          { label: 'Repair / Maintenance Action', width: 24 },
          { label: 'Technician Quotation Amount', width: 12, align: 'right' },
          { label: 'Start Time', width: 8, align: 'center' },
          { label: 'Finish Time', width: 8, align: 'center' },
        ],
        rows: inspections,
        emptyText: 'No inspection recorded yet.',
      },
      { kind: 'bar', text: '4. SPARE PARTS / CONSUMABLES USED' },
      {
        kind: 'table',
        columns: [
          { label: 'Sr.', width: 3, align: 'center' },
          { label: 'Item Description', width: 26 },
          { label: 'Part No.', width: 10 },
          { label: 'Qty.', width: 6, align: 'right' },
          { label: 'Unit', width: 6, align: 'center' },
          { label: 'Rate', width: 10, align: 'right' },
          { label: 'Total Amount', width: 11, align: 'right' },
        ],
        rows: parts,
        emptyText: 'No spare parts or consumables used.',
        foot: partsTotal
          ? [[{ text: 'Total', span: 6 }, inr(partsTotal)]]
          : undefined,
      },
      { kind: 'bar', text: '5. TESTING, SAFETY & HANDOVER' },
      {
        kind: 'fields',
        columns: 1,
        fields: [
          {
            label: 'Checks:',
            options: [...JOB_CARD_CHECKS],
            selected: c.checks ?? [],
          },
          {
            label: 'Test Result:',
            options: [...JOB_CARD_RESULTS],
            selected: one(c.testResult),
          },
          { label: 'Outstanding Work / Remarks:', value: c.outstandingWork },
        ],
      },
      {
        kind: 'fields',
        columns: 3,
        fields: [
          {
            label: 'Machine Status:',
            options: [...JOB_CARD_STATUSES],
            selected: one(c.machineStatus),
          },
          {
            label: 'Down Time:',
            value:
              c.downTimeHours === undefined
                ? ''
                : `${qty(c.downTimeHours, 2)} hrs`,
          },
          {
            label: 'Next Service Due:',
            value: [
              c.nextServiceDate ? `Date ${dotDate(c.nextServiceDate)}` : '',
              c.nextServiceReading ? `Meter ${c.nextServiceReading}` : '',
            ]
              .filter(Boolean)
              .join(' / '),
          },
        ],
      },
      { kind: 'bar', text: '6. APPROVAL & SIGN-OFF' },
      {
        kind: 'signatures',
        boxed: true,
        items: [
          { caption: 'Operator / Driver', lines: sign(c.signOff?.operator) },
          {
            caption: 'Technician / Mechanic',
            lines: sign(c.signOff?.technician),
          },
          {
            caption: 'Maintenance Supervisor',
            lines: sign(c.signOff?.supervisor),
          },
          {
            caption: 'Plant / Transport In-charge',
            lines: sign(c.signOff?.incharge),
          },
        ],
      },
      {
        kind: 'paragraph',
        text: [
          { text: 'Safety note: ', bold: true },
          {
            text:
              'Isolate equipment and apply lockout/tagout where required before maintenance. Do ' +
              'not release equipment for operation until required checks are completed and an ' +
              'authorized person approves handover.',
          },
        ],
      },
    ],
  };
}
