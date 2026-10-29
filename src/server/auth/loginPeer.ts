/**
 * Where a login attempt comes from, judged from the socket peer the authz pipeline stamps
 * on the request. X-Forwarded-For, X-Real-IP and CF-Connecting-IP are chosen by the caller,
 * so only validated proxy identities may decide a lockout key, never a locality gate.
 */
import { classifyIpScope, type IpScope } from "@/lib/ipUtils";
import {
  AUTHZ_HEADER_TRUSTED_LOGIN_CLIENT_IP,
  AUTHZ_HEADER_TRUSTED_PEER_IP,
} from "@/server/authz/headers";
import { classifyHostLocality } from "@/server/authz/routeGuard";
import { getRequestPeerLocality } from "@/shared/utils/apiAuth";

const UNKNOWN_PEER_KEY = "__unknown_peer__";

/**
 * Key for the failed-attempt lockout: explicitly trusted proxy client, else socket peer. When this process stamps
 * peers but the request carries none, every such request shares one key instead of
 * falling back to a forwarded address that can be rotated for a fresh attempt budget.
 * Without a stamping server (direct handler calls) the forwarded address is all there is.
 */
export function getLoginLockoutKey(request: Request, forwardedIp: string | null): string | null {
  if (!process.env.OMNIROUTE_PEER_STAMP_TOKEN) return forwardedIp;
  return (
    request.headers.get(AUTHZ_HEADER_TRUSTED_LOGIN_CLIENT_IP) ||
    request.headers.get(AUTHZ_HEADER_TRUSTED_PEER_IP) ||
    UNKNOWN_PEER_KEY
  );
}

/** Only the pipeline-validated sentinel can reject an unresolved proxy identity. */
export function hasInvalidLoginClient(request: Request): boolean {
  return (
    Boolean(process.env.OMNIROUTE_PEER_STAMP_TOKEN) &&
    request.headers.get(AUTHZ_HEADER_TRUSTED_LOGIN_CLIENT_IP) === "invalid"
  );
}

/** Audit identity uses the same validated client, without exposing the unknown bucket. */
export function getLoginAuditIp(request: Request, forwardedIp: string | null): string | null {
  const key = getLoginLockoutKey(request, forwardedIp);
  return key === UNKNOWN_PEER_KEY || key === "invalid" ? null : key;
}

/** Origin tag for audit rows, from the stamped peer rather than a forwarded address. */
export function getLoginSourceScope(request: Request, forwardedIp: string | null): IpScope {
  if (!process.env.OMNIROUTE_PEER_STAMP_TOKEN) return classifyIpScope(forwardedIp);
  const locality = getRequestPeerLocality(request);
  return locality === "loopback" ? "loopback" : locality === "lan" ? "private" : "public";
}

/**
 * True for the operator sitting at the host: a loopback socket peer with no proxy hop,
 * addressed by a loopback name. A proxy on the same host that adds no forwarding headers
 * looks like a loopback peer, but it normally passes the public Host through. The Host
 * header is caller-controlled, so it can only narrow this check, never widen it.
 */
export function isHostOperatorRequest(request: Request): boolean {
  if (getRequestPeerLocality(request) !== "loopback") return false;
  let host = request.headers.get("host");
  if (!host) {
    try {
      host = new URL(request.url).host;
    } catch {
      return false;
    }
  }
  return classifyHostLocality(host) === "loopback";
}
