/**
 * Shared HTTP helpers for the route handlers. Maps the domain error taxonomy
 * onto status codes so every route reports failures consistently — notably a
 * post-close append surfaces as 409 (ConditionalCheckFailed) and a witness
 * tamper attempt as 403 (immutable).
 */
import { NextResponse } from "next/server";
import {
  ConditionalCheckError,
  NotFoundError,
  ValidationError,
  WitnessImmutableError,
} from "../errors";

export function ok(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}

export function fail(err: unknown): NextResponse {
  if (err instanceof ConditionalCheckError) {
    return NextResponse.json(
      { error: err.message, code: err.code, reason: err.reason },
      { status: 409 },
    );
  }
  if (err instanceof WitnessImmutableError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 403 });
  }
  if (err instanceof NotFoundError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 404 });
  }
  if (err instanceof ValidationError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
  }
  const message = err instanceof Error ? err.message : "internal error";
  return NextResponse.json({ error: message, code: "Internal" }, { status: 500 });
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new ValidationError("invalid or missing JSON body");
  }
}
