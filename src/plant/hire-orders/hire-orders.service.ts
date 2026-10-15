import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CodeSeriesType, Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import {
  type FormDocument,
  type FormFormat,
  type FormRow,
  type RenderedForm,
  dotDate,
  fileSafe,
  inr,
  qty,
  renderFormFile,
} from '../../common/form-document';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { rupeesFirstInWords } from '../../common/rupees-in-words';
import { CodeSeriesService } from '../../settings/code-series/code-series.service';
import { assertInScope, companyScope } from '../../settings/company-scope';
import { PlantRefsService } from '../plant-refs.service';
import type {
  CreateHireOrderDto,
  HireOrderLineDto,
  UpdateHireOrderDto,
} from './dto/hire-order.dto';
import { hireOrderTerms } from './hire-order-terms';

export interface HireOrderLineView {
  id: string;
  position: number;
  equipmentId: string | null;
  title: string;
  description: string;
  sacCode: string | null;
  taxRate: number;
  quantity: number;
  uom: string;
  rate: number;
  amount: number;
}

export interface HireOrderView {
  id: string;
  companyId: string;
  code: string;
  referenceNo: string | null;
  date: string;
  vendorId: string;
  vendorName: string;
  projectId: string | null;
  projectName: string | null;
  pointOfDelivery: string | null;
  remarks: string | null;
  lines: HireOrderLineView[];
  taxableAmount: number;
  taxAmount: number;
  totalAmount: number;
  createdAt: Date;
}

/** Work orders and hire orders draw on the same series. */
const WORK_ORDER_CODE_INFIX = 'WO';

const round2 = (value: number) => Math.round(value * 100) / 100;

type OrderWithLines = Prisma.HireOrderGetPayload<{ include: { lines: true } }>;

/**
 * Vehicle work/hire orders (2026-10-15) — the client's "WORK/HIRE ORDER": the supplier, the
 * project and point of delivery, the PART-A schedule of equipment with SAC, GST rate, quantity,
 * unit and rate, and the fixed PART-C general terms.
 *
 * Numbered from the company's work-order series (Settings → Numbering), so a hire order and a
 * subcontract work order are never given the same number, and each steps over the other's.
 */
