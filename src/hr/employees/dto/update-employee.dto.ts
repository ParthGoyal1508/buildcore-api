import { PartialType, OmitType } from '@nestjs/swagger';

import { CreateEmployeeDto } from './create-employee.dto';

/**
 * Every field on the employee form is individually editable after creation.
 *
 * `siteId`/`shiftId` stay editable (a posting or shift change is routine), but the
 * employee's company is deliberately absent from both DTOs: moving an employee
 * between companies is US8's transfer flow, which reallocates the employee code and
 * writes an EmployeeTransfer audit row. Allowing it as a field edit here would let
 * that happen silently, with no record and no code reallocation.
 */
export class UpdateEmployeeDto extends PartialType(CreateEmployeeDto) {}

/**
 * Conditional statutory validation depends on seeing `pfApplicable`/`esicApplicable`
 * alongside the numbers. On a PATCH the flags may be absent, so this variant keeps
 * the same shape while the service re-validates the merged record — see
 * `EmployeesService.assertStatutoryConsistent`.
 */
export class UpdateEmployeeBodyDto extends OmitType(UpdateEmployeeDto, [] as const) {}
