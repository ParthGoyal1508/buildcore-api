/**
 * Assets and approvals — the last completion module (it references everything else).
 *
 * Two jobs, each idempotent on its own:
 *
 * 1. **The asset register in use.** The base seed registers six bare assets per company and
 *    nothing that happens to them. This tidies the register (the base seed's mixed-case
 *    categories beside the uppercase defaults, missing serials and purchase details, "allocated"
 *    laptops with no allocation, a bulk pool with no stock), registers the rest of a road
 *    company's kit — phones, auto levels, GPS, safety gear, shuttering — and gives it a history:
 *    allocations, requests, transfers, inspections, repairs and documents, each written the way
 *    `src/assets/**` writes it (the status machine in `asset-status.ts`, stock deltas as
 *    `AssetStockService.applyDelta`, custody only by an employee posted at the site).
 *
 * 2. **The approval trail.** Seeds write module rows directly, so an RA bill can be "submitted"
 *    with no `shared.ApprovalInstance` behind it — waiting on nobody, in no queue — and an
 *    "approved" one has no decision trail. This finds every row of every spine-governed kind that
 *    has no instance and writes the instance (and decisions) the service would have written:
 *    pending ones parked at a level for the role that holds it, decided ones with a decision per
 *    level by distinct people of the right role. Generic over the source tables, so rows other
 *    modules add are covered too. Leaves, claims, indents, advances, resignations and the other
 *    FR-022 single-step approvals are NOT on the spine and get nothing here.
 */
import {
  ApprovalDecisionAction,
  ApprovalState,
  AssetAllocationStatus,
  AssetInspectionOutcome,
  AssetRepairStatus,
  AssetRequestStatus,
  AssetStatus,
  AssetTrackingMode,
  AssetTransferStatus,
  CodeSeriesType,
  Permission,
  Prisma,
} from '@prisma/client';

import {
  ACTION_ATTENDANCE_CORRECTION,
  ACTION_ATTENDANCE_EXCEPTION,
  ACTION_CLIENT_BILL,
  ACTION_DWR,
  ACTION_EXIT_CLEARANCE_WAIVER,
  ACTION_OPERATOR_FUEL_RECOVERY,
  ACTION_PAYROLL_RUN,
  ACTION_RA_BILL,
  ACTION_WORK_ORDER_AWARD,
  DIRECTOR_FINAL_SEEDED_ACTIONS,
  ENTITY_BILL_PACKAGE,
} from '../../src/approvals/default-chains';
import { SLOT_FINAL, SLOT_HR } from '../../src/approvals/approval-slots';
import { ASSET_DOCUMENT_PREFIX } from '../../src/assets/constants/assets.constants';
import { webRoutes } from '../../src/common/web-routes';
import { permissionForKind } from '../../src/letters/letter-permissions';
import { packageLabel } from '../../src/projects/billing/bill-number';
import {
  CODE_SERIES_FORMATS,
  formatCode,
  NAMED_SERIES_DEFAULT,
  namedCode,
  namedPrefixFor,
  namedSerialOf,
} from '../../src/settings/code-series/code-series.formats';
import { at, money } from './support';
import type { CompanyContext, ModuleResult } from './support';

type Tx = Prisma.TransactionClient;

const DAY_MS = 86_400_000;
const addDays = (day: Date, n: number): Date =>
  new Date(day.getTime() + n * DAY_MS);
