import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  EquipmentDisposalType,
  EquipmentStatus,
  Prisma,
} from '@prisma/client';
import * as ExcelJS from 'exceljs';
import { PrismaService } from 'nestjs-prisma';

import { bookValue as depreciatedBookValue } from '../../assets/depreciation';
import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { businessToday } from '../../common/business-date';
import {
  CashPolicyService,
  cashHiddenError,
} from '../../common/cash/cash-policy';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { StorageService } from '../../common/storage/storage.service';
import { assertInScope, companyScope } from '../../settings/company-scope';
import { PlantRefsService } from '../plant-refs.service';
import { DISPOSED_STATUSES } from './in-service';
import type { DisposeEquipmentDto, ListDisposalsDto } from './dto/disposal.dto';

/** Ten megabytes — the ceiling every document upload in the app shares. */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const ATTACHMENT_NAMESPACE = 'equipment-disposal';

/**
 * A sale received in cash (038). Only a sale carries a payment mode; a scrapping never does.
 * Compared loosely, because the column is free text and older rows were written by hand.
 */
export const isCashDisposal = (row: { paymentMode?: string | null }) =>
  row.paymentMode?.trim().toLowerCase() === 'cash';

const round2 = (n: number) => Math.round(n * 100) / 100;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const dateOnly = (value: string) =>
  new Date(`${value.slice(0, 10)}T00:00:00.000Z`);

export interface DisposalView {
  id: string;
  equipmentId: string;
  equipmentCode: string;
  equipmentName: string;
  categoryId: string;
  categoryName: string | null;
  make: string | null;
  model: string | null;
  purchaseDate: string | null;
  purchaseCost: number | null;
  type: EquipmentDisposalType;
  disposalDate: string;
  scrapReason: string | null;
  counterpartyName: string | null;
  buyerContact: string | null;
  paymentMode: string | null;
  invoiceNumber: string | null;
  valueRealised: number | null;
  bookValue: number | null;
  bookValueSource: string | null;
  profitLoss: number | null;
  approvedBy: string;
  remarks: string | null;
  attachmentName: string | null;
  hasAttachment: boolean;
  releasedSiteName: string | null;
  projectId: string | null;
  projectName: string | null;
  createdAt: string;
  reversedAt: string | null;
  reversalReason: string | null;
}

/**
 * Retiring a machine by scrapping or selling it, and reversing that (2026-10-17).
 *
 * A disposal is a record, not a delete: the machine stays, its status becomes `scrapped` or `sold`,
 * and from then on it is out of every working list — the equipment pickers, site machinery,
 * schedules, utilisation — because those read only machines in service. A machine still deployed
 * at a site is released by the disposal itself (the client chose auto-release with a warning), and
 * both facts go to the machine's history. A reversal restores the status it had; it does not put
 * the machine back on its site, which someone redeploys deliberately.
 */
