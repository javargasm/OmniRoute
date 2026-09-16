import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-bridge-autopair-authz-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-secret";

const core = await import("../../../src/lib/db/core.ts");
const settingsDb = await import("../../../src/lib/db/settings.ts");
const pipeline = await import("../../../src/server/authz/pipeline.ts");
const headers = await import("../../../src/server/authz/headers.ts");

const ORIGINAL_STAMP_TOKEN = process.env.OMNIROUTE_PEER_STAMP_TOKEN;

function forwardedAutoPairHeader(response: Response): string | null {
  return response.headers.get(
    `x-middleware-request-${headers.AUTHZ_HEADER_CHATGPT_BRIDGE_AUTO_PAIR}`
  );
}

function pairRequest(peerIp: string, viaProxy = "0"): NextRequest {
  const token = "bridge-auto-pair-stamp";
  return new NextRequest("http://localhost/api/chatgpt-bridge/pair", {
    method: "POST",
    headers: {
      [headers.PEER_IP_HEADER]: `${token}|${peerIp}`,
      [headers.VIA_PROXY_HEADER]: `${token}|${viaProxy}`,
      // Simulate an attacker trying to add the trusted internal verdict themselves.
      [headers.AUTHZ_HEADER_CHATGPT_BRIDGE_AUTO_PAIR]: "1",
    },
  });
}

test.beforeEach(async () => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  process.env.OMNIROUTE_PEER_STAMP_TOKEN = "bridge-auto-pair-stamp";
  await settingsDb.updateSettings({ requireLogin: false });
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (ORIGINAL_STAMP_TOKEN === undefined) delete process.env.OMNIROUTE_PEER_STAMP_TOKEN;
  else process.env.OMNIROUTE_PEER_STAMP_TOKEN = ORIGINAL_STAMP_TOKEN;
});

test("only a direct stamped loopback POST receives the Companion auto-pair verdict", async () => {
  const response = await pipeline.runAuthzPipeline(pairRequest("127.0.0.1"), { enforce: false });

  assert.equal(response.status, 200);
  assert.equal(forwardedAutoPairHeader(response), "1");
  assert.equal(
    response.headers.get(`x-middleware-request-${headers.AUTHZ_HEADER_PEER_LOCALITY}`),
    "loopback"
  );
});

test("remote and proxied loopback requests cannot forge the Companion auto-pair verdict", async () => {
  const remoteResponse = await pipeline.runAuthzPipeline(pairRequest("203.0.113.7"), {
    enforce: false,
  });
  assert.equal(remoteResponse.status, 200);
  assert.equal(forwardedAutoPairHeader(remoteResponse), null);
  assert.equal(
    remoteResponse.headers.get(`x-middleware-request-${headers.AUTHZ_HEADER_PEER_LOCALITY}`),
    "remote"
  );

  const proxiedLoopbackResponse = await pipeline.runAuthzPipeline(pairRequest("127.0.0.1", "1"), {
    enforce: false,
  });
  assert.equal(proxiedLoopbackResponse.status, 200);
  assert.equal(forwardedAutoPairHeader(proxiedLoopbackResponse), null);
  assert.equal(
    proxiedLoopbackResponse.headers.get(
      `x-middleware-request-${headers.AUTHZ_HEADER_PEER_LOCALITY}`
    ),
    "remote"
  );
});
