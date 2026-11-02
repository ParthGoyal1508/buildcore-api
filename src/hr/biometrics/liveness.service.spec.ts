import { BadRequestException } from '@nestjs/common';

import {
  BiometricsService,
  cosineDistance,
  FACE_DESCRIPTOR_LENGTH,
  FaceMatch,
} from './biometrics.service';
import { antiSpoofCrop, FaceAnalysis, headYaw } from './face-inference';
import {
  LivenessService,
  LivenessStep,
  livenessMessage,
  livenessSubject,
} from './liveness.service';

/**
 * 057. The liveness rules against scripted frames: each frame's bytes name what it "shows", so a
 * case reads as the capture it describes. The models themselves were checked against the original
 * PyTorch pipeline when they were exported (see `models/README.md`).
 */
const face = (seed: number) =>
  Float32Array.from({ length: FACE_DESCRIPTOR_LENGTH }, (_, i) =>
    Math.sin(seed * 7 + i),
  );
const ALICE = face(1);
/** Orthogonal to ALICE — as far from her as a face can be. */
const BOB = Float32Array.from({ length: FACE_DESCRIPTOR_LENGTH }, (_, i) =>
  Math.cos(7 + i),
);

type Shown = { yaw: number; real?: number; who?: Float32Array } | null;

class ScriptedBiometrics extends BiometricsService {
  constructor(private readonly script: Record<string, Shown>) {
    super();
  }
  async computeDescriptor(): Promise<Float32Array> {
    return ALICE;
  }
  compareDescriptors(a: Float32Array, b: Float32Array): FaceMatch {
    const distance = cosineDistance(a, b);
    return { matched: distance <= 0.637, distance };
  }
  async analyse(photo: Buffer): Promise<FaceAnalysis | null> {
    const shown = this.script[photo.toString()];
    return shown
      ? {
          descriptor: shown.who ?? ALICE,
          yaw: shown.yaw,
          realScore: shown.real ?? 0.98,
        }
      : null;
  }
}

const config = {
  get: () => ({
    liveness: { challengeTtlSeconds: 120, minTurn: 0.12, minRealScore: 0.5 },
  }),
};

function harness(script: Record<string, Shown>) {
  const rows = new Map<
    string,
    { subject: string; steps: string[]; expiresAt: Date; usedAt: Date | null }
  >();
  const tx = {
    // The RLS context's `set_config`; nothing to set in a test.
    $executeRaw: async () => 0,
    livenessChallenge: {
      deleteMany: async () => ({ count: 0 }),
      create: async ({
        data,
      }: {
        data: { subject: string; steps: string[]; expiresAt: Date };
      }) => {
        const id = `ch-${rows.size + 1}`;
        rows.set(id, { ...data, usedAt: null });
        return { id };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; subject: string; expiresAt: { gt: Date } };
        data: { usedAt: Date };
      }) => {
        const row = rows.get(where.id);
        if (
          !row ||
          row.subject !== where.subject ||
          row.usedAt ||
          row.expiresAt <= where.expiresAt.gt
        ) {
          return { count: 0 };
        }
        row.usedAt = data.usedAt;
        return { count: 1 };
      },
      findUnique: async ({ where }: { where: { id: string } }) =>
        rows.get(where.id) ?? null,
    },
  };
  const prisma = {
    $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
  };
  const service = new LivenessService(
    prisma as never,
    new ScriptedBiometrics(script),
    config as never,
  );
  return { service, rows };
}

const judge = (script: Record<string, Shown>, steps: LivenessStep[]) =>
  harness(script).service.judge(
    steps,
    steps.map((_, i) => Buffer.from(`f${i}`)),
  );

