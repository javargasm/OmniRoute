/**
 * Cursor Agent CLI version constants and string helpers.
 * Platform-independent (no node:fs, node:os, node:path) so it can be safely
 * bundled in client-side / browser code (e.g. via src/lib/oauth/constants/oauth.ts).
 */

/**
 * Pinned Agent CLI build id used when no local install is found (typical
 * headless OmniRoute). Bump when refreshing Cursor CLI impersonation.
 */
export const CURSOR_AGENT_CLI_VERSION = "2026.07.08-0c04a8a";

export const VERSION_ID_RE = /^\d{4}\.\d{2}\.\d{2}-[0-9a-f]+$/;

export function isCursorAgentCliVersionId(value: string): boolean {
  return VERSION_ID_RE.test(value);
}

export function formatCursorAgentClientVersion(id: string): string {
  return `cli-${id}`;
}

/** Extract `versions/<id>` from a resolved agent binary path. */
export function extractVersionIdFromResolvedPath(resolvedPath: string): string | null {
  const parts = resolvedPath.split(/[/\\]/);
  const versionsIdx = parts.lastIndexOf("versions");
  if (versionsIdx < 0 || versionsIdx + 1 >= parts.length) return null;
  const id = parts[versionsIdx + 1];
  return isCursorAgentCliVersionId(id) ? id : null;
}

export function extractVersionIdFromInstallerScript(script: string): string | null {
  const match = script.match(/downloads\.cursor\.com\/lab\/([^/"'\s]+)\//);
  if (!match) return null;
  const id = match[1];
  return isCursorAgentCliVersionId(id) ? id : null;
}