@Injectable()
export class HireOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly refs: PlantRefsService,
    private readonly codeSeries: CodeSeriesService,
  ) {}

  async findAll(
    caller: AuthenticatedUser,
    query: { companyId?: string; vendorId?: string; projectId?: string },
  ): Promise<HireOrderView[]> {
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.hireOrder.findMany({
          where: {
            ...companyScope(caller, query.companyId),
            ...(query.vendorId ? { vendorId: query.vendorId } : {}),
            ...(query.projectId ? { projectId: query.projectId } : {}),
          },
          include: { lines: { orderBy: { position: 'asc' } } },
          orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
          take: 200,
        }),
    );
    return this.views(caller, rows);
  }

  async findOne(caller: AuthenticatedUser, id: string): Promise<HireOrderView> {
    const [view] = await this.views(caller, [await this.load(caller, id)]);
    return view;
  }

  async create(
    caller: AuthenticatedUser,
    dto: CreateHireOrderDto,
    requestedCompanyId?: string,
  ): Promise<HireOrderView> {
    const companyId = this.refs.targetCompanyOf(caller, requestedCompanyId);
    await this.validate(caller, companyId, dto);
    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const code = await this.codeSeries.next(
          tx,
          companyId,
          CodeSeriesType.WORK_ORDER,
          WORK_ORDER_CODE_INFIX,
          async (candidate) =>
            !!(await tx.hireOrder.findFirst({
              where: { companyId, code: candidate },
              select: { id: true },
            })) ||
            !!(await tx.workOrder.findFirst({
              where: { companyId, code: candidate },
              select: { id: true },
            })),
        );
        return tx.hireOrder.create({
          data: {
            companyId,
            code,
            date: this.refs.parseDate(dto.date),
            referenceNo: dto.referenceNo?.trim() || null,
            vendorId: dto.vendorId,
            projectId: dto.projectId ?? null,
            pointOfDelivery: dto.pointOfDelivery?.trim() || null,
            remarks: dto.remarks?.trim() || null,
            createdByUserId: caller.id,
            lines: { create: this.lineRows(companyId, dto.lines) },
          },
          include: { lines: { orderBy: { position: 'asc' } } },
        });
      },
    );
    const [view] = await this.views(caller, [created]);
    return view;
  }

  async update(
    caller: AuthenticatedUser,
    id: string,
    dto: UpdateHireOrderDto,
  ): Promise<HireOrderView> {
    const existing = await this.load(caller, id);
    await this.validate(caller, existing.companyId, dto);
    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        if (dto.lines) {
          await tx.hireOrderLine.deleteMany({ where: { hireOrderId: id } });
        }
        return tx.hireOrder.update({
          where: { id },
          data: {
            ...(dto.date ? { date: this.refs.parseDate(dto.date) } : {}),
            ...(dto.referenceNo !== undefined
              ? { referenceNo: dto.referenceNo.trim() || null }
              : {}),
            ...(dto.vendorId ? { vendorId: dto.vendorId } : {}),
            ...(dto.projectId !== undefined
              ? { projectId: dto.projectId || null }
              : {}),
            ...(dto.pointOfDelivery !== undefined
              ? { pointOfDelivery: dto.pointOfDelivery.trim() || null }
              : {}),
            ...(dto.remarks !== undefined
              ? { remarks: dto.remarks.trim() || null }
              : {}),
            ...(dto.lines
              ? {
                  lines: {
                    create: this.lineRows(existing.companyId, dto.lines),
                  },
                }
              : {}),
          },
          include: { lines: { orderBy: { position: 'asc' } } },
        });
      },
    );
    const [view] = await this.views(caller, [updated]);
    return view;
  }

  /** Refused once a hire bill has been raised against the order. */
  async remove(caller: AuthenticatedUser, id: string): Promise<void> {
    await this.load(caller, id);
    await withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
      const bills = await tx.hireBill.count({ where: { hireOrderId: id } });
      if (bills > 0) {
        throw new BadRequestException(
          `${bills} hire bill(s) are raised against this order; it can no longer be deleted.`,
        );
      }
      await tx.hireOrder.delete({ where: { id } });
    });
  }

  // ── the document ───────────────────────────────────────────────────────────

  async document(
    caller: AuthenticatedUser,
    id: string,
    format: FormFormat,
  ): Promise<RenderedForm> {
    const order = await this.findOne(caller, id);
    const [company, vendor] = await Promise.all([
      this.refs.documentCompany(order.companyId),
      this.refs.vendorParticulars(caller, order.vendorId),
    ]);
    return renderFormFile(
      buildHireOrderForm(order, company, vendor),
      format,
      fileSafe(`Hire Order ${order.code}`),
    );
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async load(caller: AuthenticatedUser, id: string) {
    const order = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.hireOrder.findUnique({
          where: { id },
          include: { lines: { orderBy: { position: 'asc' } } },
        }),
    );
    if (!order) throw new NotFoundException('Hire order not found');
    assertInScope(caller, order, 'Hire order');
    return order;
  }

  private async validate(
    caller: AuthenticatedUser,
    companyId: string,
    dto: UpdateHireOrderDto,
  ) {
    if (dto.vendorId) await this.refs.requireVendorName(caller, dto.vendorId);
    if (dto.projectId) {
      await this.refs.requireProject(caller, dto.projectId, companyId);
    }
    const machines = (dto.lines ?? []).flatMap((l) =>
      l.equipmentId ? [l.equipmentId] : [],
    );
    if (machines.length) {
      const found = await withRlsContext(
        this.prisma,
        rlsContextFor(caller),
        (tx) =>
          tx.equipment.count({
            where: { id: { in: machines }, companyId },
          }),
      );
      if (found !== new Set(machines).size) {
        throw new BadRequestException(
          'A line names a machine that is not registered in this company.',
        );
      }
    }
  }

  private lineRows(companyId: string, lines: HireOrderLineDto[]) {
    return lines.map((line, index) => ({
      companyId,
      position: index + 1,
      equipmentId: line.equipmentId ?? null,
      title: line.title.trim(),
      description: line.description.trim(),
      sacCode: line.sacCode?.trim() || null,
      taxRate: line.taxRate ?? 0,
      quantity: line.quantity,
      uom: line.uom.trim().toUpperCase(),
      rate: line.rate,
      amount: round2(line.quantity * line.rate),
    }));
  }

  private async views(
    caller: AuthenticatedUser,
    rows: OrderWithLines[],
  ): Promise<HireOrderView[]> {
    const vendorNames = await this.refs.vendorNames(
      caller,
      rows.map((r) => r.vendorId),
    );
    const projects = new Map<string, string>();
    for (const projectId of new Set(
      rows.flatMap((r) => (r.projectId ? [r.projectId] : [])),
    )) {
      const project = await this.refs
        .requireProject(
          caller,
          projectId,
          rows.find((r) => r.projectId === projectId)!.companyId,
        )
        .catch(() => null);
      projects.set(
        projectId,
        project ? `${project.code}-${project.name}` : 'Unknown project',
      );
    }
    return rows.map((row) => {
      const lines = row.lines.map((line) => ({
        id: line.id,
        position: line.position,
        equipmentId: line.equipmentId,
        title: line.title,
        description: line.description,
        sacCode: line.sacCode,
        taxRate: Number(line.taxRate),
        quantity: Number(line.quantity),
        uom: line.uom,
        rate: Number(line.rate),
        amount: Number(line.amount),
      }));
      const taxableAmount = round2(lines.reduce((s, l) => s + l.amount, 0));
      const taxAmount = round2(
        lines.reduce((s, l) => s + (l.amount * l.taxRate) / 100, 0),
      );
      return {
        id: row.id,
        companyId: row.companyId,
        code: row.code,
        referenceNo: row.referenceNo,
        date: row.date.toISOString().slice(0, 10),
        vendorId: row.vendorId,
        vendorName: vendorNames.get(row.vendorId) ?? 'Unknown vendor',
        projectId: row.projectId,
        projectName: row.projectId ? projects.get(row.projectId) ?? null : null,
        pointOfDelivery: row.pointOfDelivery,
        remarks: row.remarks,
        lines,
        taxableAmount,
        taxAmount,
        totalAmount: round2(taxableAmount + taxAmount),
        createdAt: row.createdAt,
      };
    });
  }
}

