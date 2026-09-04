import { BadRequestException, Injectable } from '@nestjs/common';
import { IndentStatus, Prisma } from '@prisma/client';

import { toNumber } from '../stock/stock.types';

/**
 * The one place an indent line's `fulfilledQuantity` moves (FR-023, FR-024).
 *
 * Split out of `IndentsService` rather than living on it because both the issue and
 * the purchase flow call it, and both call it *inside* their own transaction —
 * fulfilment has to commit or roll back with the movement that caused it, or an
 * issue that failed on stock would still have consumed indent quantity.
 *
 * Kept deliberately small for the same reason: everything here runs inside someone
 * else's transaction, so it must not open one, and it must not do anything that
 * could be slow enough to widen their lock window.
 */
@Injectable()
export class IndentFulfilmentService {
  /**
   * Books `quantity` against an approved indent line and advances the indent's
   * status.
   *
   * Refuses more than the line's outstanding quantity — approved minus already
   * fulfilled (FR-024). 400 rather than the 422 an over-issue against *stock*
   * returns: the two failures are different questions, and the client shows them in
   * different places. An over-issue is about the world (there is not enough
   * material); this is about the request (you asked against the wrong line, or for
   * more than was approved).
   */
  async applyFulfilment(
    tx: Prisma.TransactionClient,
    params: { companyId: string; indentLineId: string; quantity: number },
  ): Promise<void> {
    const line = await tx.materialIndentLine.findUnique({
      where: { id: params.indentLineId },
      include: {
        indent: { select: { id: true, status: true, companyId: true } },
      },
    });

    if (!line || line.companyId !== params.companyId) {
      throw new BadRequestException(
        `Indent line ${params.indentLineId} not found`,
      );
    }
    if (
      line.indent.status !== IndentStatus.approved &&
      line.indent.status !== IndentStatus.partially_fulfilled
    ) {
      throw new BadRequestException(
        `Indent line ${params.indentLineId} belongs to an indent that is ${line.indent.status}, not approved.`,
      );
    }
    if (line.approvedQuantity === null) {
      throw new BadRequestException(
        `Indent line ${params.indentLineId} has no approved quantity.`,
      );
    }

    const outstanding =
      toNumber(line.approvedQuantity) - toNumber(line.fulfilledQuantity);
    if (params.quantity > outstanding) {
      throw new BadRequestException({
        message: `This indent line has ${outstanding} outstanding; ${params.quantity} was requested.`,
        outstandingQuantity: outstanding,
      });
    }

    await tx.materialIndentLine.update({
      where: { id: line.id },
      data: { fulfilledQuantity: { increment: params.quantity } },
    });

    await this.refreshIndentStatus(tx, line.indentId);
  }

  /** Gives quantity back when an issue or purchase is reversed (FR-004, FR-028). */
  async reverseFulfilment(
    tx: Prisma.TransactionClient,
    params: { indentLineId: string; quantity: number },
  ): Promise<void> {
    const line = await tx.materialIndentLine.findUnique({
      where: { id: params.indentLineId },
      select: { id: true, indentId: true, fulfilledQuantity: true },
    });
    if (!line) return;

    // Floored at zero rather than trusted to stay non-negative: the movement being
    // reversed is the only thing that could have booked this quantity, but a
    // decrement that went negative would silently make `outstanding` exceed
    // `approved` and SC-A01 would stop holding.
    const next = Math.max(
      0,
      toNumber(line.fulfilledQuantity) - params.quantity,
    );
    await tx.materialIndentLine.update({
      where: { id: line.id },
      data: { fulfilledQuantity: next },
    });

    await this.refreshIndentStatus(tx, line.indentId);
  }

  /**
   * Re-derives the indent's status from its lines.
   *
   * Derived rather than incremented, so a reversal walks the status back down as
   * cleanly as a fulfilment walks it up. Only the three fulfilment-related states
   * are written here: `rejected` and `cancelled` are decisions, not consequences of
   * arithmetic, and must not be overwritten by a movement.
   */
  private async refreshIndentStatus(
    tx: Prisma.TransactionClient,
    indentId: string,
  ): Promise<void> {
    const indent = await tx.materialIndent.findUnique({
      where: { id: indentId },
      select: { status: true, lines: true },
    });
    if (!indent) return;
    if (
      indent.status === IndentStatus.rejected ||
      indent.status === IndentStatus.cancelled
    ) {
      return;
    }

    const anyFulfilled = indent.lines.some(
      (line) => toNumber(line.fulfilledQuantity) > 0,
    );
    const allFulfilled = indent.lines.every(
      (line) =>
        line.approvedQuantity !== null &&
        toNumber(line.fulfilledQuantity) >= toNumber(line.approvedQuantity),
    );

    const status = allFulfilled
      ? IndentStatus.fulfilled
      : anyFulfilled
      ? IndentStatus.partially_fulfilled
      : IndentStatus.approved;

    if (status !== indent.status) {
      await tx.materialIndent.update({
        where: { id: indentId },
        data: { status },
      });
    }
  }
}
