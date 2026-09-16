import { NextResponse } from "next/server";
import { getChatGptWebBridge } from "@/lib/chatgptWebBridge/bridgeServer";
import { toChatGptWebBridgeHttpError } from "@/lib/chatgptWebBridge/httpErrors";
import { AUTHZ_HEADER_CHATGPT_BRIDGE_AUTO_PAIR } from "@/server/authz/headers";

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
    const bridge = getChatGptWebBridge();
    const body = await req.json().catch(() => ({}));
    const code = typeof body?.code === "string" ? body.code.trim() : "";

    if (!code && req.headers.get(AUTHZ_HEADER_CHATGPT_BRIDGE_AUTO_PAIR) !== "1") {
      return NextResponse.json(
        { ok: false, error: "A pairing code is required outside loopback access" },
        { status: 403, headers: CORS_HEADERS }
      );
    }

    const pairingCode = code || bridge.createPairingCode().code;
    const session = bridge.pairBrowser(pairingCode, {
      label: body?.label || "Chrome Extension",
      tabId: typeof body?.tabId === "number" ? body.tabId : undefined,
      availableModels: Array.isArray(body?.availableModels) ? body.availableModels : undefined,
    });

    return NextResponse.json({ ok: true, session }, { headers: CORS_HEADERS });
  } catch (error) {
    const bridgeError = toChatGptWebBridgeHttpError(error);
    return NextResponse.json(bridgeError.body, {
      status: bridgeError.status,
      headers: CORS_HEADERS,
    });
  }
}
