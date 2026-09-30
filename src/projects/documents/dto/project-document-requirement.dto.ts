import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  MinLength,
  ValidateNested,
} from 'class-validator';

/** One required kind in the configured set (017 FR-007). */
export class ProjectDocumentRequirementDto {
  @ApiProperty({
    description:
      'The `DocumentType` a project must hold. Validated against the company’s own ' +
      'types by the service — a requirement naming a type that does not exist is a ' +
      'kind no project could ever satisfy.',
  })
  @IsString()
  @MinLength(1)
  documentTypeId: string;

  @ApiPropertyOptional({
    default: true,
    description:
      'A **mandatory** kind refuses project creation until a document is attached (FR-009). ' +
      'An **advisory** kind is reported outstanding and blocks nothing.\n\n' +
      'Named by consequence rather than as "required" and "optional": optional describes a ' +
      'kind by what it is not, and hides that the two now differ in effect rather than only ' +
      'in emphasis.\n\n' +
      'Both are reported, in separate figures — the mandatory counts are what the portfolio ' +
      'list renders, and advisory kinds are counted beside them rather than inside them ' +
      '(FR-007b). This used to say optional kinds count toward nothing; since the advisory ' +
      'split they count toward the advisory figures.',
  })
  @IsOptional()
  @IsBoolean()
  isMandatory?: boolean;
}

/**
 * The whole required set, replaced in one call (017 FR-007).
 *
 * A PUT that replaces rather than a POST that appends: the required set is a set, and
 * "remove LOI from the requirements" has no other honest expression. A DTO class even
 * for this one field is mandatory under Principle II.
 */
export class SetProjectDocumentRequirementsDto {
  @ApiProperty({
    type: [ProjectDocumentRequirementDto],
    description: 'The complete set. An empty array clears it.',
  })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ProjectDocumentRequirementDto)
  requirements: ProjectDocumentRequirementDto[];
}
