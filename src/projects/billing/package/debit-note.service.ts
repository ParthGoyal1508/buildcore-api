import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  BillDirection,
  BillPackageStatus,
  BillTaxBasis,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { financialYear } from '../../../letters/letter-reference';
import type { RlsContext } from '../../../common/prisma/rls-context';
import { withRlsContext } from '../../../common/prisma/rls-context';
import { CompaniesService } from '../../../settings/companies/companies.service';
import { ProjectSourcesRegistry } from '../../portfolio/project-sources.registry';
import type { DebitNoteView } from '../workbook/debit-note-document';
import { packageLabel } from './bill-package.service';
import { PACKAGE_ERRORS } from './package-error-codes';

/** One item of a note, as the form sends it. The amount is computed, never sent. */
export interface DebitNoteLineInput {
  description: string;
  specification?: string | null;
  unit?: string | null;
  quantity: string;
  rate: string;
}

export interface RaiseDebitNoteInput {
  /** The subcontractor's work order — what names the party, its GSTIN and its vendor code. */
  workOrderId: string;
  /** ISO date. Defaults to today. */
  noteDate?: string;
  /** "O&M of Highway". Defaults to the work order's own description of the work. */
  natureOfWork?: string | null;
  /** 18 for 18% GST. */
  gstPercent: string;
  /** CGST + SGST (`intra_state`) or IGST (`inter_state`). */
  taxBasis: BillTaxBasis;
  lines: DebitNoteLineInput[];
}

export interface DebitNoteLineRow {
  id: string;
  description: string;
  specification: string | null;
  unit: string | null;
  quantity: string | null;
  rate: string;
  amount: string;
}

export interface DebitNoteRow {
  id: string;
  /** `2026-27/001`; null on a debit recorded before numbering existed. */
  noteNumber: string | null;
  noteDate: string;
  natureOfWork: string | null;
  workOrderId: string | null;
  workOrderNo: string | null;
  partyName: string | null;
  taxBasis: BillTaxBasis | null;
  gstPercent: string;
  amount: string;
  taxAmount: string;
  netAmount: string;
  /** "RA-07", where it has been recovered. */
  recoveredOn: string | null;
  recoveredOnPackageId: string | null;
  recordedAt: string;
  lines: DebitNoteLineRow[];
}

/** The notes as one bill shows them. */
export interface DebitRegister {
  packageId: string;
  /** False on a bill to the client: debit notes are raised on subcontractors only. */
  applicable: boolean;
  /** **True where the package has been issued** — the register *as at issue* (FR-039a). */
  asAtIssue: boolean;
  notes: DebitNoteRow[];
  /** What this bill recovers — the figure block B's mechanical debit carries (FR-038). */
  recoveredOnThisPackage: string;
  /** Every note listed, recovered or not. */
  total: string;
}

const ZERO = new Prisma.Decimal(0);
const round2 = (value: Prisma.Decimal) =>
  value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

/** `9.00` → `9`, `2.50` → `2.5` — how a rate reads in "CGST 9%". */
function percentLabel(value: Prisma.Decimal): string {
  return value.toDecimalPlaces(2).toString();
}

/**
 * The tax on a note's work-done amount, and how it prints (2026-10-15).
 *
 * Intra-state splits evenly into CGST and SGST, each rounded on its own — the format's 3,17,809.23
 * twice on 35,31,213.64 at 9% — so the printed lines always add up to the tax. Inter-state is one
 * IGST line. A note whose basis was never recorded (one migrated from a debit entered as a with-tax
 * figure) prints its tax as a single "GST" line.
 */
