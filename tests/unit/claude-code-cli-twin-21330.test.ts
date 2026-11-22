import test from "node:test";
import assert from "node:assert/strict";

import { DefaultExecutor } from "../../open-sse/executors/default.ts";
import { fetchClaudeBootstrap, selectBetaFlags } from "../../open-sse/executors/claudeIdentity.ts";
import {
  FORWARDABLE_CLIENT_BETAS,
  mergeClientAnthropicBeta,
} from "../../open-sse/config/anthropicHeaders.ts";
import { CLI_FINGERPRINTS } from "../../open-sse/config/cliFingerprints.ts";
import { OAUTH_ENDPOINTS } from "../../open-sse/config/constants.ts";
import { computeFingerprint } from "../../open-sse/services/claudeCodeFingerprint.ts";
import { refreshClaudeOAuthToken } from "../../open-sse/services/tokenRefresh/providers/claudeOAuth.ts";
import { CLAUDE_CONFIG } from "../../src/lib/oauth/constants/oauth.ts";
import {
  CLAUDE_CODE_CLIENT_VERSION,
  CLAUDE_CODE_RUNTIME_VERSION,
  CLAUDE_CODE_SDK_PACKAGE_VERSION,
} from "../../src/shared/constants/claudeCodeClient.ts";

const realFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = realFetch;
});

