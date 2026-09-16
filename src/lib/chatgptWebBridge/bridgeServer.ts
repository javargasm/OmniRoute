import { createHash, randomBytes } from "node:crypto";
import {
  type BridgeBrowserRegistration,
  type BridgeBrowserSession,
  type BridgeClaimedTurn,
  type BridgeCompletedInput,
  type BridgeErrorInput,
  type BridgeEventBase,
  type BridgeIncomingEvent,
  type BridgePairingCode,
  type BridgePairedBrowserSession,
  type BridgeStatus,
  type BridgeTurnEvent,
  type BridgeTurnRequest,
  type BridgeTurnRequestInput,
  type BridgeTurnSnapshot,
  ChatGptWebBridgeError,
  type ChatGptWebBridgeTurnStatus,
} from "./types.ts";

const DEFAULT_PAIRING_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_PENDING_PAIRING_CODES = 8;
const DEFAULT_BROWSER_LEASE_MS = 45_000;
const DEFAULT_TURN_TTL_MS = 3 * 60_000;
const DEFAULT_TURN_LEASE_MS = 30_000;
const DEFAULT_TERMINAL_RETENTION_MS = 5 * 60_000;
const DEFAULT_MAX_PENDING_TURNS = 64;
const DEFAULT_MAX_EVENTS_PER_TURN = 2_048;
const DEFAULT_MAX_EVENT_BYTES = 8 * 1024 * 1024;
const MAX_PROMPT_CHARS = 512_000;
const MAX_EVENT_DELTA_CHARS = 64_000;
const MAX_ERROR_MESSAGE_CHARS = 4_000;
const MAX_SHORT_STRING_CHARS = 256;
const MAX_CLIENT_EVENT_ID_CHARS = 128;
const MAX_MODELS_PER_BROWSER = 128;

type Clock = () => number;
type SecretFactory = (purpose: "pairing" | "browser" | "turn" | "lease") => string;

export interface ChatGptWebBridgeOptions {
  now?: Clock;
  createSecret?: SecretFactory;
  pairingTtlMs?: number;
  maxPendingPairingCodes?: number;
  browserLeaseMs?: number;
  turnTtlMs?: number;
  turnLeaseMs?: number;
  terminalRetentionMs?: number;
  maxPendingTurns?: number;
  maxEventsPerTurn?: number;
  maxEventBytes?: number;
}

interface PairingRecord {
  expiresAt: number;
}

interface BrowserRecord extends BridgeBrowserSession {
  tokenHash: string;
}

interface TurnRecord {
  request: BridgeTurnRequest;
  status: ChatGptWebBridgeTurnStatus;
  claimedByBrowserId: string | null;
  leaseTokenHash: string | null;
  leaseExpiresAt: number | null;
  terminalAt: number | null;
  events: BridgeTurnEvent[];
  eventByteLength: number;
  eventIds: Map<string, BridgeTurnEvent>;
  listeners: Set<(event: BridgeTurnEvent) => void>;
}

function defaultSecretFactory(): string {
  return randomBytes(32).toString("base64url");
}

function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function clampPositiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || !value || value <= 0) return fallback;
  return Math.floor(value);
}

function isTerminal(status: ChatGptWebBridgeTurnStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "expired";
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function requireText(
  value: unknown,
  field: string,
  maxLength: number,
  allowEmpty = false
): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0) || value.length > maxLength) {
    throw new ChatGptWebBridgeError(
      "invalid_bridge_payload",
      `${field} must be a ${allowEmpty ? "string" : "non-empty string"} of at most ${maxLength} characters`
    );
  }
  return value;
}

function normalizeModels(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_MODELS_PER_BROWSER) {
    throw new ChatGptWebBridgeError("invalid_bridge_payload", "availableModels is invalid");
  }
  const models = new Set<string>();
  for (const item of value) models.add(requireText(item, "availableModels entry", MAX_SHORT_STRING_CHARS));
  return [...models];
}