export function noteTaxes(
  amount: Prisma.Decimal,
  gstPercent: Prisma.Decimal,
  taxBasis: BillTaxBasis | null,
  storedTax?: Prisma.Decimal,
): {
  lines: { label: string; amount: Prisma.Decimal }[];
  total: Prisma.Decimal;
} {
  if (taxBasis === BillTaxBasis.intra_state) {
    const half = gstPercent.div(2);
    const each = round2(amount.mul(half).div(100));
    return {
      lines: [
        { label: `CGST ${percentLabel(half)}%`, amount: each },
        { label: `SGST ${percentLabel(half)}%`, amount: each },
      ],
      total: each.mul(2),
    };
  }
  if (taxBasis === BillTaxBasis.inter_state) {
    const igst = round2(amount.mul(gstPercent).div(100));
    return {
      lines: [{ label: `IGST ${percentLabel(gstPercent)}%`, amount: igst }],
      total: igst,
    };
  }
  const tax = storedTax ?? round2(amount.mul(gstPercent).div(100));
  return {
    lines: tax.isZero()
      ? []
      : [
          {
            label: gstPercent.isZero()
              ? 'GST'
              : `GST ${percentLabel(gstPercent)}%`,
            amount: tax,
          },
        ],
    total: tax,
  };
}

/**
 * A note's figures from what the form sent: each line's amount (quantity × rate, to the paisa), the
 * work-done total, the tax, and the net rounded to the rupee. One function for the raise and the
 * preview, so the two cannot print different numbers.
 */
function computeNote(input: RaiseDebitNoteInput) {
  if (input.lines.length === 0) {
    throw new BadRequestException('A debit note needs at least one item.');
  }
  const gstPercent = new Prisma.Decimal(input.gstPercent);
  const lines = input.lines.map((line) => {
    const quantity = new Prisma.Decimal(line.quantity);
    const rate = new Prisma.Decimal(line.rate);
    const amount = round2(quantity.mul(rate));
    return { ...line, quantity, rate, amount };
  });
  const amount = lines.reduce((sum, line) => sum.plus(line.amount), ZERO);
  const taxes = noteTaxes(amount, gstPercent, input.taxBasis);
  const net = amount
    .plus(taxes.total)
    .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);
  const noteDate = input.noteDate
    ? new Date(`${input.noteDate.slice(0, 10)}T00:00:00.000Z`)
    : new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
  return { gstPercent, lines, amount, taxes, net, noteDate };
}

/** Where the running number starts each April, and how wide it prints: `2026-27/001`. */
const NUMBER_WIDTH = 3;

/**
 * Debit notes (023 US5, reshaped 2026-10-15).
 *
 * ## Who a debit note is for
 *
 * **Subcontractors only.** A note is raised against a subcontractor's work order — which is what
 * names the party, its GSTIN and its vendor code on the document — and recovered on a bill to that
 * subcontractor under the same work order. A bill to the client neither lists nor recovers one:
 * the debits a client raises on us arrive as the client's own documents.
 *
 * ## The two rules that are about money rather than bookkeeping
 *
 * **A note is recovered on exactly one bill** (FR-037), enforced by a conditional update whose row
 * count is checked — not by reading the row and then writing it, which two simultaneous callers
 * would both pass. **An issued bill's register is frozen at issue** (FR-039a): a note recorded
 * after a bill was issued cannot change that signed document.
 */
