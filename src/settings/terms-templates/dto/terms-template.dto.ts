import { ApiProperty } from '@nestjs/swagger';
import { TermsDocumentKind } from '@prisma/client';
import { IsEnum, IsString, MaxLength, MinLength } from 'class-validator';

/** The longest terms block the editor accepts. */
const MAX_TERMS_LENGTH = 20000;

export class PutTermsTemplateDto {
  @ApiProperty({
    enum: TermsDocumentKind,
    description: 'Which document these terms belong to.',
  })
  @IsEnum(TermsDocumentKind)
  documentKind: TermsDocumentKind;

  @ApiProperty({
    description:
      'The clauses, as plain text, newline-separated. No markup — what renders this ' +
      'is a PDF table cell and a textarea, and neither interprets any.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_TERMS_LENGTH)
  body: string;
}
