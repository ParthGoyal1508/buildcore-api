import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  CodeSeriesType,
  Prisma,
  VendorType,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { CodeSeriesService } from '../../settings/code-series/code-series.service';
import { assertInScope, companyScope } from '../../settings/company-scope';
import { VendorCategoriesService } from '../../settings/vendor-categories/vendor-categories.service';
import { CreateVendorDto, UpdateVendorDto } from './dto/vendor.dto';

/** Vendor types that may carry a contractor compliance profile (FR-005). */
export const CONTRACTOR_VENDOR_TYPES: VendorType[] = [
  VendorType.subcontractor,
  VendorType.labour_contractor,
];

export interface VendorListItem {
  id: string;
  code: string;
  name: string;
  type: VendorType;
  gstin: string | null;
  active: boolean;
  city: string | null;
  /** The first contact on file, for the list's "who do I call" column. */
  primaryContact: { name: string; phone: string | null } | null;
  categoryIds: string[];
}

export interface VendorListPage {
  items: VendorListItem[];
  total: number;
  page: number;
  pageSize: number;
}

const DEFAULT_PAGE_SIZE = 25;

/** Prisma hands back `Decimal`; JSON consumers want a number. Null stays null — a
 * missing TDS rate is not zero, and rendering it as 0% would be a factual claim
 * nobody made. */
function decimal(value: Prisma.Decimal | null): number | null {
  return value === null ? null : Number(value);
}

/**
 * Vendor master (007 US2).
 *
 * Contacts and category tags are replaced wholesale on update rather than diffed
 * (research.md §10): the client sends the list it wants to end up with, and this
 * service makes that true in one transaction. Diffing would need stable client-side
 * ids for rows the user may have only just typed, and a partial failure would leave
 * a vendor with half its contacts.
 */
