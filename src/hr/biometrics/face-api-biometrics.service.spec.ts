import { ConfigService } from '@nestjs/config';
import { FaceApiBiometricsService } from './face-api-biometrics.service';
import type { ImageProcessingService } from './image-processing.service';

/**
 * The model-load lifecycle of the real face matcher (2026-09-17 optimisation).
 *
 * Driven through a subclass that replaces `load()`, rather than by mocking
 * `@vladmandic/face-api` — this repo has no `jest.mock` anywhere and tests through
 * real subclasses instead (`biometrics.service.spec.ts` does the same). It also keeps
 * these tests fast: a real load pulls ~100 MB of weights into a WASM heap.
 *
 * What is worth locking in is not that the models load — it is that they load *once*,
 * that a preload failure does not permanently disable punching, and that
 * `preloadModels: false` still yields the original lazy behaviour.
 */
class TestFaceApi extends FaceApiBiometricsService {
  loadCalls = 0;
  failNextLoads = 0;

  protected async load(): Promise<void> {
    this.loadCalls += 1;
    if (this.failNextLoads > 0) {
      this.failNextLoads -= 1;
      throw new Error('model read failed');
    }
  }

  /** Exposes the protected seam so a test can await it directly. */
  load1(): Promise<void> {
    return this.ensureLoaded();
  }
}

function serviceWith(overrides: Record<string, unknown> = {}): TestFaceApi {
  const configService = new ConfigService({
    workspace: {
      faceMatch: {
        distanceThreshold: 0.6,
        minEnrolmentPhotos: 3,
        maxEnrolmentPhotos: 5,
        detector: 'tiny',
        tinyInputSize: 320,
        preloadModels: false,
        ...overrides,
      },
    },
  } as never);
  return new TestFaceApi(configService, {} as ImageProcessingService);
}

/** Lets the floating preload promise in `onModuleInit` settle. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('FaceApiBiometricsService model loading', () => {
  it('loads the models once however many callers ask', async () => {
    const svc = serviceWith();
    await Promise.all([svc.load1(), svc.load1(), svc.load1()]);
    await svc.load1();
    expect(svc.loadCalls).toBe(1);
  });

  it('does not load at startup when preloading is off', async () => {
    const svc = serviceWith({ preloadModels: false });
    svc.onModuleInit();
    await flush();
    expect(svc.loadCalls).toBe(0);

    // ...and still loads lazily when a punch arrives.
    await svc.load1();
    expect(svc.loadCalls).toBe(1);
  });

  it('loads at startup when preloading is on, and not again on first use', async () => {
    const svc = serviceWith({ preloadModels: true });
    svc.onModuleInit();
    await flush();
    expect(svc.loadCalls).toBe(1);

    await svc.load1();
    expect(svc.loadCalls).toBe(1);
  });

  it('retries after a failed load instead of refusing every later punch', async () => {
    // The regression this guards: caching the rejected promise would make one
    // transient model-read failure at boot disable face matching for the whole life
    // of the process — every punch refused, and under 020 FR-013 a refused punch is
    // a lost day.
    const svc = serviceWith();
    svc.failNextLoads = 1;

    await expect(svc.load1()).rejects.toThrow('model read failed');
    expect(svc.loadCalls).toBe(1);

    await expect(svc.load1()).resolves.toBeUndefined();
    expect(svc.loadCalls).toBe(2);
  });

  it('survives a failed preload at startup without crashing the process', async () => {
    const svc = serviceWith({ preloadModels: true });
    svc.failNextLoads = 1;

    // An unhandled rejection here would take the process down on boot.
    expect(() => svc.onModuleInit()).not.toThrow();
    await flush();
    expect(svc.loadCalls).toBe(1);

    await expect(svc.load1()).resolves.toBeUndefined();
    expect(svc.loadCalls).toBe(2);
  });

  it('still compares descriptors against the configured threshold', () => {
    const svc = serviceWith({ distanceThreshold: 0.6 });
    const a = new Float32Array(128).fill(0.1);
    expect(svc.compareDescriptors(a, a).matched).toBe(true);
    expect(
      svc.compareDescriptors(a, new Float32Array(128).fill(0.5)).matched,
    ).toBe(false);
  });
});
