// Floor for the advertised Codex client version, kept in lockstep with the
// `@openai/codex@x.y.z` pin in the root Dockerfile (the CLI installed in the
// OmniRoute image) — bump both together. At runtime OmniRoute tracks newer
// published `@openai/codex` releases on top of this floor
// (src/shared/services/codexClientVersionTracker.ts), so the fingerprint OpenAI
// sees from the OAuth/Responses face — and the models it gates on
// `minimal_client_version` — follow the real client. Setting
// CODEX_CLIENT_VERSION pins an explicit version per deployment and disables
// that tracking.
export const DEFAULT_CODEX_CLIENT_VERSION = "0.154.0";
export const CODEX_CLI_RS_ORIGINATOR = "codex_cli_rs";

export function getCodexCliRsHeaders(
  version = DEFAULT_CODEX_CLIENT_VERSION
): Record<string, string> {
  return {
    "User-Agent": `${CODEX_CLI_RS_ORIGINATOR}/${version}`,
    originator: CODEX_CLI_RS_ORIGINATOR,
  };
}