@Injectable()
export class DebitNoteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly companies: CompaniesService,
    private readonly sources: ProjectSourcesRegistry,
  ) {}

  /**
   * Raises a note against a subcontractor's work order, under the next number of the financial
   * year it is dated in.
   *
   * Every figure is computed here and stored: each line's amount, the work-done total, the tax at
   * `gstPercent`, and the net rounded to the rupee as the format prints it. A note whose total was
   * whatever somebody typed is a claim nobody can check.
   */
  async raise(
    ctx: RlsContext,
    companyId: string,
    userId: string | null,
    projectId: string,
    input: RaiseDebitNoteInput,
  ): Promise<DebitNoteRow> {
    const { gstPercent, lines, amount, taxes, net, noteDate } =
      computeNote(input);
    const prefix = `${financialYear(noteDate)}/`;

    // The number is the highest under this year's prefix plus one, so the series restarts each
    // April with no counter to roll over. Two notes raised in the same instant can draw the same
    // number; the unique index refuses the second and it is retried once with the next.
    for (let attempt = 0; ; attempt += 1) {
      try {
        const created = await withRlsContext(this.prisma, ctx, async (tx) => {
          const project = await tx.project.findFirst({
            where: { id: projectId },
            select: { id: true },
          });
          if (!project) throw new NotFoundException('Project not found');
          const workOrder = await tx.workOrder.findFirst({
            where: { id: input.workOrderId, projectId },
            select: { id: true, workDetail: true, partnerId: true },
          });
          if (!workOrder) {
            throw new BadRequestException(
              'That work order is not on this project.',
            );
          }

          const existing = await tx.billPackageDebitNote.findMany({
            where: { companyId, noteNumber: { startsWith: prefix } },
            select: { noteNumber: true },
          });
          const highest = existing.reduce((max, row) => {
            if (!row.noteNumber?.startsWith(prefix)) return max;
            const tail = row.noteNumber.slice(prefix.length);
            return /^\d+$/.test(tail) ? Math.max(max, Number(tail)) : max;
          }, 0);
          const noteNumber = `${prefix}${String(highest + 1).padStart(
            NUMBER_WIDTH,
            '0',
          )}`;

          return tx.billPackageDebitNote.create({
            data: {
              companyId,
              projectId,
              workOrderId: workOrder.id,
              noteNumber,
              noteDate,
              natureOfWork:
                input.natureOfWork?.trim() || workOrder.workDetail || null,
              taxBasis: input.taxBasis,
              gstPercent,
              amount,
              taxAmount: taxes.total,
              netAmount: net,
              recordedByUserId: userId,
              lines: {
                create: lines.map((line) => ({
                  companyId,
                  projectId,
                  description: line.description.trim(),
                  location: line.specification?.trim() || null,
                  quantity: line.quantity,
                  unit: line.unit?.trim() || null,
                  rate: line.rate,
                  amount: line.amount,
                  // Each line with its share of the tax, so the register's running total — which
                  // sums lines — carries what the note charges.
                  amountWithTax: line.amount.plus(
                    round2(line.amount.mul(gstPercent).div(100)),
                  ),
                  noteNumber,
                  recordedByUserId: userId,
                })),
              },
            },
            include: NOTE_INCLUDE,
          });
        });
        return toNoteRow(created, await this.partyNames([created]));
      } catch (err) {
        const duplicate =
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002';
        if (!duplicate || attempt >= 2) throw err;
      }
    }
  }

  /**
   * The note as it would print, before it is raised (2026-10-15) — the "Preview" on the raise
   * form. Computed by the same `computeNote` the raise uses, so the preview and the saved note
   * cannot disagree; nothing is written and no number is drawn, so the number prints as "Draft".
   */
  async previewView(
    ctx: RlsContext,
    companyId: string,
    projectId: string,
    input: RaiseDebitNoteInput,
  ): Promise<DebitNoteView> {
    const { lines, amount, taxes, net, noteDate } = computeNote(input);
    const { project, workOrder } = await withRlsContext(
      this.prisma,
      ctx,
      async (tx) => ({
        project: await tx.project.findFirst({
          where: { id: projectId },
          select: { name: true, code: true, location: true },
        }),
        workOrder: await tx.workOrder.findFirst({
          where: { id: input.workOrderId, projectId },
          select: { code: true, workDetail: true, partnerId: true },
        }),
      }),
    );
    if (!project) throw new NotFoundException('Project not found');
    if (!workOrder) {
      throw new BadRequestException('That work order is not on this project.');
    }
    const company = await this.companies.getDocumentIdentity(companyId);
    const source = this.sources.vendorIdentitySource();
    const vendor =
      workOrder.partnerId && source
        ? await source.getBillingIdentity(workOrder.partnerId, companyId)
        : null;
    return {
      company: {
        name: company.name,
        address: company.address,
        logo: company.logo,
      },
      projectName: project.name,
      projectCode: project.code,
      location: project.location,
      noteNumber: 'Draft',
      noteDate: noteDate.toISOString().slice(0, 10),
      party: {
        name: vendor?.name ?? null,
        gstin: vendor?.gstin ?? null,
        code: vendor?.code ?? null,
      },
      workOrderNo: workOrder.code,
      natureOfWork: input.natureOfWork?.trim() || workOrder.workDetail || null,
      lines: lines.map((line, index) => ({
        srNo: index + 1,
        description: line.description.trim(),
        specification: line.specification?.trim() || null,
        unit: line.unit?.trim() || null,
        quantity: line.quantity.toFixed(2),
        rate: line.rate.toFixed(2),
        amount: line.amount.toFixed(2),
      })),
      amount: amount.toFixed(2),
      taxes: taxes.lines.map((tax) => ({
        label: tax.label,
        amount: tax.amount.toFixed(2),
      })),
      netAmount: net.toFixed(0),
    };
  }

  /**
   * Recovers a note on one bill (FR-037, FR-037a, FR-037b, FR-038) — a draft bill to the
   * subcontractor whose work order the note was raised against.
   *
   * **One statement decides it.** `WHERE "recoveredOnPackageId" IS NULL` means the database
   * arbitrates, so of two simultaneous applications exactly one updates a row.
   */
  async apply(
    ctx: RlsContext,
    noteId: string,
    packageId: string,
  ): Promise<DebitNoteRow> {
    const row = await withRlsContext(this.prisma, ctx, async (tx) => {
      const pkg = await tx.billPackage.findFirst({
        where: { id: packageId },
        select: {
          id: true,
          status: true,
          sequenceNo: true,
          direction: true,
          raBill: { select: { workOrderId: true } },
        },
      });
      if (!pkg) throw new NotFoundException('Bill package not found');
      if (pkg.direction !== BillDirection.to_subcontractor) {
        throw new BadRequestException(
          'Debit notes are recovered on bills to a subcontractor, not on a bill to the client.',
        );
      }

      // FR-037b. Applying to an issued bill would move a figure that has been frozen.
      if (pkg.status !== BillPackageStatus.draft) {
        throw new ConflictException({
          statusCode: 409,
          code: PACKAGE_ERRORS.packageIssued,
          message:
            `${packageLabel(
              pkg.sequenceNo,
            )} has been issued, so a debit note cannot be recovered on it. ` +
            'Recover it on the next bill instead.',
        });
      }

      const note = await tx.billPackageDebitNote.findFirst({
        where: { id: noteId },
        select: { id: true, workOrderId: true },
      });
      if (!note) throw new NotFoundException('Debit note not found');
      if (
        note.workOrderId &&
        pkg.raBill?.workOrderId &&
        note.workOrderId !== pkg.raBill.workOrderId
      ) {
        throw new BadRequestException(
          'This debit note was raised on a different work order, so it is recovered on that ' +
            'subcontractor’s bill, not this one.',
        );
      }

      const claimed = await tx.billPackageDebitNote.updateMany({
        where: { id: noteId, recoveredOnPackageId: null },
        data: { recoveredOnPackageId: packageId },
      });

      if (claimed.count === 0) {
        const existing = await tx.billPackageDebitNote.findFirst({
          where: { id: noteId },
          select: {
            recoveredOnPackageId: true,
            recoveredOnPackage: { select: { sequenceNo: true } },
          },
        });
        throw new ConflictException({
          statusCode: 409,
          code: PACKAGE_ERRORS.debitAlreadyRecovered,
          message:
            'This debit note has already been recovered on ' +
            `${
              existing?.recoveredOnPackage
                ? packageLabel(existing.recoveredOnPackage.sequenceNo)
                : 'another bill'
            }. A debit recovered twice is money taken twice.`,
          recoveredOnPackageId: existing?.recoveredOnPackageId ?? null,
        });
      }

      // The lines follow their note, so everything that reads lines (the abstract's hint, older
      // reports) sees the same recovery.
      await tx.billPackageDebit.updateMany({
        where: { noteId },
        data: { recoveredOnPackageId: packageId },
      });

      return tx.billPackageDebitNote.findFirstOrThrow({
        where: { id: noteId },
        include: NOTE_INCLUDE,
      });
    });
    return toNoteRow(row, await this.partyNames([row]));
  }

  /**
   * The notes as one bill shows them (FR-039, FR-039a).
   *
   * On a bill to a subcontractor: every note raised against that bill's work order, plus any
   * migrated note that never named one. Live for a draft; as at issue for an issued bill. On a bill
   * to the client: none — the register does not apply.
   */
  async registerFor(
    ctx: RlsContext,
    packageId: string,
  ): Promise<DebitRegister> {
    const register = await withRlsContext(this.prisma, ctx, async (tx) => {
      const pkg = await tx.billPackage.findFirst({
        where: { id: packageId },
        select: {
          id: true,
          projectId: true,
          status: true,
          issuedAt: true,
          direction: true,
          raBill: { select: { workOrderId: true } },
        },
      });
      if (!pkg) throw new NotFoundException('Bill package not found');

      const asAtIssue =
        pkg.status !== BillPackageStatus.draft && !!pkg.issuedAt;

      if (pkg.direction !== BillDirection.to_subcontractor) {
        return {
          packageId: pkg.id,
          applicable: false,
          asAtIssue,
          notes: [] as NoteEntity[],
          recoveredOnThisPackage: '0.00',
          total: '0.00',
        };
      }

      const workOrderId = pkg.raBill?.workOrderId ?? null;
      const notes = await tx.billPackageDebitNote.findMany({
        where: {
          projectId: pkg.projectId,
          ...(workOrderId
            ? { OR: [{ workOrderId }, { workOrderId: null }] }
            : {}),
          ...(asAtIssue ? { recordedAt: { lte: pkg.issuedAt as Date } } : {}),
        },
        include: NOTE_INCLUDE,
        orderBy: [{ noteDate: 'asc' }, { recordedAt: 'asc' }],
      });

      const recovered = notes
        .filter((note) => note.recoveredOnPackageId === packageId)
        .reduce((sum, note) => sum.plus(note.netAmount), ZERO);
      const total = notes.reduce((sum, note) => sum.plus(note.netAmount), ZERO);

      return {
        packageId: pkg.id,
        applicable: true,
        asAtIssue,
        notes,
        recoveredOnThisPackage: recovered.toFixed(2),
        total: total.toFixed(2),
      };
    });
    const parties = await this.partyNames(register.notes);
    return {
      ...register,
      notes: register.notes.map((note) => toNoteRow(note, parties)),
    };
  }

  /** The notes recovered on one bill, as documents — the bill package's "Debit Note" section. */
  async viewsRecoveredOn(
    ctx: RlsContext,
    packageId: string,
  ): Promise<DebitNoteView[]> {
    const ids = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.billPackageDebitNote.findMany({
        where: { recoveredOnPackageId: packageId },
        select: { id: true },
        orderBy: [{ noteDate: 'asc' }, { recordedAt: 'asc' }],
      }),
    );
    const views: DebitNoteView[] = [];
    for (const { id } of ids) views.push(await this.viewFor(ctx, id));
    return views;
  }

  /**
   * One note as its document.
   *
   * The party is the work order's subcontractor. Where the note has been recovered on an issued
   * bill, that bill's frozen receiver is used instead — the bill is what fixed those values, and a
   * note that re-resolved them would disagree with it the first time a vendor record was corrected.
   */
  async viewFor(ctx: RlsContext, noteId: string): Promise<DebitNoteView> {
    const note = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.billPackageDebitNote.findFirst({
        where: { id: noteId },
        include: {
          lines: { orderBy: { recordedAt: 'asc' } },
          project: { select: { name: true, code: true, location: true } },
          workOrder: { select: { code: true, partnerId: true } },
          recoveredOnPackage: {
            select: {
              receiverName: true,
              receiverGstin: true,
              receiverCode: true,
            },
          },
        },
      }),
    );
    if (!note) throw new NotFoundException('Debit note not found');

    const company = await this.companies.getDocumentIdentity(note.companyId);
    const frozen = note.recoveredOnPackage?.receiverName
      ? note.recoveredOnPackage
      : null;
    const source = this.sources.vendorIdentitySource();
    const vendor =
      !frozen && note.workOrder?.partnerId && source
        ? await source.getBillingIdentity(
            note.workOrder.partnerId,
            note.companyId,
          )
        : null;

    const taxes = noteTaxes(
      note.amount,
      note.gstPercent,
      note.taxBasis,
      note.taxAmount,
    );

    return {
      company: {
        name: company.name,
        address: company.address,
        logo: company.logo,
      },
      projectName: note.project.name,
      projectCode: note.project.code,
      location: note.project.location,
      noteNumber: note.noteNumber,
      noteDate: note.noteDate.toISOString().slice(0, 10),
      party: {
        name: frozen?.receiverName ?? vendor?.name ?? null,
        gstin: frozen?.receiverGstin ?? vendor?.gstin ?? null,
        code: frozen?.receiverCode ?? vendor?.code ?? null,
      },
      workOrderNo: note.workOrder?.code ?? null,
      natureOfWork: note.natureOfWork,
      lines: note.lines.map((line, index) => ({
        srNo: index + 1,
        description: line.description,
        specification: line.location,
        unit: line.unit,
        quantity: line.quantity?.toFixed(2) ?? null,
        rate: line.rate.toFixed(2),
        amount: line.amount.toFixed(2),
      })),
      amount: note.amount.toFixed(2),
      taxes: taxes.lines.map((tax) => ({
        label: tax.label,
        amount: tax.amount.toFixed(2),
      })),
      netAmount: note.netAmount.toFixed(0),
    };
  }

  /** The subcontractors' names behind a set of notes, by vendor id. */
  private async partyNames(notes: NoteEntity[]): Promise<Map<string, string>> {
    const source = this.sources.vendorIdentitySource();
    const names = new Map<string, string>();
    if (!source) return names;
    const pairs = new Map<string, string>();
    for (const note of notes) {
      if (note.workOrder?.partnerId) {
        pairs.set(note.workOrder.partnerId, note.companyId);
      }
    }
    await Promise.all(
      [...pairs].map(async ([vendorId, companyId]) => {
        const vendor = await source
          .getBillingIdentity(vendorId, companyId)
          .catch(() => null);
        if (vendor) names.set(vendorId, vendor.name);
      }),
    );
    return names;
  }

  /** Who a note's file is named after: its number, else the project's code. */
  async fileStem(ctx: RlsContext, noteId: string): Promise<string> {
    const note = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.billPackageDebitNote.findFirst({
        where: { id: noteId },
        select: { noteNumber: true, project: { select: { code: true } } },
      }),
    );
    if (!note) throw new NotFoundException('Debit note not found');
    // "2026-27/001" cannot be a file name; the slash becomes a dash.
    return `Debit Note ${(note.noteNumber ?? note.project.code).replace(
      /\//g,
      '-',
    )}`;
  }
}

