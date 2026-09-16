import { getChatGptWebBridge } from "@/lib/chatgptWebBridge/bridgeServer";
import { toChatGptWebBridgeHttpError } from "@/lib/chatgptWebBridge/httpErrors";
import { NextResponse } from "next/server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-bridge-token",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/** Renew a claimed browser turn without emitting a user-visible stream event. */
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

    const body = await req.json().catch(() => ({}));
    const turnId = String(body?.turnId || "");
    const leaseToken = String(body?.leaseToken || "");
    if (!turnId || !leaseToken) {
      return NextResponse.json(
        { ok: false, error: "Missing turnId or leaseToken" },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const turn = getChatGptWebBridge().renewTurnLease(sessionToken, turnId, leaseToken);
    return NextResponse.json(
      { ok: true, leaseExpiresAt: turn.leaseExpiresAt },
      { headers: CORS_HEADERS }
    );
  } catch (error) {
    const bridgeError = toChatGptWebBridgeHttpError(error);
    return NextResponse.json(
      bridgeError.body,
      { status: bridgeError.status, headers: CORS_HEADERS }
    );
  }
}
