import {
  BadRequestException,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomInt } from 'crypto';
import { PrismaService } from 'nestjs-prisma';

import type { WorkspaceConfig } from '../../common/configs/config.interface';
import { withRlsContext } from '../../common/prisma/rls-context';
import { BiometricsService } from './biometrics.service';
import type { FaceAnalysis } from './face-inference';

/** One frame of a liveness capture: facing the camera, or the head turned to the subject's side. */
export type LivenessStep = 'straight' | 'left' | 'right';

/**
 * What a capture is for, which decides its frames: a punch is one straight frame and both turns;
 * an enrolment two straight frames and both turns, so the template has more than one view.
 */
export type LivenessPurpose = 'punch' | 'enrolment';

/** Why a capture did not show a live person — each gets its own sentence for the worker. */
export type LivenessFailureKind =
  /** No face in a frame. In the straight frame this is the ordinary "no face detected". */
  | 'no_face'
  /** The head did not turn the way the step asked — what a held-up photo produces. */
  | 'did_not_turn'
  /** A turn frame shows somebody other than the straight frame. */
  | 'different_person'
  /** The anti-spoof models scored the frames as a photo or a screen. */
  | 'spoof';

export interface LivenessFailure {
  kind: LivenessFailureKind;
  /** The frame it failed on, where that is one frame. */
  step?: LivenessStep;
}

export interface LivenessJudgement {
  /** Every frame's analysis, in step order; null where that frame showed no face. */
  analyses: (FaceAnalysis | null)[];
  /** The first straight frame — the one a punch is matched on and stored as its photo. */
  straight: FaceAnalysis | null;
  /** Mean anti-spoof "real" score over the frames with a face; null when none had one. */
  realScore: number | null;
  failure: LivenessFailure | null;
}

export interface IssuedChallenge {
  challengeId: string;
  steps: LivenessStep[];
  expiresAt: string;
}

const SUPER_ADMIN = { isSuperAdmin: true };

/**
 * Liveness (057): is the face in front of the camera a live person, or a photo held up to it?
 *
 * Two independent checks, because each covers the other's blind spot:
 *
 * 1. **Head turn, on a challenge the server issues.** The capture must show the head turning the
 *    way a one-time challenge asks, in its order. A flat photo cannot move its nose off the line
 *    between the eyes however it is tilted (see `FaceAnalysis.yaw`), and a pre-recorded video does
 *    not know the order. Pure geometry — it needs no calibration.
 * 2. **Passive anti-spoof models** (MiniFASNet), on every frame: trained to tell a live face from a
 *    print or a screen. Covers a video replayed on a phone, which can turn its head. Its threshold
 *    is the part to calibrate on site devices; every punch records its score for that.
 *
 * And the turn frames must show the same person as the straight one, so a real head cannot turn for
 * a photo held up in the straight frame.
 */
