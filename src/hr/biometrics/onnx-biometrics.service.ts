import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { extname, join } from 'path';
import { Worker } from 'worker_threads';
import type { WorkspaceConfig } from '../../common/configs/config.interface';
import {
  BiometricsService,
  FACE_DESCRIPTOR_LENGTH,
  FaceMatch,
  NoFaceDetectedError,
  cosineDistance,
} from './biometrics.service';
import { normalise } from './face-inference';
import type {
  FaceInferenceRequest,
  FaceInferenceResponse,
} from './face-inference.worker';

interface Pending {
  resolve: (descriptor: Float32Array | null) => void;
  reject: (error: Error) => void;
}

/**
 * The real face matcher: YuNet finds the face and its five landmarks, SFace turns the aligned crop
 * into a 128-float embedding, both on `onnxruntime-node` (constitution v1.6.0), on a worker thread.
 *
 * It replaced `@vladmandic/face-api` on TensorFlow.js WASM on 2026-10-26. Measured on the same
 * photos and machine:
 *
 * | | face-api (WASM) | this |
 * |---|---|---|
 * | process RSS after a 12 MP punch | 1,284 MB (319 MB once downscaled) | ~200 MB |
 * | time per photo | 53–71 ms | ~20–30 ms |
 * | event-loop stall per punch | 68–90 ms | none — inference is on the worker |
 * | faces found in 3 test photos | 1 | 3 |
 *
 * **One worker, spawned once.** It holds the only copy of the models, so a second worker would be
 * a second ~60 MB for throughput a construction company's punch rate does not need; ORT already
 * spreads each inference over `inferenceThreads`. Whether it starts at boot or on first use is
 * `workspace.faceMatch.preloadModels`; either way `ensureLoaded` holds the in-flight start so
 * concurrent first punches await one. If the worker dies, every waiting punch is failed and the
 * next one starts a fresh worker. One instance serves the whole process — `BiometricsModule` is
 * the only place it is provided.
 */
@Injectable()
export class OnnxBiometricsService
  extends BiometricsService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(OnnxBiometricsService.name);
  private readonly distanceThreshold: number;
  private readonly inferenceThreads: number;
  private readonly preloadModels: boolean;

  private worker: Worker | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  /** The in-flight (or completed) worker start. Held as a promise so concurrent first
   * requests await one start instead of each spawning their own. */
  private ready: Promise<void> | null = null;

  constructor(configService: ConfigService) {
    super();
    const { faceMatch } = configService.get<WorkspaceConfig>('workspace');
    this.distanceThreshold = faceMatch.distanceThreshold;
    this.inferenceThreads = faceMatch.inferenceThreads;
    this.preloadModels = faceMatch.preloadModels;
  }

  onModuleInit(): void {
    this.logger.log(
      `Face matching configured (YuNet + SFace on onnxruntime, worker thread, ` +
        `${this.inferenceThreads} inference thread(s), ` +
        `cosine distance threshold ${this.distanceThreshold}).`,
    );

    if (!this.preloadModels) return;

    // Deliberately not awaited, and deliberately not allowed to fail the boot
    // silently. Awaiting here would hold up every other module's initialisation for
    // the sake of one capability; letting the rejection escape would crash the
    // process on a transient read. So it is started here and its failure logged —
    // `ensureLoaded` will retry on the first punch if this attempt failed, because a
    // rejected `ready` promise is cleared below.
    void this.ensureLoaded().then(
      () => this.logger.log('Face models preloaded at startup.'),
      (error) =>
        this.logger.error(
          `Face model preload failed; will retry on first use. ${error}`,
        ),
    );
  }

  async onModuleDestroy(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    this.ready = null;
    await worker?.terminate();
  }

  /** `protected` rather than `private` so a test subclass can drive the load
   * lifecycle without spawning the worker — this repo tests through real
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

  /** Spawns the worker and resolves once it has loaded the models. `protected` for
   * the same reason as `ensureLoaded` above. */
  protected load(): Promise<void> {
    // `.js` in `dist`; `.ts` only when Jest runs the sources, where the worker — a
    // fresh isolate that inherits none of Jest's transform — needs ts-node to start.
    const ext = extname(__filename);
    const worker = new Worker(join(__dirname, `face-inference.worker${ext}`), {
      workerData: { threads: this.inferenceThreads },
      execArgv:
        ext === '.ts' ? ['--require', 'ts-node/register/transpile-only'] : [],
    });

    return new Promise<void>((resolve, reject) => {
      worker.on('message', (message: FaceInferenceResponse) => {
        if ('ready' in message) {
          this.worker = worker;
          // An idle worker would otherwise keep the process alive on its own — a CLI
          // script or a test run that touched a face would never exit. It is re-ref'd
          // while a request is waiting on it (`descriptorFor`).
          worker.unref();
          this.logger.log('Face models loaded on the inference worker.');
          resolve();
        } else if ('loadError' in message) {
          void worker.terminate();
          reject(new Error(message.loadError));
        } else {
          const waiting = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (this.pending.size === 0) worker.unref();
          if ('error' in message) waiting?.reject(new Error(message.error));
          else waiting?.resolve(message.descriptor);
        }
      });
      const died = (error: Error) => {
        // Settles the start if the worker died during it (a no-op once resolved), and
        // fails every punch it was holding rather than leaving them hanging. The next
        // request finds `ready` cleared and starts a fresh worker.
        reject(error);
        if (this.worker === worker) {
          this.worker = null;
          this.ready = null;
          this.logger.error(`Face inference worker stopped: ${error.message}`);
        }
        for (const waiting of this.pending.values()) waiting.reject(error);
        this.pending.clear();
      };
      worker.on('error', died);
      worker.on('exit', (code) =>
        died(new Error(`face inference worker exited with code ${code}`)),
      );
    });
  }

  /** One photo to its embedding, or null when it shows no face. */
  private descriptorFor(photo: Buffer): Promise<Float32Array | null> {
    const worker = this.worker;
    if (!worker) {
      return Promise.reject(new Error('Face inference worker is not running.'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.ref();
      worker.postMessage({ id, photo } satisfies FaceInferenceRequest);
    });
  }

  async computeDescriptor(photos: Buffer[]): Promise<Float32Array> {
    await this.ensureLoaded();

    // All at once: the worker overlaps their decodes on libuv's pool.
    const descriptors = await Promise.all(
      photos.map((photo) => this.descriptorFor(photo)),
    );
    const missing = descriptors.findIndex((d) => d === null);
    if (missing !== -1) {
      throw new NoFaceDetectedError(missing);
    }

    // Average the per-photo embeddings into one template, then put it back on the
    // unit sphere. The mean of several views of one person is a better centre than
    // any single view — which is precisely why enrolment asks for several photos.
    const averaged = new Float32Array(FACE_DESCRIPTOR_LENGTH);
    for (const descriptor of descriptors as Float32Array[]) {
      for (let i = 0; i < FACE_DESCRIPTOR_LENGTH; i += 1) {
        averaged[i] += descriptor[i];
      }
    }
    return normalise(averaged);
  }

  compareDescriptors(a: Float32Array, b: Float32Array): FaceMatch {
    const distance = cosineDistance(a, b);
    return { matched: distance <= this.distanceThreshold, distance };
  }
}