const iso = (day: Date): string => day.toISOString().slice(0, 10);
const inr = (n: number): string =>
  `Rs. ${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

export async function seedAssets(ctx: CompanyContext): Promise<ModuleResult> {
  const result: ModuleResult = {
    ...(await seedAssetRegister(ctx)),
    ...(await seedDirectorFinalSet(ctx)),
    ...(await seedApprovalTrail(ctx)),
  };
  return Object.fromEntries(Object.entries(result).filter(([, n]) => n > 0));
}

// ═════════════════════════════════════════════════════════════════════════════
// People
// ═════════════════════════════════════════════════════════════════════════════

interface Person {
  userId: string;
  username: string;
  roleIds: string[];
  designation: string;
  employeeId: string | null;
}

/** The company's logins, with the roles they hold here and their designation. */
async function loadPeople(ctx: CompanyContext, tx: Tx): Promise<Person[]> {
  const companyId = ctx.company.id;
  const users = await tx.user.findMany({
    where: { companyId },
    select: { id: true, username: true },
    orderBy: { username: 'asc' },
  });
  const roles = await tx.userRole.findMany({
    where: {
      userId: { in: users.map((u) => u.id) },
      OR: [{ companyId }, { companyId: null }],
    },
    select: { userId: true, roleId: true },
  });
  const employees = await tx.employee.findMany({
    where: { companyId, userId: { in: users.map((u) => u.id) } },
    select: { id: true, userId: true, designationId: true },
  });
  const designations = await tx.designation.findMany({
    where: {
      id: {
        in: employees
          .map((e) => e.designationId)
          .filter((id): id is string => !!id),
      },
    },
    select: { id: true, name: true },
  });
  const designationName = new Map(designations.map((d) => [d.id, d.name]));
  return users.map((u) => {
    const employee = employees.find((e) => e.userId === u.id);
    return {
      userId: u.id,
      username: u.username,
      roleIds: roles.filter((r) => r.userId === u.id).map((r) => r.roleId),
      designation:
        (employee?.designationId &&
          designationName.get(employee.designationId)) ||
        '',
      employeeId: employee?.id ?? null,
    };
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Part 1 — the asset register in use
// ═════════════════════════════════════════════════════════════════════════════

interface SiteRef {
  id: string;
  name: string;
  projectId: string | null;
}

interface EmployeeRef {
  id: string;
  name: string;
  siteId: string | null;
  designation: string;
}

interface AssetState {
  id: string;
  code: string;
  name: string;
  categoryId: string;
  mode: AssetTrackingMode;
  status: AssetStatus;
  siteId: string;
  custodianId: string | null;
  gradeId: string | null;
  nextInspectionDue: Date | null;
  disposalDate: Date | null;
  purchaseDate: Date;
  cost: number;
  vendorId: string | null;
  manufacturer: string;
  model: string;
  serial: string | null;
  isNew: boolean;
  /** As bought — a bulk pool's later shortages do not rewrite its invoice. */
  purchasedQty: number;
}

interface CategoryRef {
  id: string;
  name: string;
  inspectionIntervalDays: number | null;
  inspectionRequired: boolean;
  depreciationRatePercent: Prisma.Decimal;
  usefulLifeYears: number;
}

/**
 * The base seed created these four beside the uppercase defaults — `Power Tools` next to
 * `POWER TOOLS` — so the category list showed duplicates. Their assets move to the default and
 * the empty duplicate goes; `Survey Instruments` has no default twin and is renamed instead.
 */
const CATEGORY_MERGES: Record<string, string> = {
  'IT Equipment': 'IT ASSETS',
  'Power Tools': 'POWER TOOLS',
  Scaffolding: 'SCAFFOLDING',
};

async function seedAssetRegister(ctx: CompanyContext): Promise<ModuleResult> {
  const { prisma, company } = ctx;
  const companyId = company.id;
  // The register's history is written in one go, documents last; any of it present means done.
  const already =
    (await prisma.assetAllocation.count({ where: { companyId } })) +
    (await prisma.assetDocument.count({ where: { companyId } }));
  if (already > 0) return {};

  const counts: ModuleResult = {};
  const bump = (key: string, n = 1) => (counts[key] = (counts[key] ?? 0) + n);

  await prisma.$transaction(
    async (tx) => {
      const r = ctx.rng;
      const today = ctx.today;
      const day = (n: number) => addDays(today, n);

      // ── Reference data ──────────────────────────────────────────────────────
      const sites: SiteRef[] = await tx.site.findMany({
        where: { companyId },
        select: { id: true, name: true, projectId: true },
        orderBy: { name: 'asc' },
      });
      const projectSites = sites.filter((s) => s.projectId);
      const office = sites.find((s) => !s.projectId) ?? projectSites[0];
      if (projectSites.length === 0) return;
      const S = (i: number) => projectSites[i % projectSites.length];

      const employeesRaw = await tx.employee.findMany({
        where: { companyId, isActive: true },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          siteId: true,
          designationId: true,
        },
        orderBy: { employeeCode: 'asc' },
      });
      const desigs = await tx.designation.findMany({
        where: { companyId },
        select: { id: true, name: true },
      });
      const employees: EmployeeRef[] = employeesRaw.map((e) => ({
        id: e.id,
        name: [e.firstName, e.lastName].filter(Boolean).join(' '),
        siteId: e.siteId,
        designation:
          desigs.find((d) => d.id === e.designationId)?.name ?? 'Staff',
      }));
      /** Somebody posted at the site who would hold this kind of kit; never the Director. */
      const custodianAt = (siteId: string, prefer: RegExp[]) => {
        const here = employees.filter(
          (e) => e.siteId === siteId && !/director/i.test(e.designation),
        );
        // Fit first, then whoever holds least already — one person with four assets reads wrong.
        const fit = (e: EmployeeRef) => {
          const i = prefer.findIndex((p) => p.test(e.designation));
          return i === -1 ? prefer.length : i;
        };
        const matching = here.filter((e) => fit(e) < prefer.length);
        const pool = matching.length > 0 ? matching : here;
        return (
          [...pool].sort(
            (a, b) =>
              (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0) || fit(a) - fit(b),
          )[0] ?? null
        );
      };
      const load = new Map<string, number>();

      const people = await loadPeople(ctx, tx);
      const roleNames = await tx.role.findMany({
        select: { id: true, name: true },
      });
      const holding = (roleName: string) => {
        const roleId = roleNames.find((x) => x.name === roleName)?.id;
        return people.filter((p) => roleId && p.roleIds.includes(roleId));
      };
      const admin = holding('Super Admin')[0] ?? people[0];
      const office1 =
        holding('Head Office').find((p) => /account/i.test(p.designation)) ??
        holding('Head Office')[0] ??
        admin;
      const store =
        people.find((p) => /store/i.test(p.designation)) ??
        holding('Site Incharge')[0] ??
        office1;
      const siteLead =
        holding('Site Incharge').find((p) => /manager/i.test(p.designation)) ??
        store;
      if (!admin) return;

      const grades = await tx.conditionGrade.findMany({ where: { companyId } });
      const grade = (name: string) => {
        const g = grades.find((x) => x.name === name);
        if (!g) throw new Error(`Condition grade ${name} is missing`);
        return g.id;
      };
      const docTypes = await tx.assetDocType.findMany({ where: { companyId } });
      const docType = (name: string) =>
        docTypes.find((x) => x.name === name)?.id ?? null;

      // ── Categories: merge the duplicates, add survey instruments' rules ─────
      const catRows = await tx.assetCategory.findMany({ where: { companyId } });
      for (const [from, to] of Object.entries(CATEGORY_MERGES)) {
        const source = catRows.find((c) => c.name === from);
        const target = catRows.find((c) => c.name === to);
        if (!source || !target) continue;
        await tx.asset.updateMany({
          where: { companyId, categoryId: source.id },
          data: {
            categoryId: target.id,
            depreciationRatePercent: target.depreciationRatePercent,
            usefulLifeYears: target.usefulLifeYears,
          },
        });
        await tx.assetCategory.delete({ where: { id: source.id } });
        bump('categories merged');
      }
      const survey = catRows.find((c) => c.name === 'Survey Instruments');
      if (survey && !catRows.some((c) => c.name === 'SURVEY INSTRUMENTS')) {
        await tx.assetCategory.update({
          where: { id: survey.id },
          data: {
            name: 'SURVEY INSTRUMENTS',
            custodyRequired: true,
            inspectionRequired: true,
            inspectionIntervalDays: 365,
            depreciationRatePercent: money(15),
            usefulLifeYears: 8,
          },
        });
        await tx.asset.updateMany({
          where: { companyId, categoryId: survey.id },
          data: { depreciationRatePercent: money(15), usefulLifeYears: 8 },
        });
      }
      const categories: CategoryRef[] = await tx.assetCategory.findMany({
        where: { companyId },
        select: {
          id: true,
          name: true,
          inspectionIntervalDays: true,
          inspectionRequired: true,
          depreciationRatePercent: true,
          usefulLifeYears: true,
        },
      });
      const category = (name: string) => {
        const c = categories.find((x) => x.name === name);
        if (!c) throw new Error(`Asset category ${name} is missing`);
        return c;
      };
      const categoryOf = (id: string) => categories.find((c) => c.id === id);

      // ── Vendors the kit was bought from ─────────────────────────────────────
      const vendors = await tx.vendor.findMany({
        where: { companyId },
        select: { id: true, name: true },
      });
      const vendorFor = async (
        match: RegExp,
        create: {
          name: string;
          type: 'material' | 'service';
          city: string;
          address: string;
          pinCode: string;
          gstin: string;
        },
      ): Promise<{ id: string; name: string }> => {
        const found = vendors.find((v) => match.test(v.name));
        if (found) return found;
        const code = await allocateCode(
          tx,
          companyId,
          company.shortCode,
          CodeSeriesType.VENDORS,
          'VEN',
          async (c) =>
            !!(await tx.vendor.findFirst({ where: { companyId, code: c } })),
        );
        const created = await tx.vendor.create({
          data: {
            companyId,
            code,
            name: create.name,
            type: create.type,
            gstin: create.gstin,
            pan: create.gstin.slice(2, 12),
            address: create.address,
            city: create.city,
            state: 'Rajasthan',
            pinCode: create.pinCode,
          },
          select: { id: true, name: true },
        });
        vendors.push(created);
        bump('asset vendors');
        return created;
      };
      const vIT = await vendorFor(/comput|infotech|systems/i, {
        name: 'Shree Shyam Computers',
        type: 'material',
        city: 'Jaipur',
        address: 'G-14, Ganpati Plaza, M.I. Road',
        pinCode: '302001',
        gstin: '08ABHFS4471K1Z9',
      });
      const vTools = await vendorFor(/tools|hardware|machinery store/i, {
        name: 'Rajdhani Tools & Hardware',
        type: 'material',
        city: 'Jaipur',
        address: '112, Vishwakarma Industrial Area, Road No. 9',
        pinCode: '302013',
        gstin: '08AAKFR2290M1Z3',
      });
      const vSafety = await vendorFor(/safety/i, {
        name: 'Marudhar Safety Equipments',
        type: 'material',
        city: 'Jodhpur',
        address: 'E-71, Basni Industrial Area, Phase II',
        pinCode: '342005',
        gstin: '08AAMFM8823Q1Z6',
      });
      const vSurvey = await vendorFor(/survey|instrument/i, {
        name: 'Precision Survey Services',
        type: 'service',
        city: 'Jaipur',
        address: '45, Shanti Nagar, Durgapura',
        pinCode: '302018',
        gstin: '08AAPFP6612L1Z2',
      });

      // ── Stock, kept as AssetStockService keeps it ───────────────────────────
      const stock = new Map<
        string,
        { assetId: string; siteId: string; h: number; a: number; t: number }
      >();
      const delta = (
        assetId: string,
        siteId: string,
        d: { h?: number; a?: number; t?: number },
      ) => {
        const key = `${assetId}|${siteId}`;
        const row = stock.get(key) ?? { assetId, siteId, h: 0, a: 0, t: 0 };
        row.h += d.h ?? 0;
        row.a += d.a ?? 0;
        row.t += d.t ?? 0;
        if (row.h < 0 || row.a < 0 || row.t < 0) {
          throw new Error(`Stock for ${assetId} at ${siteId} went negative`);
        }
        stock.set(key, row);
      };

      const assets = new Map<string, AssetState>();
      const serialFor = (prefix: string, digits = 7) =>
        prefix +
        Array.from({ length: digits }, () =>
          'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789'.charAt(r.int(0, 33)),
        ).join('');

      // ── Tidy the base seed's six ────────────────────────────────────────────
      const known: Record<
        string,
        {
          manufacturer: string;
          model: string;
          serial: string | null;
          vendorId: string;
          grade: string;
          qty?: number;
          uom?: string;
        }
      > = {
        'Dell Latitude 5440 Laptop': {
          manufacturer: 'Dell',
          model: 'Latitude 5440',
          serial: serialFor('', 7),
          vendorId: vIT.id,
          grade: 'GOOD',
        },
        'Lenovo ThinkPad E14 Laptop': {
          manufacturer: 'Lenovo',
          model: 'ThinkPad E14 Gen 5',
          serial: serialFor('PF4', 5),
          vendorId: vIT.id,
          grade: 'GOOD',
        },
        'Leica TS07 Total Station': {
          manufacturer: 'Leica Geosystems',
          model: 'FlexLine TS07 5"',
          serial: String(r.int(1360000, 1399999)),
          vendorId: vSurvey.id,
          grade: 'GOOD',
        },
        'Bosch GSB 600 Impact Drill': {
          manufacturer: 'Bosch',
          model: 'GSB 600 Professional',
          serial: `${r.int(100, 999)}${serialFor('', 6)}`,
          vendorId: vTools.id,
          grade: 'FAIR',
        },
        'Concrete Needle Vibrator': {
          manufacturer: 'Kirloskar',
          model: 'KVN-40 (40 mm needle)',
          serial: `KV${r.int(210000, 289999)}`,
          vendorId: vTools.id,
          grade: 'GOOD',
        },
        'Cuplock Scaffolding Set': {
          manufacturer: 'Mahavir Scaffolding',
          model: 'Cuplock 3.0 m standard set',
          serial: null,
          vendorId: vTools.id,
          grade: 'GOOD',
          qty: 120,
          uom: 'SET',
        },
      };
      const existing = await tx.asset.findMany({
        where: { companyId, deletedAt: null },
      });
      for (const row of existing) {
        const k = known[row.name];
        const purchaseDate =
          row.purchaseDate ?? addDays(row.capitalisationDate, -r.int(2, 9));
        const qty =
          row.trackingMode === 'bulk' ? k?.qty ?? Number(row.quantity) : 1;
        const cat = categoryOf(row.categoryId);
        await tx.asset.update({
          where: { id: row.id },
          data: {
            manufacturer: row.manufacturer ?? k?.manufacturer ?? null,
            modelNumber: row.modelNumber ?? k?.model ?? null,
            serialNumber:
              row.trackingMode === 'serialised'
                ? row.serialNumber ?? k?.serial ?? null
                : null,
            unitOfMeasure: row.unitOfMeasure ?? k?.uom ?? null,
            purchaseDate,
            manufacturingYear:
              row.manufacturingYear ?? purchaseDate.getUTCFullYear(),
            vendorId: row.vendorId ?? k?.vendorId ?? null,
            createdBy: row.createdBy ?? office1.userId,
          },
        });
        const inspectionDue =
          cat?.inspectionRequired && cat.inspectionIntervalDays
            ? addDays(row.capitalisationDate, cat.inspectionIntervalDays)
            : null;
        assets.set(row.name, {
          id: row.id,
          code: row.assetCode,
          name: row.name,
          categoryId: row.categoryId,
          mode: row.trackingMode,
          // "allocated" with no allocation is fixed below by allocating it for real.
          status: row.status === 'allocated' ? 'idle' : row.status,
          siteId: row.currentSiteId,
          custodianId: null,
          gradeId: grade(k?.grade ?? 'GOOD'),
          nextInspectionDue: inspectionDue,
          disposalDate: null,
          purchaseDate,
          cost: Number(row.purchaseCost),
          vendorId: row.vendorId ?? k?.vendorId ?? null,
          manufacturer: k?.manufacturer ?? row.manufacturer ?? '',
          model: k?.model ?? row.modelNumber ?? '',
          serial: k?.serial ?? null,
          isNew: false,
          purchasedQty: qty,
        });
        delta(row.id, row.currentSiteId, { h: qty });
      }
      const wasAllocated = existing
        .filter((a) => a.status === 'allocated')
        .map((a) => a.name);

      // ── Register the rest of the kit, coded as AssetService codes it ────────
      const format =
        (await tx.codeFormat.findUnique({
          where: { companyId_series: { companyId, series: 'ASSETS' } },
        })) ?? NAMED_SERIES_DEFAULT;
      const usedCodes = new Set(existing.map((a) => a.assetCode));
      const nextCode = (name: string, year: number) => {
        const prefix = namedPrefixFor(name);
        let serial = 0;
        for (const c of usedCodes) {
          serial = Math.max(serial, namedSerialOf(format, c, prefix) ?? 0);
        }
        const code = namedCode(format, prefix, serial + 1, year);
        usedCodes.add(code);
        return code;
      };
      const register = async (
        key: string,
        def: {
          name: string;
          category: string;
          manufacturer: string;
          model: string;
          cost: number;
          purchased: number;
          capitalised?: number;
          site: SiteRef;
          vendorId: string;
          qty?: number;
          uom?: string;
          serial?: string;
          gradeName?: string;
        },
      ): Promise<AssetState> => {
        const cat = category(def.category);
        const purchaseDate = day(-def.purchased);
        const capitalisationDate = day(-(def.capitalised ?? def.purchased - 3));
        const year = purchaseDate.getUTCFullYear();
        const serialised = !def.qty;
        const status: AssetStatus =
          capitalisationDate > today ? 'not_in_service' : 'idle';
        const nextInspectionDue =
          cat.inspectionRequired && cat.inspectionIntervalDays
            ? addDays(capitalisationDate, cat.inspectionIntervalDays)
            : null;
        const created = await tx.asset.create({
          data: {
            companyId,
            assetCode: nextCode(def.name, year),
            name: def.name,
            categoryId: cat.id,
            trackingMode: serialised ? 'serialised' : 'bulk',
            manufacturer: def.manufacturer,
            modelNumber: def.model,
            serialNumber: serialised ? def.serial ?? null : null,
            quantity: money(def.qty ?? 1),
            unitOfMeasure: def.uom ?? null,
            manufacturingYear: year,
            purchaseDate,
            purchaseCost: money(def.cost),
            capitalisationDate,
            depreciationRatePercent: cat.depreciationRatePercent,
            usefulLifeYears: cat.usefulLifeYears,
            salvageValue: money(Math.round(def.cost * 0.05)),
            vendorId: def.vendorId,
            currentSiteId: def.site.id,
            currentConditionGradeId: grade(def.gradeName ?? 'NEW'),
            status,
            nextInspectionDue,
            createdBy: office1.userId,
            createdAt: at(purchaseDate, 16, 30),
          },
        });
        const state: AssetState = {
          id: created.id,
          code: created.assetCode,
          name: def.name,
          categoryId: cat.id,
          mode: created.trackingMode,
          status,
          siteId: def.site.id,
          custodianId: null,
          gradeId: created.currentConditionGradeId,
          nextInspectionDue,
          disposalDate: null,
          purchaseDate,
          cost: def.cost,
          vendorId: def.vendorId,
          manufacturer: def.manufacturer,
          model: def.model,
          serial: created.serialNumber,
          isNew: true,
          purchasedQty: def.qty ?? 1,
        };
        assets.set(key, state);
        delta(created.id, def.site.id, { h: def.qty ?? 1 });
        bump('assets registered');
        return state;
      };

      const hpLaptop = await register('hp-laptop', {
        name: 'HP ProBook 440 G10 Laptop',
        category: 'IT ASSETS',
        manufacturer: 'HP',
        model: 'ProBook 440 G10 (i5-1335U, 16 GB)',
        cost: 72500,
        purchased: 214,
        site: S(0),
        vendorId: vIT.id,
        serial: serialFor('5CD3', 6),
      });
      const phones: AssetState[] = [];
      for (let i = 0; i < 3; i += 1) {
        phones.push(
          await register(`phone-${i}`, {
            name: 'Samsung Galaxy M34 Mobile',
            category: 'IT ASSETS',
            manufacturer: 'Samsung',
            model: 'Galaxy M34 5G (SM-M346B)',
            cost: 16999,
            purchased: 180 - i * 25,
            site: S(i),
            vendorId: vIT.id,
            serial: `R9ZW${r.int(10, 99)}${serialFor('', 5)}`,
          }),
        );
      }
      const oldLaptop = await register('old-laptop', {
        name: 'HP 250 G7 Laptop',
        category: 'IT ASSETS',
        manufacturer: 'HP',
        model: '250 G7 (i3-7020U, 8 GB)',
        cost: 34500,
        purchased: 1720,
        site: S(1),
        vendorId: vIT.id,
        serial: serialFor('CND9', 6),
        gradeName: 'POOR',
      });
      const autoLevel1 = await register('auto-level-1', {
        name: 'Sokkia B40A Auto Level',
        category: 'SURVEY INSTRUMENTS',
        manufacturer: 'Sokkia',
        model: 'B40A (24x)',
        cost: 38500,
        purchased: 330,
        site: S(1),
        vendorId: vSurvey.id,
        serial: `${r.int(170000, 189999)}`,
      });
      const autoLevel2 = await register('auto-level-2', {
        name: 'Sokkia B40A Auto Level',
        category: 'SURVEY INSTRUMENTS',
        manufacturer: 'Sokkia',
        model: 'B40A (24x)',
        cost: 38500,
        purchased: 330,
        site: S(0),
        vendorId: vSurvey.id,
        serial: `${r.int(190000, 199999)}`,
      });
      const leicaLevel = await register('leica-level', {
        name: 'Leica NA720 Auto Level',
        category: 'SURVEY INSTRUMENTS',
        manufacturer: 'Leica Geosystems',
        model: 'NA720 (20x)',
        cost: 42000,
        purchased: 610,
        site: S(2),
        vendorId: vSurvey.id,
        serial: `${r.int(5800000, 5899999)}`,
        gradeName: 'GOOD',
      });
      const gps = await register('gps', {
        name: 'Garmin eTrex 30x Handheld GPS',
        category: 'SURVEY INSTRUMENTS',
        manufacturer: 'Garmin',
        model: 'eTrex 30x',
        cost: 31800,
        purchased: 260,
        site: office,
        vendorId: vSurvey.id,
        serial: `4K${r.int(1000000, 9999999)}`,
      });
      const hammer = await register('hammer', {
        name: 'Hilti TE 30-A36 Rotary Hammer',
        category: 'POWER TOOLS',
        manufacturer: 'Hilti',
        model: 'TE 30-A36 (cordless)',
        cost: 48500,
        purchased: 150,
        site: office,
        vendorId: vTools.id,
        serial: `${r.int(10000000, 19999999)}`,
      });
      await register('laser-meter', {
        name: 'Bosch GLM 50-27 Laser Distance Meter',
        category: 'POWER TOOLS',
        manufacturer: 'Bosch',
        model: 'GLM 50-27 C Professional',
        cost: 11900,
        purchased: 5,
        // Bought last week and capitalised on the first of next month: on the register,
        // not yet in service (spec Edge Cases).
        capitalised: -Math.round(
          (Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1) -
            today.getTime()) /
            DAY_MS,
        ),
        site: office,
        vendorId: vTools.id,
        serial: `${r.int(300, 399)}${serialFor('', 5)}`,
      });
      const helmets = await register('helmets', {
        name: 'Safety Helmet (ISI Marked)',
        category: 'SAFETY EQUIPMENT',
        manufacturer: 'Karam',
        model: 'PN-521 ratchet type, IS 2925',
        cost: 150 * 285,
        purchased: 140,
        site: office,
        vendorId: vSafety.id,
        qty: 150,
        uom: 'NOS',
      });
      const harness = await register('harness', {
        name: 'Full Body Safety Harness',
        category: 'SAFETY EQUIPMENT',
        manufacturer: 'Karam',
        model: 'PN-56 double lanyard, IS 3521',
        cost: 36 * 2450,
        purchased: 120,
        site: S(0),
        vendorId: vSafety.id,
        qty: 36,
        uom: 'NOS',
      });
      const jackets = await register('jackets', {
        name: 'Reflective Safety Jacket',
        category: 'SAFETY EQUIPMENT',
        manufacturer: 'Udyogi',
        model: 'Hi-vis orange, 50 mm tape',
        cost: 200 * 180,
        purchased: 95,
        site: office,
        vendorId: vSafety.id,
        qty: 200,
        uom: 'NOS',
      });
      const plates = await register('plates', {
        name: 'Steel Shuttering Plate 900 x 600 mm',
        category: 'SHUTTERING',
        manufacturer: 'Shree Ganesh Fabricators',
        model: '3 mm MS sheet, angle frame',
        cost: 400 * 1850,
        purchased: 230,
        site: S(1),
        vendorId: vTools.id,
        qty: 400,
        uom: 'NOS',
        gradeName: 'GOOD',
      });
      const chairs = await register('chairs', {
        name: 'Site Office Folding Chair',
        category: 'SITE FURNITURE',
        manufacturer: 'Nilkamal',
        model: 'CHR 2135 steel frame',
        cost: 40 * 950,
        purchased: 300,
        site: office,
        vendorId: vTools.id,
        qty: 40,
        uom: 'NOS',
        gradeName: 'GOOD',
      });

      // ── Movements ───────────────────────────────────────────────────────────
      const allocationIds: Record<string, string> = {};
      const allocate = async (
        key: string,
        a: AssetState,
        site: SiteRef,
        opts: {
          qty?: number;
          from: Date;
          until: Date;
          custodian?: EmployeeRef | null;
          remarks: string;
          by?: Person;
        },
      ) => {
        if (!site.projectId) return null;
        const qty = opts.qty ?? 1;
        if (a.mode === 'serialised') {
          if (a.status !== 'idle' || a.siteId !== site.id) {
            throw new Error(`${a.code} cannot be allocated at ${site.name}`);
          }
          a.status = 'allocated';
          a.custodianId = opts.custodian?.id ?? null;
          if (opts.custodian) {
            load.set(opts.custodian.id, (load.get(opts.custodian.id) ?? 0) + 1);
          }
        }
        delta(a.id, site.id, { h: -qty, a: qty });
        const row = await tx.assetAllocation.create({
          data: {
            companyId,
            assetId: a.id,
            projectId: site.projectId,
            siteId: site.id,
            custodianEmployeeId: opts.custodian?.id ?? null,
            quantity: money(qty),
            allocatedFrom: opts.from,
            expectedReturnDate: opts.until,
            remarks: opts.remarks,
            createdBy: (opts.by ?? store).userId,
            createdAt: at(opts.from, 11, r.int(0, 59)),
          },
        });
        allocationIds[key] = row.id;
        bump('allocations');
        return row;
      };
      const returnAllocation = async (
        key: string,
        a: AssetState,
        on: Date,
        gradeName: string,
        remarks: string,
      ) => {
        const row = await tx.assetAllocation.findUniqueOrThrow({
          where: { id: allocationIds[key] },
        });
        const g = grades.find((x) => x.name === gradeName);
        if (!g) throw new Error(`Grade ${gradeName} missing`);
        const qty = Number(row.quantity);
        const next: AssetStatus = g.isScrap
          ? 'scrapped'
          : g.isDamaged
          ? 'under_repair'
          : 'idle';
        delta(a.id, row.siteId, g.isScrap ? { a: -qty } : { a: -qty, h: qty });
        await tx.assetAllocation.update({
          where: { id: row.id },
          data: {
            status: AssetAllocationStatus.closed,
            actualReturnDate: on,
            conditionOnReturnId: g.id,
            remarks,
            updatedAt: at(on, 17, r.int(0, 59)),
          },
        });
        a.gradeId = g.id;
        if (a.mode === 'serialised') {
          a.status = next;
          a.custodianId = null;
          if (next === 'scrapped') a.disposalDate = on;
        }
      };
      const transfer = async (
        a: AssetState,
        from: SiteRef,
        to: SiteRef,
        opts: {
          qty?: number;
          dispatched: Date;
          received?: Date;
          receivedQty?: number;
          cancelled?: string;
          mode: string;
          vehicle: string;
          discrepancy?: string;
        },
      ) => {
        const qty = opts.qty ?? 1;
        delta(a.id, from.id, { h: -qty, t: qty });
        let status: AssetTransferStatus = AssetTransferStatus.in_transit;
        const receivedQty = opts.receivedQty ?? qty;
        const dispatchGrade = a.gradeId;
        let receiptGrade: string | null = null;
        if (opts.cancelled) {
          delta(a.id, from.id, { t: -qty, h: qty });
          status = AssetTransferStatus.cancelled;
        } else if (opts.received) {
          delta(a.id, from.id, { t: -qty });
          delta(a.id, to.id, { h: receivedQty });
          status =
            receivedQty < qty
              ? AssetTransferStatus.closed_with_shortage
              : AssetTransferStatus.closed;
          receiptGrade = opts.discrepancy
            ? grade(opts.discrepancy)
            : dispatchGrade;
          if (a.mode === 'serialised') {
            a.siteId = to.id;
            a.status = 'idle';
          }
          if (opts.discrepancy) a.gradeId = receiptGrade;
        } else if (a.mode === 'serialised') {
          a.status = 'in_transit';
        }
        await tx.assetTransfer.create({
          data: {
            companyId,
            assetId: a.id,
            fromSiteId: from.id,
            toSiteId: to.id,
            quantity: money(qty),
            dispatchDate: opts.dispatched,
            transportMode: opts.mode,
            vehicleNumber: opts.vehicle,
            dispatchConditionId: dispatchGrade,
            receivedDate: opts.received ?? null,
            receivedQuantity: opts.received ? money(receivedQty) : null,
            conditionOnReceiptId: receiptGrade,
            conditionDiscrepancy: !!opts.discrepancy,
            transitShortage:
              opts.received && receivedQty < qty
                ? money(qty - receivedQty)
                : null,
            status,
            cancelReason: opts.cancelled ?? null,
            createdBy: store.userId,
            createdAt: at(opts.dispatched, 10, r.int(0, 59)),
          },
        });
        bump('transfers');
      };
      const inspect = async (
        a: AssetState,
        on: Date,
        gradeName: string,
        outcome: AssetInspectionOutcome,
        remarks: string,
        by: Person,
      ) => {
        const g = grade(gradeName);
        await tx.assetInspection.create({
          data: {
            companyId,
            assetId: a.id,
            inspectionDate: on,
            conditionGradeId: g,
            outcome,
            remarks,
            inspectedByUserId: by.userId,
            createdAt: at(on, 15, r.int(0, 59)),
          },
        });
        a.gradeId = g;
        const cat = categoryOf(a.categoryId);
        if (cat?.inspectionRequired && cat.inspectionIntervalDays) {
          a.nextInspectionDue = addDays(on, cat.inspectionIntervalDays);
        }
        if (a.mode === 'serialised' && outcome === 'repair_required') {
          a.status = 'under_repair';
        }
        if (a.mode === 'serialised' && outcome === 'condemn') {
          a.status = 'scrapped';
          a.disposalDate = on;
        }
        bump('inspections');
      };
      const repair = async (
        a: AssetState,
        opts: {
          on: Date;
          description: string;
          cost: number;
          vendorId: string;
          expected: Date;
          completed?: Date;
          resultGrade?: string;
        },
      ) => {
        if (a.mode === 'serialised') a.status = 'under_repair';
        const closed = !!opts.completed;
        await tx.assetRepair.create({
          data: {
            companyId,
            assetId: a.id,
            repairDate: opts.on,
            description: opts.description,
            cost: money(opts.cost),
            vendorId: opts.vendorId,
            expectedCompletionDate: opts.expected,
            actualCompletionDate: opts.completed ?? null,
            resultingConditionGradeId: closed
              ? grade(opts.resultGrade ?? 'GOOD')
              : null,
            downtimeDays: closed
              ? Math.round(
                  ((opts.completed as Date).getTime() - opts.on.getTime()) /
                    DAY_MS,
                )
              : null,
            status: closed ? AssetRepairStatus.closed : AssetRepairStatus.open,
            createdBy: store.userId,
            createdAt: at(opts.on, 12, r.int(0, 59)),
          },
        });
        if (closed) {
          a.gradeId = grade(opts.resultGrade ?? 'GOOD');
          if (a.mode === 'serialised') a.status = 'idle';
        }
        bump('repairs');
      };

      const engineerish = [/engineer/i, /surveyor/i, /supervisor/i, /manager/i];
      const officeish = [/account/i, /quantity/i, /hr/i, /engineer/i];
      const longTerm = day(365 - r.int(0, 60));

      // The base seed's two laptops, allocated for real this time.
      for (const name of wasAllocated) {
        const a = assets.get(name);
        if (!a) continue;
        const site = sites.find((s) => s.id === a.siteId);
        const custodian = site ? custodianAt(site.id, officeish) : null;
        if (!site?.projectId || !custodian) continue;
        await allocate(`existing:${name}`, a, site, {
          from: day(-r.int(70, 110)),
          until: longTerm,
          custodian,
          remarks: `Site office laptop for ${custodian.designation.toLowerCase()} — billing, MB and DPR entry`,
          by: office1,
        });
      }

      // HP ProBook — with the planning engineer at S0.
      const hpCustodian = custodianAt(S(0).id, officeish);
      await allocate('hp-laptop', hpLaptop, S(0), {
        from: day(-196),
        until: day(169),
        custodian: hpCustodian,
        remarks:
          'Site office laptop for billing and DPR work; return at project close-out',
        by: office1,
      });

      // Phones — one per site to the site engineer/supervisor, one already overdue.
      for (const [i, phone] of phones.entries()) {
        const site = S(i);
        const custodian = custodianAt(site.id, engineerish);
        await allocate(`phone-${i}`, phone, site, {
          from: day(-(170 - i * 25)),
          until: i === 2 ? day(-6) : day(190 - i * 20),
          custodian,
          remarks:
            i === 2
              ? 'Site CUG phone for night-shift supervision; due back after the paving stretch'
              : 'Site CUG phone with DPR app and WhatsApp group for the site',
        });
      }
      // A screen replaced on the first phone, under warranty bar the glass.
      await repair(phones[0], {
        on: day(-62),
        description:
          'Cracked display replaced (dropped at batching plant); glass not under warranty',
        cost: 4850,
        vendorId: vIT.id,
        expected: day(-58),
        completed: day(-57),
        resultGrade: 'GOOD',
      });
      // ...and the repair happened while it was out on allocation: restore the custody state.
      phones[0].status = 'allocated';

      // The old HP laptop: back from site, beyond economic repair.
      await allocate('old-laptop', oldLaptop, S(1), {
        from: day(-400),
        until: day(-30),
        custodian: custodianAt(S(1).id, officeish),
        remarks: 'Store and attendance laptop',
      });
      await returnAllocation(
        'old-laptop',
        oldLaptop,
        day(-34),
        'SCRAP',
        'Motherboard failed; repair estimate Rs. 14,500 exceeds book value — condemned and handed to IT for e-waste disposal',
      );

      // Total station: out for the Km 312–318 layout, back, calibrated.
      const totalStation = assets.get('Leica TS07 Total Station');
      if (totalStation) {
        const site = sites.find((s) => s.id === totalStation.siteId);
        if (site?.projectId) {
          await allocate('total-station', totalStation, site, {
            from: day(-150),
            until: day(-45),
            custodian: custodianAt(site.id, [/surveyor/i, /engineer/i]),
            remarks:
              'Centre-line and cross-section survey for the realignment stretch',
          });
          await returnAllocation(
            'total-station',
            totalStation,
            day(-44),
            'GOOD',
            'Returned to site store with tripod, two prisms and charger; all accessories checked',
          );
        }
        await inspect(
          totalStation,
          day(-40),
          'GOOD',
          'pass',
          'Annual calibration by authorised Leica service centre; angular error within 5"',
          store,
        );
      }

      // Auto levels: one with the surveyor (from a request), one on its way to S2.
      await allocate('auto-level-1', autoLevel1, S(1), {
        from: day(-88),
        until: day(92),
        custodian: custodianAt(S(1).id, [/surveyor/i, /engineer/i]),
        remarks: 'Level transfer for culvert and drain works',
      });
      await transfer(autoLevel2, S(0), S(2), {
        dispatched: day(-2),
        mode: 'Site jeep',
        vehicle: `RJ${r.pick(['26', '14', '06'])} UA ${r.int(1000, 9999)}`,
      });
      await inspect(
        autoLevel1,
        day(-95),
        'NEW',
        'pass',
        'Two-peg test before issue: collimation error 2 mm in 30 m, within limit',
        store,
      );

      // Leica NA720: failed its check, at the service centre now.
      await inspect(
        leicaLevel,
        day(-21),
        'DAMAGED',
        'repair_required',
        'Compensator sticking after the instrument fell from the tripod; readings drift 8 mm in 30 m',
        siteLead,
      );
      await repair(leicaLevel, {
        on: day(-19),
        description:
          'Compensator realignment and eyepiece replacement at authorised service centre',
        cost: 6400,
        vendorId: vSurvey.id,
        expected: day(4),
      });

      // GPS: a transfer raised and cancelled.
      await transfer(gps, office, S(1), {
        dispatched: day(-47),
        cancelled:
          'Requirement met by the hired survey agency; instrument kept at head office',
        mode: 'Courier',
        vehicle: 'DTDC docket D47731920',
      });

      // Hilti hammer: from the office store to S0, now with the supervisor there.
      await transfer(hammer, office, S(0), {
        dispatched: day(-131),
        received: day(-130),
        mode: 'Company pickup',
        vehicle: `RJ${r.pick(['26', '14'])} GB ${r.int(1000, 9999)}`,
      });
      await allocate('hammer', hammer, S(0), {
        from: day(-129),
        until: day(51),
        custodian: custodianAt(S(0).id, [/supervisor/i, /engineer/i]),
        remarks: 'Core cutting and anchor drilling for crash barrier posts',
      });
      await inspect(
        hammer,
        day(-129),
        'NEW',
        'pass',
        'New tool, checked before issue: chuck, clutch and battery pack OK',
        store,
      );

      // The base seed's drill and vibrator: inspected, repaired, back in service.
      const drill = assets.get('Bosch GSB 600 Impact Drill');
      if (drill) {
        await inspect(
          drill,
          day(-200),
          'FAIR',
          'repair_required',
          'Sparking at the commutator; carbon brushes worn',
          store,
        );
        await repair(drill, {
          on: day(-199),
          description: 'Carbon brushes and switch replaced',
          cost: 650,
          vendorId: vTools.id,
          expected: day(-196),
          completed: day(-195),
          resultGrade: 'FAIR',
        });
        await inspect(
          drill,
          day(-17),
          'FAIR',
          'pass',
          'Six-monthly check: body, cable and earthing OK',
          store,
        );
      }
      const vibrator = assets.get('Concrete Needle Vibrator');
      if (vibrator) {
        await inspect(
          vibrator,
          day(-64),
          'POOR',
          'repair_required',
          'Needle not vibrating at full frequency; flexible shaft worn',
          store,
        );
        await repair(vibrator, {
          on: day(-63),
          description:
            'Flexible shaft and needle bearing replaced; motor rewound',
          cost: 3200,
          vendorId: vTools.id,
          expected: day(-58),
          completed: day(-55),
          resultGrade: 'GOOD',
        });
        await inspect(
          vibrator,
          day(-54),
          'GOOD',
          'pass',
          'Post-repair trial on the culvert raft pour; frequency normal',
          store,
        );
      }

      // Bulk: helmets out to two sites and issued to the gangs.
      await transfer(helmets, office, S(0), {
        qty: 60,
        dispatched: day(-128),
        received: day(-127),
        mode: 'Pickup',
        vehicle: `RJ${r.pick(['26', '14'])} GA ${r.int(1000, 9999)}`,
      });
      await transfer(helmets, office, S(1), {
        qty: 50,
        dispatched: day(-120),
        received: day(-118),
        mode: 'Pickup',
        vehicle: `RJ${r.pick(['26', '14'])} GA ${r.int(1000, 9999)}`,
      });
      await allocate('helmets-0', helmets, S(0), {
        qty: 45,
        from: day(-126),
        until: day(54),
        remarks: 'Issued to earthwork and paving gangs (labour contractor)',
      });
      await allocate('helmets-1', helmets, S(1), {
        qty: 40,
        from: day(-116),
        until: day(64),
        remarks: 'Issued to structure gang for culvert works',
      });
      await inspect(
        helmets,
        day(-36),
        'GOOD',
        'pass',
        'Quarterly check: shells and ratchets OK; 6 helmets with cracked shells set aside',
        store,
      );

      // Harness: twelve sent to S2, ten arrived.
      await transfer(harness, S(0), S(2), {
        qty: 12,
        dispatched: day(-75),
        received: day(-73),
        receivedQty: 10,
        mode: 'Tractor trolley',
        vehicle: `RJ${r.pick(['26', '14'])} RA ${r.int(1000, 9999)}`,
      });
      await allocate('harness-2', harness, S(2), {
        qty: 8,
        from: day(-72),
        until: day(18),
        remarks: 'Work at height on the ROB pier caps',
      });
      await inspect(
        harness,
        day(-30),
        'GOOD',
        'pass',
        'Quarterly inspection: webbing, D-rings and lanyard hooks OK',
        store,
      );

      // Jackets: eighty to S0, one batch returned, fifty on their way to S1.
      await transfer(jackets, office, S(0), {
        qty: 80,
        dispatched: day(-90),
        received: day(-89),
        mode: 'Pickup',
        vehicle: `RJ${r.pick(['26', '14'])} GA ${r.int(1000, 9999)}`,
      });
      await allocate('jackets-old', jackets, S(0), {
        qty: 20,
        from: day(-88),
        until: day(-50),
        remarks: 'Traffic diversion crew during the culvert crossing',
      });
      await returnAllocation(
        'jackets-old',
        jackets,
        day(-52),
        'GOOD',
        'Diversion closed; jackets returned to site store',
      );
      await allocate('jackets-0', jackets, S(0), {
        qty: 70,
        from: day(-45),
        until: day(45),
        remarks: 'Night paving crew and flagmen',
      });
      await transfer(jackets, office, S(1), {
        qty: 50,
        dispatched: day(-1),
        mode: 'Pickup',
        vehicle: `RJ${r.pick(['26', '14'])} GA ${r.int(1000, 9999)}`,
      });
      // Jackets: their quarterly inspection is two days overdue (an inspection-due flag on the register).
      // Shuttering: a hundred plates to S0, most of the rest in use at S1.
      await transfer(plates, S(1), S(0), {
        qty: 100,
        dispatched: day(-160),
        received: day(-158),
        mode: 'Truck',
        vehicle: `RJ${r.pick(['26', '14'])} GB ${r.int(1000, 9999)}`,
      });
      await allocate('plates-1', plates, S(1), {
        qty: 250,
        from: day(-150),
        until: day(30),
        remarks: 'Box culvert walls and wing walls',
      });

      // Chairs to S0's site office.
      await transfer(chairs, office, S(0), {
        qty: 15,
        dispatched: day(-210),
        received: day(-209),
        mode: 'Pickup',
        vehicle: `RJ${r.pick(['26', '14'])} GA ${r.int(1000, 9999)}`,
      });

      // The base seed's scaffolding pool: most of it on the structure.
      const scaffolding = assets.get('Cuplock Scaffolding Set');
      if (scaffolding) {
        const site = sites.find((s) => s.id === scaffolding.siteId);
        if (site?.projectId) {
          await allocate('scaffolding', scaffolding, site, {
            qty: 80,
            from: day(-68),
            until: day(22),
            remarks: 'Staging for deck slab shuttering',
          });
        }
      }

      // ── Requests ────────────────────────────────────────────────────────────
      const requestNumber = () =>
        allocateCode(
          tx,
          companyId,
          company.shortCode,
          CodeSeriesType.ASSET_REQUEST,
          'ARQ',
          async (c) =>
            !!(await tx.assetRequest.findFirst({
              where: { companyId, requestNumber: c },
            })),
        );
      const request = async (def: {
        category: string;
        asset?: AssetState;
        qty?: number;
        site: SiteRef;
        raised: number;
        requiredBy: number;
        justification: string;
        status: AssetRequestStatus;
        decidedAfter?: number;
        rejectionReason?: string;
        fulfilled?: string;
      }) => {
        if (!def.site.projectId) return;
        const raised = day(-def.raised);
        const decided =
          def.status === 'pending'
            ? null
            : at(addDays(raised, def.decidedAfter ?? 1), 12, r.int(0, 59));
        const allocationId = def.fulfilled
          ? allocationIds[def.fulfilled]
          : null;
        await tx.assetRequest.create({
          data: {
            companyId,
            requestNumber: await requestNumber(),
            categoryId: category(def.category).id,
            assetId: def.asset?.id ?? null,
            quantity: money(def.qty ?? 1),
            projectId: def.site.projectId,
            siteId: def.site.id,
            requiredByDate: day(def.requiredBy),
            justification: def.justification,
            status: def.status,
            approvedBy:
              def.status === 'pending' || def.status === 'cancelled'
                ? null
                : office1.userId,
            approvedAt:
              def.status === 'pending' || def.status === 'cancelled'
                ? null
                : decided,
            rejectionReason: def.rejectionReason ?? null,
            fulfilledAllocationId: allocationId,
            fulfilledAt: allocationId ? decided : null,
            createdBy: siteLead.userId,
            createdAt: at(raised, 10, r.int(0, 59)),
          },
        });
        bump('requests');
      };
      await request({
        category: 'SURVEY INSTRUMENTS',
        asset: autoLevel1,
        site: S(1),
        raised: 92,
        requiredBy: -88,
        justification:
          'Auto level needed for levelling of culvert foundations at Km 16–19',
        status: 'fulfilled',
        decidedAfter: 4,
        fulfilled: 'auto-level-1',
      });
      await request({
        category: 'SAFETY EQUIPMENT',
        asset: helmets,
        qty: 40,
        site: S(1),
        raised: 121,
        requiredBy: -116,
        justification:
          'Helmets for the structure gang mobilised for box culverts',
        status: 'fulfilled',
        decidedAfter: 5,
        fulfilled: 'helmets-1',
      });
      await request({
        category: 'IT ASSETS',
        site: S(2),
        raised: 6,
        requiredBy: 8,
        justification:
          'Laptop for the new billing engineer joining the site office',
        status: 'approved',
        decidedAfter: 2,
      });
      await request({
        category: 'SURVEY INSTRUMENTS',
        asset: totalStation,
        site: S(1),
        raised: 3,
        requiredBy: 12,
        justification:
          'Total station for setting out the minor bridge at Km 21.400',
        status: 'pending',
      });
      await request({
        category: 'SAFETY EQUIPMENT',
        asset: harness,
        qty: 10,
        site: S(0),
        raised: 1,
        requiredBy: 6,
        justification: 'Additional harnesses for sign-gantry erection work',
        status: 'pending',
      });
      await request({
        category: 'POWER TOOLS',
        site: S(2),
        raised: 26,
        requiredBy: -20,
        justification:
          'Angle grinder for cutting reinforcement at the ROB site',
        status: 'rejected',
        decidedAfter: 1,
        rejectionReason:
          'Bar cutting is in the labour contractor’s scope with his own tools as per work order; no company tool to be issued',
      });
      await request({
        category: 'SHUTTERING',
        qty: 250,
        site: S(2),
        raised: 14,
        requiredBy: 10,
        justification:
          'Shuttering plates for retaining wall at the ROB approach',
        status: 'procurement_pending',
        decidedAfter: 2,
      });
      await request({
        category: 'IT ASSETS',
        site: S(0),
        raised: 40,
        requiredBy: -30,
        justification: 'CUG phone for the new site supervisor',
        status: 'cancelled',
      });

      // ── Documents ───────────────────────────────────────────────────────────
      const companyRow = await tx.company.findUnique({
        where: { id: companyId },
      });
      const companyGstin =
        (companyRow as { gstin?: string | null } | null)?.gstin ?? '';
      const vendorName = (id: string | null) =>
        vendors.find((v) => v.id === id)?.name ?? 'Supplier';
      const document = async (
        a: AssetState,
        typeName: string,
        def: {
          number: string;
          issued: Date;
          expires?: Date | null;
          title: string;
          body: string;
          by?: Person;
        },
      ) => {
        const typeId = docType(typeName);
        if (!typeId) return;
        const pdf = await ctx.renderPdf(def.title, def.body);
        const fileRef = await ctx.writeBlob(ASSET_DOCUMENT_PREFIX, pdf);
        await tx.assetDocument.create({
          data: {
            companyId,
            assetId: a.id,
            docTypeId: typeId,
            fileRef,
            fileName: `${typeName.toLowerCase().replace(/\s+/g, '-')}-${a.code
              .replace(/[^A-Za-z0-9]+/g, '-')
              .toLowerCase()}.pdf`,
            mimeType: 'application/pdf',
            documentNumber: def.number,
            issueDate: def.issued,
            expiryDate: def.expires ?? null,
            uploadedByUserId: (def.by ?? office1).userId,
            uploadedAt: at(addDays(def.issued, 2), 14, r.int(0, 59)),
          },
        });
        bump('documents');
      };
      const fy = (d0: Date) => {
        const y =
          d0.getUTCMonth() >= 3 ? d0.getUTCFullYear() : d0.getUTCFullYear() - 1;
        return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
      };
      for (const a of assets.values()) {
        if (a.status === 'scrapped') continue;
        const taxable = a.cost;
        const gst = Math.round(taxable * 0.18 * 100) / 100;
        const invoiceNo = `${vendorName(a.vendorId)
          .split(/\s+/)
          .map((w) => w[0])
          .join('')
          .toUpperCase()}/${fy(a.purchaseDate)}/${r.int(100, 1999)}`;
        await document(a, 'PURCHASE INVOICE', {
          number: invoiceNo,
          issued: a.purchaseDate,
          title: `TAX INVOICE — ${vendorName(a.vendorId)}`,
          body: [
            `Invoice No: ${invoiceNo}`,
            `Invoice Date: ${iso(a.purchaseDate)}`,
            '',
            `Bill to: ${company.name}`,
            companyGstin ? `GSTIN: ${companyGstin}` : '',
            '',
            `Item: ${a.name}`,
            `Make / Model: ${a.manufacturer} ${a.model}`,
            a.serial ? `Serial No: ${a.serial}` : '',
            `Quantity: ${a.purchasedQty}`,
            `Taxable value: ${inr(taxable)}`,
            `CGST @ 9%: ${inr(gst / 2)}`,
            `SGST @ 9%: ${inr(gst / 2)}`,
            `Invoice total: ${inr(taxable + gst)}`,
            '',
            'Goods once sold will not be taken back. Subject to Jaipur jurisdiction.',
            'For and on behalf of the supplier — Authorised Signatory',
          ]
            .filter((line) => line !== null)
            .join('\n'),
        });
        const cat = categoryOf(a.categoryId)?.name ?? '';
        if (cat === 'IT ASSETS') {
          const years = a.name.includes('Mobile') ? 1 : 3;
          await document(a, 'WARRANTY', {
            number: `${a.manufacturer.toUpperCase().slice(0, 3)}-WTY-${
              a.serial ?? r.int(10000, 99999)
            }`,
            issued: a.purchaseDate,
            expires: addDays(a.purchaseDate, 365 * years),
            title: `${a.manufacturer} Warranty Certificate`,
            body: `Product: ${a.manufacturer} ${a.model}\nSerial No: ${
              a.serial ?? '-'
            }\nPurchased from: ${vendorName(
              a.vendorId,
            )}\nWarranty: ${years} year${
              years > 1 ? 's' : ''
            } onsite, from ${iso(a.purchaseDate)} to ${iso(
              addDays(a.purchaseDate, 365 * years),
            )}\nRegistered to: ${company.name}`,
          });
        }
        if (cat === 'SURVEY INSTRUMENTS') {
          // The NA720's certificate runs out in a fortnight: an expiry alert on the register.
          const calibrated =
            a === totalStation
              ? day(-40)
              : a === leicaLevel
              ? day(14 - 365)
              : addDays(a.purchaseDate, 2);
          const expires = addDays(calibrated, 365);
          await document(a, 'CALIBRATION CERTIFICATE', {
            number: `CAL/${fy(calibrated)}/${r.int(1000, 4999)}`,
            issued: calibrated,
            expires,
            title: 'Certificate of Calibration',
            body: `Instrument: ${a.manufacturer} ${a.model}\nSerial No: ${
              a.serial ?? '-'
            }\nOwner: ${company.name}\nCalibrated by: ${vendorName(
              vSurvey.id,
            )} (NABL traceable standards)\nResult: within manufacturer tolerance\nValid until: ${iso(
              expires,
            )}`,
            by: store,
          });
        }
        if (a === totalStation) {
          await document(a, 'INSURANCE', {
            number: `OG-${r.int(25, 26)}-1407-4012-${r.int(
              10000000,
              99999999,
            )}`,
            issued: day(-200),
            expires: day(165),
            title: 'Contractor’s Plant & Machinery Insurance — Policy Schedule',
            body: `Insured: ${
              company.name
            }\nCover: Electronic equipment / survey instruments, all risks at site\nInstrument: ${
              a.manufacturer
            } ${a.model}, Sl. ${a.serial}\nSum insured: ${inr(
              a.cost,
            )}\nPeriod: ${iso(day(-200))} to ${iso(day(165))}`,
          });
        }
        if (a === harness || a === scaffolding) {
          await document(a, 'TEST CERTIFICATE', {
            number: `TC/${fy(a.purchaseDate)}/${r.int(100, 999)}`,
            issued: a.purchaseDate,
            expires: addDays(a.purchaseDate, 365),
            title: 'Manufacturer’s Test Certificate',
            body: `Product: ${a.name} — ${a.model}\nManufacturer: ${a.manufacturer}\nQuantity covered: ${a.purchasedQty}\nTested to the relevant IS standard; batch passed load and drop tests.`,
            by: store,
          });
        }
      }

      // ── Write back the register's final state and stock ─────────────────────
      for (const a of assets.values()) {
        const rows = [...stock.values()].filter((s) => s.assetId === a.id);
        const total = rows.reduce((n, s) => n + s.h + s.a + s.t, 0);
        await tx.asset.update({
          where: { id: a.id },
          data: {
            status: a.status,
            currentSiteId: a.siteId,
            currentCustodianId: a.custodianId,
            currentConditionGradeId: a.gradeId,
            nextInspectionDue: a.nextInspectionDue,
            disposalDate: a.disposalDate,
            ...(a.mode === 'bulk' ? { quantity: money(total) } : {}),
          },
        });
        for (const s of rows) {
          await tx.assetStock.upsert({
            where: { assetId_siteId: { assetId: a.id, siteId: s.siteId } },
            create: {
              companyId,
              assetId: a.id,
              siteId: s.siteId,
              quantityOnHand: money(s.h),
              quantityAllocated: money(s.a),
              quantityInTransit: money(s.t),
            },
            update: {
              quantityOnHand: money(s.h),
              quantityAllocated: money(s.a),
              quantityInTransit: money(s.t),
            },
          });
          bump('stock rows');
        }
      }
    },
    { timeout: 300_000, maxWait: 60_000 },
  );
  return counts;
}

/** `CodeSeriesService.allocate`, reproduced: one atomic increment, then the series' format. */
async function allocateCode(
  tx: Tx,
  companyId: string,
  shortCode: string,
  seriesType: CodeSeriesType,
  infix: string,
  isTaken: (code: string) => Promise<boolean>,
): Promise<string> {
  await tx.codeSequence.upsert({
    where: { companyId_seriesType: { companyId, seriesType } },
    create: { companyId, seriesType, lastNumber: 0 },
    update: {},
  });
  const row = await tx.codeFormat.findUnique({
    where: { companyId_series: { companyId, series: seriesType } },
  });
  const format = row
    ? { prefix: row.prefix, base: row.base, step: row.step, width: row.width }
    : CODE_SERIES_FORMATS[seriesType] ?? null;
  for (let guard = 0; guard < 10_000; guard += 1) {
    const [{ lastNumber }] = await tx.$queryRaw<{ lastNumber: number }[]>`
      UPDATE "settings"."CodeSequence"
      SET "lastNumber" = "lastNumber" + 1, "updatedAt" = NOW()
      WHERE "companyId" = ${companyId}
        AND "seriesType" = ${seriesType}::"settings"."CodeSeriesType"
      RETURNING "lastNumber"`;
    const code = format
      ? formatCode(format, lastNumber)
      : `${shortCode}-${infix}-${String(lastNumber).padStart(4, '0')}`;
    if (!(await isTaken(code))) return code;
  }
  throw new Error(`No free ${seriesType} code for ${shortCode}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// Part 2 — the director-final set
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Migration `20260930140000_director_final_action_table` wrote these seven rows for every
 * company that existed then; a company created afterwards (as both develop companies were) has
 * none and falls back to the same list from config. Written so Settings → Approvals shows the
 * set as stored, the way a production company's does. Same values, so behaviour is unchanged.
 */
