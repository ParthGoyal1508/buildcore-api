import { ApiProperty } from '@nestjs/swagger';

/** Generic message-only response shape, used for the 401/423/429 error bodies. */
export class MessageDto {
  @ApiProperty()
  message: string;
}
