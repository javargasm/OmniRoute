import { test } from "node:test";
import assert from "node:assert";
import { CLAUDE_CONFIG } from "@/lib/oauth/constants/oauth.ts";
import { OAUTH_ENDPOINTS } from "@omniroute/open-sse/config/constants.ts";
import { REGISTRY } from "@omniroute/open-sse/config/providerRegistry.ts";

// Exact-equality assertions (not substring `.includes`) so the host is pinned
// precisely — a substring check would also pass for e.g. `api.anthropic.com.evil`
// (CodeQL js/incomplete-url-substring-sanitization).

test("CLAUDE_CONFIG.tokenUrl uses platform.claude.com (matching Claude Code 2.1.330)", () => {
  assert.equal(CLAUDE_CONFIG.tokenUrl, "https://platform.claude.com/v1/oauth/token");
  assert.equal(CLAUDE_CONFIG.authorizeUrl, "https://claude.com/cai/oauth/authorize");
});

test("OAUTH_ENDPOINTS.anthropic uses platform.claude.com for token and auth", () => {
  assert.equal(OAUTH_ENDPOINTS.anthropic.token, "https://platform.claude.com/v1/oauth/token");
  assert.equal(OAUTH_ENDPOINTS.anthropic.auth, "https://platform.claude.com/oauth/authorize");
});

test("Provider registry claude oauth.tokenUrl uses platform.claude.com", () => {
  const claude = REGISTRY.claude;
  assert.ok(claude, "claude provider should exist in registry");
  assert.equal(claude.oauth.tokenUrl, "https://platform.claude.com/v1/oauth/token");
});

test("No console.anthropic.com remains in OAuth constants or registry", () => {
  const allUrls = [
    CLAUDE_CONFIG.tokenUrl,
    OAUTH_ENDPOINTS.anthropic.token,
    OAUTH_ENDPOINTS.anthropic.auth,
    REGISTRY.claude?.oauth?.tokenUrl,
  ].filter(Boolean) as string[];
  for (const url of allUrls) {
    // Compare the parsed hostname, not a substring, so the check is exact.
    assert.notEqual(
      new URL(url).hostname,
      "console.anthropic.com",
      `Found console.anthropic.com host in ${url}`
    );
  }
});
