import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * FR-007c's permission separation (017 T123a).
 *
 * **A Project Manager may comply with the gate and may not move it.** Filing a project's documents
 * is `PROJECTS`; changing what every project must hold is `SETTINGS`. If both were the same
 * permission, the party being gated would hold the gate — which is the whole point of the
 * separation, and the assertion standing between them.
 *
 * Asserted from the route metadata rather than over HTTP because what must be true is a property of
 * the declarations: the write routes on the requirements controller carry `SETTINGS`, and the upload
 * routes carry `PROJECTS`. An e2e could prove one caller is refused; this proves none was missed.
 *
 * This had no task until `/speckit-analyze` found the gap (finding C1), and it is US2 acceptance
 * scenario 8.
 */

const DIR = __dirname;

const read = (file: string) => readFileSync(join(DIR, file), 'utf8');

describe('FR-007c — configuring the required set is a SETTINGS decision', () => {
  const requirements = read('project-documents.controller.ts');
  const uploads = read('project-document-upload.controller.ts');

  it('finds both controllers', () => {
    // A guard reading a moved file passes everything below vacuously.
    expect(requirements).toContain('@Controller');
    expect(uploads).toContain('@Controller');
  });

  it('has no class-level permission on the requirements controller', () => {
    // Read and write are different authorities here, so a class-level permission would have to be
    // one or the other and would be wrong for the rest.
    const beforeClass = requirements.slice(
      0,
      requirements.indexOf('export class'),
    );
    expect(beforeClass).not.toMatch(/@RequirePermissions\(/);
  });

  it('guards the PUT with SETTINGS, not PROJECTS', () => {
    const put = requirements.slice(requirements.indexOf('@Put()'));
    const guard = put.slice(0, put.indexOf('@ApiOperation'));
    expect(guard).toContain('Permission.SETTINGS');
    expect(guard).not.toContain('Permission.PROJECTS');
  });

  it('guards defining a kind with SETTINGS too', () => {
    // Defining a kind is how a mandatory requirement becomes satisfiable, so it sits with the
    // requirement rather than with the upload.
    const post = requirements.slice(
      requirements.indexOf("@Post('kinds/:code')"),
    );
    const guard = post.slice(0, post.indexOf('@ApiOperation'));
    expect(guard).toContain('Permission.SETTINGS');
  });

  it('guards the upload and staging routes with PROJECTS, not SETTINGS', () => {
    // The other half. A Project Manager must be able to file the documents the gate demands
    // without being able to change what it demands.
    expect(uploads).toContain('@RequirePermissions(Permission.PROJECTS)');
    expect(uploads).not.toContain('Permission.SETTINGS');
  });

  it('uses SETTINGS, not COMPANY_SETTINGS', () => {
    // Corrected in the spec on 2026-09-16 and worth pinning: `COMPANY_SETTINGS` would refuse the
    // people who are supposed to hold this, and the two names are one word apart.
    expect(requirements).not.toContain('Permission.COMPANY_SETTINGS');
  });
});
