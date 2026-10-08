import * as request from 'supertest';

/**
 * Creates a project through the API, satisfying feature 017's mandatory-document rule by
 * doing what a project manager does — staging the documents first.
 *
 * ## Why seven suites needed this
 *
 * FR-009 refuses to create a project while a mandatory document kind has no document
 * attached: the client's "Project Managers cannot create a project without them". The seeded
 * companies mark four kinds mandatory — letter of intent, work order, insurance and bill of
 * quantities.
 *
 * Seven end-to-end suites predate that rule and create a project as a *fixture*, on the way
 * to testing something else: assets, inventory, partners, plant, payroll approval, settings,
 * and the projects module itself. All seven broke, and every one of them reported the same
 * unhelpful line — `expected 201 "Created", got 400 "Bad Request"` — because `.expect(201)`
 * throws away the body that says why.
 *
 * Two ways to fix it, and the choice matters. Insert the project row directly with Prisma and
 * the rule is bypassed: the fixture is faster and none of those seven suites could ever notice
 * the rule breaking again. Or stage the documents and create the project properly. This is the
 * second. (`client-bills.e2e-spec.ts` does bypass it, deliberately and with its reason stated:
 * it tests billing arithmetic, and routing its fixture through four uploads would let a
 * billing test fail for a document reason.)
 *
 * ## It asks the API which documents are missing rather than working it out
 *
 * The first version of this helper read `ProjectDocumentRequirement` for the company id the
 * suite holds, staged one document per row, and failed with `PROJECT_DOCUMENT_TYPE_UNKNOWN`.
 * The reason is feature 019: `resolveCompanyId` **ignores the requested company** for anyone
 * who is not a super admin and pins the write to the caller's own. So the suite's `companyId`
 * and the company the API actually wrote to were different, and the helper had staged
 * documents belonging to the wrong one.
 *
 * So it does not compute the answer. It attempts the creation, and if the refusal comes back
 * it stages exactly the kinds the refusal named — `missingTypeIds`, which feature 017 added
 * for precisely this reason — and tries once more. The ids come from the API's own resolved
 * company, so there is nothing left to get wrong. One retry, never a loop: a second refusal
 * is a real failure and is returned to the caller unchanged.
 */

/** The smallest thing that is honestly a PDF: enough for a store that records bytes. */
const TINY_PDF = Buffer.from('%PDF-1.4\n%%EOF\n').toString('base64');

const MANDATORY_MISSING = 'PROJECT_DOCUMENTS_MANDATORY_MISSING';

export interface CreateProjectOptions {
  /** The suite's supertest factory, already pointed at its app. */
  http: () => request.SuperTest<request.Test>;
  /** The suite's auth header, as a ready object. */
  headers: Record<string, string>;
  /** The project body, exactly as the suite would have sent it. */
  body: Record<string, unknown>;
  /**
   * The company query parameter the suite passes, if it passes one. Sent on both the staging
   * calls and the creation so the two cannot resolve to different companies.
   */
  companyId?: string;
}

/**
 * Posts the project, staging mandatory documents if the first attempt is refused for them.
 *
 * Returns the supertest response, so the caller asserts on it exactly as before — this helper
 * deliberately asserts nothing about the project. Whether the mandatory rule *works* is
 * `project-documents.e2e-spec.ts`'s subject; if this helper asserted it too, one defect would
 * fail eight suites and the cause would be hidden in whichever failed first.
 */
export async function createProjectWithMandatoryDocuments(
  opts: CreateProjectOptions,
): Promise<request.Response> {
  const query = opts.companyId ? `?companyId=${opts.companyId}` : '';
  const post = (body: Record<string, unknown>) =>
    opts.http().post(`/projects${query}`).set(opts.headers).send(body);

  const first = await post(opts.body);
  if (first.status !== 400 || first.body?.code !== MANDATORY_MISSING) {
    return first;
  }

  const missing: string[] = first.body.missingTypeIds ?? [];
  if (missing.length === 0) {
    // The refusal fired without naming a type id. Returned rather than papered over: it
    // would mean FR-009's machine-readable half had stopped being populated, which is worth
    // failing on rather than silently retrying with nothing staged.
    return first;
  }

  const stagedDocumentIds: string[] = [];
  for (const documentTypeId of missing) {
    const staged = await opts
      .http()
      .post(`/projects/document-uploads${query}`)
      .set(opts.headers)
      .send({
        documentTypeId,
        documentType: 'E2E mandatory fixture',
        data: TINY_PDF,
        contentType: 'application/pdf',
        // Sent for every kind, not only the ones that expire (2026-10-09). The server requires
        // it when `DocumentType.hasExpiry` and ignores it otherwise, and this helper does not
        // know which kinds a given suite's company declared — asking it to find out would make
        // a fixture depend on the vocabulary it is working around.
        //
        // Far future on purpose: a lapsed document no longer answers its required kind, so a
        // date inside any suite's lifetime would make these projects start failing readiness
        // the moment the clock passed it.
        expiresAt: '2099-12-31',
      });

    // Thrown with the body in the message, because a failure here is a failure of the
    // *fixture*. A suite about asset allocation reporting "expected 201, got 400" on a
    // document upload sends the reader to the wrong module entirely — which is exactly how
    // all seven suites presented before this file existed.
    if (staged.status !== 201) {
      throw new Error(
        `Staging a mandatory project document failed with ${staged.status}: ` +
          `${JSON.stringify(
            staged.body,
          )}. This is fixture setup, not the subject of the ` +
          `test — see test/fixtures/mandatory-project-documents.ts.`,
      );
    }
    stagedDocumentIds.push(staged.body.stagedDocumentId);
  }

  return post({ ...opts.body, stagedDocumentIds });
}