async function seedDirectorFinalSet(
  ctx: CompanyContext,
): Promise<ModuleResult> {
  const actions = [
    ...new Set([...DIRECTOR_FINAL_SEEDED_ACTIONS, ACTION_PAYROLL_RUN]),
  ].filter((a) => a !== ACTION_EXIT_CLEARANCE_WAIVER);
  const { count } = await ctx.prisma.directorFinalAction.createMany({
    data: actions.map((actionType) => ({
      companyId: ctx.company.id,
      actionType,
      isFinal: true,
    })),
    skipDuplicates: true,
  });
  return { 'director-final actions': count };
}

// ═════════════════════════════════════════════════════════════════════════════
// Part 3 — the approval trail
// ═════════════════════════════════════════════════════════════════════════════

type Outcome = 'pending' | 'approved' | 'rejected' | 'returned';

/** One governed row that should have an `ApprovalInstance` and has none. */
interface ApprovalItem {
  actionType: string;
  entityType: string;
  entityId: string;
  subject: string;
  href: string | null;
  viewPermission: Permission;
  originatorUserId: string | null;
  submittedAt: Date;
  outcome: Outcome;
  /** Who made the deciding call, when the module row records it. */
  deciderUserId?: string | null;
  decidedAt?: Date | null;
  reason?: string | null;
  /** For a row that already names its instance (attendance corrections). */
  instanceId?: string;
  /** Money and paperwork routes to the accountant at HO; people matters to the HR executive. */
  flavour: 'finance' | 'people';
  after?: (tx: Tx, instanceId: string) => Promise<void>;
}