const NOTE_INCLUDE = {
  lines: { orderBy: { recordedAt: 'asc' as const } },
  workOrder: { select: { code: true, partnerId: true } },
  recoveredOnPackage: { select: { sequenceNo: true } },
} satisfies Prisma.BillPackageDebitNoteInclude;

type NoteEntity = Prisma.BillPackageDebitNoteGetPayload<{
  include: typeof NOTE_INCLUDE;
}>;

function toNoteRow(
  note: NoteEntity,
  parties: Map<string, string> = new Map(),
): DebitNoteRow {
  return {
    id: note.id,
    noteNumber: note.noteNumber,
    noteDate: note.noteDate.toISOString().slice(0, 10),
    natureOfWork: note.natureOfWork,
    workOrderId: note.workOrderId,
    workOrderNo: note.workOrder?.code ?? null,
    partyName: note.workOrder?.partnerId
      ? parties.get(note.workOrder.partnerId) ?? null
      : null,
    taxBasis: note.taxBasis,
    gstPercent: note.gstPercent.toFixed(2),
    amount: note.amount.toFixed(2),
    taxAmount: note.taxAmount.toFixed(2),
    netAmount: note.netAmount.toFixed(2),
    recoveredOn: note.recoveredOnPackage
      ? packageLabel(note.recoveredOnPackage.sequenceNo)
      : null,
    recoveredOnPackageId: note.recoveredOnPackageId,
    recordedAt: note.recordedAt.toISOString(),
    lines: note.lines.map((line) => ({
      id: line.id,
      description: line.description,
      specification: line.location,
      unit: line.unit,
      quantity: line.quantity?.toFixed(3) ?? null,
      rate: line.rate.toFixed(2),
      amount: line.amount.toFixed(2),
    })),
  };
}
