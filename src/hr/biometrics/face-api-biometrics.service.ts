import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { dirname, join } from 'path';
import type { WorkspaceConfig } from '../../common/configs/config.interface';
import {
  BiometricsService,
  FACE_DESCRIPTOR_LENGTH,
  FaceMatch,
  NoFaceDetectedError,
  euclideanDistance,
} from './biometrics.service';
import { ImageProcessingService } from './image-processing.service';

/**
 * The real face matcher: `@vladmandic/face-api` on the TensorFlow.js WASM backend.
 *
 * The WASM build specifically, not face-api's default Node entry point. That
 * default requires `@tensorflow/tfjs-node`, a native-binding package the
 * constitution's biometric pre-approval explicitly excludes — so this loads
 * `face-api.node-wasm`, whose only dependencies are pure JS and a `.wasm` payload.
 * The trade is throughput for portability: WASM inference is slower than a native
 * build, but it installs identically everywhere and needs no build toolchain in the
 * production image.
 *
 * Models load once, lazily, on first use rather than at construction — a punch is
 * the only thing that needs them, and paying ~6 MB of model loading during
 * application startup would slow every deploy for a capability most requests never
 * touch.
 */
@Injectable()
export class FaceApiBiometricsService
  extends BiometricsService
  implements OnModuleInit
{
  private readonly logger = new Logger(FaceApiBiometricsService.name);
  private readonly distanceThreshold: number;

  /* eslint-disable @typescript-eslint/no-explicit-any */
  private faceapi: any;
  private tf: any;
  /** The in-flight (or completed) model load. Held as a promise so concurrent first
   * requests await one load instead of each starting their own. */
  private ready: Promise<void> | null = null;

  constructor(
    configService: ConfigService,
    private readonly images: ImageProcessingService,
  ) {
    super();
    this.distanceThreshold =
      configService.get<WorkspaceConfig>(
        'workspace',
      ).faceMatch.distanceThreshold;
  }

  onModuleInit(): void {
    // Intentionally does not await: see the lazy-loading note above.
    this.logger.log(
      `Face matching ready (WASM backend, distance threshold ${this.distanceThreshold}).`,
    );
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.ready) {
      this.ready = this.load();
    }
    return this.ready;
  }

  private async load(): Promise<void> {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const faceapi = require('@vladmandic/face-api/dist/face-api.node-wasm.js');
    const tf = require('@tensorflow/tfjs');
    const wasm = require('@tensorflow/tfjs-backend-wasm');

    // Point the WASM backend at the .wasm binaries inside the installed package
    // rather than letting it reach for a CDN. A production container has no
    // business making an outbound request to fetch part of its own runtime, and on
    // a locked-down network that fetch is what would fail.
    const wasmDir = join(
      dirname(require.resolve('@tensorflow/tfjs-backend-wasm/package.json')),
      'dist',
    );
    wasm.setWasmPaths(`${wasmDir}/`);

    await tf.setBackend('wasm');
    await tf.ready();

    // The models ship inside the npm package, so there is nothing to download or
    // vendor — resolve them from wherever the package actually installed.
    const modelPath = join(
      dirname(require.resolve('@vladmandic/face-api/package.json')),
      'model',
    );
    await faceapi.nets.ssdMobilenetv1.loadFromDisk(modelPath);
    await faceapi.nets.faceLandmark68Net.loadFromDisk(modelPath);
    await faceapi.nets.faceRecognitionNet.loadFromDisk(modelPath);

    this.faceapi = faceapi;
    this.tf = tf;
    this.logger.log(`Face-api models loaded from ${modelPath}.`);
  }

  /** Decodes one photo and returns its descriptor, or null if no face is found. */
  private async descriptorFor(photo: Buffer): Promise<Float32Array | null> {
    const { data, width, height, channels } = await this.images.decodeToRaw(
      photo,
    );

    // tfjs owns this tensor's memory manually — WASM memory is not garbage
    // collected, so a tensor not disposed is leaked for the process's lifetime.
    // `tidy` cannot be used here because the work in between is asynchronous.
    const tensor = this.tf.tensor3d(new Uint8Array(data), [
      height,
      width,
      channels,
    ]);
    try {
      const detection = await this.faceapi
        .detectSingleFace(tensor)
        .withFaceLandmarks()
        .withFaceDescriptor();
      return detection ? (detection.descriptor as Float32Array) : null;
    } finally {
      tensor.dispose();
    }
  }

  async computeDescriptor(photos: Buffer[]): Promise<Float32Array> {
    await this.ensureLoaded();

    const descriptors: Float32Array[] = [];
    for (const [index, photo] of photos.entries()) {
      const descriptor = await this.descriptorFor(photo);
      if (!descriptor) {
        throw new NoFaceDetectedError(index);
      }
      descriptors.push(descriptor);
    }

    // Average the per-photo descriptors into one template. Face descriptors live in
    // a space where the mean of several views of one person is a better centre than
    // any single view — which is precisely why enrolment asks for several photos.
    const averaged = new Float32Array(FACE_DESCRIPTOR_LENGTH);
    for (const descriptor of descriptors) {
      for (let i = 0; i < FACE_DESCRIPTOR_LENGTH; i += 1) {
        averaged[i] += descriptor[i];
      }
    }
    for (let i = 0; i < FACE_DESCRIPTOR_LENGTH; i += 1) {
      averaged[i] /= descriptors.length;
    }
    return averaged;
  }

  compareDescriptors(a: Float32Array, b: Float32Array): FaceMatch {
    const distance = euclideanDistance(a, b);
    return { matched: distance <= this.distanceThreshold, distance };
  }
}