describe('LivenessService', () => {
  describe('judge', () => {
    it('passes a live face that turns as asked', async () => {
      const result = await judge(
        { f0: { yaw: 0.02 }, f1: { yaw: 0.3 }, f2: { yaw: -0.25 } },
        ['straight', 'left', 'right'],
      );
      expect(result.failure).toBeNull();
      expect(result.straight?.descriptor).toBe(ALICE);
      expect(result.realScore).toBeCloseTo(0.98);
    });

    it('refuses a held-up photo: the head never turns', async () => {
      // Tilting a flat picture keeps the nose on the line between the eyes.
      const result = await judge(
        { f0: { yaw: 0.01 }, f1: { yaw: 0.03 }, f2: { yaw: -0.02 } },
        ['straight', 'left', 'right'],
      );
      expect(result.failure).toEqual({ kind: 'did_not_turn', step: 'left' });
    });

    it('refuses turns in the wrong order — a recording cannot know it', async () => {
      const result = await judge(
        { f0: { yaw: 0 }, f1: { yaw: 0.3 }, f2: { yaw: -0.3 } },
        ['straight', 'right', 'left'],
      );
      expect(result.failure).toEqual({ kind: 'did_not_turn', step: 'right' });
    });

    it('measures a turn from the straight frames, not from zero', async () => {
      // Somebody who naturally faces the camera a little turned is not penalised for it.
      const result = await judge(
        {
          f0: { yaw: 0.1 },
          f1: { yaw: 0.1 },
          f2: { yaw: 0.25 },
          f3: { yaw: -0.05 },
        },
        ['straight', 'straight', 'left', 'right'],
      );
      expect(result.failure).toBeNull();
    });

    it('refuses when a different person turns for a photo held up straight', async () => {
      const result = await judge(
        {
          f0: { yaw: 0 },
          f1: { yaw: 0.3, who: BOB },
          f2: { yaw: -0.3, who: BOB },
        },
        ['straight', 'left', 'right'],
      );
      expect(result.failure).toEqual({
        kind: 'different_person',
        step: 'left',
      });
    });

    it('refuses what the anti-spoof models score as a screen or print', async () => {
      const result = await judge(
        {
          f0: { yaw: 0, real: 0.2 },
          f1: { yaw: 0.3, real: 0.3 },
          f2: { yaw: -0.3, real: 0.25 },
        },
        ['straight', 'left', 'right'],
      );
      expect(result.failure).toEqual({ kind: 'spoof' });
      expect(result.realScore).toBeCloseTo(0.25);
    });

    it('names the straight frame when it has no face, and a turn frame when that has none', async () => {
      expect(
        (
          await judge({ f1: { yaw: 0.3 }, f2: { yaw: -0.3 } }, [
            'straight',
            'left',
            'right',
          ])
        ).failure,
      ).toEqual({ kind: 'no_face', step: 'straight' });
      expect(
        (
          await judge({ f0: { yaw: 0 }, f2: { yaw: -0.3 } }, [
            'straight',
            'left',
            'right',
          ])
        ).failure,
      ).toEqual({ kind: 'no_face', step: 'left' });
    });

    it('rejects a capture with the wrong number of frames as malformed', async () => {
      const { service } = harness({});
      await expect(
        service.judge(['straight', 'left', 'right'], [Buffer.from('f0')]),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('challenges', () => {
    it('issues both turns, in either order, after the straight frames', async () => {
      const { service } = harness({});
      const punch = await service.issue('u:staff-punch:', 'punch');
      const enrol = await service.issue('u:staff-enrolment:', 'enrolment');
      expect(punch.steps[0]).toBe('straight');
      expect([...punch.steps.slice(1)].sort()).toEqual(['left', 'right']);
      expect(enrol.steps.slice(0, 2)).toEqual(['straight', 'straight']);
      expect([...enrol.steps.slice(2)].sort()).toEqual(['left', 'right']);
    });

    it('can be spent once, and only by its subject', async () => {
      const { service } = harness({});
      const { challengeId, steps } = await service.issue(
        'u1:staff-punch:',
        'punch',
      );

      await expect(
        service.consume(challengeId, 'u2:staff-punch:'),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.consume(challengeId, 'u1:staff-punch:'),
      ).resolves.toEqual(steps);
      await expect(
        service.consume(challengeId, 'u1:staff-punch:'),
      ).rejects.toMatchObject({
        response: { code: 'LIVENESS_CHALLENGE_INVALID' },
      });
    });

    it('binds a labour punch challenge to the labour', () => {
      expect(livenessSubject('sup-1', 'labour-punch', 'w-9')).toBe(
        'sup-1:labour-punch:w-9',
      );
    });
  });

  it('says which check failed, in words the person can act on', () => {
    expect(
      livenessMessage({ kind: 'did_not_turn', step: 'right' }, 'your'),
    ).toMatch(/did not turn to the right.*Turn your head/);
    expect(livenessMessage({ kind: 'spoof' }, "the labour's")).toMatch(
      /screen or a printout/,
    );
  });
});

describe('face geometry (057)', () => {
  it('reads a frontal face as no turn, and the nose off-centre as a turn', () => {
    const eyes: [number, number][] = [
      [100, 100],
      [160, 100],
    ];
    expect(headYaw([...eyes, [130, 130]])).toBeCloseTo(0);
    expect(headYaw([...eyes, [145, 130]])).toBeCloseTo(0.25);
    expect(headYaw([...eyes, [118, 130]])).toBeCloseTo(-0.2);
  });

  it('crops exactly as the original anti-spoof pipeline does', () => {
    // Expected boxes from Silent-Face-Anti-Spoofing's `CropImage._get_new_box`, run on these inputs.
    expect(antiSpoofCrop(640, 480, [187, 43, 124, 173], 2.7)).toEqual([
      81, 0, 416, 467,
    ]);
    expect(antiSpoofCrop(640, 480, [187, 43, 124, 173], 4.0)).toEqual([
      77, 0, 420, 479,
    ]);
    expect(antiSpoofCrop(640, 480, [10, 10, 100, 120], 2.7)).toEqual([
      0, 0, 270, 324,
    ]);
    expect(antiSpoofCrop(320, 240, [200, 100, 110, 130], 4.0)).toEqual([
      116, 0, 319, 239,
    ]);
  });
});
