import { NextResponse } from "next/server";
import { getChatGptWebBridge } from "@/lib/chatgptWebBridge/bridgeServer";
import { toChatGptWebBridgeHttpError } from "@/lib/chatgptWebBridge/httpErrors";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-bridge-token",
};

function abortedResponse() {
  return NextResponse.json(
    { ok: false, error: "Bridge pending request was cancelled", code: "client_disconnected" },
    { status: 499, headers: CORS_HEADERS }
  );
}

function waitForPollInterval(signal: AbortSignal, delayMs: number): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const sessionToken = req.headers.get("x-bridge-token") || url.searchParams.get("token") || "";

    if (!sessionToken) {
      return NextResponse.json(
        { ok: false, error: "Missing x-bridge-token header" },
        { status: 401, headers: CORS_HEADERS }
      );
    }

    if (req.signal.aborted) return abortedResponse();

    const bridge = getChatGptWebBridge();
    const wait = url.searchParams.get("wait") === "true";
    const timeoutMs = Math.min(
      25000,
      Math.max(1000, Number(url.searchParams.get("timeout") || 20000))
    );

    // Try immediate claim
    let claimed = bridge.claimNextTurn(sessionToken);
    if (claimed) {
      return NextResponse.json({ ok: true, claimed }, { headers: CORS_HEADERS });
    }

    if (!wait) {
      return NextResponse.json({ ok: true, claimed: null }, { headers: CORS_HEADERS });
    }

    // Poll with an abort-aware sleep so a disconnected extension cannot claim a later turn.
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const remainingMs = timeoutMs - (Date.now() - startTime);
      const completedSleep = await waitForPollInterval(req.signal, Math.min(400, remainingMs));
      if (!completedSleep || req.signal.aborted) return abortedResponse();

      claimed = bridge.claimNextTurn(sessionToken);
      if (claimed) {
        return NextResponse.json({ ok: true, claimed }, { headers: CORS_HEADERS });
      }
    }

    return NextResponse.json({ ok: true, claimed: null }, { headers: CORS_HEADERS });
  } catch (error) {
    const bridgeError = toChatGptWebBridgeHttpError(error);
    return NextResponse.json(bridgeError.body, {
      status: bridgeError.status,
      headers: CORS_HEADERS,
    });
  }
}
