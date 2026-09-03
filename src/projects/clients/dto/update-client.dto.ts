import { PartialType } from '@nestjs/swagger';

import { CreateClientDto } from './create-client.dto';

/**
 * Every create field, all optional (spec US1 — "edit any field").
 *
 * `PartialType` rather than a hand-written copy: the two would drift, and a
 * validation rule that applies on create but silently not on edit is worse than no
 * rule at all. 007's `UpdateVendorDto` follows the same pattern.
 */
export class UpdateClientDto extends PartialType(CreateClientDto) {}
