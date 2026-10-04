import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LetterFieldSource } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Declaring a field one letter kind's templates may use (017 FR-011b, FR-011c).
 *
 * `sourceType` and `sourcePath` together are the requirement: **a field that is only a label is a
 * placeholder that renders blank**, and a blank in a signed letter is indistinguishable from a
 * deliberate omission. `manual` is the honest exception — a term typed at issue time has no record
 * behind it — and the service refuses a `sourcePath` with it, matching the database's own CHECK.
 */
export class UpsertLetterKindFieldDto {
  @ApiProperty({
    description:
      'The `{{token}}` name, without braces. Letters, digits and underscores only, because that is ' +
      'what the template tokeniser matches — a token it cannot find is a field that silently never ' +
      'renders.',
    example: 'siteName',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  @Matches(/^[a-zA-Z0-9_]+$/, {
    message:
      'token may contain only letters, digits and underscores — the template tokeniser matches no others',
  })
  token: string;

  @ApiProperty({
    description:
      'What the template editor calls it. "Offered CTC", not `offeredCtc`.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  label: string;

  @ApiProperty({
    enum: LetterFieldSource,
    description:
      'Which record the value is read from. `manual` means it is typed at issue time and takes no path.',
  })
  @IsEnum(LetterFieldSource)
  sourceType: LetterFieldSource;

  @ApiPropertyOptional({
    description:
      'The dot path within the source record — `designation.name`, `basic`. Required for every ' +
      'source except `manual`, and refused with `manual`. A path naming regulated personal data ' +
      '(Aadhaar, PAN, a bank account) is refused outright: defining a kind does not grant a way ' +
      'past FR-024.',
    example: 'site.name',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  sourcePath?: string | null;

  @ApiPropertyOptional({
    description:
      'Whether issuing a letter with no value for this field is refused. An unresolvable optional ' +
      'field renders empty by design; an unresolvable required one is a letter nobody should sign.',
  })
  @IsOptional()
  @IsBoolean()
  isRequired?: boolean;
}
