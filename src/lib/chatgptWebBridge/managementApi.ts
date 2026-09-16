import {
  getChatGptWebBridge,
  type ChatGptWebBridgeServer,
} from "./bridgeServer.ts";
import { ChatGptWebBridgeError, type BridgeStatus } from "./types.ts";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, no-cache, must-revalidate",
  Pragma: "no-cache",
  Expires: "0",
  "X-Content-Type-Options": "nosniff",
} as const;

type ManagementAuthorizer = (request: Request) => Promise<Response | null>;
type BridgeGetter = () => ChatGptWebBridgeServer;

export type SafeChatGptWebBridgeStatus = Pick<
  BridgeStatus,
  "pairedBrowserCount" | "activeBrowserCount" | "queuedTurnCount" | "claimedTurnCount"
> & {
  availableModels: string[];
};

export interface ChatGptWebBridgeManagementApiDeps {
  authorize: ManagementAuthorizer;
  getBridge?: BridgeGetter;
}

export interface ChatGptWebBridgeManagementHandlers {
  status: (request: Request) => Promise<Response>;
  createPairing: (request: Request) => Promise<Response>;
}

function secureNoStoreHeaders(input?: HeadersInit): Headers {
  const headers = new Headers(input);
  for (const [name, value] of Object.entries(NO_STORE_HEADERS)) headers.set(name, value);
  return headers;
}

export function chatGptWebBridgeNoStoreJson(body: unknown, init: ResponseInit = {}): Response {
  return Response.json(body, {
    ...init,
    headers: secureNoStoreHeaders(init.headers),
  });
}

function noStoreResponse(response: Response): Response {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: secureNoStoreHeaders(response.headers),
  });
}

function safeStatus(status: BridgeStatus): SafeChatGptWebBridgeStatus {
  return {
    pairedBrowserCount: status.pairedBrowserCount,
    activeBrowserCount: status.activeBrowserCount,
    queuedTurnCount: status.queuedTurnCount,
    claimedTurnCount: status.claimedTurnCount,
    availableModels: [...status.availableModels],
  };
}

function unavailable(message: string, code: string): Response {
  return chatGptWebBridgeNoStoreJson(
    { error: { message, type: "server_error", code } },
    { status: 503 }
  );
}

/**
 * The only dashboard-facing bridge operations currently allowed. They reveal a
 * secret only once (the pairing code), never accept browser credentials, and
 * intentionally do not expose turn queue, claim, event, or prompt endpoints.
 */
export function createChatGptWebBridgeManagementHandlers(
  deps: ChatGptWebBridgeManagementApiDeps
): ChatGptWebBridgeManagementHandlers {
  const getBridge = deps.getBridge ?? getChatGptWebBridge;

  async function authenticate(request: Request): Promise<Response | null> {
    try {
      const response = await deps.authorize(request);
      return response ? noStoreResponse(response) : null;
    } catch {
      return unavailable("Companion management authentication is unavailable", "management_auth_unavailable");
    }
  }

  return {
    async status(request: Request): Promise<Response> {
      const authError = await authenticate(request);
      if (authError) return authError;
      try {
        return chatGptWebBridgeNoStoreJson({ bridge: safeStatus(getBridge().getStatus()) });
      } catch {
        return unavailable("Companion bridge status is unavailable", "companion_status_unavailable");
      }
    },

    async createPairing(request: Request): Promise<Response> {
      const authError = await authenticate(request);
      if (authError) return authError;
      try {
        const pairing = getBridge().createPairingCode();
        return chatGptWebBridgeNoStoreJson({ code: pairing.code, expiresAt: pairing.expiresAt });
      } catch (error) {
        if (error instanceof ChatGptWebBridgeError && error.code === "bridge_capacity_exceeded") {
          return unavailable("Too many pending Companion pairing codes", "bridge_capacity_exceeded");
        }
        return unavailable("Could not create a Companion pairing code", "companion_pairing_unavailable");
      }
    },
  };
}
