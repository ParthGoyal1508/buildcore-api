import {
  BiometricsService,
  FACE_DESCRIPTOR_LENGTH,
  FaceMatch,
  euclideanDistance,
} from './biometrics.service';

/** Concrete subclass so the base class's serialization helpers can be exercised. */
class TestBiometrics extends BiometricsService {
  async computeDescriptor(): Promise<Float32Array> {
    return new Float32Array(FACE_DESCRIPTOR_LENGTH);
  }
  compareDescriptors(a: Float32Array, b: Float32Array): FaceMatch {
    const distance = euclideanDistance(a, b);
    return { matched: distance <= 0.6, distance };
  }
}

describe('euclideanDistance', () => {
  it('is zero for identical descriptors', () => {
    const d = Float32Array.from([0.1, 0.2, 0.3]);
    expect(euclideanDistance(d, d)).toBe(0);
  });

  it('computes a known distance', () => {
    // 3-4-5 triangle.
    expect(
      euclideanDistance(Float32Array.from([0, 0]), Float32Array.from([3, 4])),
    ).toBeCloseTo(5, 6);
  });

  it('refuses to compare descriptors of different lengths', () => {
    // Silently comparing a truncated descriptor would produce a plausible-looking
    // distance from incomparable data — worse than failing.
    expect(() =>
      euclideanDistance(
        Float32Array.from([1, 2]),
        Float32Array.from([1, 2, 3]),
      ),
    ).toThrow(/different lengths/);
  });
});

describe('descriptor serialization', () => {
  const service = new TestBiometrics();

  it('round-trips a descriptor through the encrypted-column representation', () => {
    const original = Float32Array.from(
      Array.from({ length: FACE_DESCRIPTOR_LENGTH }, (_, i) => i / 128),
    );
    const restored = service.deserializeDescriptor(
      service.serializeDescriptor(original),
    );
    expect(restored.length).toBe(FACE_DESCRIPTOR_LENGTH);
    expect(Array.from(restored)).toEqual(Array.from(original));
    // The round-trip must be exact, or a stored template would slowly stop
    // matching the person it was enrolled from.
    expect(service.compareDescriptors(original, restored).distance).toBe(0);
  });

  it('produces a buffer of exactly 4 bytes per float', () => {
    const buffer = service.serializeDescriptor(
      new Float32Array(FACE_DESCRIPTOR_LENGTH),
    );
    expect(buffer.length).toBe(FACE_DESCRIPTOR_LENGTH * 4);
  });

  it('does not alias pooled Buffer memory', () => {
    // Node pools small Buffers; a Float32Array viewing one could be corrupted by
    // unrelated allocations reusing the pool.
    const original = Float32Array.from(
      { length: FACE_DESCRIPTOR_LENGTH },
      () => 0.5,
    );
    const bytes = service.serializeDescriptor(original);
    const restored = service.deserializeDescriptor(bytes);
    bytes.fill(0);
    expect(restored[0]).toBeCloseTo(0.5, 6);
  });
});
