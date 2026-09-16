import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";
import { ChatGptWebBridgeError, type ChatGptWebBridgeErrorCode } from "./types";

export interface ChatGptWebBridgeHttpError {
  status: number;
  body: {
    ok: false;
    error: string;
    code?: ChatGptWebBridgeErrorCode;
  };
}

/**
 * Translate bridge failures into stable HTTP semantics for the local browser
 * client. In particular, a restarted bridge cannot recognize a persisted
 * extension session token; returning 401 lets the extension discard it and
 * pair again without user intervention.
 */
export function toChatGptWebBridgeHttpError(error: unknown): ChatGptWebBridgeHttpError {
  if (error instanceof ChatGptWebBridgeError) {
    const status =
      error.code === "extension_not_paired"
        ? 401
        : error.code === "turn_not_found"
          ? 404
          : error.code === "lease_lost" || error.code === "turn_not_claimable"
            ? 409
            : 400;

    return {
      status,
      body: {
        ok: false,
        error: sanitizeErrorMessage(error.message) || "ChatGPT bridge request failed",
        code: error.code,
      },
    };
  }

  return {
    status: 400,
    body: {
      ok: false,
      error:
        error instanceof Error
          ? sanitizeErrorMessage(error) || "ChatGPT bridge request failed"
          : "ChatGPT bridge request failed",
    },
  };
}
