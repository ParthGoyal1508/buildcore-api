/**
 * A local billing demo, end to end (2026-10-13).
 *
 * Builds everything a client bill and a subcontractor bill need — and nothing past the first
 * decision — so the whole flow can be walked by hand in the browser:
 *
 *   client bill:  draft → send for approval → approve (inline) → issue → share → certify
 *                 → Payment Abstract (Excel / PDF / Word)
 *   subcontractor: draft (with a diesel recovery) → approve → issue → certify
 *                 → Generate payment advice (date, amount, mode, bank ref) → PDF / Word
 *
 * What it creates, in Parth Realcon (the local admin's company):
 *   - the company's registered address and logo, as the payment advice prints them;
 *   - a client, PWD Zone Ajmer, and a project with a 5% client retention term;
 *   - a four-line BOQ with rates, and three approved daily work reports in September 2026;
 *   - a subcontractor vendor, Tirupati Enterprises, **with** bank details, and an approved work
 *     order whose award lines map onto two of the BOQ lines;
 *   - two draft bills for September 2026, one in each direction.
 *
 * Driven through the **running API** wherever the API can do it, so every rule a person meets in
 * the browser also ran here. Two things are written directly, both as the e2e suites do: the
 * project (creating one through the API needs four mandatory documents uploaded) and the work
 * order's approval (deciding it is the approvals inbox's subject, not this demo's).
 *
 * Usage (API running on :3000):
 *   npm run seed:billing-demo            # creates the demo, or says it already exists
 *   npm run seed:billing-demo -- --reset # removes the demo project and builds it again
 *
 * Signs in as admin@buildcore.dev / secret42, who holds the Director ("final") approval slot in
 * Parth Realcon — so the Approve button appears on the bill for that account.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';

const API = process.env.DEMO_API_URL ?? 'http://localhost:3000';
const EMAIL = process.env.DEMO_EMAIL ?? 'admin@buildcore.dev';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'secret42';
const PROJECT_CODE = 'DEMO-BILL';
const PERIOD = { from: '2026-09-01', to: '2026-09-30' };

const prisma = new PrismaClient();
let token = '';

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 500)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

async function reset(companyId: string): Promise<void> {
  const project = await prisma.project.findFirst({
    where: { companyId, code: PROJECT_CODE },
    select: { id: true },
  });
  if (!project) return;
  const projectId = project.id;
  const packages = await prisma.billPackage.findMany({
    where: { projectId },
    select: { id: true },
  });
  const workOrders = await prisma.workOrder.findMany({
    where: { projectId },
    select: { id: true, partnerId: true },
  });
  const entityIds = [
    ...packages.map((p) => p.id),
    ...workOrders.map((w) => w.id),
  ];
  const dwrs = await prisma.dailyWorkReport.findMany({
    where: { projectId },
    select: { id: true },
  });
  entityIds.push(...dwrs.map((d) => d.id));

  await prisma.approvalDecision.deleteMany({
    where: { approvalInstance: { entityId: { in: entityIds } } },
  });
  await prisma.approvalInstance.deleteMany({
    where: { entityId: { in: entityIds } },
  });
  await prisma.rABillPayment.deleteMany({
    where: { raBill: { projectId } },
  });
  await prisma.signedCopy.deleteMany({
    where: { companyId, subjectId: { in: packages.map((p) => p.id) } },
  });
  await prisma.billPackageDebit.deleteMany({ where: { projectId } });
  await prisma.billPackageDebitNote.deleteMany({ where: { projectId } });
  await prisma.billPackage.deleteMany({ where: { projectId } });
  await prisma.rABill.deleteMany({ where: { projectId } });
  await prisma.clientBill.deleteMany({ where: { projectId } });
  await prisma.workOrder.deleteMany({ where: { projectId } });
  await prisma.project.delete({ where: { id: projectId } });
  console.log('Removed the previous demo project.');
}

async function main(): Promise<void> {
  const reset_ = process.argv.includes('--reset');

  const login = await call<{ accessToken: string }>('POST', '/auth/login', {
    identifier: EMAIL,
    password: PASSWORD,
  });
  token = login.accessToken;

  const admin = await prisma.user.findFirst({
    where: { email: EMAIL },
    select: { companyId: true },
  });
  const companyId = admin?.companyId;
  if (!companyId) throw new Error(`${EMAIL} belongs to no company.`);
  const q = `?companyId=${companyId}`;

  if (reset_) await reset(companyId);
  const existing = await prisma.project.findFirst({
    where: { companyId, code: PROJECT_CODE },
    select: { id: true },
  });
  if (existing) {
    console.log(
      `The demo already exists (project ${PROJECT_CODE}). Run with --reset to rebuild it.`,
    );
    return;
  }

  // ── The company, as the payment advice prints it ─────────────────────────
  await prisma.company.update({
    where: { id: companyId },
    data: {
      address:
        '28-A, Gandhi Nagar, Ward No-15, Teli Mohalla, Deoli, Dist. Tonk',
      city: null,
      state: 'Rajasthan',
      pinCode: '304804',
    },
  });
  // The mark alone, cropped from the company's letterhead — the advice draws it in a band beside
  // the name, where a whole letterhead page would shrink to a thumbnail.
  const logoPath = join(__dirname, 'seeds', 'parth-realcon-logo.jpeg');
  if (existsSync(logoPath)) {
    await call('PUT', `/settings/companies/${companyId}/logo`, {
      data: readFileSync(logoPath).toString('base64'),
    });
    console.log('Company logo set.');
  }

  // Bill approval chains — installed here too, in case `seed:chains` has not been run since
  // `client_bill` was added.
  for (const actionType of ['client_bill', 'ra_bill']) {
    const chain = await prisma.approvalChain.findFirst({
      where: { companyId, actionType },
      select: { id: true },
    });
    if (!chain) {
      throw new Error(
        `No "${actionType}" approval chain in this company. Run \`npm run seed:chains\` first.`,
      );
    }
  }

  // ── Client and project ───────────────────────────────────────────────────
  // Reused across `--reset`, so running it twice does not leave two of each behind.
  const CLIENT_NAME = 'Additional Chief Engineer, PWD Zone Ajmer';
  const client =
    (await prisma.client.findFirst({
      where: { companyId, name: CLIENT_NAME },
      select: { id: true },
    })) ??
    (await call<{ id: string }>('POST', `/projects/clients${q}`, {
      name: CLIENT_NAME,
      address: 'PWD Zone Office, Ajmer, Rajasthan',
      state: '08',
    }));
  const project = await prisma.project.create({
    data: {
      companyId,
      code: PROJECT_CODE,
      name: 'Widening of NH-52 (Deva Khera) to NH-148D (Dhor), MDR-419 — billing demo',
      clientId: client.id,
      contractValue: 88321358,
      startDate: new Date('2026-06-01'),
      clientRetentionFraction: 0.05,
      cgstApplicable: true,
    },
    select: { id: true },
  });
  const projectId = project.id;

  // ── BOQ ─────────────────────────────────────────────────────────────────
  const group = await call<{ id: string }>(
    'POST',
    `/projects/${projectId}/boq/groups${q}`,
    { boqNo: '1', name: 'Earthwork and pavement', scopeQty: '0' },
  );
  const boq = [
    {
      boqNo: '1.1',
      taskName: 'Earthwork in excavation',
      unit: 'Cum',
      scopeQty: '20000',
      rate: '185.00',
    },
    {
      boqNo: '1.2',
      taskName: 'Granular sub-base (GSB)',
      unit: 'Cum',
      scopeQty: '8000',
      rate: '1650.00',
    },
    {
      boqNo: '1.3',
      taskName: 'Wet mix macadam (WMM)',
      unit: 'Cum',
      scopeQty: '6000',
      rate: '2150.00',
    },
    {
      boqNo: '1.4',
      taskName: 'Dense bituminous macadam (DBM)',
      unit: 'Cum',
      scopeQty: '3000',
      rate: '8900.00',
    },
  ];
  const items: string[] = [];
  for (const line of boq) {
    const item = await call<{ id: string }>(
      'POST',
      `/projects/${projectId}/boq/items${q}`,
      { groupId: group.id, ...line },
    );
    items.push(item.id);
  }

  // ── Three approved daily work reports in September ───────────────────────
  const days: [string, string[]][] = [
    ['2026-09-08', ['850.000', '220.000', '0.000', '0.000']],
    ['2026-09-16', ['1200.000', '340.000', '180.000', '0.000']],
    ['2026-09-24', ['640.000', '210.000', '260.000', '95.000']],
  ];
  for (const [workDate, qtys] of days) {
    const dwr = await call<{ id: string }>(
      'POST',
      `/projects/${projectId}/dwr${q}`,
      {
        workDate,
        workerCount: 24,
        lines: qtys
          .map((servedQty, i) => ({
            paymentMode: 'day_basis',
            boqItemId: items[i],
            servedQty,
          }))
          .filter((line) => Number(line.servedQty) > 0),
      },
    );
    await call('POST', `/projects/dwr/${dwr.id}/submit${q}`);
    await call('POST', `/projects/dwr/${dwr.id}/approve${q}`);
  }
  console.log('Three daily work reports approved in September 2026.');

  // ── Subcontractor with bank details, and an approved award ───────────────
  const VENDOR_NAME = 'TIRUPATI ENTERPRISES, DEOLI';
  const vendorBody = {
    name: VENDOR_NAME,
    type: 'subcontractor',
    gstin: '08AAKFT1234M1Z5',
    pan: 'AAKFT1234M',
    address: 'Main Market, Deoli',
    city: 'Deoli',
    state: 'Rajasthan',
    pinCode: '304804',
    bankName: 'BOB',
    bankBranch: 'Deoli',
    bankAccountNumber: '09310400000526',
    bankAccountHolderName: 'TIRUPATI ENTERPRISES',
    ifscCode: 'BARB0DEOLIX',
  };
  const found = await prisma.vendor.findFirst({
    where: { companyId, name: VENDOR_NAME },
    select: { id: true },
  });
  const vendor = found
    ? await call<{ id: string; code: string }>(
        'PATCH',
        `/partners/vendors/${found.id}${q}`,
        vendorBody,
      )
    : await call<{ id: string; code: string }>(
        'POST',
        `/partners/vendors${q}`,
        vendorBody,
      );
  const order = await call<{ id: string }>(
    'POST',
    `/projects/work-orders${q}`,
    {
      projectId,
      partnerId: vendor.id,
      workDetail: 'Earthwork and GSB, Km 0/0 to 22/0',
      retentionPercent: 0.05,
    },
  );
  await call('PUT', `/projects/ra-bills/awards/${order.id}${q}`, {
    lines: [
      {
        description: 'Earthwork in excavation',
        unit: 'Cum',
        awardedQty: 20000,
        rate: 140,
        boqTaskItemId: items[0],
      },
      {
        description: 'Granular sub-base (GSB)',
        unit: 'Cum',
        awardedQty: 8000,
        rate: 1250,
        boqTaskItemId: items[1],
      },
    ],
  });
  await prisma.workOrder.update({
    where: { id: order.id },
    data: { status: 'active' },
  });
  console.log(
    `Subcontractor ${vendor.code} with bank details, on an approved award.`,
  );

  // ── Two draft bills for September ─────────────────────────────────────────
  const clientBill = await call<{ id: string; label: string }>(
    'POST',
    `/projects/${projectId}/bill-packages${q}`,
    { direction: 'to_client', periodFrom: PERIOD.from, periodTo: PERIOD.to },
  );
  const subBill = await call<{ id: string; label: string }>(
    'POST',
    `/projects/${projectId}/bill-packages${q}`,
    {
      direction: 'to_subcontractor',
      periodFrom: PERIOD.from,
      periodTo: PERIOD.to,
      workOrderId: order.id,
    },
  );
  await call(
    'PATCH',
    `/projects/bill-packages/${subBill.id}/deduction-lines${q}`,
    {
      lines: [
        {
          section: 'recovery',
          label: 'Recovery of diesel',
          amount: '25000.00',
        },
        {
          section: 'deduction',
          label: 'Camp / accommodation rent',
          amount: '8000.00',
        },
      ],
    },
  );

  const web = process.env.DEMO_WEB_URL ?? 'http://localhost:3001';
  console.log(`
Billing demo ready.

  Project:            ${web}/dashboard/projects/portfolio/${projectId}/bill-packages
  Client bill:        ${web}/dashboard/projects/portfolio/${projectId}/bill-packages/${clientBill.id}
  Subcontractor bill: ${web}/dashboard/projects/portfolio/${projectId}/bill-packages/${subBill.id}

Both are drafts. On each: Send for approval → Approve (inline, as ${EMAIL}) → Issue the bill →
Mark as shared → Certify. On the certified subcontractor bill, "Generate payment advice".`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
