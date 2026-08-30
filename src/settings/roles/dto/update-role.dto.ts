import { PartialType } from '@nestjs/swagger';
import { CreateRoleDto } from './create-role.dto';

/** Both fields are optional on edit; the protected Super Admin role rejects either
 * one (FR-008), enforced in RolesService rather than here. */
export class UpdateRoleDto extends PartialType(CreateRoleDto) {}
