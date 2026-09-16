import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { ChatGptWebBridgeServer } from "../../src/lib/chatgptWebBridge/bridgeServer.ts";
import { createChatGptWebBridgeManagementHandlers } from "../../src/lib/chatgptWebBridge/managementApi.ts";
import { isPublicApiRoute } from "../../src/shared/constants/publicApiRoutes.ts";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const STATUS_ROUTE = path.join(ROOT, "src/app/api/chatgpt-bridge/status/route.ts");
const PAIRING_ROUTE = path.join(ROOT, "src/app/api/chatgpt-bridge/pairing/route.ts");

function request(pathname: string, method = "GET") {
  return new Request(`http://localhost${pathname}`, { method });
}

function noStore(response: Response): void {
  const cacheControl = response.headers.get("Cache-Control") || "";
  assert.match(cacheControl, /no-store/);
  assert.equal(response.headers.get("Pragma"), "no-cache");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
}

test("management handlers deny before touching bridge state and mark errors no-store", async () => {
  let bridgeRead = 0;
  const denied = new Response(JSON.stringify({ error: "Authentication required" }), { status: 401 });
  const handlers = createChatGptWebBridgeManagementHandlers({
    authorize: async () => denied,
    getBridge: () => {
      bridgeRead++;
      throw new Error("bridge must not be reached before auth");
    },
  });

  const status = await handlers.status(request("/api/chatgpt-bridge/status"));
  assert.equal(status.status, 401);
  noStore(status);
  assert.equal(bridgeRead, 0);

  const pairing = await handlers.createPairing(request("/api/chatgpt-bridge/pairing", "POST"));
  assert.equal(pairing.status, 401);
  noStore(pairing);
  assert.equal(bridgeRead, 0);
});

test("management status is sanitized and pairing codes are ephemeral no-store secrets", async () => {
  const bridge = new ChatGptWebBridgeServer({ maxPendingPairingCodes: 2 });
  const first = bridge.createPairingCode();
  const browser = bridge.pairBrowser(first.code, {
    label: "No identity here",
    tabId: 7,
    availableModels: ["companion"],
  });
  const handlers = createChatGptWebBridgeManagementHandlers({
    authorize: async () => null,
    getBridge: () => bridge,
  });

  const status = await handlers.status(request("/api/chatgpt-bridge/status"));
  assert.equal(status.status, 200);
  noStore(status);
  const statusBody = await status.json();
  assert.deepEqual(statusBody, {
    bridge: {
      pairedBrowserCount: 1,
      activeBrowserCount: 1,
      queuedTurnCount: 0,
      claimedTurnCount: 0,
      availableModels: ["companion"],
    },
  });
  assert.equal(JSON.stringify(statusBody).includes(browser.sessionToken), false);
  assert.equal(JSON.stringify(statusBody).includes("No identity here"), false);

  const pairing = await handlers.createPairing(request("/api/chatgpt-bridge/pairing", "POST"));
  assert.equal(pairing.status, 200);
  noStore(pairing);
  const pairingBody = (await pairing.json()) as { code: string; expiresAt: number };
  assert.equal(typeof pairingBody.code, "string");
  assert.ok(pairingBody.code.length >= 16);
  assert.equal(typeof pairingBody.expiresAt, "number");
  assert.equal(JSON.stringify(pairingBody).includes(browser.sessionToken), false);
  assert.ok(bridge.pairBrowser(pairingBody.code).sessionToken);
});

test("pairing endpoint fails closed once the in-memory pairing budget is exhausted", async () => {
  const bridge = new ChatGptWebBridgeServer({ maxPendingPairingCodes: 1 });
  const handlers = createChatGptWebBridgeManagementHandlers({
    authorize: async () => null,
    getBridge: () => bridge,
  });
  const first = await handlers.createPairing(request("/api/chatgpt-bridge/pairing", "POST"));
  const firstBody = (await first.json()) as { code: string };
  const exhausted = await handlers.createPairing(request("/api/chatgpt-bridge/pairing", "POST"));

  assert.equal(exhausted.status, 503);
  noStore(exhausted);
  const body = await exhausted.text();
  assert.match(body, /Too many pending Companion pairing codes/);
  assert.equal(body.includes(firstBody.code), false);
});

test("dashboard bridge routes stay non-public and always require management auth", () => {
  assert.equal(isPublicApiRoute("/api/chatgpt-bridge/status", "GET"), false);
  assert.equal(isPublicApiRoute("/api/chatgpt-bridge/pairing", "POST"), false);

  for (const route of [STATUS_ROUTE, PAIRING_ROUTE]) {
    const source = fs.readFileSync(route, "utf8");
    assert.match(source, /requireManagementAuth\(request, \{ alwaysRequireAuth: true \}\)/);
    assert.match(source, /createChatGptWebBridgeManagementHandlers/);
    assert.match(source, /force-dynamic/);
  }
});