function normalizeBrowserRegistration(input: BridgeBrowserRegistration = {}): BridgeBrowserRegistration {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ChatGptWebBridgeError("invalid_bridge_payload", "browser registration is invalid");
  }
  if (input.tabId !== undefined && (!Number.isInteger(input.tabId) || input.tabId < 0)) {
    throw new ChatGptWebBridgeError("invalid_bridge_payload", "tabId is invalid");
  }
  return {
    ...(input.label === undefined
      ? {}
      : { label: requireText(input.label, "label", MAX_SHORT_STRING_CHARS, true) }),
    ...(input.tabId === undefined ? {} : { tabId: input.tabId }),
    availableModels: normalizeModels(input.availableModels),
  };
}

function cloneBrowser(session: BrowserRecord): BridgeBrowserSession {
  return {
    id: session.id,
    connectedAt: session.connectedAt,
    lastSeenAt: session.lastSeenAt,
    expiresAt: session.expiresAt,
    label: session.label,
    tabId: session.tabId,
    availableModels: [...session.availableModels],
  };
}

function snapshot(turn: TurnRecord): BridgeTurnSnapshot {
  return {
    id: turn.request.id,
    requestId: turn.request.requestId,
    model: turn.request.model,
    status: turn.status,
    createdAt: turn.request.createdAt,
    expiresAt: turn.request.expiresAt,
    claimedByBrowserId: turn.claimedByBrowserId,
    leaseExpiresAt: turn.leaseExpiresAt,
    lastSequence: turn.events.at(-1)?.sequence ?? 0,
    terminalAt: turn.terminalAt,
  };
}

/**
 * In-memory coordinator for a local browser extension. A lease is deliberately
 * failed rather than re-queued when it expires: browser UI submission is not
 * idempotent and replaying it could send a duplicate message to ChatGPT.
 */
export class ChatGptWebBridgeServer {
  private readonly now: Clock;
  private readonly createSecret: SecretFactory;
  private readonly pairingTtlMs: number;
  private readonly maxPendingPairingCodes: number;
  private readonly browserLeaseMs: number;
  private readonly turnTtlMs: number;
  private readonly turnLeaseMs: number;
  private readonly terminalRetentionMs: number;
  private readonly maxPendingTurns: number;
  private readonly maxEventsPerTurn: number;
  private readonly maxEventBytes: number;
  private readonly pairingCodes = new Map<string, PairingRecord>();
  private readonly browsers = new Map<string, BrowserRecord>();
  private readonly browserIdByTokenHash = new Map<string, string>();
  private readonly turns = new Map<string, TurnRecord>();
  private readonly queuedTurnIds: string[] = [];

  constructor(options: ChatGptWebBridgeOptions = {}) {
    this.now = options.now ?? Date.now;
    this.createSecret = options.createSecret ?? defaultSecretFactory;
    this.pairingTtlMs = clampPositiveInteger(options.pairingTtlMs, DEFAULT_PAIRING_TTL_MS);
    this.maxPendingPairingCodes = clampPositiveInteger(
      options.maxPendingPairingCodes,
      DEFAULT_MAX_PENDING_PAIRING_CODES
    );
    this.browserLeaseMs = clampPositiveInteger(options.browserLeaseMs, DEFAULT_BROWSER_LEASE_MS);
    this.turnTtlMs = clampPositiveInteger(options.turnTtlMs, DEFAULT_TURN_TTL_MS);
    this.turnLeaseMs = clampPositiveInteger(options.turnLeaseMs, DEFAULT_TURN_LEASE_MS);
    this.terminalRetentionMs = clampPositiveInteger(
      options.terminalRetentionMs,
      DEFAULT_TERMINAL_RETENTION_MS
    );
    this.maxPendingTurns = clampPositiveInteger(options.maxPendingTurns, DEFAULT_MAX_PENDING_TURNS);
    this.maxEventsPerTurn = clampPositiveInteger(options.maxEventsPerTurn, DEFAULT_MAX_EVENTS_PER_TURN);
    this.maxEventBytes = clampPositiveInteger(options.maxEventBytes, DEFAULT_MAX_EVENT_BYTES);
  }