/** The same instant if it falls in IST office hours (10:00–18:30), else the next morning's. */
function workingHours(t: Date): Date {
  const ist = new Date(t.getTime() + 330 * 60_000);
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  if (minutes >= 600 && minutes <= 1110) return t;
  const midnight =
    Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) -
    330 * 60_000;
  const base = minutes < 600 ? midnight : midnight + DAY_MS;
  return new Date(base + (600 + (minutes % 53)) * 60_000);
}

const REJECT_REASONS: Record<string, string> = {
  [ACTION_ATTENDANCE_EXCEPTION]:
    'Employee was on approved leave that day; punch not accepted',
  [ACTION_ATTENDANCE_CORRECTION]:
    'Muster and gate register do not support this correction',
  [ACTION_OPERATOR_FUEL_RECOVERY]:
    'Shortfall traced to a faulty dispenser meter, not the operator — do not recover',
  [ACTION_EXIT_CLEARANCE_WAIVER]:
    'Recover through full and final settlement; waiver not justified',
  [ACTION_DWR]:
    'Quantities do not match the measurement book; recheck and resubmit',
};

async function seedApprovalTrail(ctx: CompanyContext): Promise<ModuleResult> {
  const { prisma, company } = ctx;
  const companyId = company.id;

  const chains = await prisma.approvalChain.findMany({
    where: { companyId, isActive: true },
    include: { levels: { orderBy: { position: 'asc' } } },
  });
  if (chains.length === 0) return {};
  const chainFor = new Map(chains.map((c) => [c.actionType, c]));
  const mappings = await prisma.roleSlotMapping.findMany({
    where: { companyId },
  });
  const roleOf = new Map(mappings.map((m) => [m.slotKey, m.roleId]));
  const people = await loadPeople(ctx, prisma as unknown as Tx);

  const existing = await prisma.approvalInstance.findMany({
    where: { companyId },
    select: { id: true, entityType: true, entityId: true },
  });
  const governed = new Set(
    existing.map((e) => `${e.entityType}|${e.entityId}`),
  );
  const instanceIds = new Set(existing.map((e) => e.id));

  const items = await collectItems(ctx);
  const fresh = items
    .filter(
      (i) =>
        !governed.has(`${i.entityType}|${i.entityId}`) &&
        !(i.instanceId && instanceIds.has(i.instanceId)),
    )
    .sort(
      (a, b) =>
        a.submittedAt.getTime() - b.submittedAt.getTime() ||
        a.entityId.localeCompare(b.entityId),
    );
  if (fresh.length === 0) return {};

  // Holders of a slot's role, best fit first for this kind of item.
  const holders = (slotKey: string, flavour: ApprovalItem['flavour']) => {
    const roleId = roleOf.get(slotKey);
    if (!roleId) return [];
    const prefer =
      slotKey === SLOT_HR
        ? flavour === 'finance'
          ? [/account/i, /hr/i]
          : [/hr/i, /account/i]
        : slotKey === SLOT_FINAL
        ? [/director/i]
        : [/manager/i, /engineer/i, /store/i];
    const score = (p: Person) => {
      const i = prefer.findIndex((re) => re.test(p.designation));
      return i === -1 ? prefer.length : i;
    };
    return people
      .filter((p) => p.roleIds.includes(roleId))
      .sort(
        (a, b) => score(a) - score(b) || a.username.localeCompare(b.username),
      );
  };

  const counts: ModuleResult = {};
  const bump = (key: string) => (counts[key] = (counts[key] ?? 0) + 1);
  const now = Date.now();
  // Pending items are spread over their chains' levels, oldest furthest along, so each
  // approver's inbox has something in it.
  const order = await prisma.company.findMany({
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  let pendingRank = Math.max(
    0,
    order.findIndex((c) => c.id === companyId),
  );

  for (const item of fresh) {
    const chain = chainFor.get(item.actionType);
    if (!chain || chain.levels.length === 0) {
      bump('approvals skipped (no chain)');
      continue;
    }
    const levels = chain.levels;
    const n = levels.length;

    // Where the chain stops and what the last act was.
    let stopAt: number; // the level the item rests at (pending) or was decided at last
    let lastAction: ApprovalDecisionAction | null;
    let state: ApprovalState;
    const deciderLevel = (userId?: string | null) => {
      if (!userId) return null;
      const person = people.find((p) => p.userId === userId);
      if (!person) return null;
      for (let i = n - 1; i >= 0; i -= 1) {
        const roleId = roleOf.get(levels[i].slotKey);
        if (roleId && person.roleIds.includes(roleId)) return i + 1;
      }
      return null;
    };
    if (item.outcome === 'pending') {
      stopAt = 1 + (pendingRank % n);
      pendingRank += 1;
      lastAction = null;
      state = ApprovalState.pending;
    } else if (item.outcome === 'approved') {
      stopAt = n;
      lastAction = ApprovalDecisionAction.approve;
      state = ApprovalState.approved;
    } else {
      stopAt = deciderLevel(item.deciderUserId) ?? n;
      lastAction =
        item.outcome === 'rejected'
          ? ApprovalDecisionAction.reject
          : ApprovalDecisionAction.return;
      state =
        item.outcome === 'rejected'
          ? ApprovalState.rejected
          : ApprovalState.returned;
    }

    // One person, one decision per round (FR-021a); never the originator.
    const used = new Set<string>(
      item.originatorUserId ? [item.originatorUserId] : [],
    );
    const decided = lastAction ? stopAt : stopAt - 1;
    const actors: string[] = [];
    // The recorded decider takes the last level when they hold it.
    const deciderFits =
      lastAction !== null &&
      item.deciderUserId &&
      deciderLevel(item.deciderUserId) === stopAt &&
      item.deciderUserId !== item.originatorUserId;
    if (deciderFits) used.add(item.deciderUserId as string);
    let feasible = true;
    for (let pos = 1; pos <= decided; pos += 1) {
      if (pos === decided && deciderFits) {
        actors.push(item.deciderUserId as string);
        continue;
      }
      const pick =
        holders(levels[pos - 1].slotKey, item.flavour).find(
          (p) => !used.has(p.userId),
        ) ??
        // Only the originator holds this level: the spine allows it (it has no originator
        // check), and it is what would have happened in a company this small.
        holders(levels[pos - 1].slotKey, item.flavour).find(
          (p) =>
            p.userId === item.originatorUserId && !actors.includes(p.userId),
        );
      if (!pick) {
        feasible = false;
        break;
      }
      used.add(pick.userId);
      actors.push(pick.userId);
    }
    if (!feasible) {
      if (item.outcome !== 'pending') {
        bump('approvals skipped (no approver)');
        continue;
      }
      // Park it at the first level nobody else can take.
      stopAt = actors.length + 1;
    }

    // Times: submitted, then a decision every few working hours (IST 10:00–18:30), the last on
    // the date the module row records.
    const t0 = item.submittedAt;
    const end = item.decidedAt && item.decidedAt > t0 ? item.decidedAt : null;
    const span = end
      ? (end.getTime() - t0.getTime()) / (actors.length + 1)
      : Math.min(26 * 3_600_000, (now - t0.getTime()) / (actors.length + 1));
    const times: Date[] = [];
    let previous = t0;
    for (let i = 0; i < actors.length; i += 1) {
      const isLast = i === actors.length - 1;
      let t =
        isLast && end && lastAction
          ? end
          : workingHours(
              new Date(
                previous.getTime() +
                  Math.max(span, 50 * 60_000) +
                  ctx.rng.int(0, 25) * 60_000,
              ),
            );
      if (t <= previous) t = new Date(previous.getTime() + 35 * 60_000);
      times.push(t);
      previous = t;
    }
    // Nothing decided in the future: pull the tail back before now, keeping the order.
    for (let i = times.length - 1; i >= 0; i -= 1) {
      const ceiling =
        i === times.length - 1
          ? now - 5 * 60_000
          : times[i + 1].getTime() - 20 * 60_000;
      if (times[i].getTime() > ceiling)
        times[i] = new Date(Math.max(t0.getTime() + 60_000, ceiling));
    }

    const reason =
      lastAction && lastAction !== ApprovalDecisionAction.approve
        ? item.reason?.trim() ||
          REJECT_REASONS[item.actionType] ||
          'Not in order; please review and raise again'
        : null;

    await prisma.$transaction(async (tx) => {
      const instance = await tx.approvalInstance.create({
        data: {
          ...(item.instanceId ? { id: item.instanceId } : {}),
          companyId,
          chainId: chain.id,
          entityType: item.entityType,
          entityId: item.entityId,
          subject: item.subject,
          href: item.href,
          viewPermission: item.viewPermission,
          originatorUserId: item.originatorUserId,
          currentPosition: state === ApprovalState.pending ? stopAt : decided,
          state,
          createdAt: t0,
          updatedAt: times[times.length - 1] ?? t0,
        },
      });
      for (const [i, actorUserId] of actors.entries()) {
        const position = i + 1;
        const isLast = position === decided && lastAction !== null;
        await tx.approvalDecision.create({
          data: {
            approvalInstanceId: instance.id,
            companyId,
            round: 1,
            position,
            actorUserId,
            action: isLast
              ? (lastAction as ApprovalDecisionAction)
              : ApprovalDecisionAction.approve,
            reason: isLast ? reason : null,
            decidedAt: times[i],
          },
        });
      }
      if (item.after) await item.after(tx, instance.id);
    });
    bump(`approvals ${state}`);
  }
  return counts;
}

/** Every spine-governed row in the company, as the module that owns it would have submitted it. */
async function collectItems(ctx: CompanyContext): Promise<ApprovalItem[]> {
  const { prisma } = ctx;
  const companyId = ctx.company.id;
  const items: ApprovalItem[] = [];
  const users = await prisma.user.findMany({
    where: { companyId },
    select: { id: true },
  });
  const isUser = (id: string | null | undefined) =>
    !!id && users.some((u) => u.id === id);
  const people = await loadPeople(ctx, prisma as unknown as Tx);
  /** Who raises site paperwork when the row does not say: an engineer, not the manager. */
  const siteRaiser =
    people.find((p) => /site engineer|surveyor|store/i.test(p.designation))
      ?.userId ?? null;

  // RA bills on the legacy measured-bill path (a bill in a package is the package's approval).
  const packaged = new Set(
    (
      await prisma.billPackage.findMany({
        where: { companyId, raBillId: { not: null } },
        select: { raBillId: true },
      })
    ).map((p) => p.raBillId),
  );
  for (const bill of await prisma.rABill.findMany({
    where: { companyId, status: { in: ['submitted', 'approved'] } },
  })) {
    if (packaged.has(bill.id)) continue;
    items.push({
      actionType: ACTION_RA_BILL,
      entityType: ACTION_RA_BILL,
      entityId: bill.id,
      subject: `RA bill ${bill.billNumber}${
        bill.revisionCount > 0 ? ' (revised)' : ''
      }`,
      href: webRoutes.projectRaBills(bill.projectId),
      viewPermission: Permission.PROJECT_FINANCIALS,
      originatorUserId: siteRaiser,
      submittedAt: at(bill.submittedAt ?? bill.createdAt, 10, 5),
      outcome: bill.status === 'approved' ? 'approved' : 'pending',
      deciderUserId: bill.approvedByUserId,
      // Same day as the bill records its approval, so the trail and the bill agree.
      decidedAt: bill.approvedAt ? at(bill.approvedAt, 17, 40) : null,
      flavour: 'finance',
    });
  }

  // Work order awards: active only through an approved chain (028 FR-009). Submitted ahead of
  // the first bill measured against it — the row's own timestamp is when the seed ran.
  for (const order of await prisma.workOrder.findMany({
    where: {
      companyId,
      status: { in: ['pending_approval', 'active', 'completed'] },
    },
    include: { raBills: { select: { billingDate: true } } },
  })) {
    const firstBill = order.raBills
      .map((b) => b.billingDate.getTime())
      .sort((a, b) => a - b)[0];
    const submitted = firstBill
      ? at(addDays(new Date(firstBill), -26), 11, 20)
      : order.createdAt;
    const detail = order.workDetail.split('\n')[0].trim();
    items.push({
      actionType: ACTION_WORK_ORDER_AWARD,
      entityType: ACTION_WORK_ORDER_AWARD,
      entityId: order.id,
      // The service writes `code ?? id`; a work order with no code gets its description rather
      // than a raw id in the queue.
      subject: `Work order ${
        order.code ??
        (detail.length > 70 ? `${detail.slice(0, 67)}...` : detail || order.id)
      }`,
      href: webRoutes.projectRaBills(order.projectId),
      viewPermission: Permission.PROJECT_FINANCIALS,
      originatorUserId: siteRaiser,
      submittedAt: submitted,
      outcome: order.status === 'pending_approval' ? 'pending' : 'approved',
      decidedAt:
        order.status === 'pending_approval'
          ? null
          : at(addDays(submitted, 2), 16, 10),
      flavour: 'finance',
    });
  }

  // Bill packages, either direction.
  for (const pkg of await prisma.billPackage.findMany({
    where: {
      companyId,
      status: { in: ['pending_approval', 'approved', 'issued', 'certified'] },
    },
  })) {
    const toClient = pkg.direction === 'to_client';
    items.push({
      actionType: toClient ? ACTION_CLIENT_BILL : ACTION_RA_BILL,
      entityType: ENTITY_BILL_PACKAGE,
      entityId: pkg.id,
      subject:
        `${toClient ? 'Client bill' : 'Subcontractor bill'} ${packageLabel(
          pkg.sequenceNo,
        )}` +
        `${pkg.receiverName ? ` · ${pkg.receiverName}` : ''} · payable ₹` +
        `${Math.round(Number(pkg.payable)).toLocaleString('en-IN')}`,
      href: webRoutes.projectBillPackage(pkg.projectId, pkg.id),
      viewPermission: Permission.PROJECT_FINANCIALS,
      originatorUserId: siteRaiser,
      submittedAt: pkg.submittedAt ?? pkg.createdAt,
      outcome: pkg.status === 'pending_approval' ? 'pending' : 'approved',
      deciderUserId: pkg.approvedByUserId,
      decidedAt: pkg.approvedAt,
      flavour: 'finance',
    });
  }

  // Daily work reports that reached the chain.
  for (const dwr of await prisma.dailyWorkReport.findMany({
    where: {
      companyId,
      OR: [
        { status: { in: ['submitted', 'approved'] } },
        { status: 'returned', returnedAt: { not: null } },
      ],
    },
  })) {
    const outcome: Outcome =
      dwr.status === 'approved'
        ? 'approved'
        : dwr.status === 'returned'
        ? 'returned'
        : 'pending';
    items.push({
      actionType: ACTION_DWR,
      entityType: ACTION_DWR,
      entityId: dwr.id,
      subject: `${dwr.dprNumber} — ${iso(dwr.workDate)}`,
      href: webRoutes.projectDwr(dwr.projectId),
      viewPermission: Permission.DWR,
      originatorUserId: isUser(dwr.submittedByUserId)
        ? dwr.submittedByUserId
        : isUser(dwr.createdByUserId)
        ? dwr.createdByUserId
        : siteRaiser,
      submittedAt: dwr.submittedAt ?? dwr.updatedAt,
      outcome,
      deciderUserId:
        outcome === 'returned' ? dwr.returnedByUserId : dwr.approvedByUserId,
      decidedAt: outcome === 'returned' ? dwr.returnedAt : dwr.approvedAt,
      reason: dwr.returnReason,
      flavour: 'finance',
    });
  }

  // Payroll runs: processed runs enter the chain; a bank sheet or payment means it completed.
  const runs = await prisma.payrollRun.findMany({
    where: { companyId, status: { in: ['processed', 'paid'] }, isFnf: false },
  });
  const exported = new Set(
    (
      await prisma.bankSheetExport.findMany({
        where: { payrollRunId: { in: runs.map((x) => x.id) } },
        select: { payrollRunId: true },
      })
    ).map((x) => x.payrollRunId),
  );
  for (const run of runs) {
    const done = run.status === 'paid' || exported.has(run.id);
    items.push({
      actionType: ACTION_PAYROLL_RUN,
      entityType: ACTION_PAYROLL_RUN,
      entityId: run.id,
      subject: `Payroll run ${run.period}`,
      href: webRoutes.payrollRun(run.id),
      viewPermission: Permission.PAYROLL,
      originatorUserId: null,
      submittedAt: run.processedAt ?? run.generatedAt ?? run.createdAt,
      outcome: done ? 'approved' : 'pending',
      decidedAt: run.paidAt
        ? new Date(run.paidAt.getTime() - 6 * 3_600_000)
        : null,
      flavour: 'people',
    });
  }

  // Operator fuel recoveries.
  for (const rec of await prisma.operatorFuelRecovery.findMany({
    where: { companyId },
    include: {
      fuelVarianceException: {
        include: {
          fuelEntry: { include: { equipment: { select: { code: true } } } },
        },
      },
    },
  })) {
    const outcome: Outcome =
      rec.status === 'pending_approval'
        ? 'pending'
        : rec.status === 'rejected'
        ? 'rejected'
        : 'approved';
    items.push({
      actionType: ACTION_OPERATOR_FUEL_RECOVERY,
      entityType: ACTION_OPERATOR_FUEL_RECOVERY,
      entityId: rec.id,
      subject: `${
        rec.fuelVarianceException.fuelEntry.equipment.code
      } — fuel recovery of ${Number(rec.amount).toFixed(2)} from operator`,
      href: webRoutes.plantFuel(),
      viewPermission: Permission.MACHINERY,
      originatorUserId: isUser(rec.createdByUserId)
        ? rec.createdByUserId
        : null,
      submittedAt: rec.createdAt,
      outcome,
      decidedAt: outcome === 'pending' ? null : rec.updatedAt,
      flavour: 'people',
      // The service writes the instance id back onto the recovery once it has one.
      after: rec.approvalItemId
        ? undefined
        : async (tx, instanceId) => {
            await tx.operatorFuelRecovery.update({
              where: { id: rec.id },
              data: { approvalItemId: instanceId },
            });
          },
    });
  }

  // Manual attendance corrections: the row already names its instance id.
  for (const c of await prisma.pendingAttendanceCorrection.findMany({
    where: { companyId },
    include: {
      employee: { select: { firstName: true, lastName: true, id: true } },
    },
  })) {
    const name =
      [c.employee.firstName, c.employee.lastName].filter(Boolean).join(' ') ||
      c.employee.id;
    items.push({
      actionType: ACTION_ATTENDANCE_CORRECTION,
      entityType: ACTION_ATTENDANCE_CORRECTION,
      entityId: c.id,
      instanceId: c.approvalInstanceId,
      subject: `${name} — ${iso(c.date)}, manual attendance correction`,
      href: webRoutes.hrAttendance(),
      viewPermission: Permission.ATTENDANCE,
      originatorUserId: isUser(c.submittedByUserId)
        ? c.submittedByUserId
        : null,
      submittedAt: c.createdAt,
      outcome: c.appliedAt ? 'approved' : 'pending',
      decidedAt: c.appliedAt,
      flavour: 'people',
    });
  }

  // Flagged punches (face or geofence exception).
  const employeesById = new Map(
    (
      await prisma.employee.findMany({
        where: { companyId },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          employeeCode: true,
          userId: true,
        },
      })
    ).map((e) => [e.id, e]),
  );
  for (const punch of await prisma.punchRecord.findMany({
    where: {
      exceptionResolution: { not: null },
      employeeId: { in: [...employeesById.keys()] },
    },
  })) {
    const employee = employeesById.get(punch.employeeId);
    if (!employee) continue;
    const reasons = [
      punch.faceMatchResult === 'exception' ? 'face did not match' : null,
      punch.geofenceResult === 'exception' ? 'outside the site geofence' : null,
    ].filter(Boolean);
    const name =
      [employee.firstName, employee.lastName]
        .filter(Boolean)
        .join(' ')
        .trim() || employee.employeeCode;
    const day = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(punch.capturedAt);
    items.push({
      actionType: ACTION_ATTENDANCE_EXCEPTION,
      entityType: ACTION_ATTENDANCE_EXCEPTION,
      entityId: punch.id,
      subject: `${name} — ${day}, ${reasons.join(' and ') || 'flagged punch'}`,
      href: webRoutes.hrAttendance(),
      viewPermission: Permission.ATTENDANCE,
      originatorUserId: isUser(employee.userId) ? employee.userId : null,
      submittedAt: punch.capturedAt,
      outcome:
        punch.exceptionResolution === 'pending'
          ? 'pending'
          : punch.exceptionResolution === 'confirmed'
          ? 'approved'
          : 'rejected',
      deciderUserId: punch.resolvedByUserId,
      decidedAt: punch.resolvedAt,
      flavour: 'people',
    });
  }

  // Exit clearance waivers.
  for (const w of await prisma.exitClearanceWaiverProposal.findMany({
    where: { companyId },
    include: { exitRecord: { select: { employeeId: true } } },
  })) {
    items.push({
      actionType: ACTION_EXIT_CLEARANCE_WAIVER,
      entityType: ACTION_EXIT_CLEARANCE_WAIVER,
      entityId: w.id,
      subject: `Waive ${w.itemKind.replace(/_/g, ' ')} on exit — ${w.reason}`,
      href: webRoutes.employee(w.exitRecord.employeeId),
      viewPermission: Permission.PAYROLL,
      originatorUserId: isUser(w.proposedByUserId) ? w.proposedByUserId : null,
      submittedAt: w.proposedAt,
      outcome:
        w.status === 'approved'
          ? 'approved'
          : w.status === 'rejected'
          ? 'rejected'
          : 'pending',
      flavour: 'people',
    });
  }

  // Letters of a kind that needs approval: issued means its chain completed.
  for (const letter of await prisma.issuedLetter.findMany({
    where: {
      companyId,
      isSuperseded: false,
      letterKind: { requiresApproval: true, approvalActionType: { not: null } },
    },
    include: { letterKind: true },
  })) {
    const actionType = letter.letterKind.approvalActionType as string;
    items.push({
      actionType,
      entityType: actionType,
      entityId: letter.id,
      subject:
        `${letter.letterKind.label} — ` +
        (letter.subjectId
          ? `${letter.subjectType ?? 'subject'} ${letter.subjectId}`
          : letter.employeeId ?? letter.candidateId ?? 'unaddressed'),
      href:
        letter.subjectType === 'project' && letter.subjectId
          ? webRoutes.projectLetters(letter.subjectId)
          : letter.letterKind.key === 'letter_purchase_order'
          ? webRoutes.inventoryPurchaseOrders()
          : webRoutes.recruitmentLetters(),
      viewPermission: permissionForKind(letter.letterKind.key),
      originatorUserId: isUser(letter.issuedBy) ? letter.issuedBy : null,
      submittedAt: letter.createdAt,
      outcome: letter.issuedAt ? 'approved' : 'pending',
      decidedAt: letter.issuedAt
        ? new Date(letter.issuedAt.getTime() - 3_600_000)
        : null,
      flavour: 'finance',
    });
  }

  return items;
}
