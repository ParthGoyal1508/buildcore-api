import { Module } from '@nestjs/common';

import { LettersModule } from '../letters/letters.module';
import { NocsController } from './nocs.controller';
import { NocsService } from './nocs.service';

/** Uploaded No Objection Certificates, for every record that can carry one (2026-10-15). */
@Module({
  imports: [LettersModule],
  controllers: [NocsController],
  providers: [NocsService],
})
export class NocsModule {}
