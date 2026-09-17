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
 * Models load once and are reused. Whether that happens at startup or on first use
 * is `workspace.faceMatch.preloadModels`, and it now defaults to startup: the
 * instance is long-lived, so the cost belongs where nobody is waiting, and an
 * out-of-memory during model loading is far easier to diagnose as a failed boot than
 * as a failed punch. Either way the load happens exactly once — `ensureLoaded` holds
 * the in-flight promise so concurrent first punches await one load.
 *
 * **Inference blocks the event loop.** tfjs-wasm executes on the main thread, so for
 * the duration of a face match this process serves no other request. That is why the
 * detector is configurable and why its default changed on 2026-09-17: measured on a
 * 640×480 punch frame, `ssdMobilenetv1` blocked the loop for 228ms per punch against
 * `tinyFaceDetector@320`'s 35ms, and held 399 MB of process RSS against 239 MB. The
 * fix that removes the blocking rather than shrinking it is a worker thread, which is
 * a design change and deliberately not attempted here.
 */
@Injectable()
export class FaceApiBiometricsService
  extends BiometricsService
  implements OnModuleInit
{
  private readonly logger = new Logger(FaceApiBiometricsService.name);
  private readonly distanceThreshold: number;
  private readonly detector: 'tiny' | 'ssd';
  private readonly tinyInputSize: number;
  private readonly preloadModels: boolean;
  /** Built once at load time, not per inference: constructing it per call allocates
   * an options object for every punch to say the same thing each time. */
  private detectorOptions: unknown;

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
    const { faceMatch } = configService.get<WorkspaceConfig>('workspace');
    this.distanceThreshold = faceMatch.distanceThreshold;
    this.detector = faceMatch.detector;
    this.tinyInputSize = faceMatch.tinyInputSize;
    this.preloadModels = faceMatch.preloadModels;
  }

  onModuleInit(): void {
    this.logger.log(
      `Face matching configured (WASM backend, detector ${this.detector}` +
        `${this.detector === 'tiny' ? `@${this.tinyInputSize}` : ''}, ` +
        `distance threshold ${this.distanceThreshold}).`,
    );

    if (!this.preloadModels) return;

    // Deliberately not awaited, and deliberately not allowed to fail the boot
    // silently. Awaiting here would hold up every other module's initialisation for
    // the sake of one capability; letting the rejection escape would crash the
    // process on a transient read. So it is started here and its failure logged —
    // `ensureLoaded` will retry on the first punch if this attempt failed, because a
    // rejected `ready` promise is cleared below.
    void this.ensureLoaded().then(
      () => this.logger.log('Face-api models preloaded at startup.'),
      (error) =>
        this.logger.error(
          `Face-api model preload failed; will retry on first use. ${error}`,
        ),
    );
  }

  /** `protected` rather than `private` so a test subclass can drive the load
   * lifecycle without mocking the WASM modules — this repo tests through real
   * subclasses rather than module mocks (`biometrics.service.spec.ts`). */
  protected async ensureLoaded(): Promise<void> {
    if (!this.ready) {
      // Clear on failure so a transient model-read error is retried by the next
      // caller instead of being cached as a permanent one. Without this, a failed
      // preload would refuse every punch for the life of the process.
      this.ready = this.load().catch((error) => {
        this.ready = null;
        throw error;
      });
    }
    return this.ready;
  }

  /** `protected` for the same reason as `ensureLoaded` above. */
  protected async load(): Promise<void> {
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
    // Only the detector is configurable. `faceLandmark68Net` stays the full model
    // rather than its tiny variant: measured, the tiny landmarks saved 9 MB and no
    // measurable time, while landmark precision is what aligns the crop the
    // descriptor is computed from — so downgrading it would cost match quality for
    // nothing. `faceRecognitionNet` produces the descriptor and has no alternative.
    if (this.detector === 'ssd') {
      await faceapi.nets.ssdMobilenetv1.loadFromDisk(modelPath);
    } else {
      await faceapi.nets.tinyFaceDetector.loadFromDisk(modelPath);
    }
    await faceapi.nets.faceLandmark68Net.loadFromDisk(modelPath);
    await faceapi.nets.faceRecognitionNet.loadFromDisk(modelPath);

    this.detectorOptions =
      this.detector === 'ssd'
        ? new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 })
        : new faceapi.TinyFaceDetectorOptions({
            inputSize: this.tinyInputSize,
            scoreThreshold: 0.5,
          });

    this.faceapi = faceapi;
    this.tf = tf;
    this.logger.log(
      `Face-api models loaded from ${modelPath} (detector ${this.detector}).`,
    );
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
        .detectSingleFace(tensor, this.detectorOptions)
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
