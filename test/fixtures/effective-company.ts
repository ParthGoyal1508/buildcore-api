/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The company the API will actually write to for a given account — which is not necessarily
 * the one a test asks for.
 *
 * ## The drift this exists for
 *
 * Five end-to-end suites opened with the same four lines: log in as `admin@buildcore.dev`,
 * take the oldest company, and pass it as `?companyId=` on every request. That was correct
 * until feature 019.
 *
 * 019 made company selection a first-class thing. `resolveCompanyId` honours a requested
 * company **only** for a caller who is genuinely cross-company; a cross-company caller who
 * has *selected* a company arrives with `isSuperAdmin` false and the selection on the request
 * context, and the selection then wins and the query parameter is ignored. That is deliberate
 * — it is what makes the company switcher mean anything.
 *
 * `admin@buildcore.dev` has a selection in the development database: one row in
 * `UserCompanySelection`, pointing at the second company. So five suites were asking for the
 * first company, writing to the second, and asserting against the first. **Mostly they got
 * away with it**, because a fixture created through the API and read back through the API is
 * consistent with itself — what broke was any assertion that named the company directly, and
 * any fixture that crossed from a directly-inserted row to an API call. One assertion in the
 * projects suite failed on it; the rest failed later and for reasons that looked unrelated.
 *
 * That single row is why. It is worth knowing that one record in a shared development
 * database silently repoints five test suites, and that nothing in the suites said so.
 *
 * ## Read, never cleared
 *
 * Deleting the selection would make these suites deterministic and would change what every
 * other suite sees — it is shared state. Reading it keeps each suite honest without reaching
 * into anybody else's fixtures.
 */

/**
 * Returns the company id the API will resolve for `email`, falling back to the oldest company
 * when that account has made no selection.
 *
 * `sys` is the suite's own super-admin Prisma proxy, passed in rather than built here: each
 * suite already has one wired to its app's client, and a second client would be another pool
 * on a server whose connection limit is the reason the harness was broken in the first place.
 */
export async function effectiveCompanyIdFor(
  sys: any,
  email = 'admin@buildcore.dev',
): Promise<string> {
  const user = await sys.user.findFirst({
    where: { email },
    select: { id: true },
  });

  const selection = user
    ? await sys.userCompanySelection.findFirst({
        where: { userId: user.id },
        select: { companyId: true },
      })
    : null;

  if (selection?.companyId) return selection.companyId;

  const oldest = await sys.company.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!oldest) {
    throw new Error(
      'No company exists in this database. Run `npm run seed:demo` before the e2e suites.',
    );
  }
  return oldest.id;
}
