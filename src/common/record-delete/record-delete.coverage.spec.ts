import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Every `DELETE` route, and which side of the Super Admin rule it is on (2026-11-07).
 *
 * `RecordDeleteInterceptor` refuses a delete to everyone but a Super Admin unless the route is
 * marked `@EditorMayDelete()` or its controller `@OwnRecords()`. The marked list is written out
 * here so that marking another route is a decision somebody makes in review, not a line that
 * slips in with a feature.
 */
const EDITOR_MAY_DELETE = [
  'auth/face-unlock.controller.ts @Delete()',
  "partners/contractors/contractors.controller.ts @Delete('documents/:documentId')",
  "plant/equipment/equipment.controller.ts @Delete(':id/documents/:docId')",
  "plant/equipment/equipment.controller.ts @Delete(':id/photos/:photoId')",
  "plant/maintenance/maintenance.controller.ts @Delete('parts/:movementId')",
  "projects/bank-guarantees/bank-guarantees.controller.ts @Delete('documents/:documentId')",
  "projects/billing/package/bill-package.controller.ts @Delete('projects/bill-packages/:packageId/non-boq-items/:itemId')",
  "projects/boq/boq.controller.ts @Delete('groups/:groupId')",
  "projects/boq/boq.controller.ts @Delete('items/:itemId')",
  "projects/documents/project-document-upload.controller.ts @Delete('projects/:projectId/documents/:documentId')",
  "projects/dwr/dwr.controller.ts @Delete('projects/dwr/:dwrId/attachments/:attachmentId')",
  "settings/letter-kinds/letter-kinds.controller.ts @Delete(':id/fields/:token')",
];

const SRC = join(process.cwd(), 'src');

function controllerFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return controllerFiles(path);
    return name.endsWith('.controller.ts') ? [path] : [];
  });
}

interface DeleteRoute {
  route: string;
  marked: boolean;
  own: boolean;
}

const routes: DeleteRoute[] = controllerFiles(SRC).flatMap((file) => {
  const source = readFileSync(file, 'utf8');
  const own = /@OwnRecords\(\)\s*(?:@[\s\S]*?)?export class/.test(source);
  return [...source.matchAll(/@Delete\([^)]*\)/g)].map((match) => {
    // The decorators stacked on this method: everything since the previous method or comment.
    const before = source.slice(0, match.index);
    const start = Math.max(
      before.lastIndexOf(';\n'),
      before.lastIndexOf('*/'),
      before.lastIndexOf('}\n'),
    );
    const after = source.slice(
      match.index,
      source.indexOf('(', match.index + match[0].length),
    );
    return {
      route: `${relative(SRC, file)} ${match[0]}`,
      marked: (before.slice(start) + after).includes('@EditorMayDelete()'),
      own,
    };
  });
});

describe('Who may delete (2026-11-07)', () => {
  it('found the delete routes', () => {
    expect(routes.length).toBeGreaterThanOrEqual(50);
  });

  it('marks exactly the parts-of-an-edit routes', () => {
    const marked = routes
      .filter((r) => r.marked)
      .map((r) => r.route)
      .sort();
    expect(marked).toEqual([...EDITOR_MAY_DELETE].sort());
  });

  it("keeps the caller's own deletes on My Workspace controllers", () => {
    const own = routes
      .filter((r) => r.own)
      .map((r) => r.route)
      .sort();
    expect(own).toEqual([
      "hr/biometrics/face-enrolment.controller.ts @Delete('consent')",
      "hr/reimbursements/reimbursement.controller.ts @Delete(':id')",
    ]);
  });
});