test("Claude Code CLI 2.1.330 twin: native claude OAuth computes dynamic cc_version fingerprint and clean system blocks", async () => {
  const captured: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/api/claude_cli/bootstrap")) {
      return new Response(JSON.stringify({ oauth_account: { account_uuid: "acct-uuid-1234" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    captured.push({
      url: u,
      headers: (init?.headers as Record<string, string>) || {},
      body: String(init?.body ?? ""),
    });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const executor = new DefaultExecutor("claude");
  const msg1 = "Compare cursor positioning with copilot in TypeScript";
  const msg2 = "Explain quantum tunneling in semiconductors";

  for (const userText of [msg1, msg2]) {
    await executor.execute({
      model: "claude-opus-4-7",
      body: {
        model: "claude-opus-4-7",
        max_tokens: 1024,
        system: [
          {
            type: "text",
            text: "x-anthropic-billing-header: cc_version=2.1.0.000; cc_entrypoint=cli; cch=00000;",
          },
          {
            type: "text",
            text: "You are Claude Code, Anthropic's official CLI for Claude.",
            cache_control: { type: "ephemeral", ttl: "1h" },
          },
          { type: "text", text: "__SYSTEM_PROMPT_STATIC_BREAKPOINT__" },
          { type: "text", text: "" },
          {
            type: "text",
            text: "Project instructions mentioning opencode and cursor.",
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content: [{ type: "text", text: userText }] }],
        tools: [{ name: "Bash", description: "Run shell", input_schema: { type: "object" } }],
      },
      stream: false,
      credentials: {
        accessToken: "sk-ant-oat-test-token",
        connectionId: "cc-twin-1",
        providerSpecificData: {},
      },
      clientHeaders: {
        "user-agent": `claude-cli/${CLAUDE_CODE_CLIENT_VERSION} (external, cli)`,
        "x-app": "cli",
        "anthropic-beta":
          "claude-code-20250219,oauth-2025-04-20,effort-2025-11-24,thinking-token-count-2026-05-13,resumption-2026-10-08,tool-provenance-2026-10-26",
        "x-claude-code-prompt-id": "11111111-2222-4333-8444-555555555555",
        "x-claude-code-request-class": "main",
        "x-claude-code-wiggly-dove":
          "983fad3bbb6cff8714b9f0c8bce0d76386cabd5e65e046625c159df3b953f99d",
      },
    } as never);
  }

  assert.equal(captured.length, 2);

  const first = JSON.parse(captured[0].body) as {
    system: Array<{ type: string; text: string; cache_control?: Record<string, string> }>;
    messages: Array<{ role: string; content: Array<{ text: string }> }>;
    metadata: { user_id: string };
  };
  const second = JSON.parse(captured[1].body) as {
    system: Array<{ type: string; text: string }>;
  };

  const expectedFp1 = computeFingerprint(msg1, CLAUDE_CODE_CLIENT_VERSION);
  const expectedFp2 = computeFingerprint(msg2, CLAUDE_CODE_CLIENT_VERSION);
  assert.notEqual(expectedFp1, expectedFp2);

  assert.match(
    first.system[0].text,
    new RegExp(
      `^x-anthropic-billing-header: cc_version=${CLAUDE_CODE_CLIENT_VERSION}\\.${expectedFp1}; cc_entrypoint=cli; cch=(?!00000)[0-9a-f]{5};$`
    )
  );
  assert.match(
    second.system[0].text,
    new RegExp(
      `^x-anthropic-billing-header: cc_version=${CLAUDE_CODE_CLIENT_VERSION}\\.${expectedFp2}; cc_entrypoint=cli; cch=(?!00000)[0-9a-f]{5};$`
    )
  );
  assert.equal(first.system[0].cache_control, undefined);
  assert.equal(first.system[1].text, "You are Claude Code, Anthropic's official CLI for Claude.");
  assert.deepEqual(first.system[1].cache_control, { type: "ephemeral", ttl: "1h" });
  assert.equal(first.system.length, 3, "empty and breakpoint marker blocks must be stripped");
  assert.equal(
    first.system[2].text,
    "Project instructions mentioning opencode and cursor.",
    "CC CLI system text must not be mutated with ZWJ"
  );
  assert.equal(
    first.messages[0].content[0].text,
    msg1,
    "CC CLI user prompt must not be mutated with ZWJ"
  );

  // Headers match 2.1.330 wire profile
  const h = captured[0].headers;
  assert.equal(h["User-Agent"], `claude-cli/${CLAUDE_CODE_CLIENT_VERSION} (external, cli)`);
  assert.equal(h["X-Stainless-Package-Version"], CLAUDE_CODE_SDK_PACKAGE_VERSION);
  assert.equal(h["X-Stainless-Runtime-Version"], CLAUDE_CODE_RUNTIME_VERSION);
  assert.equal(h["x-app"], "cli");
  assert.equal(h["anthropic-dangerous-direct-browser-access"], "true");
  assert.equal(h["x-claude-code-prompt-id"], "11111111-2222-4333-8444-555555555555");
  assert.equal(h["x-claude-code-request-class"], "main");
  assert.equal(
    h["x-claude-code-wiggly-dove"],
    "983fad3bbb6cff8714b9f0c8bce0d76386cabd5e65e046625c159df3b953f99d"
  );

  const betaList = (h["anthropic-beta"] || "").split(",");
  assert.ok(!betaList.includes("mid-conversation-system-2026-04-07"));
  assert.ok(betaList.includes("resumption-2026-10-08"));
  assert.ok(betaList.includes("tool-provenance-2026-10-26"));

  const meta = JSON.parse(first.metadata.user_id) as {
    device_id: string;
    account_uuid: string;
    session_id: string;
  };
  assert.deepEqual(Object.keys(meta), ["device_id", "account_uuid", "session_id"]);
  assert.equal(meta.session_id, h["X-Claude-Code-Session-Id"]);
});

test("Claude Code CLI 2.1.330 twin: non-CLI OAuth callers still get 3rd-party obfuscation and 2.1.330 body field order", async () => {
  const captured: Array<{ body: string }> = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/api/claude_cli/bootstrap")) {
      return new Response("{}", { status: 200 });
    }
    captured.push({ body: String(init?.body ?? "") });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const executor = new DefaultExecutor("claude");
  await executor.execute({
    model: "claude-sonnet-4-6",
    body: {
      model: "claude-sonnet-4-6",
      temperature: 1,
      thinking: { type: "adaptive" },
      max_tokens: 1024,
      system: "Use cursor carefully.",
      messages: [{ role: "user", content: "Explain cursor" }],
    },
    stream: false,
    credentials: {
      accessToken: "sk-ant-oat-test-token",
      connectionId: "cc-twin-non-cli",
      providerSpecificData: {},
    },
    clientHeaders: { "user-agent": "curl/8.0" },
  } as never);

  const parsed = JSON.parse(captured[0].body) as Record<string, unknown>;
  const keys = Object.keys(parsed);
  assert.ok(keys.indexOf("thinking") < keys.indexOf("temperature"));
  assert.ok(
    ((parsed.messages as Array<{ content: string }>)[0].content || "").includes("\u200d"),
    "non-CLI client retains ZWJ obfuscation"
  );
  assert.deepEqual(CLI_FINGERPRINTS.claude.bodyFieldOrder.slice(-5), [
    "output_config",
    "speed",
    "thread",
    "diagnostics",
    "stream",
  ]);
});

test("Claude Code CLI 2.1.330 twin: selectBetaFlags and FORWARDABLE_CLIENT_BETAS match 2.1.330 gating", () => {
  const flags = selectBetaFlags({
    model: "claude-opus-4-7",
    system: "sys",
    tools: [{ name: "Bash" }],
    thread: { type: "create" },
    fallbacks: [{ model: "claude-sonnet-4-6" }],
    safeguards: [{ type: "classifier" }],
    thinking: { type: "adaptive", display: "summarized" },
  });
  const tokens = flags.split(",");
  assert.ok(!tokens.includes("mid-conversation-system-2026-04-07"));
  assert.ok(tokens.includes("message-threads-2026-08-12"));
  assert.ok(tokens.includes("server-side-fallback-2026-06-01"));
  assert.ok(tokens.includes("dangerous-tool-use-2026-09-03"));
  assert.ok(tokens.includes("thinking-display-updates-2026-08-18"));

  const merged = mergeClientAnthropicBeta(
    "oauth-2025-04-20",
    "thinking-resumption-2026-07-17,web-search-results-only-2026-11-15,task-budgets-2026-03-13"
  );
  assert.ok(merged.includes("thinking-resumption-2026-07-17"));
  assert.ok(merged.includes("web-search-results-only-2026-11-15"));
  assert.ok(merged.includes("task-budgets-2026-03-13"));
  assert.ok(FORWARDABLE_CLIENT_BETAS.includes("program-use-case-ids-2026-09-17"));
});

test("Claude Code CLI 2.1.330 twin: OAuth endpoints, scopes, JSON refresh with invalid_scope fallback, and bootstrap", async () => {
  assert.equal(CLAUDE_CONFIG.authorizeUrl, "https://claude.com/cai/oauth/authorize");
  assert.equal(CLAUDE_CONFIG.tokenUrl, "https://platform.claude.com/v1/oauth/token");
  assert.equal(OAUTH_ENDPOINTS.anthropic.token, "https://platform.claude.com/v1/oauth/token");
  assert.ok(CLAUDE_CONFIG.scopes.includes("user:file_upload"));
  assert.ok(CLAUDE_CONFIG.scopes.includes("user:plugins"));
  assert.ok(CLAUDE_CONFIG.scopes.includes("user:privacy_consents:write"));

  const refreshCalls: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    refreshCalls.push({ headers: new Headers(init?.headers), body });
    if (refreshCalls.length === 1) {
      return new Response(JSON.stringify({ error: "invalid_scope" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({
        access_token: "new-at",
        refresh_token: "new-rt",
        expires_in: 3600,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  const refreshed = await refreshClaudeOAuthToken("old-rt", null);
  assert.equal(refreshCalls.length, 2);
  assert.equal(refreshCalls[0].headers.get("content-type"), "application/json");
  assert.equal(typeof refreshCalls[0].body.scope, "string");
  assert.equal(refreshCalls[1].body.scope, undefined);
  assert.deepEqual(refreshed, {
    accessToken: "new-at",
    refreshToken: "new-rt",
    expiresIn: 3600,
  });

  const bootCalls: Array<{ url: string; headers: Headers }> = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    bootCalls.push({ url: String(url), headers: new Headers(init?.headers) });
    return new Response(JSON.stringify({ oauth_account: { account_uuid: "uuid-1" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const boot = await fetchClaudeBootstrap("at-1", {
    entrypoint: "cli",
    model: "claude-opus-4-7",
  });
  assert.equal(boot?.account_uuid, "uuid-1");
  assert.equal(
    bootCalls[0].url,
    "https://api.anthropic.com/api/claude_cli/bootstrap?entrypoint=cli&model=claude-opus-4-7"
  );
  assert.equal(bootCalls[0].headers.get("content-type"), "application/json");
  assert.equal(bootCalls[0].headers.get("user-agent"), `claude-code/${CLAUDE_CODE_CLIENT_VERSION}`);
});
