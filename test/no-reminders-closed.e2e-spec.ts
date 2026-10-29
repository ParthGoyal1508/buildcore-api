import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';
import { hash } from 'argon2';
import { Permission } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/configure-app';
import { withRlsContext } from '../src/common/prisma/rls-context';
import { RemindersService } from '../src/dashboard/reminders/reminders.service';

/**
 * 049: no reminders for scrapped or sold machines, scrapped assets, or completed projects — on the
 * Reminders list, in the bell, and in the nightly ledger — and they come back when the record is
 * reactivated. Fixtures prefixed `E2E049`, all inside one throwaway company removed in `afterAll`.
 */
const PREFIX = 'E2E049';
const unique = (s: string) => `${PREFIX}${s}${Date.now() % 100000}`;
const DAY = 24 * 60 * 60 * 1000;
const inDays = (n: number) =>
  new Date(new Date(Date.now() + n * DAY).toISOString().slice(0, 10));

describe('049 no reminders for closed records (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => request.SuperTest<request.Test>;
  let companyId: string;
  let token: string;
  let machineId: string;
  let paperId: string;
  let machineDocId: string;
  let scheduleId: string;
  let projectId: string;
  let projectDocId: string;
  let assetId: string;
  let userId: string;
  let roleId: string;

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const sys = (fn: (tx: any) => Promise<any>) =>
    withRlsContext(prisma, { isSuperAdmin: true }, fn);
  const auth = () => ({ Authorization: `Bearer ${token}` });

  const reminderEntityIds = async (): Promise<string[]> => {
    const res = await http()
      .get('/dashboard/reminders')
      .set(auth())
      .expect(200);
    return res.body.reminders.map((r: { entityId: string }) => r.entityId);
  };
  const bell = async (): Promise<string> => {
    const res = await http().get('/notifications').set(auth()).expect(200);
    return JSON.stringify(res.body);
  };
  const openLedger = (entityId: string) =>
    sys((tx) =>
      tx.reminderNotification.count({
        where: { companyId, entityId, closedAt: null },
      }),
    );

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    http = () => request(app.getHttpServer());

    companyId = (
      await sys((tx) =>
        tx.company.create({
          data: {
            name: 'Dummy Reminders Test Firm',
            shortCode: unique('RM').slice(0, 10),
            payrollLockDay: 7,
            pfEmployerRate: 12,
            esicEmployerRate: 3.25,
            gratuityRate: 4.81,
            bonusRate: 8.33,
          },
        }),
      )
    ).id;
    const siteId = (
      await sys((tx) =>
        tx.site.create({
          data: {
            companyId,
            name: unique('Dummy Site'),
            latitude: 19.076,
            longitude: 72.8777,
            geofenceRadiusMeters: 200,
            weeklyOffDay: 0,
          },
        }),
      )
    ).id;

    // A machine with a registration paper lapsing in 5 days and a service already overdue.
    const categoryId = (
      await sys((tx) =>
        tx.equipmentCategory.create({
          data: { companyId, name: unique('Excavators'), meterType: 'hours' },
        }),
      )
    ).id;
    const machine = await sys((tx) =>
      tx.equipment.create({
        data: {
          companyId,
          code: unique('EX').slice(0, 16),
          name: 'Dummy Excavator',
          categoryId,
          ownership: 'owned',
          powerSource: 'diesel',
          meterType: 'hours',
          currentReading: 600,
          registrationNo: unique('MH01'),
        },
      }),
    );
    machineId = machine.id;
    paperId = (
      await sys((tx) =>
        tx.equipmentRegistrationItem.create({
          data: {
            companyId,
            equipmentId: machineId,
            kind: 'insurance',
            status: 'held',
            expiresAt: inDays(5),
          },
        }),
      )
    ).id;
    scheduleId = (
      await sys((tx) =>
        tx.serviceSchedule.create({
          data: {
            companyId,
            equipmentId: machineId,
            serviceType: 'Engine oil',
            intervalHours: 250,
            lastDoneReading: 250,
            nextDueReading: 500,
          },
        }),
      )
    ).id;

    // A project with an insurance certificate lapsing in 5 days.
    const branchId = (
      await sys((tx) =>
        tx.companyBranch.create({
          data: { companyId, label: 'Head office', isHeadOffice: true },
        }),
      )
    ).id;
    const clientId = (
      await sys((tx) =>
        tx.client.create({
          data: { companyId, name: unique('Dummy Client') },
        }),
      )
    ).id;
    projectId = (
      await sys((tx) =>
        tx.project.create({
          data: {
            companyId,
            clientId,
            branchId,
            code: unique('PRJ'),
            name: 'Dummy Road Project',
            contractValue: 100000,
            startDate: new Date('2026-04-01'),
            status: 'ongoing',
          },
        }),
      )
    ).id;

    // An asset with an insurance paper lapsing in 5 days and an inspection overdue.
    const assetCategoryId = (
      await sys((tx) =>
        tx.assetCategory.create({
          data: {
            companyId,
            name: unique('Generators'),
            trackingMode: 'serialised',
          },
        }),
      )
    ).id;
    const assetDocTypeId = (
      await sys((tx) =>
        tx.assetDocType.create({
          data: { companyId, name: unique('Insurance'), alertDays: 30 },
        }),
      )
    ).id;
    assetId = (
      await sys((tx) =>
        tx.asset.create({
          data: {
            companyId,
            assetCode: unique('AST'),
            name: 'Dummy Generator',
            categoryId: assetCategoryId,
            trackingMode: 'serialised',
            capitalisationDate: new Date('2026-01-01'),
            currentSiteId: siteId,
            status: 'idle',
            nextInspectionDue: inDays(-3),
          },
        }),
      )
    ).id;

    const password = await hash('secret42');
    const user = await sys((tx) =>
      tx.user.create({
        data: {
          email: `${unique('rem')}@example.test`,
          username: unique('rem'),
          password,
          firstname: 'Reminder',
          lastname: 'Tester',
          companyId,
        },
      }),
    );
    userId = user.id;
    const uploadedByUserId = userId;
    projectDocId = (
      await sys((tx) =>
        tx.projectDocument.create({
          data: {
            companyId,
            projectId,
            documentType: 'Contractor all-risk insurance',
            fileRef: 'dummy/ref',
            expiresAt: inDays(5),
            uploadedByUserId,
          },
        }),
      )
    ).id;
    await sys((tx) =>
      tx.assetDocument.create({
        data: {
          companyId,
          assetId,
          docTypeId: assetDocTypeId,
          fileRef: 'dummy/ref',
          expiryDate: inDays(5),
          uploadedByUserId,
        },
      }),
    );
    // A machine document whose type is not one of the register's papers, so the document rule
    // (not the registration rule) is the one that reminds about it.
    const machineDocTypeId = (
      await sys((tx) =>
        tx.equipmentDocType.create({
          data: { companyId, name: unique('Hypothecation'), alertDays: 30 },
        }),
      )
    ).id;
    machineDocId = (
      await sys((tx) =>
        tx.equipmentDocument.create({
          data: {
            companyId,
            equipmentId: machineId,
            docTypeId: machineDocTypeId,
            fileRef: 'dummy/ref',
            expiresAt: inDays(5),
            uploadedByUserId,
          },
        }),
      )
    ).id;
    const role = await sys((tx) =>
      tx.role.create({
        data: {
          name: unique('RemRole'),
          permissions: [
            Permission.DASHBOARD,
            Permission.MACHINERY,
            Permission.PROJECTS,
            Permission.ASSETS,
          ],
        },
      }),
    );
    roleId = role.id;
    await sys((tx) => tx.userRole.create({ data: { userId, roleId } }));
    const login = await http()
      .post('/auth/login')
      .send({ identifier: user.email, password: 'secret42', rememberMe: false })
      .expect(201);
    token = login.body.accessToken;
  });

  afterAll(async () => {
    if (prisma) {
      await sys(async (tx) => {
        await tx.notification.deleteMany({ where: { userId } });
        await tx.reminderNotification.deleteMany({ where: { companyId } });
        await tx.userRole.deleteMany({ where: { userId } });
        await tx.role.deleteMany({ where: { id: roleId } });
        await tx.refreshToken.deleteMany({ where: { accountId: userId } });
        await tx.auditLogEntry.updateMany({
          where: { accountId: userId },
          data: { accountId: null },
        });
      });
      await sys(async (tx) => {
        await tx.projectDocument.deleteMany({ where: { companyId } });
        await tx.project.deleteMany({ where: { companyId } });
        await tx.client.deleteMany({ where: { companyId } });
        await tx.assetDocument.deleteMany({ where: { companyId } });
        await tx.asset.deleteMany({ where: { companyId } });
        await tx.assetDocType.deleteMany({ where: { companyId } });
        await tx.assetCategory.deleteMany({ where: { companyId } });
        await tx.serviceSchedule.deleteMany({ where: { companyId } });
        await tx.equipmentDocument.deleteMany({ where: { companyId } });
        await tx.equipmentDocType.deleteMany({ where: { companyId } });
        await tx.equipmentRegistrationItem.deleteMany({ where: { companyId } });
        await tx.equipment.deleteMany({ where: { companyId } });
        await tx.equipmentCategory.deleteMany({ where: { companyId } });
        await tx.site.deleteMany({ where: { companyId } });
      });
      await sys((tx) => tx.user.deleteMany({ where: { id: userId } }));
      await sys((tx) => tx.company.deleteMany({ where: { id: companyId } }));
    }
    if (app) await app.close();
  });

  it('reminds about everything while it is live', async () => {
    const ids = await reminderEntityIds();
    expect(ids).toEqual(
      expect.arrayContaining([paperId, machineDocId, scheduleId, projectDocId]),
    );
    expect(await bell()).toContain('Contractor all-risk insurance expires');

    await app.get(RemindersService).evaluateAndEmit();
    expect(await openLedger(paperId)).toBe(1);
    expect(await openLedger(projectDocId)).toBe(1);

    const asset = await http()
      .get(`/assets/${assetId}`)
      .set(auth())
      .expect(200);
    expect(asset.body.expiryAlert).toBe(true);
    expect(asset.body.inspectionDue).toBe(true);
    expect(asset.body.documents[0].expiring).toBe(true);

    const machine = await http()
      .get(`/plant/equipment/${machineId}`)
      .set(auth())
      .expect(200);
    expect(machine.body.expiryAlert).toBe(true);
  });

  it.each(['scrapped', 'sold'])(
    'a %s machine raises none, and reversal brings them back',
    async (status) => {
      await sys((tx) =>
        tx.equipment.update({ where: { id: machineId }, data: { status } }),
      );
      const ids = await reminderEntityIds();
      expect(ids).not.toContain(paperId);
      expect(ids).not.toContain(machineDocId);
      expect(ids).not.toContain(scheduleId);
      expect(await bell()).not.toContain('Insurance paper');

      // The ledger row already raised is closed by the next sweep.
      await app.get(RemindersService).evaluateAndEmit();
      expect(await openLedger(paperId)).toBe(0);

      const machine = await http()
        .get(`/plant/equipment/${machineId}`)
        .set(auth())
        .expect(200);
      expect(machine.body.expiryAlert).toBe(false);
      expect(machine.body.alertDocumentTypes).toEqual([]);
      expect(machine.body.documents[0].expiring).toBe(false);

      // Disposal reversed: the machine goes back to its previous status.
      await sys((tx) =>
        tx.equipment.update({
          where: { id: machineId },
          data: { status: 'active' },
        }),
      );
      expect(await reminderEntityIds()).toEqual(
        expect.arrayContaining([paperId, machineDocId, scheduleId]),
      );
      await app.get(RemindersService).evaluateAndEmit();
      expect(await openLedger(paperId)).toBe(1);
    },
  );

  it('a completed project raises none; on hold still does; reopened does again', async () => {
    await sys((tx) =>
      tx.project.update({
        where: { id: projectId },
        data: { status: 'completed' },
      }),
    );
    expect(await reminderEntityIds()).not.toContain(projectDocId);
    expect(await bell()).not.toContain('Contractor all-risk insurance expires');
    await app.get(RemindersService).evaluateAndEmit();
    expect(await openLedger(projectDocId)).toBe(0);

    await sys((tx) =>
      tx.project.update({
        where: { id: projectId },
        data: { status: 'on_hold' },
      }),
    );
    expect(await reminderEntityIds()).toContain(projectDocId);

    await sys((tx) =>
      tx.project.update({
        where: { id: projectId },
        data: { status: 'ongoing' },
      }),
    );
    expect(await reminderEntityIds()).toContain(projectDocId);
    expect(await bell()).toContain('Contractor all-risk insurance expires');
  });

  it('a scrapped asset raises no alert and leaves the inspection-due list', async () => {
    const before = await http()
      .get('/assets?inspectionDue=true')
      .set(auth())
      .expect(200);
    expect(before.body.items.map((a: { id: string }) => a.id)).toContain(
      assetId,
    );

    await sys((tx) =>
      tx.asset.update({
        where: { id: assetId },
        data: { status: 'scrapped', disposalDate: new Date() },
      }),
    );
    const asset = await http()
      .get(`/assets/${assetId}`)
      .set(auth())
      .expect(200);
    expect(asset.body.expiryAlert).toBe(false);
    expect(asset.body.inspectionDue).toBe(false);
    expect(asset.body.documents[0].expiring).toBe(false);

    for (const query of [
      'inspectionDue=true',
      'inspectionDue=true&status=scrapped',
    ]) {
      const after = await http()
        .get(`/assets?${query}`)
        .set(auth())
        .expect(200);
      expect(after.body.items.map((a: { id: string }) => a.id)).not.toContain(
        assetId,
      );
    }
  });
});
