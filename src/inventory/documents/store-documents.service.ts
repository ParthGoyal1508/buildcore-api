import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PurchaseStatus } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { actorNameOf } from '../../common/actor-name';
import {
  type FormBlock,
  type FormDocument,
  type FormField,
  type FormFormat,
  type FormRow,
  type RenderedForm,
  dashDate,
  fileSafe,
  qty,
  renderFormFile,
} from '../../common/form-document';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { ProjectsService } from '../../projects/portfolio/projects.service';
import { CompaniesService } from '../../settings/companies/companies.service';
import { assertInScope } from '../../settings/company-scope';
import { GRN_CONDITIONS } from '../purchases/dto/purchase.dto';
import { InventoryRefsService } from '../inventory-refs.service';
import { toNumber } from '../stock/stock.types';

/** The line every store form ends with in the client's set. */
const ERP_REFERENCE =
  'ERP Reference: Record linked document numbers, approvals and supporting attachments in the system.';

/**
 * The store documents in the client's "Parth Realcon ERP Inventory Forms" set (2026-10-15) — one
 * page each: the material indent / requisition, the material delivery challan, the goods receipt
 * note, the material issue slip and the stock transfer slip — and the daily issue register.
 *
 * Each prints a record the store already keeps: the indent, the transfer (its slip and the challan
 * that travels with it), the purchase's GRN, the issue. The labels, headings and sign-off captions
 * are the client's and fixed; everything filled in comes from the record. A field the record does
 * not hold prints blank for writing in, as the paper form would.
 */
