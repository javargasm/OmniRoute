import { NextResponse } from "next/server";
import { getChatGptWebBridge } from "@/lib/chatgptWebBridge/bridgeServer";
import { toChatGptWebBridgeHttpError } from "@/lib/chatgptWebBridge/httpErrors";

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

    const bridge = getChatGptWebBridge();
    const body = await req.json().catch(() => ({}));

    const session = bridge.heartbeat(sessionToken, {
      label: body?.label,
      tabId: typeof body?.tabId === "number" ? body.tabId : undefined,
      availableModels: Array.isArray(body?.availableModels) ? body.availableModels : undefined,
    });

    return NextResponse.json({ ok: true, session }, { headers: CORS_HEADERS });
  } catch (error) {
    const bridgeError = toChatGptWebBridgeHttpError(error);
    return NextResponse.json(
      bridgeError.body,
      { status: bridgeError.status, headers: CORS_HEADERS }
    );
  }
}
