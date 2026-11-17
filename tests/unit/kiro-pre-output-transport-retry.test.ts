import assert from "node:assert/strict";
import test from "node:test";

const { shouldRetrySameAccountTransport } = await import(
  "../../src/sse/services/sameAccountTransportRetry.ts"
);

test("Kiro retries one pre-output transport or early-EOF failure on the same account", () => {
  assert.equal(
    shouldRetrySameAccountTransport({
      status: 503,
      errorText: "ServiceException: temporary upstream connection reset",
      attempt: 0,
    }),
    true
  );
  assert.equal(
    shouldRetrySameAccountTransport({
      status: 502,
      errorText: "Kiro stream ended before producing output",
      errorCode: "STREAM_EARLY_EOF",
      attempt: 0,
    }),
    true
  );
  assert.equal(
    shouldRetrySameAccountTransport({
      status: 502,
      errorCode: "STREAM_EARLY_EOF",
      attempt: 1,
    }),
    false,
    "the same-account retry must remain bounded to one attempt"
  );
});

test("Kiro never replays rate-limit or oversized-input failures before output", () => {
  const nonRetryableCases = [
    { status: 429, errorText: "ThrottlingException: Rate exceeded" },
    { status: 413, errorText: "Request Entity Too Large" },
    {
      status: 503,
      errorText: "ValidationException: CONTENT_LENGTH_EXCEEDS_THRESHOLD",
    },
    { status: 503, errorText: "ValidationException: Input is too long" },
  ];

  for (const failure of nonRetryableCases) {
    assert.equal(
      shouldRetrySameAccountTransport({ ...failure, attempt: 0 }),
      false,
      `${failure.status} ${failure.errorText} must not be replayed`
    );
  }
});

test("Kiro never retries once output may have reached the client", () => {
  assert.equal(
    shouldRetrySameAccountTransport({
      status: 503,
      errorText: "remote connection failure",
      attempt: 0,
      hasEmittedOutput: true,
    }),
    false
  );
});
