import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CheckListAnswer } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

import { CHECK_LIST_KEYS } from '../check-list';

export class CheckListAnswerDto {
  @ApiProperty({
    enum: CHECK_LIST_KEYS as string[],
    description:
      'Which of the six fixed questions. Validated against the list rather than accepted freely: ' +
      'the questions are the client’s format, so an unknown key is a caller inventing a question.',
  })
  @IsString()
  @IsIn(CHECK_LIST_KEYS as string[])
  questionKey: string;

  @ApiPropertyOptional({
    enum: CheckListAnswer,
    description:
      '`yes`, `no`, `not_required` — or **omitted**, which leaves the question unanswered. ' +
      'Unanswered is not an answer of no (FR-042): "we checked and it is not attached" and ' +
      '"nobody has looked" call for different actions from whoever is holding the bill.',
  })
  @IsOptional()
  @IsEnum(CheckListAnswer)
  answer?: CheckListAnswer;
}

export class SetCheckListDto {
  @ApiProperty({ type: [CheckListAnswerDto] })
  @IsArray()
  // Six questions exist, so a body carrying more than six answers is a mistake worth refusing
  // rather than silently truncating.
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => CheckListAnswerDto)
  answers: CheckListAnswerDto[];
}
