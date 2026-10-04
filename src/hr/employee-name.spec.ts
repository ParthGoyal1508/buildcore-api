import {
  employeeNameOf,
  withEmployeeNames,
  type NameableEmployee,
} from './employee-name';

const employee = (over: Partial<NameableEmployee> = {}): NameableEmployee => ({
  id: 'emp-1',
  employeeCode: 'BCD-0002',
  firstName: 'Asha',
  lastName: 'Patel',
  ...over,
});

describe('employeeNameOf', () => {
  it('joins the two name parts', () => {
    expect(employeeNameOf(employee())).toBe('Asha Patel');
  });

  it('accepts a first name alone', () => {
    expect(employeeNameOf(employee({ lastName: null }))).toBe('Asha');
  });

  it('accepts a last name alone', () => {
    expect(employeeNameOf(employee({ firstName: null }))).toBe('Patel');
  });

  /**
   * Null, not the code.
   *
   * The code travels in its own field, so a caller handed null here can render the
   * code and still be telling the truth. Returning the code from this function would
   * make "called BCD-0002" and "has no name on record" the same answer.
   */
  it('returns null when the record carries no name at all', () => {
    expect(employeeNameOf(employee({ firstName: null, lastName: null }))).toBe(
      null,
    );
  });

  it('treats whitespace as no name', () => {
    expect(employeeNameOf(employee({ firstName: '  ', lastName: null }))).toBe(
      null,
    );
  });
});

describe('withEmployeeNames', () => {
  const rows = [
    { id: 'leave-1', employeeId: 'emp-1' },
    { id: 'leave-2', employeeId: 'emp-2' },
  ];

  it('names each row from the roster', () => {
    const named = withEmployeeNames(rows, [
      employee(),
      employee({ id: 'emp-2', employeeCode: 'BCD-0003', firstName: 'Ravi' }),
    ]);

    expect(named).toEqual([
      {
        id: 'leave-1',
        employeeId: 'emp-1',
        employeeCode: 'BCD-0002',
        employeeName: 'Asha Patel',
      },
      {
        id: 'leave-2',
        employeeId: 'emp-2',
        employeeCode: 'BCD-0003',
        employeeName: 'Ravi Patel',
      },
    ]);
  });

  /**
   * The bug this whole helper exists for.
   *
   * The browser resolved names by fetching the first hundred employees and joining;
   * an id missing from that roster fell back to **the id itself**, which rendered a
   * cuid in a column headed "Employee" and looked like data rather than like a
   * failure. Nothing here may ever emit `employeeId` as a name.
   */
  it('never falls back to the id for an employee it cannot see', () => {
    const named = withEmployeeNames(rows, [employee()]);

    expect(named[1]).toEqual({
      id: 'leave-2',
      employeeId: 'emp-2',
      employeeCode: null,
      employeeName: null,
    });
    expect(JSON.stringify(named)).not.toContain('"employeeName":"emp-2"');
  });

  it('distinguishes an unknown employee from one with no name on record', () => {
    const named = withEmployeeNames(rows, [
      employee(),
      employee({
        id: 'emp-2',
        employeeCode: 'BCD-0003',
        firstName: null,
        lastName: null,
      }),
    ]);

    // Known, unnamed: the code is there to render.
    expect(named[1].employeeCode).toBe('BCD-0003');
    expect(named[1].employeeName).toBe(null);
  });

  it('keeps every field the row already carried', () => {
    const [named] = withEmployeeNames(
      [{ employeeId: 'emp-1', status: 'pending', dayCount: 2 }],
      [employee()],
    );

    expect(named.status).toBe('pending');
    expect(named.dayCount).toBe(2);
  });

  it('handles an empty roster without throwing', () => {
    expect(withEmployeeNames(rows, [])).toHaveLength(2);
  });
});