  createPairingCode(): BridgePairingCode {
    this.sweep();
    if (this.pairingCodes.size >= this.maxPendingPairingCodes) {
      throw new ChatGptWebBridgeError(
        "bridge_capacity_exceeded",
        "too many pending Companion pairing codes"
      );
    }
    const code = this.createUniqueSecret("pairing", this.pairingCodes);
    const expiresAt = this.now() + this.pairingTtlMs;
    this.pairingCodes.set(hashSecret(code), { expiresAt });
    return { code, expiresAt };
  }

  pairBrowser(code: string, registration?: BridgeBrowserRegistration): BridgePairedBrowserSession {
    this.sweep();
    requireText(code, "pairing code", MAX_SHORT_STRING_CHARS);
    // Validate before consuming the one-time code so a malformed extension
    // message cannot remotely burn a pairing attempt the user just approved.
    const normalized = normalizeBrowserRegistration(registration);
    const codeHash = hashSecret(code);
    const record = this.pairingCodes.get(codeHash);
    if (!record || record.expiresAt <= this.now()) {
      this.pairingCodes.delete(codeHash);
      throw new ChatGptWebBridgeError("invalid_pairing_code", "pairing code is invalid or expired");
    }
    this.pairingCodes.delete(codeHash);

    const sessionToken = this.createUniqueSecret("browser", this.browserIdByTokenHash);
    const id = this.createUniqueId("browser");
    const now = this.now();
    const browser: BrowserRecord = {
      id,
      tokenHash: hashSecret(sessionToken),
      connectedAt: now,
      lastSeenAt: now,
      expiresAt: now + this.browserLeaseMs,
      label: normalized.label?.trim() || null,
      tabId: normalized.tabId ?? null,
      availableModels: normalized.availableModels ?? [],
    };
    this.browsers.set(id, browser);
    this.browserIdByTokenHash.set(browser.tokenHash, id);
    return { ...cloneBrowser(browser), sessionToken };
  }

  heartbeat(sessionToken: string, registration?: BridgeBrowserRegistration): BridgeBrowserSession {
    const browser = this.requireBrowser(sessionToken);
    const normalized = registration ? normalizeBrowserRegistration(registration) : null;
    browser.lastSeenAt = this.now();
    browser.expiresAt = browser.lastSeenAt + this.browserLeaseMs;
    if (normalized) {
      if (normalized.label !== undefined) browser.label = normalized.label.trim() || null;
      if (normalized.tabId !== undefined) browser.tabId = normalized.tabId;
      if (normalized.availableModels !== undefined) browser.availableModels = normalized.availableModels;
    }
    return cloneBrowser(browser);
  }

  enqueueTurn(input: BridgeTurnRequestInput): BridgeTurnSnapshot {
    this.sweep();
    if (this.getQueuedTurnCount() >= this.maxPendingTurns) {
      throw new ChatGptWebBridgeError("bridge_capacity_exceeded", "the Companion turn queue is full");
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new ChatGptWebBridgeError("invalid_bridge_payload", "turn request is invalid");
    }
    if (input.temporaryChat !== undefined && typeof input.temporaryChat !== "boolean") {
      throw new ChatGptWebBridgeError("invalid_bridge_payload", "temporaryChat must be a boolean");
    }
    if (
      input.responseFormat !== undefined &&
      input.responseFormat !== "chat_completions" &&
      input.responseFormat !== "responses"
    ) {
      throw new ChatGptWebBridgeError("invalid_bridge_payload", "responseFormat is invalid");
    }
    const now = this.now();
    const request: BridgeTurnRequest = {
      id: this.createUniqueId("turn"),
      requestId: requireText(input.requestId, "requestId", MAX_SHORT_STRING_CHARS),
      model: requireText(input.model, "model", MAX_SHORT_STRING_CHARS),
      prompt: requireText(input.prompt, "prompt", MAX_PROMPT_CHARS),
      temporaryChat: input.temporaryChat !== false,
      responseFormat: input.responseFormat === "responses" ? "responses" : "chat_completions",
      createdAt: now,
      expiresAt: now + this.turnTtlMs,
    };
    const turn: TurnRecord = {
      request,
      status: "queued",
      claimedByBrowserId: null,
      leaseTokenHash: null,
      leaseExpiresAt: null,
      terminalAt: null,
      events: [],
      eventByteLength: 0,
      eventIds: new Map(),
      listeners: new Set(),
    };
    this.turns.set(request.id, turn);
    this.queuedTurnIds.push(request.id);
    return snapshot(turn);
  }