@Injectable()
export class EquipmentDisposalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly refs: PlantRefsService,
    private readonly storage: StorageService,
    private readonly cash: CashPolicyService,
  ) {}

  /**
   * 038 — what "the cash sale does not exist" means for a disposal. The **machine** stays disposed:
   * its status is a fact about the equipment, not a transaction, and un-retiring it on screen would
   * put a sold machine back in every picker. What is hidden is the cash sale record itself — the
   * row on the Scrapped & Sold dashboard and its export, its value, buyer, invoice and profit, the
   * counts and totals, its attachment and its by-id read (404). Reversing it is refused.
   */
  private async hiddenCash<
    T extends { companyId: string; paymentMode: string | null },
  >(rows: T[]): Promise<T[]> {
    const cashRows = rows.filter(isCashDisposal);
    if (cashRows.length === 0) return rows;
    const hidden = await this.cash.hiddenAmong(
      cashRows.map((r) => r.companyId),
    );
    if (hidden.size === 0) return rows;
    return rows.filter((r) => !(isCashDisposal(r) && hidden.has(r.companyId)));
  }

  /**
   * What the dispose form and its confirmation step need: the book value on the date where the
   * machine's depreciation gives one, and the site it would be released from.
   */
  async preview(caller: AuthenticatedUser, equipmentId: string, date: string) {
    const machine = await this.loadMachine(caller, equipmentId);
    const siteName = machine.deployedSiteId
      ? (await this.refs.siteNames(caller, [machine.deployedSiteId])).get(
          machine.deployedSiteId,
        ) ?? null
      : null;
    return {
      equipmentId: machine.id,
      code: machine.code,
      name: machine.name,
      status: machine.status,
      disposed: DISPOSED_STATUSES.includes(machine.status),
      deployedSiteId: machine.deployedSiteId,
      deployedSiteName: siteName,
      purchaseDate: machine.purchaseDate ? iso(machine.purchaseDate) : null,
      purchaseCost: machine.purchaseCost?.toNumber() ?? null,
      bookValue: this.bookValueOn(machine, dateOnly(date)),
    };
  }

  async dispose(
    caller: AuthenticatedUser,
    equipmentId: string,
    dto: DisposeEquipmentDto,
    ipAddress: string,
  ): Promise<DisposalView> {
    const machine = await this.loadMachine(caller, equipmentId);
    if (DISPOSED_STATUSES.includes(machine.status)) {
      throw new ConflictException({
        code: 'EQUIPMENT_ALREADY_DISPOSED',
        message: `${machine.code} is already marked as ${machine.status}.`,
      });
    }

    const disposalDate = dateOnly(dto.disposalDate);
    // Today in the business timezone (036 K18). The UTC date is yesterday until 05:30 IST, so
    // the old comparison refused a machine disposed of "today" for the first hours of every day.
    const today = businessToday();
    if (disposalDate > today) {
      throw new BadRequestException(
        'The disposal date cannot be in the future.',
      );
    }
    if (machine.purchaseDate && disposalDate < machine.purchaseDate) {
      throw new BadRequestException(
        `The disposal date is before the machine was bought (${iso(
          machine.purchaseDate,
        )}).`,
      );
    }

    const isSale = dto.type === EquipmentDisposalType.sold;
    // 038. A sale received in cash is a cash transaction; with cash hidden nobody records one.
    if (isSale && isCashDisposal(dto)) {
      await this.cash.assertCashAllowed(machine.companyId);
    }
    if (isSale) {
      if (!dto.counterpartyName?.trim()) {
        throw new BadRequestException('Enter the buyer’s name.');
      }
      if (dto.valueRealised === undefined) {
        throw new BadRequestException('Enter the sale amount.');
      }
    } else if (!dto.scrapReason) {
      throw new BadRequestException(
        'Choose why the machine is being scrapped.',
      );
    }

    // Book value: the machine's own depreciation where it has one, otherwise as entered.
    const computed = this.bookValueOn(machine, disposalDate);
    const bookValue = computed ?? dto.bookValue ?? null;
    if (isSale && bookValue === null) {
      throw new BadRequestException(
        'This machine has no depreciation on record, so enter its book value on the sale date.',
      );
    }
    const valueRealised = dto.valueRealised ?? null;
    const profitLoss =
      isSale && valueRealised !== null && bookValue !== null
        ? round2(valueRealised - bookValue)
        : null;

    let attachmentRef: string | null = null;
    if (dto.attachment) {
      const buffer = Buffer.from(dto.attachment, 'base64');
      if (buffer.length === 0)
        throw new BadRequestException('The attachment is empty.');
      if (buffer.length > MAX_ATTACHMENT_BYTES) {
        throw new BadRequestException('The attachment is over 10 MB.');
      }
      // TODO(VIRUS_SCAN): stored unscanned, the same gap every document upload here carries.
      attachmentRef = await this.storage.put(
        ATTACHMENT_NAMESPACE,
        buffer,
        dto.attachmentMime ?? 'application/octet-stream',
      );
    }

    const releasedSiteId = machine.deployedSiteId;
    const [siteName, project] = releasedSiteId
      ? await Promise.all([
          this.refs
            .siteNames(caller, [releasedSiteId])
            .then((m) => m.get(releasedSiteId) ?? null),
          this.refs.projectOfSite(caller, releasedSiteId),
        ])
      : [null, null];

    const label = isSale ? 'sold' : 'scrapped';
    let created;
    try {
      created = await withRlsContext(
        this.prisma,
        rlsContextFor(caller),
        async (tx) => {
          const row = await tx.equipmentDisposal.create({
            data: {
              companyId: machine.companyId,
              equipmentId: machine.id,
              type: dto.type,
              disposalDate,
              scrapReason: isSale ? null : dto.scrapReason,
              counterpartyName: dto.counterpartyName?.trim() || null,
              buyerContact: isSale ? dto.buyerContact?.trim() || null : null,
              paymentMode: isSale ? dto.paymentMode ?? null : null,
              invoiceNumber: isSale ? dto.invoiceNumber?.trim() || null : null,
              valueRealised,
              bookValue,
              bookValueSource:
                bookValue === null
                  ? null
                  : computed !== null
                  ? 'depreciation'
                  : 'manual',
              profitLoss,
              approvedBy: dto.approvedBy.trim(),
              remarks: dto.remarks?.trim() || null,
              attachmentRef,
              attachmentName: attachmentRef
                ? dto.attachmentName?.trim() || null
                : null,
              attachmentMime: attachmentRef ? dto.attachmentMime ?? null : null,
              previousStatus: machine.status,
              releasedSiteId,
              projectId: project?.id ?? null,
              createdByUserId: caller.id,
            },
          });
          await tx.equipment.update({
            where: { id: machine.id },
            data: {
              status: isSale ? EquipmentStatus.sold : EquipmentStatus.scrapped,
              deployedSiteId: null,
            },
          });
          if (releasedSiteId) {
            await tx.equipmentEvent.create({
              data: {
                companyId: machine.companyId,
                equipmentId: machine.id,
                kind: 'site_released',
                summary: `Released from ${siteName ?? 'its site'} on disposal`,
                detail: { siteId: releasedSiteId, disposalId: row.id },
                actorUserId: caller.id,
              },
            });
          }
          await tx.equipmentEvent.create({
            data: {
              companyId: machine.companyId,
              equipmentId: machine.id,
              kind: isSale ? 'disposed_sold' : 'disposed_scrapped',
              summary: isSale
                ? `Sold to ${dto.counterpartyName?.trim()} on ${iso(
                    disposalDate,
                  )}`
                : `Scrapped on ${iso(disposalDate)} (${(
                    dto.scrapReason ?? ''
                  ).replace(/_/g, ' ')})`,
              detail: { disposalId: row.id, approvedBy: dto.approvedBy.trim() },
              actorUserId: caller.id,
            },
          });
          return row;
        },
      );
    } catch (err) {
      if (attachmentRef)
        await this.storage.delete(attachmentRef).catch(() => undefined);
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException({
          code: 'EQUIPMENT_ALREADY_DISPOSED',
          message: `${machine.code} was disposed a moment ago by someone else.`,
        });
      }
      throw err;
    }

    await this.auditLog.record({
      entityType: AuditEntityType.EQUIPMENT_DISPOSAL,
      action: AuditAction.CREATE,
      entityId: created.id,
      accountId: caller.id,
      companyId: machine.companyId,
      ipAddress,
      // `paymentMode` so the activity log can leave a cash sale's entries out while cash is hidden (038).
      changes: {
        equipmentId: machine.id,
        type: label,
        releasedSiteId,
        paymentMode: isSale ? dto.paymentMode ?? null : null,
      },
    });
    return this.findOne(caller, created.id);
  }

  /** Undoes a disposal made by mistake. The machine gets its previous status back, not its site. */
  async reverse(
    caller: AuthenticatedUser,
    equipmentId: string,
    reason: string,
    ipAddress: string,
  ): Promise<DisposalView> {
    const machine = await this.loadMachine(caller, equipmentId);
    const disposal = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.equipmentDisposal.findFirst({
          where: { equipmentId: machine.id, reversedAt: null },
        }),
    );
    if (!disposal) {
      throw new ConflictException({
        code: 'EQUIPMENT_NOT_DISPOSED',
        message: `${machine.code} is not scrapped or sold, so there is nothing to reverse.`,
      });
    }
    // 038. A cash sale is not reversed while cash is hidden — reversing it is changing it.
    if (
      isCashDisposal(disposal) &&
      (await this.cash.isHidden(disposal.companyId))
    ) {
      throw cashHiddenError();
    }
    await withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
      await tx.equipmentDisposal.update({
        where: { id: disposal.id },
        data: {
          reversedAt: new Date(),
          reversedByUserId: caller.id,
          reversalReason: reason.trim(),
        },
      });
      await tx.equipment.update({
        where: { id: machine.id },
        data: {
          status: DISPOSED_STATUSES.includes(disposal.previousStatus)
            ? EquipmentStatus.active
            : disposal.previousStatus,
        },
      });
      await tx.equipmentEvent.create({
        data: {
          companyId: machine.companyId,
          equipmentId: machine.id,
          kind: 'disposal_reversed',
          summary: `${
            disposal.type === EquipmentDisposalType.sold ? 'Sale' : 'Scrapping'
          } reversed: ${reason.trim()}`,
          detail: { disposalId: disposal.id },
          actorUserId: caller.id,
        },
      });
    });
    await this.auditLog.record({
      entityType: AuditEntityType.EQUIPMENT_DISPOSAL,
      action: AuditAction.UPDATE,
      entityId: disposal.id,
      accountId: caller.id,
      companyId: machine.companyId,
      ipAddress,
      changes: {
        reversed: true,
        reason: reason.trim(),
        paymentMode: disposal.paymentMode,
      },
    });
    return this.findOne(caller, disposal.id);
  }

  /** The machine's history, newest first. */
  async history(caller: AuthenticatedUser, equipmentId: string) {
    const machine = await this.loadMachine(caller, equipmentId);
    const events = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.equipmentEvent.findMany({
          where: { equipmentId: machine.id },
          orderBy: { createdAt: 'desc' },
          take: 200,
        }),
    );
    const names = await this.actorNames(events.map((e) => e.actorUserId));
    return events.map((e) => ({
      id: e.id,
      kind: e.kind,
      summary: e.summary,
      at: e.createdAt.toISOString(),
      actorName: e.actorUserId ? names.get(e.actorUserId) ?? null : null,
    }));
  }

  /** The disposal in force for a machine, or null. */
  async current(caller: AuthenticatedUser, equipmentId: string) {
    const machine = await this.loadMachine(caller, equipmentId);
    const row = await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.equipmentDisposal.findFirst({
        where: { equipmentId: machine.id, reversedAt: null },
      }),
    );
    if (!row || (await this.hiddenCash([row])).length === 0) return null;
    return this.findOne(caller, row.id);
  }

  async findOne(caller: AuthenticatedUser, id: string): Promise<DisposalView> {
    const row = await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.equipmentDisposal.findUnique({ where: { id } }),
    );
    if (!row || (await this.hiddenCash([row])).length === 0) {
      throw new NotFoundException('Disposal not found');
    }
    assertInScope(caller, row, 'Disposal');
    const [view] = await this.toViews(caller, [row]);
    return view;
  }

  async attachment(caller: AuthenticatedUser, id: string) {
    const row = await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.equipmentDisposal.findUnique({ where: { id } }),
    );
    if (
      !row ||
      !row.attachmentRef ||
      (await this.hiddenCash([row])).length === 0
    )
      throw new NotFoundException('No attachment');
    assertInScope(caller, row, 'Disposal');
    return {
      buffer: await this.storage.get(row.attachmentRef),
      fileName: row.attachmentName ?? 'disposal-attachment',
      mimeType: row.attachmentMime ?? 'application/octet-stream',
    };
  }

  /**
   * The Scrapped & Sold Machines dashboard: disposals in force, filtered, with the summary cards
   * and a month-by-month count split by type.
   */
  async list(caller: AuthenticatedUser, query: ListDisposalsDto) {
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.equipmentDisposal.findMany({
          where: {
            ...companyScope(caller, query.companyId),
            reversedAt: null,
            ...(query.type ? { type: query.type } : {}),
            ...(query.projectId ? { projectId: query.projectId } : {}),
            ...(query.from || query.to
              ? {
                  disposalDate: {
                    ...(query.from ? { gte: dateOnly(query.from) } : {}),
                    ...(query.to ? { lte: dateOnly(query.to) } : {}),
                  },
                }
              : {}),
          },
          orderBy: { disposalDate: 'desc' },
        }),
    );
    // 038: a cash sale of a company hiding cash is left out of the rows, counts and totals alike.
    let items = await this.toViews(caller, await this.hiddenCash(rows));
    if (query.categoryId)
      items = items.filter((i) => i.categoryId === query.categoryId);
    if (query.search?.trim()) {
      const needle = query.search.trim().toLowerCase();
      items = items.filter((i) =>
        [i.equipmentCode, i.equipmentName, i.make, i.model, i.counterpartyName]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(needle),
      );
    }

    const scrapped = items.filter(
      (i) => i.type === EquipmentDisposalType.scrapped,
    );
    const sold = items.filter((i) => i.type === EquipmentDisposalType.sold);
    const sum = (list: DisposalView[], f: (i: DisposalView) => number | null) =>
      round2(list.reduce((s, i) => s + (f(i) ?? 0), 0));

    // Months, oldest first, ending with the latest disposal's month (or this month).
    const months = query.months ?? 12;
    const end = items[0] ? dateOnly(items[0].disposalDate) : new Date();
    const byMonth = Array.from({ length: months }, (_, k) => {
      const d = new Date(
        Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - (months - 1 - k), 1),
      );
      const key = iso(d).slice(0, 7);
      return {
        month: key,
        scrapped: scrapped.filter((i) => i.disposalDate.startsWith(key)).length,
        sold: sold.filter((i) => i.disposalDate.startsWith(key)).length,
      };
    });

    return {
      summary: {
        totalScrapped: scrapped.length,
        totalSold: sold.length,
        saleValueRealised: sum(sold, (i) => i.valueRealised),
        scrapValueRealised: sum(scrapped, (i) => i.valueRealised),
        netProfitLossOnSales: sum(sold, (i) => i.profitLoss),
      },
      byMonth,
      items,
    };
  }

  async exportXlsx(caller: AuthenticatedUser, query: ListDisposalsDto) {
    const { items, summary } = await this.list(caller, query);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Scrapped & Sold', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    ws.columns = [
      { header: 'Machine ID', key: 'code', width: 14 },
      { header: 'Name', key: 'name', width: 28 },
      { header: 'Category', key: 'category', width: 18 },
      { header: 'Make / Model', key: 'makeModel', width: 22 },
      { header: 'Purchase date', key: 'purchaseDate', width: 13 },
      { header: 'Purchase cost', key: 'purchaseCost', width: 14 },
      { header: 'Disposal type', key: 'type', width: 12 },
      { header: 'Disposal date', key: 'date', width: 13 },
      { header: 'Value realised', key: 'value', width: 14 },
      { header: 'Book value', key: 'book', width: 14 },
      { header: 'Profit / Loss', key: 'pl', width: 14 },
      { header: 'Buyer / Vendor', key: 'party', width: 24 },
      { header: 'Approved by', key: 'approvedBy', width: 18 },
      { header: 'Project', key: 'project', width: 22 },
      { header: 'Remarks', key: 'remarks', width: 30 },
    ];
    ws.getRow(1).font = { bold: true };
    for (const i of items) {
      ws.addRow({
        code: i.equipmentCode,
        name: i.equipmentName,
        category: i.categoryName ?? '',
        makeModel: [i.make, i.model].filter(Boolean).join(' / '),
        purchaseDate: i.purchaseDate ?? '',
        purchaseCost: i.purchaseCost,
        type: i.type === EquipmentDisposalType.sold ? 'Sold' : 'Scrapped',
        date: i.disposalDate,
        value: i.valueRealised,
        book: i.bookValue,
        pl: i.profitLoss,
        party: i.counterpartyName ?? '',
        approvedBy: i.approvedBy,
        project: i.projectName ?? '',
        remarks: i.remarks ?? '',
      });
    }
    const totals = ws.addRow({
      code: 'Total',
      value: round2(summary.saleValueRealised + summary.scrapValueRealised),
      pl: summary.netProfitLossOnSales,
    });
    totals.font = { bold: true };
    for (const key of ['purchaseCost', 'value', 'book', 'pl']) {
      ws.getColumn(key).numFmt = '#,##0.00';
    }
    return {
      buffer: Buffer.from(await wb.xlsx.writeBuffer()),
      filename: `Scrapped_and_Sold_Machines_${iso(new Date())}.xlsx`,
    };
  }

  // ── internals ───────────────────────────────────────────────────────────

  private async loadMachine(caller: AuthenticatedUser, id: string) {
    const machine = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) => tx.equipment.findUnique({ where: { id } }),
    );
    if (!machine) throw new NotFoundException('Machine not found');
    assertInScope(caller, machine, 'Machine');
    return machine;
  }

  /** Straight-line book value on a date, or null when the machine has no cost, rate or date. */
  private bookValueOn(
    machine: {
      purchaseCost: Prisma.Decimal | null;
      depreciationRate: Prisma.Decimal | null;
      purchaseDate: Date | null;
    },
    asOf: Date,
  ): number | null {
    if (
      !machine.purchaseCost ||
      !machine.depreciationRate ||
      !machine.purchaseDate
    ) {
      return null;
    }
    return depreciatedBookValue(
      {
        purchaseCost: machine.purchaseCost.toNumber(),
        depreciationRatePercent: machine.depreciationRate.toNumber(),
        salvageValue: 0,
        capitalisationDate: machine.purchaseDate,
      },
      asOf,
    );
  }

  private async actorNames(
    ids: (string | null)[],
  ): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id): id is string => !!id))];
    if (unique.length === 0) return new Map();
    const users = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) =>
        tx.user.findMany({
          where: { id: { in: unique } },
          select: {
            id: true,
            displayName: true,
            firstname: true,
            lastname: true,
            username: true,
          },
        }),
    );
    return new Map(
      users.map((u) => [
        u.id,
        u.displayName?.trim() ||
          [u.firstname, u.lastname].filter(Boolean).join(' ').trim() ||
          u.username,
      ]),
    );
  }

  private async toViews(
    caller: AuthenticatedUser,
    rows: Prisma.EquipmentDisposalGetPayload<object>[],
  ): Promise<DisposalView[]> {
    if (rows.length === 0) return [];
    const machines = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.equipment.findMany({
          where: { id: { in: rows.map((r) => r.equipmentId) } },
        }),
    );
    const byId = new Map(machines.map((m) => [m.id, m]));
    const [categories, siteNames, projects] = await Promise.all([
      this.refs.categoriesByIds(
        caller,
        machines.map((m) => m.categoryId),
      ),
      this.refs.siteNames(
        caller,
        rows.flatMap((r) => (r.releasedSiteId ? [r.releasedSiteId] : [])),
      ),
      this.projectNames(
        caller,
        rows.flatMap((r) =>
          r.releasedSiteId && r.projectId ? [r.releasedSiteId] : [],
        ),
      ),
    ]);
    return rows.map((r) => {
      const m = byId.get(r.equipmentId);
      return {
        id: r.id,
        equipmentId: r.equipmentId,
        equipmentCode: m?.code ?? '',
        equipmentName: m?.name ?? '',
        categoryId: m?.categoryId ?? '',
        categoryName: (m && categories.get(m.categoryId)?.name) ?? null,
        make: m?.make ?? null,
        model: m?.model ?? null,
        purchaseDate: m?.purchaseDate ? iso(m.purchaseDate) : null,
        purchaseCost: m?.purchaseCost?.toNumber() ?? null,
        type: r.type,
        disposalDate: iso(r.disposalDate),
        scrapReason: r.scrapReason,
        counterpartyName: r.counterpartyName,
        buyerContact: r.buyerContact,
        paymentMode: r.paymentMode,
        invoiceNumber: r.invoiceNumber,
        valueRealised: r.valueRealised?.toNumber() ?? null,
        bookValue: r.bookValue?.toNumber() ?? null,
        bookValueSource: r.bookValueSource,
        profitLoss: r.profitLoss?.toNumber() ?? null,
        approvedBy: r.approvedBy,
        remarks: r.remarks,
        attachmentName: r.attachmentName,
        hasAttachment: !!r.attachmentRef,
        releasedSiteName: r.releasedSiteId
          ? siteNames.get(r.releasedSiteId) ?? null
          : null,
        projectId: r.projectId,
        projectName: r.releasedSiteId
          ? projects.get(r.releasedSiteId) ?? null
          : null,
        createdAt: r.createdAt.toISOString(),
        reversedAt: r.reversedAt?.toISOString() ?? null,
        reversalReason: r.reversalReason,
      };
    });
  }

  /** Project names by the site each disposal released, one lookup per distinct site. */
  private async projectNames(caller: AuthenticatedUser, siteIds: string[]) {
    const unique = [...new Set(siteIds)];
    const entries = await Promise.all(
      unique.map(async (siteId) => {
        const project = await this.refs
          .projectOfSite(caller, siteId)
          .catch(() => null);
        return [siteId, project?.name ?? null] as const;
      }),
    );
    return new Map(entries);
  }
}
