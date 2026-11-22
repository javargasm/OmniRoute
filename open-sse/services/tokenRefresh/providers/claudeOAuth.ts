// @ts-nocheck
// Extracted from open-sse/services/tokenRefresh.ts — see ../shared.ts for
// provenance notes (ported idea from KooshaPari's PR #7338, redone on tip).
import { PROVIDERS, OAUTH_ENDPOINTS } from "../../../config/constants.ts";
import { runWithProxyContext } from "../../../utils/proxyFetch.ts";
import { readRefreshErrorBody } from "../shared.ts";

const CLAUDE_REFRESH_SCOPES = [
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
  "user:plugins",
];

async function postClaudeRefresh(
  refreshToken: string,
  proxyConfig: unknown,
  includeScope: boolean
): Promise<Response> {
  const payload: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: PROVIDERS.claude.clientId,
  };
  if (includeScope) {
    payload.scope = CLAUDE_REFRESH_SCOPES.join(" ");
  }

  return runWithProxyContext(proxyConfig, () =>
    fetch(OAUTH_ENDPOINTS.anthropic.token, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    })
  );
}

/**
 * Specialized refresh for Claude OAuth tokens (mirrors Claude Code CLI 2.1.330).
 */
export async function refreshClaudeOAuthToken(refreshToken, log, proxyConfig: unknown = null) {
  try {
    let response = await postClaudeRefresh(refreshToken, proxyConfig, true);

    if (!response.ok) {
      // Read + classify the body ONCE, shape-agnostic. A proxy/MITM can deliver
      // the invalid_grant 400 as a JSON string, a double-encoded string, a
      // nested {error:{code}}, or raw text — all must yield the sentinel so the
      // HealthCheck deactivates instead of looping every 60s.
      const firstError = await readRefreshErrorBody(response);
      const isInvalidScope =
        firstError.code === "invalid_scope" || /\binvalid_scope\b/i.test(firstError.rawText);
      if (response.status === 400 && isInvalidScope) {
        // Legacy refresh tokens minted before newer scopes were added fail with
        // invalid_scope if the expanded scope list is sent; retry without scope.
        response = await postClaudeRefresh(refreshToken, proxyConfig, false);
        if (!response.ok) {
          const fallbackError = await readRefreshErrorBody(response);
          log?.error?.("TOKEN_REFRESH", "Failed to refresh Claude OAuth token", {
            status: response.status,
            error: fallbackError.rawText.slice(0, 300),
          });
          if (fallbackError.code === "invalid_grant" || fallbackError.code === "invalid_request") {
            return { error: "unrecoverable_refresh_error", code: fallbackError.code };
          }
          return null;
        }
      } else {
        log?.error?.("TOKEN_REFRESH", "Failed to refresh Claude OAuth token", {
          status: response.status,
          error: firstError.rawText.slice(0, 300),
        });
        if (firstError.code === "invalid_grant" || firstError.code === "invalid_request") {
          return { error: "unrecoverable_refresh_error", code: firstError.code };
        }
        return null;
      }
    }

    const tokens = await response.json();

    log?.info?.("TOKEN_REFRESH", "Successfully refreshed Claude OAuth token", {
      hasNewAccessToken: !!tokens.access_token,
      hasNewRefreshToken: !!tokens.refresh_token,
      expiresIn: tokens.expires_in,
    });

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || refreshToken,
      expiresIn: tokens.expires_in,
    };
  } catch (error) {
    log?.error?.("TOKEN_REFRESH", `Network error refreshing Claude token: ${error.message}`);
    return null;
  }
}
