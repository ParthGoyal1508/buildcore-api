/**
 * The one way this product turns an employee row into something a person reads.
 *
 * The sibling of `common/actor-name.ts`, and here for the same reason: a list whose
 * rows carry only `employeeId` renders a cuid in a column headed "Employee" unless
 * somebody resolves it, and every screen that resolved it for itself resolved it
 * slightly differently.
 *
 * **Resolved on the server, never in the browser.** The leave queue did it in the
 * browser by fetching the first hundred employees and joining client-side, which
 * fails in three ways a reader cannot distinguish: the roster request fails and every
 * row shows a cuid; the company has more than a hundred employees and the hundred-and-first
 * shows a cuid; the application belongs to an employee outside the caller's current
 * company scope and shows a cuid. All three looked identical, and all three looked
 * like data rather than like a failure. Resolving here removes the first two outright
 * and makes the third say so.
 */
export interface NameableEmployee {
  id: string;
  employeeCode: string;
  firstName: string | null;
  lastName: string | null;
}

/** The columns `employeeNameOf` needs, as a Prisma `select`. */
export const EMPLOYEE_NAME_SELECT = {
  id: true,
  employeeCode: true,
  firstName: true,
  lastName: true,
} as const;

/**
 * The employee's name, or `null` when the record carries none.
 *
 * Null rather than the code, so a caller can tell "this person has no name on record"
 * from "this person is called BCD-0002". The code travels in its own field and is
 * never absent, so a screen always has something to render.
 */
export function employeeNameOf(employee: NameableEmployee): string | null {
  const name = [employee.firstName, employee.lastName]
    .filter(Boolean)
    .join(' ')
    .trim();
  return name || null;
}

/**
 * Joins rows carrying `employeeId` to the employees they belong to.
 *
 * Both fields are nullable on purpose. An employee the caller cannot see — RLS
 * confines the roster to their company, and the row may predate a transfer — resolves
 * to nulls rather than to the id, because a client told "no name and no code" renders
 * an honest marker, whereas a client handed an id renders it.
 */
export function withEmployeeNames<T extends { employeeId: string }>(
  rows: T[],
  employees: NameableEmployee[],
): (T & { employeeCode: string | null; employeeName: string | null })[] {
  const byId = new Map(employees.map((employee) => [employee.id, employee]));
  return rows.map((row) => {
    const employee = byId.get(row.employeeId);
    return {
      ...row,
      employeeCode: employee?.employeeCode ?? null,
      employeeName: employee ? employeeNameOf(employee) : null,
    };
  });
}