@Injectable()
export class StoreDocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly refs: InventoryRefsService,
    private readonly projects: ProjectsService,
    private readonly companies: CompaniesService,
  ) {}

  // ── Material indent / requisition ──────────────────────────────────────────

  async indent(
    caller: AuthenticatedUser,
    id: string,
    format: FormFormat,
  ): Promise<RenderedForm> {
    const indent = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const found = await tx.materialIndent.findUnique({
          where: { id },
          include: { lines: { orderBy: { createdAt: 'asc' } } },
        });
        if (!found || found.deleted) {
          throw new NotFoundException('Indent not found');
        }
        assertInScope(caller, found, 'Indent');
        const balances = await tx.stockBalance.findMany({
          where: {
            siteId: found.siteId,
            itemId: { in: found.lines.map((l) => l.itemId) },
          },
        });
        const users = await tx.user.findMany({
          where: { id: { in: [found.requestedByUserId] } },
        });
        return { found, balances, raisedBy: users[0] };
      },
    );
    const { found, balances } = indent;
    const [company, items, sites, projectName] = await Promise.all([
      this.company(found.companyId, found.projectId),
      this.refs.itemsByIds(
        caller,
        found.lines.map((l) => l.itemId),
      ),
      this.refs.siteNames(caller, [found.siteId]),
      this.projectName(caller, found.projectId),
    ]);
    const stockOf = new Map(
      balances.map((b) => [
        b.itemId,
        toNumber(b.received) +
          toNumber(b.transferIn) -
          toNumber(b.issued) -
          toNumber(b.transferOut),
      ]),
    );
    const rows: FormRow[] = found.lines.map((line, i) => {
      const item = items.get(line.itemId);
      return [
        String(i + 1),
        item ? `${item.name} (${item.code})` : 'Unknown item',
        item?.unit ?? '',
        qty(toNumber(line.requestedQuantity)),
        qty(stockOf.get(line.itemId) ?? 0),
        line.approvedQuantity === null
          ? ''
          : qty(toNumber(line.approvedQuantity)),
      ];
    });
    return this.render(
      {
        company,
        title: 'MATERIAL INDENT / REQUISITION',
        caption: 'Site Material Demand Form',
        accent: 'blue',
        blocks: [
          {
            kind: 'fields',
            columns: 2,
            fields: [
              { label: 'Indent No.:', value: found.indentNumber },
              { label: 'Date:', value: dashDate(found.createdAt) },
              { label: 'Project Name:', value: projectName },
              {
                label: 'Site / Location:',
                value: sites.get(found.siteId) ?? '',
              },
              { label: 'Department:', value: found.department },
              {
                label: 'Required By Date:',
                value: dashDate(found.requiredByDate),
              },
              {
                label: 'Indent Raised By:',
                value: indent.raisedBy ? actorNameOf(indent.raisedBy) : '',
              },
              { label: 'Work / Purpose:', value: found.justification },
            ],
          },
          {
            kind: 'table',
            columns: [
              { label: 'S.No.', width: 4, align: 'center' },
              { label: 'Material Description / Specification', width: 30 },
              { label: 'Unit', width: 6, align: 'center' },
              { label: 'Qty. Required', width: 9, align: 'right' },
              { label: 'Available Stock', width: 9, align: 'right' },
              { label: 'Qty. Approved', width: 9, align: 'right' },
            ],
            rows,
          },
          remarks('Remarks:', found.decisionReason),
          ...signOff([
            ['Prepared By', 'Name / Signature'],
            ['Checked By', 'Storekeeper'],
            ['Approved By', 'Project Manager / HO'],
          ]),
        ],
      },
      format,
      `Indent ${found.indentNumber}`,
    );
  }

  // ── Delivery challan and stock transfer slip ───────────────────────────────

  async challan(
    caller: AuthenticatedUser,
    transferId: string,
    format: FormFormat,
  ): Promise<RenderedForm> {
    const t = await this.transfer(caller, transferId);
    return this.render(
      {
        company: t.company,
        title: 'MATERIAL DELIVERY CHALLAN',
        caption: 'Material Dispatch Document',
        accent: 'blue',
        blocks: [
          {
            kind: 'fields',
            columns: 2,
            fields: [
              { label: 'Challan No.:', value: t.row.challanNo },
              { label: 'Date:', value: dashDate(t.row.date) },
              { label: 'From Store / Supplier:', value: t.fromName },
              { label: 'To Project / Site:', value: t.toLabel },
              {
                label: 'Indent / PO No.:',
                value: t.row.dispatchReference ?? t.row.requestNo,
              },
              { label: 'Vehicle No.:', value: t.row.vehicleNo },
              { label: 'Transporter:', value: t.row.transporter },
              { label: 'Dispatch Reference:', value: t.row.transferNo },
            ],
          },
          {
            kind: 'table',
            columns: [
              { label: 'S.No.', width: 4, align: 'center' },
              { label: 'Material Description', width: 34 },
              { label: 'Unit', width: 6, align: 'center' },
              { label: 'Qty. Dispatched', width: 10, align: 'right' },
              { label: 'Remarks', width: 16 },
            ],
            rows: [
              ['1', t.itemLabel, t.unit, qty(t.quantity), t.row.remarks ?? ''],
            ],
          },
          remarks(
            'Total packages / quantity:',
            `${qty(t.quantity)} ${t.unit}`.trim(),
          ),
          remarks('Remarks:', t.row.reason),
          ...signOff([
            ['Prepared By', 'Storekeeper'],
            ['Checked By', 'Authorized Person'],
            ['Received By', 'Recipient acknowledgement'],
          ]),
        ],
      },
      format,
      `Delivery Challan ${t.row.challanNo ?? t.fallbackName}`,
    );
  }

  async transferSlip(
    caller: AuthenticatedUser,
    transferId: string,
    format: FormFormat,
  ): Promise<RenderedForm> {
    const t = await this.transfer(caller, transferId);
    const received =
      t.row.receivedQuantity === null ? null : toNumber(t.row.receivedQuantity);
    return this.render(
      {
        company: t.company,
        title: 'STOCK TRANSFER SLIP',
        caption: 'Inter-Store / Inter-Site Material Transfer',
        accent: 'blue',
        blocks: [
          {
            kind: 'fields',
            columns: 2,
            fields: [
              { label: 'Transfer No.:', value: t.row.transferNo },
              { label: 'Transfer Date:', value: dashDate(t.row.date) },
              { label: 'From Store / Site:', value: t.fromName },
              { label: 'To Store / Site:', value: t.toName },
              { label: 'Transfer Request No.:', value: t.row.requestNo },
              { label: 'Project / Cost Centre:', value: t.toProject },
              { label: 'Vehicle No.:', value: t.row.vehicleNo },
              {
                label: 'Expected Arrival:',
                value: dashDate(t.row.expectedArrival),
              },
            ],
          },
          {
            kind: 'table',
            columns: [
              { label: 'S.No.', width: 4, align: 'center' },
              { label: 'Material Description', width: 28 },
              { label: 'Unit', width: 6, align: 'center' },
              { label: 'Qty. Requested', width: 9, align: 'right' },
              { label: 'Qty. Dispatched', width: 9, align: 'right' },
              { label: 'Qty. Received', width: 9, align: 'right' },
              { label: 'Difference', width: 9, align: 'right' },
            ],
            rows: [
              [
                '1',
                t.itemLabel,
                t.unit,
                qty(t.quantity),
                qty(t.quantity),
                received === null ? '' : qty(received),
                received === null ? '' : qty(received - t.quantity),
              ],
            ],
          },
          remarks('Reason for Transfer:', t.row.reason),
          remarks('Shortage / Damage / Other Remarks:', t.row.remarks),
          ...signOff([
            ['Authorized By', 'Transfer approval'],
            ['Dispatched By', 'Sending storekeeper'],
            ['Received By', 'Receiving storekeeper'],
          ]),
        ],
      },
      format,
      `Transfer Slip ${t.row.transferNo ?? t.fallbackName}`,
    );
  }

  // ── Goods receipt note ─────────────────────────────────────────────────────

  async grn(
    caller: AuthenticatedUser,
    purchaseId: string,
    format: FormFormat,
  ): Promise<RenderedForm> {
    const found = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const purchase = await tx.purchase.findUnique({
          where: { id: purchaseId },
          include: {
            grn: true,
            indentLine: { include: { indent: true } },
          },
        });
        // 043: a site entry waiting for Head Office has no GRN until it is completed.
        if (
          !purchase ||
          purchase.deleted ||
          purchase.status !== PurchaseStatus.completed
        ) {
          throw new NotFoundException('Purchase not found');
        }
        assertInScope(caller, purchase, 'Purchase');
        return purchase;
      },
    );
    const grn = found.grn;
    const receivingProject = this.refs
      .projectOfSite(caller, found.siteId)
      .catch(() => null);
    const [company, items, sites, vendors, projectId] = await Promise.all([
      this.company(found.companyId, receivingProject),
      this.refs.itemsByIds(caller, [found.itemId]),
      this.refs.siteNames(caller, [found.siteId]),
      this.refs.vendorNames(caller, [found.vendorId]),
      receivingProject,
    ]);
    const item = items.get(found.itemId);
    const project = await this.projectName(caller, projectId);
    const n = (value: { toString(): string } | null | undefined) =>
      value === null || value === undefined ? '' : qty(Number(value));
    const ordered = toNumber(found.quantity);
    return this.render(
      {
        company,
        title: 'GOODS RECEIPT NOTE (GRN)',
        caption: 'Material Receipt & Verification',
        accent: 'blue',
        blocks: [
          {
            kind: 'fields',
            columns: 2,
            fields: [
              { label: 'GRN No.:', value: grn?.grnNumber },
              { label: 'Receipt Date:', value: dashDate(found.date) },
              {
                label: 'Project / Site:',
                value: [project, sites.get(found.siteId)]
                  .filter(Boolean)
                  .join(' / '),
              },
              { label: 'Receiving Store:', value: sites.get(found.siteId) },
              {
                label: 'Supplier / Transfer From:',
                value: vendors.get(found.vendorId),
              },
              {
                label: 'PO / Indent No.:',
                value: found.indentLine?.indent.indentNumber,
              },
              { label: 'Challan No.:', value: grn?.challanNo },
              { label: 'Vehicle No.:', value: grn?.vehicleNo },
            ],
          },
          {
            kind: 'table',
            columns: [
              { label: 'S.No.', width: 4, align: 'center' },
              { label: 'Material Description', width: 26 },
              { label: 'Unit', width: 6, align: 'center' },
              { label: 'Qty. Ordered / Sent', width: 9, align: 'right' },
              { label: 'Qty. Received', width: 9, align: 'right' },
              { label: 'Accepted Qty.', width: 9, align: 'right' },
              { label: 'Rejected / Short Qty.', width: 9, align: 'right' },
            ],
            rows: [
              [
                '1',
                item ? `${item.name} (${item.code})` : 'Unknown item',
                item?.unit ?? '',
                qty(ordered),
                grn?.receivedQuantity !== null &&
                grn?.receivedQuantity !== undefined
                  ? n(grn.receivedQuantity)
                  : qty(ordered),
                n(grn?.acceptedQuantity),
                n(grn?.rejectedQuantity),
              ],
            ],
          },
          {
            kind: 'fields',
            columns: 1,
            fields: [
              {
                label: 'Material condition:',
                options: [...GRN_CONDITIONS],
                selected: grn?.condition ? [grn.condition] : [],
              },
              {
                label: 'Batch / Make / Specification (if applicable):',
                value: grn?.batchDetails,
              },
              {
                label: 'Remarks / Discrepancy Details:',
                value: grn?.discrepancy ?? found.remarks,
              },
            ],
          },
          ...signOff([
            ['Received By', 'Storekeeper'],
            ['Inspected By', 'Engineer / QA-QC'],
            ['Verified By', 'Authorized Person'],
          ]),
        ],
      },
      format,
      // A purchase recorded before GRNs were numbered is named by what and when, not by its id.
      `GRN ${
        grn?.grnNumber ?? `${item?.name ?? 'Material'} ${dashDate(found.date)}`
      }`,
    );
  }

  // ── Material issue slip ────────────────────────────────────────────────────

  async issueSlip(
    caller: AuthenticatedUser,
    issueId: string,
    format: FormFormat,
  ): Promise<RenderedForm> {
    const issue = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const found = await tx.issue.findUnique({
          where: { id: issueId },
          include: { indentLine: { include: { indent: true } } },
        });
        if (!found || found.deleted) {
          throw new NotFoundException('Issue not found');
        }
        assertInScope(caller, found, 'Issue');
        // 039: a composite issue is one slip for every sub-item it took from the store.
        const lines = found.issueGroupId
          ? await tx.issue.findMany({
              where: { issueGroupId: found.issueGroupId, deleted: false },
              orderBy: { itemId: 'asc' },
            })
          : [found];
        return { ...found, lines };
      },
    );
    const ctx = rlsContextFor(caller);
    const [company, items, sites, project, activity, composites] =
      await Promise.all([
        this.company(issue.companyId, issue.projectId),
        this.refs.itemsByIds(
          caller,
          issue.lines.map((line) => line.itemId),
        ),
        this.refs.siteNames(caller, [issue.siteId]),
        this.projectName(caller, issue.projectId),
        issue.activityId
          ? this.projects
              .getActivityById(issue.activityId, ctx)
              .catch(() => null)
          : Promise.resolve(null),
        this.refs.compositeNames(
          caller,
          issue.compositeItemId ? [issue.compositeItemId] : [],
        ),
      ]);
    const item = items.get(issue.itemId);
    const store = sites.get(issue.siteId) ?? '';
    const composite = issue.compositeItemId
      ? composites.get(issue.compositeItemId)
      : undefined;
    // "DLC Concrete for plant foundation · 10 CUM", printed above the sub-items it was issued as.
    const compositeLabel = issue.compositeItemId
      ? `${composite?.name ?? 'Composite item'} · ${qty(
          toNumber(issue.compositeQuantity),
        )} ${composite?.unit ?? ''}`.trim()
      : null;
    return this.render(
      {
        company,
        title: 'MATERIAL ISSUE SLIP',
        caption: 'Material Issue to User / Work Activity',
        accent: 'blue',
        blocks: [
          {
            kind: 'fields',
            columns: 2,
            fields: [
              { label: 'Issue Slip No.:', value: issue.slipNo },
              { label: 'Issue Date:', value: dashDate(issue.date) },
              {
                label: 'Project / Site:',
                value: [project, store].filter(Boolean).join(' / '),
              },
              { label: 'Store Location:', value: store },
              { label: 'Issued To:', value: issue.issuedTo },
              {
                label: 'Indent / Reference No.:',
                value: issue.indentLine?.indent.indentNumber,
              },
              { label: 'Work Activity:', value: activity?.name },
              {
                label: 'Equipment No. (if applicable):',
                value: issue.equipmentNo,
              },
            ],
          },
          {
            kind: 'table',
            columns: [
              { label: 'S.No.', width: 4, align: 'center' },
              { label: 'Material Description', width: 30 },
              { label: 'Unit', width: 6, align: 'center' },
              { label: 'Qty. Requested', width: 9, align: 'right' },
              { label: 'Qty. Issued', width: 9, align: 'right' },
              { label: 'Remarks', width: 14 },
            ],
            rows: [...issue.lines]
              .sort((a, b) =>
                (items.get(a.itemId)?.name ?? '').localeCompare(
                  items.get(b.itemId)?.name ?? '',
                ),
              )
              .map((line, i) => {
                const lineItem = items.get(line.itemId);
                return [
                  String(i + 1),
                  lineItem
                    ? `${lineItem.name} (${lineItem.code})`
                    : 'Unknown item',
                  lineItem?.unit ?? '',
                  // A composite never fulfils an indent, so this is only ever the one plain line.
                  issue.indentLine
                    ? qty(toNumber(issue.indentLine.requestedQuantity))
                    : '',
                  qty(toNumber(line.quantity)),
                  line.returnedQuantity !== null
                    ? `Returned ${qty(toNumber(line.returnedQuantity))}`
                    : '',
                ];
              }),
          },
          remarks(
            'Purpose / Remarks:',
            [compositeLabel, issue.remarks].filter(Boolean).join(' — ') || null,
          ),
          ...signOff([
            ['Issued By', 'Storekeeper'],
            ['Approved By', 'Authorized Engineer / PM'],
            ['Received By', 'User / Employee'],
          ]),
        ],
      },
      format,
      `Issue Slip ${
        issue.slipNo ?? `${item?.name ?? 'Material'} ${dashDate(issue.date)}`
      }`,
    );
  }

  // ── Daily issue register ───────────────────────────────────────────────────

  /**
   * The client's "DAILY ISSUE REGISTER" for one store over a span of days: every issue with its
   * date, item code and description, quantity and recipient, a column to sign, and what came back
   * — the quantity, when, and who received it.
   */
  async dailyRegister(
    caller: AuthenticatedUser,
    query: {
      siteId: string;
      dateFrom: string;
      dateTo?: string;
      companyId?: string;
    },
    format: FormFormat,
  ): Promise<RenderedForm> {
    if (!query.siteId) throw new BadRequestException('siteId is required');
    const from = this.refs.parseDate(query.dateFrom);
    const to = this.refs.parseDate(query.dateTo ?? query.dateFrom);
    if (to < from) throw new BadRequestException('dateTo is before dateFrom');
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.issue.findMany({
          where: {
            siteId: query.siteId,
            deleted: false,
            date: { gte: from, lte: to },
          },
          orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
        }),
    );
    // The site must be one the caller can see, whether or not it issued anything.
    const companyId = this.refs.targetCompanyOf(
      caller,
      query.companyId ?? rows[0]?.companyId,
    );
    const siteName = await this.refs.requireSiteName(
      caller,
      query.siteId,
      companyId,
    );
    const siteProject = this.refs
      .projectOfSite(caller, query.siteId)
      .catch(() => null);
    const [company, items, projectId, composites] = await Promise.all([
      this.company(companyId, siteProject),
      this.refs.itemsByIds(
        caller,
        rows.map((r) => r.itemId),
      ),
      siteProject,
      this.refs.compositeNames(
        caller,
        rows.flatMap((r) => (r.compositeItemId ? [r.compositeItemId] : [])),
      ),
    ]);
    const project = await this.projectName(caller, projectId);
    // A composite issue's rows share one slip number; the header names each slip once.
    const slips = [
      ...new Set(rows.flatMap((r) => (r.slipNo ? [r.slipNo] : []))),
    ];
    const span =
      dashDate(from) === dashDate(to)
        ? dashDate(from)
        : `${dashDate(from)} to ${dashDate(to)}`;
    const body: FormRow[] = rows.map((r, i) => {
      const item = items.get(r.itemId);
      return [
        String(i + 1),
        dashDate(r.date),
        item?.code ?? '',
        item?.name ?? 'Unknown item',
        `${qty(toNumber(r.quantity))} ${item?.unit ?? ''}`.trim(),
        r.issuedTo,
        '',
        r.returnedQuantity === null ? '' : qty(toNumber(r.returnedQuantity)),
        dashDate(r.returnedOn),
        r.receivedBy ?? '',
        // 039: a sub-item row says which mix it went out as, "DLC Concrete · 10 CUM".
        [
          r.slipNo,
          r.compositeItemId
            ? `${
                composites.get(r.compositeItemId)?.name ?? 'Composite item'
              } · ${qty(toNumber(r.compositeQuantity))} ${
                composites.get(r.compositeItemId)?.unit ?? ''
              }`.trim()
            : null,
          r.remarks,
        ]
          .filter(Boolean)
          .join(' · '),
      ];
    });
    return this.render(
      {
        company,
        title: 'DAILY ISSUE REGISTER',
        accent: 'navy',
        landscape: true,
        sheetName: 'Daily Issue Register',
        blocks: [
          {
            kind: 'fields',
            columns: 2,
            fields: [
              {
                label: 'SITE / PROJECT:',
                value: [project, siteName].filter(Boolean).join(' / '),
              },
              {
                label: 'ISSUE SLIP NO.:',
                value: slips.length
                  ? slips.length === 1
                    ? slips[0]
                    : `${slips[0]} – ${slips[slips.length - 1]}`
                  : '',
              },
              { label: 'STORE / LOCATION:', value: siteName },
              { label: 'DATE:', value: span },
            ],
          },
          {
            kind: 'table',
            fontSize: 7.5,
            columns: [
              { label: 'S. NO.', width: 3.5, align: 'center' },
              { label: 'DATE', width: 6.5, align: 'center' },
              { label: 'ITEM CODE', width: 7 },
              { label: 'MATERIAL DESCRIPTION', width: 16 },
              { label: 'ISSUED QTY', width: 6.5, align: 'right' },
              { label: 'ISSUED TO', width: 10 },
              { label: 'ISSUER SIGNATURE', width: 8 },
              { label: 'RECEIVED QTY', width: 6, align: 'right' },
              { label: 'RETURNED ON', width: 6.5, align: 'center' },
              { label: 'RECEIVED BY', width: 8 },
              { label: 'REMARKS', width: 10 },
            ],
            rows: body,
            emptyText: 'No material was issued from this store in this period.',
          },
          ...signOff([
            ['ISSUED BY', ''],
            ['CHECKED BY', ''],
            ['AUTHORIZED BY', ''],
          ]).filter((b) => b.kind !== 'paragraph'),
        ],
      },
      format,
      `Daily Issue Register ${siteName} ${span}`,
    );
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async transfer(caller: AuthenticatedUser, id: string) {
    const row = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const found = await tx.stockTransfer.findUnique({ where: { id } });
        if (!found || found.deleted) {
          throw new NotFoundException('Transfer not found');
        }
        assertInScope(caller, found, 'Transfer');
        return found;
      },
    );
    const receivingProject = this.refs
      .projectOfSite(caller, row.toSiteId)
      .catch(() => null);
    const [company, items, sites, toProjectId] = await Promise.all([
      // A transfer is printed as the receiving project's branch — the registration taking the goods.
      this.company(row.companyId, receivingProject),
      this.refs.itemsByIds(caller, [row.itemId]),
      this.refs.siteNames(caller, [row.fromSiteId, row.toSiteId]),
      receivingProject,
    ]);
    const toProject = await this.projectName(caller, toProjectId);
    const item = items.get(row.itemId);
    const toName = sites.get(row.toSiteId) ?? '';
    return {
      row,
      company,
      fromName: sites.get(row.fromSiteId) ?? '',
      toName,
      toProject,
      toLabel: [toProject, toName].filter(Boolean).join(' / '),
      itemLabel: item ? `${item.name} (${item.code})` : 'Unknown item',
      /** For a transfer recorded before slips were numbered: what and when, not its id. */
      fallbackName: `${item?.name ?? 'Material'} ${dashDate(row.date)}`,
      unit: item?.unit ?? '',
      quantity: toNumber(row.quantity),
    };
  }

  /**
   * The company as printed at a store document's head — as the branch (041) of the project the
   * document belongs to, or the head office when it has none.
   */
  private async company(
    companyId: string,
    projectId?: string | null | Promise<string | null>,
  ) {
    const branchId = await this.projects.branchIdOf(companyId, await projectId);
    const identity = await this.companies.getDocumentIdentity(
      companyId,
      branchId,
    );
    return {
      name: identity.name.toUpperCase(),
      address: identity.address,
      logo: identity.logo,
    };
  }

  private async projectName(
    caller: AuthenticatedUser,
    projectId: string | null,
  ): Promise<string | null> {
    if (!projectId) return null;
    const names = await this.refs.projectNames(caller, [projectId]);
    return names.get(projectId) ?? null;
  }

  private render(form: FormDocument, format: FormFormat, stem: string) {
    return renderFormFile(
      { ...form, footer: form.footer ?? form.title },
      format,
      fileSafe(stem),
    );
  }
}

/** A labelled line that may be blank, as "Remarks: ____" is on the form. */
function remarks(label: string, value: string | null | undefined): FormBlock {
  const field: FormField = { label, value: value ?? '' };
  return { kind: 'fields', columns: 1, fields: [field] };
}

/** The three signature places and the ERP reference line under them. */
function signOff(places: [string, string][]): FormBlock[] {
  return [
    {
      kind: 'signatures',
      items: places.map(([caption, sub]) => ({
        caption,
        ...(sub ? { sub } : {}),
      })),
    },
    {
      kind: 'paragraph',
      text: ERP_REFERENCE,
      italic: true,
      small: true,
      align: 'center',
    },
  ];
}
