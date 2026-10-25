import { Module } from '@nestjs/common';
import { BiometricsService } from './biometrics.service';
import { OnnxBiometricsService } from './onnx-biometrics.service';

/**
 * The one place the face matcher is provided.
 *
 * Until 2026-10-26 `hr` and `labour` each listed `{ provide: BiometricsService, useClass: … }`
 * themselves, and Nest builds a provider once per module that declares it — so every process held
 * two matchers and loaded the models twice. Importing this module instead gives both the same
 * instance. The e2e suites' `overrideProvider(BiometricsService)` still reaches it, since an
 * override is keyed on the token, not on the module that declares it.
 */
@Module({
  providers: [{ provide: BiometricsService, useClass: OnnxBiometricsService }],
  exports: [BiometricsService],
})
export class BiometricsModule {}