  claimNextTurn(sessionToken: string): BridgeClaimedTurn | null {
    const browser = this.requireBrowser(sessionToken);
    this.touchBrowser(browser);
    if (this.hasClaimedTurn(browser.id)) return null;

    const turn = this.takeNextCompatibleQueuedTurn(browser);
    if (!turn) return null;
    const leaseToken = this.createUniqueId("lease");
    turn.status = "claimed";
    turn.claimedByBrowserId = browser.id;
    turn.leaseTokenHash = hashSecret(leaseToken);
    turn.leaseExpiresAt = this.now() + this.turnLeaseMs;
    return {
      turn: { ...turn.request },
      leaseToken,
      leaseExpiresAt: turn.leaseExpiresAt,
    };
  }

  renewTurnLease(sessionToken: string, turnId: string, leaseToken: string): BridgeTurnSnapshot {
    const turn = this.requireLease(sessionToken, turnId, leaseToken);
    turn.leaseExpiresAt = this.now() + this.turnLeaseMs;
    return snapshot(turn);
  }

  appendTurnEvent(
    sessionToken: string,
    turnId: string,
    leaseToken: string,
    input: BridgeIncomingEvent
  ): BridgeTurnEvent {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new ChatGptWebBridgeError("invalid_bridge_payload", "turn event is invalid");
    }
    const clientEventId = this.clientEventId(input);
    const browser = this.requireBrowser(sessionToken);
    this.touchBrowser(browser);
    requireText(turnId, "turnId", MAX_SHORT_STRING_CHARS);
    requireText(leaseToken, "lease token", MAX_SHORT_STRING_CHARS);
    const turn = this.turns.get(turnId);
    if (!turn) throw new ChatGptWebBridgeError("turn_not_found", "turn was not found");
    if (clientEventId) {
      const existing = turn.eventIds.get(clientEventId);
      // A response can be lost after the extension successfully posts its final
      // event. Preserve the hashed lease only for this no-op retry check; the
      // cleared active lease still prevents any new event after terminality.
      if (existing && turn.leaseTokenHash === hashSecret(leaseToken)) return existing;
    }
    this.requireLease(sessionToken, turnId, leaseToken);
    const event = this.normalizeIncomingEvent(turn, input);
    this.ensureEventCapacity(turn, event);
    this.storeEvent(turn, event, clientEventId);
    if (event.type === "completed") this.markTerminal(turn, "completed");
    if (event.type === "error") this.markTerminal(turn, "failed");
    return event;
  }

  cancelTurn(turnId: string, reason = "client_cancelled"): boolean {
    this.sweep();
    const turn = this.turns.get(turnId);
    if (!turn) throw new ChatGptWebBridgeError("turn_not_found", "turn was not found");
    if (isTerminal(turn.status)) return false;
    const event: BridgeTurnEvent = {
      turnId,
      sequence: this.nextSequence(turn),
      createdAt: this.now(),
      type: "cancelled",
      reason: requireText(reason, "cancel reason", MAX_SHORT_STRING_CHARS),
    };
    this.storeEvent(turn, event);
    this.markTerminal(turn, "cancelled");
    return true;
  }

  getTurnSnapshot(turnId: string): BridgeTurnSnapshot | null {
    this.sweep();
    const turn = this.turns.get(turnId);
    return turn ? snapshot(turn) : null;
  }

  getTurnEvents(turnId: string, afterSequence = 0): BridgeTurnEvent[] {
    this.sweep();
    const turn = this.turns.get(turnId);
    if (!turn) throw new ChatGptWebBridgeError("turn_not_found", "turn was not found");
    const normalizedSequence = Number.isInteger(afterSequence) && afterSequence > 0 ? afterSequence : 0;
    return turn.events.filter((event) => event.sequence > normalizedSequence).map((event) => ({ ...event }));
  }

  subscribeToTurn(
    turnId: string,
    listener: (event: BridgeTurnEvent) => void,
    afterSequence = 0
  ): () => void {
    if (typeof listener !== "function") {
      throw new ChatGptWebBridgeError("invalid_bridge_payload", "turn listener must be a function");
    }
    const turn = this.turns.get(turnId);
    if (!turn) throw new ChatGptWebBridgeError("turn_not_found", "turn was not found");
    for (const event of turn.events) {
      if (event.sequence > afterSequence) this.notifyOne(listener, event);
    }
    turn.listeners.add(listener);
    return () => turn.listeners.delete(listener);
  }

  getStatus(): BridgeStatus {
    this.sweep();
    const now = this.now();
    const activeBrowsers = [...this.browsers.values()].filter((browser) => browser.expiresAt > now);
    return {
      pairedBrowserCount: this.browsers.size,
      activeBrowserCount: activeBrowsers.length,
      queuedTurnCount: this.getQueuedTurnCount(),
      claimedTurnCount: [...this.turns.values()].filter((turn) => turn.status === "claimed").length,
      availableModels: [...new Set(activeBrowsers.flatMap((browser) => browser.availableModels))].sort(),
    };
  }

  /**
   * An empty browser inventory means the local client has not declared a
   * restrictive model list; it may therefore claim a request for any model.
   */
  hasCompatibleBrowserForModel(model: string): boolean {
    requireText(model, "model", MAX_SHORT_STRING_CHARS);
    this.sweep();
    const now = this.now();
    return [...this.browsers.values()].some(
      (browser) =>
        browser.expiresAt > now &&
        (browser.availableModels.length === 0 || browser.availableModels.includes(model))
    );
  }

  /** Remove expired pairing codes/sessions/turns. Safe to call from polling routes. */
  sweep(): void {
    const now = this.now();
    for (const [codeHash, pairing] of this.pairingCodes) {
      if (pairing.expiresAt <= now) this.pairingCodes.delete(codeHash);
    }
    for (const [browserId, browser] of this.browsers) {
      if (browser.expiresAt > now) continue;
      this.browsers.delete(browserId);
      this.browserIdByTokenHash.delete(browser.tokenHash);
      for (const turn of this.turns.values()) {
        if (turn.status === "claimed" && turn.claimedByBrowserId === browserId) {
          this.failTurn(turn, "extension_disconnected", "paired browser stopped heartbeating", true);
        }
      }
    }
    for (const [turnId, turn] of this.turns) {
      if (!isTerminal(turn.status) && turn.request.expiresAt <= now) {
        this.failTurn(turn, "turn_expired", "turn expired before it could complete", true, "expired");
      } else if (
        turn.status === "claimed" &&
        turn.leaseExpiresAt !== null &&
        turn.leaseExpiresAt <= now
      ) {
        // Never re-queue a potentially submitted browser UI turn.
        this.failTurn(turn, "lease_expired", "browser turn lease expired", true);
      }
      if (isTerminal(turn.status) && turn.terminalAt !== null && turn.terminalAt + this.terminalRetentionMs <= now) {
        turn.listeners.clear();
        turn.eventIds.clear();
        this.turns.delete(turnId);
      }
    }
  }

  private createUniqueSecret(
    purpose: "pairing" | "browser" | "turn" | "lease",
    existing: ReadonlyMap<string, unknown>
  ): string {
    for (let attempt = 0; attempt < 8; attempt++) {
      const secret = this.createSecret(purpose);
      if (typeof secret === "string" && secret.length >= 16 && !existing.has(hashSecret(secret))) return secret;
    }
    throw new Error(`could not generate a unique ${purpose} secret`);
  }

  private createUniqueId(purpose: "browser" | "turn" | "lease"): string {
    for (let attempt = 0; attempt < 8; attempt++) {
      const id = `${purpose}_${this.createSecret(purpose)}`;
      const exists =
        purpose === "browser"
          ? this.browsers.has(id)
          : purpose === "turn"
            ? this.turns.has(id)
            : false;
      if (!exists) return id;
    }
    throw new Error(`could not generate a unique ${purpose} id`);
  }

  private requireBrowser(sessionToken: string): BrowserRecord {
    this.sweep();
    requireText(sessionToken, "browser session token", MAX_SHORT_STRING_CHARS);
    const id = this.browserIdByTokenHash.get(hashSecret(sessionToken));
    const browser = id ? this.browsers.get(id) : undefined;
    if (!browser || browser.expiresAt <= this.now()) {
      throw new ChatGptWebBridgeError("extension_not_paired", "browser session is not paired or has expired");
    }
    return browser;
  }

  private touchBrowser(browser: BrowserRecord): void {
    browser.lastSeenAt = this.now();
    browser.expiresAt = browser.lastSeenAt + this.browserLeaseMs;
  }

  private requireLease(sessionToken: string, turnId: string, leaseToken: string): TurnRecord {
    const browser = this.requireBrowser(sessionToken);
    this.touchBrowser(browser);
    requireText(turnId, "turnId", MAX_SHORT_STRING_CHARS);
    requireText(leaseToken, "lease token", MAX_SHORT_STRING_CHARS);
    const turn = this.turns.get(turnId);
    if (!turn) throw new ChatGptWebBridgeError("turn_not_found", "turn was not found");
    if (
      turn.status !== "claimed" ||
      turn.claimedByBrowserId !== browser.id ||
      !turn.leaseTokenHash ||
      turn.leaseTokenHash !== hashSecret(leaseToken) ||
      turn.leaseExpiresAt === null ||
      turn.leaseExpiresAt <= this.now()
    ) {
      throw new ChatGptWebBridgeError("lease_lost", "turn lease is no longer valid");
    }
    return turn;
  }

  private hasClaimedTurn(browserId: string): boolean {
    return [...this.turns.values()].some(
      (turn) => turn.status === "claimed" && turn.claimedByBrowserId === browserId
    );
  }

  private takeNextCompatibleQueuedTurn(browser: BrowserRecord): TurnRecord | null {
    for (let index = 0; index < this.queuedTurnIds.length; index++) {
      const turnId = this.queuedTurnIds[index];
      const turn = this.turns.get(turnId);
      if (!turn || turn.status !== "queued") {
        this.queuedTurnIds.splice(index--, 1);
        continue;
      }
      if (turn.request.expiresAt <= this.now()) {
        this.queuedTurnIds.splice(index--, 1);
        this.failTurn(turn, "turn_expired", "turn expired before it could be claimed", true, "expired");
        continue;
      }
      if (
        browser.availableModels.length > 0 &&
        !browser.availableModels.includes(turn.request.model)
      ) {
        continue;
      }
      this.queuedTurnIds.splice(index, 1);
      return turn;
    }
    return null;
  }

  private getQueuedTurnCount(): number {
    return [...this.turns.values()].filter((turn) => turn.status === "queued").length;
  }

  private clientEventId(input: BridgeIncomingEvent): string | undefined {
    if (input.clientEventId === undefined) return undefined;
    return requireText(input.clientEventId, "clientEventId", MAX_CLIENT_EVENT_ID_CHARS);
  }

  private normalizeIncomingEvent(turn: TurnRecord, input: BridgeIncomingEvent): BridgeTurnEvent {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new ChatGptWebBridgeError("invalid_bridge_payload", "turn event is invalid");
    }
    const base: BridgeEventBase = {
      turnId: turn.request.id,
      sequence: this.nextSequence(turn),
      createdAt: this.now(),
    };
    switch (input.type) {
      case "text_delta":
        return {
          ...base,
          type: "text_delta",
          delta: requireText(input.delta, "text delta", MAX_EVENT_DELTA_CHARS, true),
          ...(input.clientEventId ? { clientEventId: input.clientEventId } : {}),
        };
      case "reasoning_delta":
        return {
          ...base,
          type: "reasoning_delta",
          delta: requireText(input.delta, "reasoning delta", MAX_EVENT_DELTA_CHARS, true),
          ...(input.clientEventId ? { clientEventId: input.clientEventId } : {}),
        };
      case "model":
        return {
          ...base,
          type: "model",
          model: requireText(input.model, "observed model", MAX_SHORT_STRING_CHARS),
          ...(input.clientEventId ? { clientEventId: input.clientEventId } : {}),
        };
      case "error":
        return this.normalizeErrorEvent(base, input);
      case "completed":
        return this.normalizeCompletedEvent(base, input);
      default:
        throw new ChatGptWebBridgeError("invalid_bridge_payload", "turn event type is invalid");
    }
  }

  private normalizeErrorEvent(base: BridgeEventBase, input: BridgeErrorInput): BridgeTurnEvent {
    return {
      ...base,
      type: "error",
      code: requireText(input.code, "error code", MAX_SHORT_STRING_CHARS),
      message: requireText(input.message, "error message", MAX_ERROR_MESSAGE_CHARS),
      retryable: input.retryable === true,
      ...(input.clientEventId ? { clientEventId: input.clientEventId } : {}),
    };
  }

  private normalizeCompletedEvent(base: BridgeEventBase, input: BridgeCompletedInput): BridgeTurnEvent {
    const finishReason = input.finishReason ?? "stop";
    if (!["stop", "length", "content_filter"].includes(finishReason)) {
      throw new ChatGptWebBridgeError("invalid_bridge_payload", "finish reason is invalid");
    }
    return {
      ...base,
      type: "completed",
      finishReason,
      ...(input.clientEventId ? { clientEventId: input.clientEventId } : {}),
    };
  }

  private ensureEventCapacity(turn: TurnRecord, event: BridgeTurnEvent): void {
    if (turn.events.length >= this.maxEventsPerTurn || turn.eventByteLength + byteLength(event) > this.maxEventBytes) {
      this.failTurn(turn, "event_limit_exceeded", "browser emitted too much streaming data", false);
      throw new ChatGptWebBridgeError("bridge_capacity_exceeded", "turn event limit exceeded");
    }
  }

  private storeEvent(turn: TurnRecord, event: BridgeTurnEvent, clientEventId?: string): void {
    turn.events.push(event);
    turn.eventByteLength += byteLength(event);
    if (clientEventId) turn.eventIds.set(clientEventId, event);
    for (const listener of turn.listeners) this.notifyOne(listener, event);
  }

  private notifyOne(listener: (event: BridgeTurnEvent) => void, event: BridgeTurnEvent): void {
    try {
      listener({ ...event });
    } catch {
      // An SSE client can disappear while events are emitted. It must not break the bridge.
    }
  }

  private markTerminal(turn: TurnRecord, status: Extract<ChatGptWebBridgeTurnStatus, "completed" | "failed" | "cancelled" | "expired">): void {
    turn.status = status;
    turn.terminalAt = this.now();
    // Keep the hash briefly so an already-accepted event can be retried
    // idempotently. `leaseExpiresAt` and `claimedByBrowserId` still make the
    // lease inactive, and the whole turn is removed after terminal retention.
    turn.leaseExpiresAt = null;
    turn.claimedByBrowserId = null;
    this.removeQueuedTurnId(turn.request.id);
  }

  private failTurn(
    turn: TurnRecord,
    code: string,
    message: string,
    retryable: boolean,
    terminalStatus: "failed" | "expired" = "failed"
  ): void {
    if (isTerminal(turn.status)) return;
    const event: BridgeTurnEvent = {
      turnId: turn.request.id,
      sequence: this.nextSequence(turn),
      createdAt: this.now(),
      type: "error",
      code,
      message,
      retryable,
    };
    this.storeEvent(turn, event);
    this.markTerminal(turn, terminalStatus);
  }

  private nextSequence(turn: TurnRecord): number {
    return (turn.events.at(-1)?.sequence ?? 0) + 1;
  }

  private removeQueuedTurnId(turnId: string): void {
    const index = this.queuedTurnIds.indexOf(turnId);
    if (index >= 0) this.queuedTurnIds.splice(index, 1);
  }
}

declare global {
  var __omnirouteChatGptWebBridge: ChatGptWebBridgeServer | undefined;
}

/** Process-wide bridge instance for Next route handlers and the executor. */
export function getChatGptWebBridge(): ChatGptWebBridgeServer {
  if (!globalThis.__omnirouteChatGptWebBridge) {
    globalThis.__omnirouteChatGptWebBridge = new ChatGptWebBridgeServer();
  }
  return globalThis.__omnirouteChatGptWebBridge;
}
