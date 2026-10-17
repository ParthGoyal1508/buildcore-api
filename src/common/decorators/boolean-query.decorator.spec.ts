import { plainToInstance } from 'class-transformer';
import { IsBoolean, IsOptional, validateSync } from 'class-validator';
import { BooleanQuery } from './boolean-query.decorator';
import { ListEmployeesQueryDto } from '../../hr/employees/dto/create-employee.dto';

class Probe {
  @IsOptional()
  @BooleanQuery()
  @IsBoolean()
  flag?: boolean;
}

const read = (flag: unknown) => plainToInstance(Probe, { flag }).flag;

describe('BooleanQuery', () => {
  it('reads the query-string spellings as the caller meant them', () => {
    expect(read('true')).toBe(true);
    expect(read('false')).toBe(false);
    expect(read(true)).toBe(true);
    expect(read(false)).toBe(false);
  });

  it('treats anything else as absent rather than guessing', () => {
    for (const junk of ['', 'yes', '0', '1', undefined]) {
      const probe = plainToInstance(Probe, { flag: junk });
      expect(probe.flag).toBeUndefined();
      expect(validateSync(probe)).toHaveLength(0);
    }
  });

  // The bug that prompted it (036 B12): `?isActive=false` used to come back as active staff.
  it('makes the employee list Inactive filter mean inactive', () => {
    const query = plainToInstance(ListEmployeesQueryDto, { isActive: 'false' });
    expect(query.isActive).toBe(false);
  });
});