@Injectable()
export class VendorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly codeSeries: CodeSeriesService,
    private readonly vendorCategories: VendorCategoriesService,
  ) {}

  /**
   * Validates category ids before any transaction opens.
   *
   * Deliberately not inside the vendor transaction: `VendorCategoriesService` opens
   * its own RLS transaction, and nesting one inside another would either deadlock or
   * silently run outside the outer transaction's context. Reporting every bad id at
   * once rather than the first also gives the client something it can act on.
   */
  private async assertCategoriesExist(
    caller: AuthenticatedUser,
    categoryIds: string[],
  ): Promise<void> {
    if (categoryIds.length === 0) return;
    const missing: string[] = [];
    for (const id of categoryIds) {
      const found = await this.vendorCategories.getVendorCategory(caller, id);
      if (!found) missing.push(id);
    }
    if (missing.length > 0) {
      throw new BadRequestException(
        `Unknown vendor category id(s): ${missing.join(', ')}`,
      );
    }
  }

  private hireDetailData(
    input: NonNullable<CreateVendorDto['hireDetail']>,
  ): Prisma.VendorHireDetailUncheckedCreateWithoutVendorInput {
    return {
      hireType: input.hireType,
      contractCode: input.contractCode ?? null,
      periodFrom: input.periodFrom ? new Date(input.periodFrom) : null,
      periodTo: input.periodTo ? new Date(input.periodTo) : null,
      machineCategory: input.machineCategory ?? null,
      machineName: input.machineName ?? null,
      requiredAvg: input.requiredAvg ?? null,
      chargesBase: input.chargesBase ?? 'monthly',
      rate: input.rate ?? null,
      minWorkingDays: input.minWorkingDays ?? null,
      allowBdDays: input.allowBdDays ?? false,
      allowIdleDays: input.allowIdleDays ?? false,
      operatorCharges: input.operatorCharges ?? null,
      helperCharges: input.helperCharges ?? null,
      maintenanceCharges: input.maintenanceCharges ?? null,
      fuelCharges: input.fuelCharges ?? null,
      termsAndConditions: input.termsAndConditions ?? null,
      requirements: input.requirements ?? null,
    };
  }

  async create(
    caller: AuthenticatedUser,
    dto: CreateVendorDto,
    ipAddress: string,
    companyId?: string,
  ): Promise<Record<string, unknown>> {
    // See VendorCategoriesService.create() for why the caller's own company is the
    // fallback rather than an immediate refusal.
    const scope = companyScope(caller, companyId);
    const targetCompanyId = scope.companyId ?? caller.companyId;
    if (!targetCompanyId) {
      throw new BadRequestException(
        'companyId is required for a cross-company caller.',
      );
    }
    await this.assertCategoriesExist(caller, dto.categoryIds ?? []);

    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        // Allocated inside this transaction so a later failure rolls the number back
        // rather than burning it — a gap in a vendor code series reads as a deleted
        // supplier to anyone auditing it later.
        const code = await this.codeSeries.next(
          tx,
          targetCompanyId,
          CodeSeriesType.VENDORS,
          'VEN',
        );
        return tx.vendor.create({
          data: {
            companyId: targetCompanyId,
            code,
            name: dto.name.trim(),
            type: dto.type,
            gstin: dto.gstin ?? null,
            pan: dto.pan ?? null,
            tdsSection: dto.tdsSection ?? null,
            tdsRate: dto.tdsRate ?? null,
            active: dto.active ?? true,
            address: dto.address ?? null,
            city: dto.city ?? null,
            state: dto.state ?? null,
            pinCode: dto.pinCode ?? null,
            vendorCurrency: dto.vendorCurrency ?? 'INR',
            exchangeRate: dto.exchangeRate ?? 1,
            contacts: dto.contacts?.length
              ? {
                  create: dto.contacts.map((contact) => ({
                    name: contact.name.trim(),
                    phone: contact.phone ?? null,
                    email: contact.email ?? null,
                  })),
                }
              : undefined,
            dealsIn: dto.categoryIds?.length
              ? {
                  create: dto.categoryIds.map((categoryId) => ({ categoryId })),
                }
              : undefined,
            hireDetail: dto.hireDetail
              ? { create: this.hireDetailData(dto.hireDetail) }
              : undefined,
          },
          include: { contacts: true, dealsIn: true, hireDetail: true },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.VENDOR,
      action: AuditAction.CREATE,
      entityId: created.id,
      accountId: caller.id,
      companyId: created.companyId,
      ipAddress,
    });
    return this.toDetail(created);
  }

  async findAll(
    caller: AuthenticatedUser,
    query: {
      search?: string;
      type?: VendorType;
      active?: boolean;
      page?: number;
      pageSize?: number;
      companyId?: string;
    },
  ): Promise<VendorListPage> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(
      200,
      Math.max(1, query.pageSize ?? DEFAULT_PAGE_SIZE),
    );

    const where: Prisma.VendorWhereInput = {
      ...companyScope(caller, query.companyId),
      ...(query.type ? { type: query.type } : {}),
      ...(query.active !== undefined ? { active: query.active } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { code: { contains: query.search, mode: 'insensitive' } },
              { gstin: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    return withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
      const [rows, total] = await Promise.all([
        tx.vendor.findMany({
          where,
          orderBy: { name: 'asc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: {
            contacts: { orderBy: { createdAt: 'asc' }, take: 1 },
            dealsIn: true,
          },
        }),
        tx.vendor.count({ where }),
      ]);

      return {
        items: rows.map((vendor) => ({
          id: vendor.id,
          code: vendor.code,
          name: vendor.name,
          type: vendor.type,
          gstin: vendor.gstin,
          active: vendor.active,
          city: vendor.city,
          primaryContact: vendor.contacts[0]
            ? {
                name: vendor.contacts[0].name,
                phone: vendor.contacts[0].phone,
              }
            : null,
          categoryIds: vendor.dealsIn.map((link) => link.categoryId),
        })),
        total,
        page,
        pageSize,
      };
    });
  }

  async findOne(
    caller: AuthenticatedUser,
    id: string,
  ): Promise<Record<string, unknown>> {
    const vendor = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.vendor.findUnique({
          where: { id },
          include: {
            contacts: { orderBy: { createdAt: 'asc' } },
            dealsIn: true,
            hireDetail: true,
            contractor: { select: { id: true, complianceStatus: true } },
          },
        }),
    );
    if (!vendor) {
      throw new NotFoundException(`Vendor ${id} not found`);
    }
    assertInScope(caller, vendor, `Vendor ${id}`);
    return this.toDetail(vendor);
  }

  async update(
    caller: AuthenticatedUser,
    id: string,
    dto: UpdateVendorDto,
    ipAddress: string,
  ): Promise<Record<string, unknown>> {
    if (dto.categoryIds) {
      await this.assertCategoriesExist(caller, dto.categoryIds);
    }

    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.vendor.findUnique({ where: { id } });
        if (!existing) {
          throw new NotFoundException(`Vendor ${id} not found`);
        }
        assertInScope(caller, existing, `Vendor ${id}`);

        // Wholesale replacement, in the same transaction as the vendor update: the
        // client sent the list it wants to end up with, and a delete that committed
        // without its matching insert would silently strip a vendor's contacts.
        if (dto.contacts) {
          await tx.vendorContact.deleteMany({ where: { vendorId: id } });
          if (dto.contacts.length > 0) {
            await tx.vendorContact.createMany({
              data: dto.contacts.map((contact) => ({
                vendorId: id,
                name: contact.name.trim(),
                phone: contact.phone ?? null,
                email: contact.email ?? null,
              })),
            });
          }
        }
        if (dto.categoryIds) {
          await tx.vendorDealsIn.deleteMany({ where: { vendorId: id } });
          if (dto.categoryIds.length > 0) {
            await tx.vendorDealsIn.createMany({
              data: dto.categoryIds.map((categoryId) => ({
                vendorId: id,
                categoryId,
              })),
            });
          }
        }
        if (dto.hireDetail) {
          const data = this.hireDetailData(dto.hireDetail);
          await tx.vendorHireDetail.upsert({
            where: { vendorId: id },
            create: { vendorId: id, ...data },
            update: data,
          });
        }

        return tx.vendor.update({
          where: { id },
          data: {
            ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
            ...(dto.type !== undefined ? { type: dto.type } : {}),
            ...(dto.gstin !== undefined ? { gstin: dto.gstin ?? null } : {}),
            ...(dto.pan !== undefined ? { pan: dto.pan ?? null } : {}),
            ...(dto.tdsSection !== undefined
              ? { tdsSection: dto.tdsSection ?? null }
              : {}),
            ...(dto.tdsRate !== undefined
              ? { tdsRate: dto.tdsRate ?? null }
              : {}),
            ...(dto.active !== undefined ? { active: dto.active } : {}),
            ...(dto.address !== undefined
              ? { address: dto.address ?? null }
              : {}),
            ...(dto.city !== undefined ? { city: dto.city ?? null } : {}),
            ...(dto.state !== undefined ? { state: dto.state ?? null } : {}),
            ...(dto.pinCode !== undefined
              ? { pinCode: dto.pinCode ?? null }
              : {}),
            ...(dto.vendorCurrency !== undefined
              ? { vendorCurrency: dto.vendorCurrency }
              : {}),
            ...(dto.exchangeRate !== undefined
              ? { exchangeRate: dto.exchangeRate }
              : {}),
          },
          include: {
            contacts: { orderBy: { createdAt: 'asc' } },
            dealsIn: true,
            hireDetail: true,
          },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.VENDOR,
      action: AuditAction.UPDATE,
      entityId: id,
      changes: { after: { name: updated.name, active: updated.active } },
      accountId: caller.id,
      companyId: updated.companyId,
      ipAddress,
    });
    return this.toDetail(updated);
  }

  /** TDS section and rate only (FR-002) — the slice Inventory and Machinery need when
   * raising a bill, deliberately not the whole vendor. */
  async getTds(
    caller: AuthenticatedUser,
    id: string,
  ): Promise<{ tdsSection: string | null; tdsRate: number | null }> {
    const vendor = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.vendor.findUnique({
          where: { id },
          select: {
            companyId: true,
            tdsSection: true,
            tdsRate: true,
          },
        }),
    );
    if (!vendor) {
      throw new NotFoundException(`Vendor ${id} not found`);
    }
    assertInScope(caller, vendor, `Vendor ${id}`);
    return { tdsSection: vendor.tdsSection, tdsRate: decimal(vendor.tdsRate) };
  }

  /** How many vendors are tagged with a category — the delete guard's input (FR-014). */
  async countInCategory(
    caller: AuthenticatedUser,
    categoryId: string,
  ): Promise<number> {
    return withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.vendorDealsIn.count({ where: { categoryId } }),
    );
  }

  private toDetail(vendor: Record<string, unknown>): Record<string, unknown> {
    const hireDetail = vendor.hireDetail as Record<string, unknown> | null;
    return {
      ...vendor,
      tdsRate: decimal(vendor.tdsRate as Prisma.Decimal | null),
      exchangeRate: Number(vendor.exchangeRate),
      categoryIds: (
        (vendor.dealsIn as { categoryId: string }[] | undefined) ?? []
      ).map((link) => link.categoryId),
      hireDetail: hireDetail
        ? {
            ...hireDetail,
            requiredAvg: decimal(
              hireDetail.requiredAvg as Prisma.Decimal | null,
            ),
            rate: decimal(hireDetail.rate as Prisma.Decimal | null),
            operatorCharges: decimal(
              hireDetail.operatorCharges as Prisma.Decimal | null,
            ),
            helperCharges: decimal(
              hireDetail.helperCharges as Prisma.Decimal | null,
            ),
            maintenanceCharges: decimal(
              hireDetail.maintenanceCharges as Prisma.Decimal | null,
            ),
            fuelCharges: decimal(
              hireDetail.fuelCharges as Prisma.Decimal | null,
            ),
          }
        : null,
    };
  }
}
