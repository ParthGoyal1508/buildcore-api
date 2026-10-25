import { ConfigService } from '@nestjs/config';
type Sharp = (options: import('sharp').SharpOptions) => import('sharp').Sharp;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sharp: Sharp = require('sharp');
import { NoFaceDetectedError } from './biometrics.service';
import { ALIGNMENT_TEMPLATE, alignFace, fitSimilarity } from './face-inference';
import { OnnxBiometricsService } from './onnx-biometrics.service';

/**
 * The model-load lifecycle of the real face matcher, driven through a subclass that replaces
 * `load()` rather than by mocking `worker_threads` — this repo has no `jest.mock` anywhere and
 * tests through real subclasses instead (`biometrics.service.spec.ts` does the same).
 *
 * What is worth locking in is not that the models load — it is that they load *once*, that a
 * preload failure does not permanently disable punching, and that `preloadModels: false` still
 * yields the original lazy behaviour.
 */
class TestOnnx extends OnnxBiometricsService {
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

function configWith(overrides: Record<string, unknown> = {}): ConfigService {
  return new ConfigService({
    workspace: {
      faceMatch: {
        distanceThreshold: 0.637,
        minEnrolmentPhotos: 3,
        maxEnrolmentPhotos: 5,
        inferenceThreads: 1,
        preloadModels: false,
        ...overrides,
      },
    },
  } as never);
}

function serviceWith(overrides: Record<string, unknown> = {}): TestOnnx {
  return new TestOnnx(configWith(overrides));
}

/** Lets the floating preload promise in `onModuleInit` settle. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('OnnxBiometricsService model loading', () => {
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
});

describe('OnnxBiometricsService comparison', () => {
  it('matches by cosine distance against the configured threshold', () => {
    const svc = serviceWith({ distanceThreshold: 0.637 });
    const a = Float32Array.from([1, 0, 0]);

    expect(svc.compareDescriptors(a, a)).toEqual({
      matched: true,
      distance: 0,
    });
    // Same direction, different length: cosine ignores magnitude.
    expect(
      svc.compareDescriptors(a, Float32Array.from([5, 0, 0])).matched,
    ).toBe(true);
    // Orthogonal: distance 1, well past 0.637.
    const orthogonal = svc.compareDescriptors(a, Float32Array.from([0, 1, 0]));
    expect(orthogonal.matched).toBe(false);
    expect(orthogonal.distance).toBeCloseTo(1);
  });
});

describe('face alignment', () => {
  it('fits the identity when the landmarks already sit on the template', () => {
    const t = fitSimilarity(ALIGNMENT_TEMPLATE, ALIGNMENT_TEMPLATE);
    expect(t.a).toBeCloseTo(1);
    expect(t.b).toBeCloseTo(0);
    expect(t.tx).toBeCloseTo(0);
    expect(t.ty).toBeCloseTo(0);
  });

  it('recovers a rotated, scaled and shifted face exactly', () => {
    // The template as it would appear in a photo: twice the size, turned 30°, moved.
    const angle = Math.PI / 6;
    const [a, b] = [2 * Math.cos(angle), 2 * Math.sin(angle)];
    const inPhoto = ALIGNMENT_TEMPLATE.map(
      ([x, y]) => [a * x - b * y + 300, b * x + a * y + 120] as const,
    );

    const t = fitSimilarity(inPhoto, ALIGNMENT_TEMPLATE);
    for (let i = 0; i < inPhoto.length; i += 1) {
      const [x, y] = inPhoto[i];
      expect(t.a * x - t.b * y + t.tx).toBeCloseTo(ALIGNMENT_TEMPLATE[i][0], 6);
      expect(t.b * x + t.a * y + t.ty).toBeCloseTo(ALIGNMENT_TEMPLATE[i][1], 6);
    }
  });

  it('copies pixels unchanged under the identity, as channel planes', () => {
    const size = 112;
    const data = Buffer.alloc(size * size * 3);
    for (let i = 0; i < size * size; i += 1) {
      data[i * 3] = 10;
      data[i * 3 + 1] = 20;
      data[i * 3 + 2] = 30;
    }
    const out = alignFace(
      { data, width: size, height: size, channels: 3 },
      { a: 1, b: 0, tx: 0, ty: 0 },
    );
    const plane = size * size;
    expect(out[0]).toBe(10);
    expect(out[plane]).toBe(20);
    expect(out[2 * plane]).toBe(30);
    expect(out[plane - 1]).toBe(10);
  });
});

describe('OnnxBiometricsService with the real models', () => {
  // A blank frame, not a photograph: committing a real face to the repository is exactly what the
  // abstract `BiometricsService` exists to avoid. What this proves is the part a fake cannot — the
  // worker starts, the vendored models load from beside it, and a photo runs through decode,
  // detection and the threshold to a "no face" answer instead of a crash or a hang.
  const svc = new OnnxBiometricsService(configWith());
  afterAll(() => svc.onModuleDestroy());

  it('finds no face in a blank photo', async () => {
    const blank = await sharp({
      create: { width: 1280, height: 960, channels: 3, background: '#808080' },
    })
      .jpeg()
      .toBuffer();

    await expect(svc.computeDescriptor([blank])).rejects.toBeInstanceOf(
      NoFaceDetectedError,
    );
  }, 30_000);

  it('refuses the punch rather than hanging when a photo cannot be decoded', async () => {
    await expect(
      svc.computeDescriptor([Buffer.from('not an image')]),
    ).rejects.toThrow();
  }, 30_000);
});
