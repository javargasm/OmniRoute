import { NextResponse } from "next/server";
import { getChatGptWebBridge } from "@/lib/chatgptWebBridge/bridgeServer";
import { toChatGptWebBridgeHttpError } from "@/lib/chatgptWebBridge/httpErrors";
import type { BridgeIncomingEvent } from "@/lib/chatgptWebBridge/types";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-bridge-token",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(req: Request) {
  try {
    const sessionToken =
      req.headers.get("x-bridge-token") ||
      new URL(req.url).searchParams.get("token") ||
      "";

    if (!sessionToken) {
      return NextResponse.json(
        { ok: false, error: "Missing x-bridge-token header" },
        { status: 401, headers: CORS_HEADERS }
      );
    }

    const body = await req.json();
    const turnId = String(body?.turnId || "");
    const leaseToken = String(body?.leaseToken || "");

    if (!turnId || !leaseToken) {
      return NextResponse.json(
        { ok: false, error: "Missing turnId or leaseToken" },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    // Normalize event payload
    let incomingEvent: BridgeIncomingEvent;
    const rawType = body?.type || body?.event?.type;

    if (rawType === "text_delta" || rawType === "delta") {
      incomingEvent = {
        type: "text_delta",
        delta: String(body?.delta || body?.text || body?.event?.delta || body?.event?.text || ""),
        clientEventId: body?.clientEventId,
      };
    } else if (rawType === "reasoning_delta" || rawType === "thinking") {
      incomingEvent = {
        type: "reasoning_delta",
        delta: String(body?.delta || body?.thinking || body?.event?.delta || body?.event?.thinking || ""),
        clientEventId: body?.clientEventId,
      };
    } else if (rawType === "completed" || rawType === "finish") {
      incomingEvent = {
        type: "completed",
        finishReason: body?.finishReason || body?.event?.finishReason || "stop",
        clientEventId: body?.clientEventId,
      };
    } else if (rawType === "error") {
      incomingEvent = {
        type: "error",
        code: String(body?.code || body?.event?.code || "turn_error"),
        message: String(body?.message || body?.error || body?.event?.message || body?.event?.error || "Turn error"),
        retryable: Boolean(body?.retryable || body?.event?.retryable),
        clientEventId: body?.clientEventId,
      };
    } else {
      return NextResponse.json(
        { ok: false, error: `Unsupported event type: ${rawType}` },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const bridge = getChatGptWebBridge();
    const stored = bridge.appendTurnEvent(sessionToken, turnId, leaseToken, incomingEvent);
    return NextResponse.json({ ok: true, sequence: stored.sequence }, { headers: CORS_HEADERS });
  } catch (error) {
    const bridgeError = toChatGptWebBridgeHttpError(error);
    return NextResponse.json(
      bridgeError.body,
      { status: bridgeError.status, headers: CORS_HEADERS }
    );
  }
}