/**
 * The order as the client's format lays it out. Everything entered — the reference, the supplier,
 * the project, the point of delivery, the PART-A lines — comes from the order; every label, the
 * opening paragraph, PART-C and the sign-off text are fixed.
 */
export function buildHireOrderForm(
  order: HireOrderView,
  company: {
    name: string;
    address: string | null;
    logo: Buffer | null;
    place: string | null;
  },
  vendor: {
    name: string;
    code: string;
    address: string | null;
    email: string | null;
    phone: string | null;
    gstin: string | null;
  } | null,
): FormDocument {
  const supplier = vendor?.name ?? order.vendorName;
  const rows: FormRow[] = [];
  order.lines.forEach((line, index) => {
    rows.push([
      String((index + 1) * 10).padStart(3, '0'),
      '',
      { text: line.title, bold: true },
      '',
      '',
      '',
      '',
      '',
      '',
    ]);
    rows.push([
      '',
      String(10).padStart(4, '0'),
      line.description,
      line.sacCode ?? '',
      line.taxRate ? qty(line.taxRate, 2) : '',
      qty(line.quantity, 3),
      line.uom,
      inr(line.rate),
      inr(line.amount),
    ]);
  });

  // GST by rate, as a tax invoice groups it.
  const byRate = new Map<number, number>();
  for (const line of order.lines) {
    if (line.taxRate > 0) {
      byRate.set(
        line.taxRate,
        (byRate.get(line.taxRate) ?? 0) + (line.amount * line.taxRate) / 100,
      );
    }
  }
  const foot: FormRow[] = [
    [{ text: 'Total', span: 8, align: 'right' }, inr(order.taxableAmount)],
    [
      { text: 'Total Taxable Amount', span: 8, align: 'right' },
      inr(order.taxableAmount),
    ],
    ...[...byRate].map(
      ([rate, amount]): FormRow => [
        { text: `GST @ ${qty(rate, 2)}%`, span: 8, align: 'right' },
        inr(round2(amount)),
      ],
    ),
    ...(byRate.size
      ? [
          [
            { text: 'Total Order Value', span: 8, align: 'right' },
            inr(order.totalAmount),
          ] as FormRow,
        ]
      : []),
    [
      {
        text: `Order value in words: ${rupeesFirstInWords(order.totalAmount)}`,
        span: 9,
        align: 'left',
      },
    ],
  ];

  const vendorLines = [
    supplier,
    vendor?.address ?? '',
    `Vendor Number:- ${vendor?.code ?? ''}`,
    `Work Order Number:- ${order.code}`,
    `Email ID:- ${vendor?.email ?? ''}`,
    ...(vendor?.phone ? [`Contact:- ${vendor.phone}`] : []),
    ...(vendor?.gstin ? [`GSTIN:- ${vendor.gstin}`] : []),
  ].filter((line) => line !== '');

  return {
    company,
    title: 'WORK/HIRE ORDER',
    accent: 'plain',
    sheetName: order.code,
    footer: `Work/Hire Order ${order.code}`,
    blocks: [
      {
        kind: 'fields',
        columns: 2,
        fields: [
          { label: 'Ref No.:', value: order.referenceNo ?? order.code },
          { label: 'Date:', value: dotDate(order.date) },
        ],
      },
      { kind: 'paragraph', text: 'To,', bold: true },
      { kind: 'paragraph', text: vendorLines.join('\n') },
      {
        kind: 'paragraph',
        text: [
          { text: 'Project: ', bold: true },
          { text: order.projectName ?? '' },
        ],
      },
      {
        kind: 'paragraph',
        text: [
          { text: 'Point of Delivery: ', bold: true },
          { text: order.pointOfDelivery ?? '' },
        ],
      },
      {
        kind: 'paragraph',
        align: 'left',
        text: [
          { text: company.name, bold: true },
          {
            text: ' (hereinafter referred to as the "Company") is hereby pleased to issue to ',
          },
          { text: supplier, bold: true },
          {
            text:
              ', (hereinafter referred to as the "Supplier"), this Work Order for the hiring of ' +
              'the following items as mentioned in PART-A, on the terms and conditions more ' +
              'particularly stipulated in this Work Order (herein after referred as the "Order"):-',
          },
        ],
      },
      {
        kind: 'table',
        caption: 'PART-A',
        fontSize: 8,
        columns: [
          { label: 'Sr. No.', width: 5, align: 'center' },
          { label: 'Sub No.', width: 5, align: 'center' },
          { label: 'Description Of Equipment(S)', width: 24 },
          { label: 'SAC Code', width: 6, align: 'center' },
          { label: 'Tax Rate(%)', width: 6, align: 'right' },
          { label: 'Quantity', width: 8, align: 'right' },
          { label: 'UOM', width: 5, align: 'center' },
          { label: 'Unit Rate INR', width: 10, align: 'right' },
          { label: 'Amount INR', width: 11, align: 'right' },
        ],
        rows,
        foot,
      },
      ...(order.remarks
        ? [
            {
              kind: 'paragraph' as const,
              text: [
                { text: 'Remarks: ', bold: true },
                { text: order.remarks },
              ],
            },
          ]
        : []),
      { kind: 'pageBreak' },
      { kind: 'heading', text: 'PART-C', align: 'center', underline: true },
      {
        kind: 'heading',
        text: 'GENERAL TERMS OF THIS WORK ORDER',
        align: 'center',
      },
      {
        kind: 'clauses',
        sections: hireOrderTerms(
          company.name,
          company.place ?? 'the place of the Company’s registered office',
        ),
      },
      {
        kind: 'paragraph',
        text:
          'You are requested to sign and stamp the duplicate copy of this order and return it ' +
          'to the Company for the records.',
      },
      { kind: 'paragraph', text: 'Thanking You, Yours faithfully,' },
      {
        kind: 'signatures',
        items: [
          { caption: `For, ${company.name}`, sub: '(Authorized Signatory)' },
        ],
      },
      {
        kind: 'paragraph',
        text: [
          { text: 'Acceptance : ', bold: true },
          {
            text:
              'I have read & understand the Order completely & I am accepting the Work Order by ' +
              'agreeing to the mentioned terms & condition as above. I acknowledge that I am a ' +
              'valid and lawful authority to enter into this Order. I confirmed that the Order is ' +
              'accepted and executed by the Authorized Person/Signatory of the Supplier, competent ' +
              'to sign this Order.',
          },
        ],
      },
      {
        kind: 'signatures',
        items: [{ caption: `For, ${supplier}`, sub: '(Authorized Signatory)' }],
      },
      {
        kind: 'paragraph',
        text: 'The above Work Order is for the ensuring the taxation compliance.',
      },
      {
        kind: 'signatures',
        items: [
          {
            caption: `For Vendor: ${supplier}`,
            sub: 'Authorized Signatory & Seal',
          },
          { caption: `For ${company.name}`, sub: 'Authorized Signatory' },
        ],
      },
    ],
  };
}
