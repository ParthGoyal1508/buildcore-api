import { PartialType } from '@nestjs/swagger';
import { CreateCompanyDto } from './create-company.dto';

/** Every Company field is individually editable after creation (FR-002/FR-003);
 * `status` is how a company is deactivated, since companies are never hard-deleted
 * (FR-005, contracts/settings-api.md). */
export class UpdateCompanyDto extends PartialType(CreateCompanyDto) {}