@Injectable()
export class LivenessService {
  private readonly ttlSeconds: number;
  private readonly minTurn: number;
  private readonly minRealScore: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly biometrics: BiometricsService,
    config: ConfigService,
  ) {
    const { liveness } = config.get<WorkspaceConfig>('workspace');
    this.ttlSeconds = liveness.challengeTtlSeconds;
    this.minTurn = liveness.minTurn;
    this.minRealScore = liveness.minRealScore;
  }

  /**
   * A fresh challenge for `subject` (see `livenessSubject`). The two turns come in a random order,
   * so a recording made in advance has to guess it.
   */
  async issue(
    subject: string,
    purpose: LivenessPurpose,
  ): Promise<IssuedChallenge> {
    const turns: LivenessStep[] =
      randomInt(2) === 0 ? ['left', 'right'] : ['right', 'left'];
    const steps: LivenessStep[] =
      purpose === 'enrolment'
        ? ['straight', 'straight', ...turns]
        : ['straight', ...turns];
    const now = Date.now();
    const expiresAt = new Date(now + this.ttlSeconds * 1000);
    const row = await withRlsContext(this.prisma, SUPER_ADMIN, async (tx) => {
      // Housekeeping on the way in: nothing reads a challenge an hour past its expiry.
      await tx.livenessChallenge.deleteMany({
        where: { expiresAt: { lt: new Date(now - 60 * 60 * 1000) } },
      });
      return tx.livenessChallenge.create({
        data: { subject, steps, expiresAt },
        select: { id: true },
      });
    });
    return {
      challengeId: row.id,
      steps,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Takes a challenge out of circulation and returns its steps — once. Presented by the wrong
   * subject, after its expiry or a second time, it is refused as one condition: the client's
   * answer to all three is the same, start the capture again.
   */
  async consume(challengeId: string, subject: string): Promise<LivenessStep[]> {
    const now = new Date();
    const steps = await withRlsContext(this.prisma, SUPER_ADMIN, async (tx) => {
      // One conditional update is the whole guard: of two submissions racing with the same
      // challenge, exactly one changes `usedAt`.
      const { count } = await tx.livenessChallenge.updateMany({
        where: {
          id: challengeId,
          subject,
          usedAt: null,
          expiresAt: { gt: now },
        },
        data: { usedAt: now },
      });
      if (count !== 1) return null;
      const row = await tx.livenessChallenge.findUnique({
        where: { id: challengeId },
        select: { steps: true },
      });
      return row?.steps ?? null;
    });
    if (!steps) {
      throw new BadRequestException({
        code: 'LIVENESS_CHALLENGE_INVALID',
        message:
          'This capture has expired or was already used. Start again and follow the prompts on screen.',
      });
    }
    return steps as LivenessStep[];
  }

  /**
   * Spends a challenge and judges its capture, refusing anything that is not a live person (057) —
   * for the captures with no refusal log of their own: staff enrolment and labour registration.
   * A punch judges with `judge` instead, because its refusal is logged with the rest of its checks.
   *
   * No face in the straight frame is a 400 under `noFaceCode`, as a photo with no face always was;
   * any other failed check is a 422 `LIVENESS_FAILED` saying which.
   */
  async assertLive(
    challengeId: string,
    subject: string,
    frames: Buffer[],
    words: { subject: 'your' | "the labour's"; noFaceCode: string },
  ): Promise<LivenessJudgement> {
    const steps = await this.consume(challengeId, subject);
    const judgement = await this.judge(steps, frames);
    const { failure } = judgement;
    if (failure?.kind === 'no_face' && failure.step === 'straight') {
      throw new BadRequestException({
        code: words.noFaceCode,
        message:
          'No face could be seen in the photo facing the camera. Retake it in good light with the face filling the oval.',
      });
    }
    if (failure) {
      throw new UnprocessableEntityException({
        code: 'LIVENESS_FAILED',
        message: livenessMessage(failure, words.subject),
        reason: failure.kind,
        step: failure.step,
      });
    }
    return judgement;
  }

  /**
   * Judges a capture against its steps. Never throws for a failed check — a failure is a verdict
   * the caller turns into a refusal with its own wording — only for a malformed capture.
   */
  async judge(
    steps: LivenessStep[],
    frames: Buffer[],
  ): Promise<LivenessJudgement> {
    if (frames.length !== steps.length) {
      throw new BadRequestException({
        code: 'LIVENESS_FRAMES_MISMATCH',
        message: `Expected ${steps.length} photos for this capture, received ${frames.length}. Start again.`,
      });
    }
    const analyses = await Promise.all(
      frames.map((frame) => this.biometrics.analyse(frame)),
    );
    const straightIndex = steps.indexOf('straight');
    const straight = analyses[straightIndex] ?? null;
    const found = analyses.filter((a): a is FaceAnalysis => a !== null);
    const realScore =
      found.length === 0
        ? null
        : found.reduce((sum, a) => sum + a.realScore, 0) / found.length;
    const verdict = (failure: LivenessFailure | null): LivenessJudgement => ({
      analyses,
      straight,
      realScore,
      failure,
    });

    // Every straight frame needs a face; their mean head position is what a turn is measured from,
    // so a face that is already turned a little in the straight frame is not held against anyone.
    const straights = steps.flatMap((step, i) =>
      step === 'straight' ? [analyses[i]] : [],
    );
    if (straights.some((a) => a === null)) {
      return verdict({ kind: 'no_face', step: 'straight' });
    }
    const baseline =
      (straights as FaceAnalysis[]).reduce((sum, a) => sum + a.yaw, 0) /
      straights.length;

    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i];
      if (step === 'straight') continue;
      const turn = analyses[i];
      if (!turn) return verdict({ kind: 'no_face', step });
      // Turning to the subject's **left** moves the nose to the image's right in an unmirrored
      // frame: yaw rises. Their right: yaw falls.
      const moved = (turn.yaw - baseline) * (step === 'left' ? 1 : -1);
      if (moved < this.minTurn) return verdict({ kind: 'did_not_turn', step });
    }

    for (let i = 0; i < steps.length; i += 1) {
      const frame = analyses[i] as FaceAnalysis;
      if (i === straightIndex) continue;
      if (
        !this.biometrics.compareDescriptors(
          frame.descriptor,
          (straight as FaceAnalysis).descriptor,
        ).matched
      ) {
        return verdict({ kind: 'different_person', step: steps[i] });
      }
    }

    if (realScore === null || realScore < this.minRealScore) {
      return verdict({ kind: 'spoof' });
    }
    return verdict(null);
  }
}

/**
 * What a failed liveness check says (057), by which check failed. `subject` is "your" for the
 * employee holding their own phone and "the labour's" for a supervisor photographing someone.
 */
export function livenessMessage(
  failure: LivenessFailure | undefined,
  subject: 'your' | "the labour's",
): string {
  const side =
    failure?.step === 'left' || failure?.step === 'right' ? failure.step : null;
  switch (failure?.kind) {
    case 'did_not_turn':
      return (
        `The head did not turn${
          side ? ` to the ${side}` : ''
        } when asked, so this could not be ` +
        'confirmed as a live person — a photo held up to the camera looks exactly like this. ' +
        `Turn ${subject} head slowly when the screen says so, then try again.`
      );
    case 'no_face':
      return (
        `The face left the frame${
          side ? ` while turning ${side}` : ''
        }. Turn ${subject} head ` +
        'slowly, keeping the face inside the oval, then try again.'
      );
    case 'different_person':
      return (
        'The face changed between the photos, so this could not be confirmed as one live person. ' +
        'Keep the same face in the frame for the whole capture, then try again.'
      );
    case 'spoof':
      return (
        'These photos look like a picture of a screen or a printout rather than a live face. ' +
        'The person must face the camera themselves, in good light — then try again.'
      );
    default:
      return 'This capture could not be confirmed as a live person. Follow the prompts on screen and try again.';
  }
}

/**
 * Who may present a challenge: the user asking, the purpose, and for labour the worker it is for —
 * so a challenge issued to punch one labour cannot be spent on another.
 */
export function livenessSubject(
  userId: string,
  purpose: string,
  workerId?: string,
): string {
  return [userId, purpose, workerId ?? ''].join(':');
}
