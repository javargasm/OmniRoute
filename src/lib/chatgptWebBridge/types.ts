/**
 * Process-local contract between the OmniRoute executor and a paired Chrome
 * Companion. It deliberately contains no ChatGPT cookie, storage-state, or
 * account credential fields.
 */

export const CHATGPT_WEB_BRIDGE_TERMINAL_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "expired",
] as const;

export type ChatGptWebBridgeTerminalStatus =
  (typeof CHATGPT_WEB_BRIDGE_TERMINAL_STATUSES)[number];

export type ChatGptWebBridgeTurnStatus =
  | "queued"
  | "claimed"
  | ChatGptWebBridgeTerminalStatus;

export type ChatGptWebBridgeResponseFormat = "chat_completions" | "responses";

export interface BridgeTurnRequestInput {
  /** Correlates bridge work with the originating OmniRoute request; never a prompt. */
  requestId: string;
  /** Provider-qualified model requested by the caller. */
  model: string;
  /** Text rendered by the executor. It stays only in process memory until completion. */
  prompt: string;
  /** Enables a future extension policy without assuming a ChatGPT UI contract today. */
  temporaryChat?: boolean;
  responseFormat?: ChatGptWebBridgeResponseFormat;
}

export interface BridgeTurnRequest extends Required<BridgeTurnRequestInput> {
  id: string;
  createdAt: number;
  expiresAt: number;
}

export interface BridgeBrowserRegistration {
  /** Optional local display label; it must not contain account identity or credentials. */
  label?: string;
  /** Chrome tab ID, used only for local diagnostics and routing. */
  tabId?: number;
  /** Models the extension currently observes as selectable in its attached page. */
  availableModels?: string[];
}

export interface BridgeBrowserSession {
  id: string;
  connectedAt: number;
  lastSeenAt: number;
  expiresAt: number;
  label: string | null;
  tabId: number | null;
  availableModels: string[];
}

/** Returned once when a pairing code is redeemed. Store it in extension storage, never the page. */
export interface BridgePairedBrowserSession extends BridgeBrowserSession {
  sessionToken: string;
}

export interface BridgePairingCode {
  code: string;
  expiresAt: number;
}

export interface BridgeClaimedTurn {
  turn: BridgeTurnRequest;
  leaseToken: string;
  leaseExpiresAt: number;
}

export interface BridgeTextDeltaInput {
  type: "text_delta";
  delta: string;
  /** An extension-generated id makes retried POSTs safe to deduplicate. */
  clientEventId?: string;
}

export interface BridgeReasoningDeltaInput {
  type: "reasoning_delta";
  delta: string;
  clientEventId?: string;
}

export interface BridgeModelInput {
  type: "model";
  model: string;
  clientEventId?: string;
}

export interface BridgeErrorInput {
  type: "error";
  code: string;
  message: string;
  retryable?: boolean;
  clientEventId?: string;
}

export interface BridgeCompletedInput {
  type: "completed";
  finishReason?: "stop" | "length" | "content_filter";
  clientEventId?: string;
}

export type BridgeIncomingEvent =
  | BridgeTextDeltaInput
  | BridgeReasoningDeltaInput
  | BridgeModelInput
  | BridgeErrorInput
  | BridgeCompletedInput;

export interface BridgeEventBase {
  turnId: string;
  sequence: number;
  createdAt: number;
}

export type BridgeTurnEvent =
  | (BridgeEventBase & BridgeTextDeltaInput)
  | (BridgeEventBase & BridgeReasoningDeltaInput)
  | (BridgeEventBase & BridgeModelInput)
  | (BridgeEventBase & BridgeErrorInput)
  | (BridgeEventBase & BridgeCompletedInput)
  | (BridgeEventBase & {
      type: "cancelled";
      reason: string;
    });

export interface BridgeTurnSnapshot {
  id: string;
  requestId: string;
  model: string;
  status: ChatGptWebBridgeTurnStatus;
  createdAt: number;
  expiresAt: number;
  claimedByBrowserId: string | null;
  leaseExpiresAt: number | null;
  lastSequence: number;
  terminalAt: number | null;
}

export interface BridgeStatus {
  pairedBrowserCount: number;
  activeBrowserCount: number;
  queuedTurnCount: number;
  claimedTurnCount: number;
  availableModels: string[];
}

export type ChatGptWebBridgeErrorCode =
  | "invalid_pairing_code"
  | "extension_not_paired"
  | "turn_not_found"
  | "turn_not_claimable"
  | "lease_lost"
  | "invalid_bridge_payload"
  | "bridge_capacity_exceeded";

export class ChatGptWebBridgeError extends Error {
  constructor(
    public readonly code: ChatGptWebBridgeErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ChatGptWebBridgeError";
  }
}
