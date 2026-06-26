/**
 * Shared error taxonomy.
 *
 * Parity is load-bearing: the in-memory store and the real DynamoDB store must
 * fail in the *same* way so the same invariant suite passes against both. The
 * DynamoStore maps AWS exceptions (ConditionalCheckFailedException,
 * TransactionCanceledException) onto these classes; MemoryStore throws them
 * directly. Tests assert on `instanceof ConditionalCheckError`.
 */

/** Why a conditional write was refused. */
export type ConditionReason =
  | "SESSION_CLOSED" // append attempted after seal
  | "ALREADY_SEALED" // seal attempted on an already-sealed auction
  | "COUNT_CONFLICT" // optimistic-concurrency: bid count moved under us
  | "SEQ_CONFLICT"; // two appends raced for the same sequence slot

/**
 * The single conditional-failure class. Models DynamoDB rejecting a write
 * whose `ConditionExpression` was not satisfied — the database itself refusing
 * a wrong-position-in-time write. Both backends throw this exact class.
 */
export class ConditionalCheckError extends Error {
  readonly code = "ConditionalCheckFailed";
  readonly reason: ConditionReason;
  constructor(reason: ConditionReason, message: string) {
    super(message);
    this.name = "ConditionalCheckError";
    this.reason = reason;
    Object.setPrototypeOf(this, ConditionalCheckError.prototype);
  }
}

/**
 * Thrown when something tries to overwrite or delete a witnessed object.
 * Models S3 Object Lock (COMPLIANCE mode) refusing mutation — not even the
 * account root can alter it until retention expires. The in-memory WORM
 * witness throws the same class so the invariant holds locally too.
 */
export class WitnessImmutableError extends Error {
  readonly code = "WitnessImmutable";
  constructor(message: string) {
    super(message);
    this.name = "WitnessImmutableError";
    Object.setPrototypeOf(this, WitnessImmutableError.prototype);
  }
}

/** A requested auction/bid/record does not exist. */
export class NotFoundError extends Error {
  readonly code = "NotFound";
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
    Object.setPrototypeOf(this, NotFoundError.prototype);
  }
}

/** Caller-supplied input was invalid (bad reveal, wrong seal token, etc.). */
export class ValidationError extends Error {
  readonly code = "Validation";
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}
