import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Reversing an approval (022 FR-019).
 *
 * The reason is required by this DTO as well as by the column's docblock, and it is required for a
 * reason rather than for form: a reversal takes a quantity back out of a figure a bill may already
 * have been built from, and "why was December's measurement reduced in February" is the first
 * question anybody asks. An optional reason on a path that moves money is an empty field.
 */
export class ReverseDwrDto {
  @ApiProperty({
    example: 'double-counted CH 228+200 — measured by both crews',
    minLength: 10,
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(10, {
    message:
      'Say what was wrong. A reversal moves a quantity a bill may depend on, and a one-word reason answers nobody.',
  })
  @MaxLength(2000)
  reason!: string;
}

/**
 * Sending a submitted report back for correction (028).
 *
 * **The reason was already being typed and thrown away.** The reviewer answers "why is this going
 * back to the author?" in a prompt, the web has sent it since 025, and this route took no body at
 * all — so the one thing that tells the author what to fix never left the browser. A required
 * reason here is not new ceremony; it is the existing question finally being asked for.
 *
 * The floor matches `ReverseDwrDto` for the same reason: "no" is not a correction request. A
 * reversal moves a quantity and a return moves a report, but both land on somebody who has to act
 * on the sentence and nothing else.
 */
export class ReturnDwrDto {
  @ApiProperty({
    example: 'CH 21+300 measured 5.8 × 1.8 — the sheet says 5.8 × 1.6',
    minLength: 10,
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(10, {
    message:
      'Say what has to change. The author sees only this sentence, and a one-word reason sends ' +
      'them back to the report with nothing to go on.',
  })
  @MaxLength(2000)
  reason!: string;
}

/** Repairing a drifted counter (022 FR-039c, decision D3). */
export class RepairDoneQtyDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  boqItemIds!: string[];

  @ApiProperty({
    example: 'drift of 5.000 traced to the interrupted approval on 14 Jan',
    minLength: 10,
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(10, {
    message:
      'Say what drifted and why you believe the counter is the wrong figure. A repair overwrites it.',
  })
  @MaxLength(2000)
  reason!: string;
}

/**
 * Attaching a file to a report (022 FR-009, FR-009a).
 *
 * Base64 in the body rather than multipart, matching every other upload in this repository — see
 * `project-document-upload.controller.ts`. The content type is **not** accepted from the caller:
 * it is detected from the bytes, because a client's `Content-Type` is a guess made from a file
 * extension and a wrong one is what makes a browser offer a download instead of showing the
 * photograph somebody wants to look at.
 */
export class AddDwrAttachmentDto {
  @ApiProperty({ description: 'The file, base64-encoded.' })
  @IsString()
  @IsNotEmpty()
  data!: string;

  @ApiProperty({
    example: 'CH 228+200 RHS — before.jpg',
    description:
      'As the uploader’s own filesystem spells it. Stored and served back verbatim so the ' +
      'download arrives named, rather than as the opaque storage reference.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  fileName!: string;
}
