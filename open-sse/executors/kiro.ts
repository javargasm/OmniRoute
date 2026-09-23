import {
  BaseExecutor,
  mergeUpstreamExtraHeaders,
  type ExecuteInput,
  type ExecutorLog,
  type ProviderCredentials,
} from "./base.ts";
import { PROVIDERS } from "../config/constants.ts";
import { getRegistryEntry } from "../config/providerRegistry.ts";
import { v4 as uuidv4 } from "uuid";
import { getAccessToken } from "../services/tokenRefresh.ts";
import {
  isExternalIdpAuthMethod,
  KIRO_EXTERNAL_IDP_TOKEN_TYPE_HEADER,
  KIRO_EXTERNAL_IDP_TOKEN_TYPE_VALUE,
} from "../services/kiroExternalIdp.ts";
import {
  splitInlineThinking,
  flushPendingThinking,
  type KiroThinkingState,
} from "./kiroThinking.ts";
import {
  ByteQueue,
  KIRO_MAX_EVENTSTREAM_BUFFER_BYTES,
  KIRO_MAX_EVENTSTREAM_FRAME_BYTES,
  KIRO_MAX_EVENTSTREAM_RESPONSE_BYTES,
  KiroEventStreamProtocolError,
  TEXT_ENCODER,
  parseEventFrame,
  extractEventStreamException,
} from "./kiro/eventstream.ts";
import {
  kiroRuntimeHost,
  kiroRuntimeEndpoint,
  resolveKiroRuntimeRegion,
  DEFAULT_PROFILE_ARN,
} from "../services/kiroRegion.ts";
import { getKiroServiceHeaders } from "../config/providerHeaderProfiles.ts";
import {
  KIRO_TOOL_CALL_WRAPPER,
  appendBufferedKiroToolInput,
  encodeSse,
  getBufferedKiroToolInput,
  validateKiroToolCallWrapperInput,
  validateKiroToolName,
  validateKiroToolUse,
  type PendingKiroWrapperToolCall,
} from "./kiroToolCallValidation.ts";

export { validateKiroToolUse } from "./kiroToolCallValidation.ts";

type JsonRecord = Record<string, unknown>;

type UsageSummary = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

type KiroStreamState = {
  endDetected: boolean;
  finishEmitted: boolean;
  startEmitted: boolean;
  stopSeen: boolean;
  /** Authoritative termination marker carried by Kiro's metadataEvent. */
  stopReason?: string;
  hasToolCalls: boolean;
  toolCallIndex: number;
  seenToolIds: Map<string, number>;
  toolArgsEmitted: Map<string, string>;
  toolArgsBuffered: Map<string, { toolIndex: number; canonical: string }>;
  generatedToolIdCounter: number;
  pendingWrapperToolCalls: Map<string, PendingKiroWrapperToolCall>;
  invalidToolCall?: boolean;
  totalContentLength?: number;
  contextUsagePercentage?: number;
  hasContextUsage?: boolean;
  hasMeteringEvent?: boolean;
  usage?: Partial<UsageSummary>;
  hasReasoningContent?: boolean;
  reasoningChunkCount?: number;
  // Inline-thinking splitter state (populated only when thinkingExpected=true).
  thinking?: KiroThinkingState;
};

type KiroEventStreamTransformOptions = {
  thinkingExpected?: boolean;
  /**
   * Narrow-only test/debug seams. Callers can make a limit stricter, never
   * relax the production safety ceilings declared in eventstream.ts.
   */
  maxEventStreamFrameBytes?: number;
  maxEventStreamBufferBytes?: number;
  maxEventStreamResponseBytes?: number;
};

function resolveKiroEventStreamLimit(value: unknown, maximum: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : maximum;
}

/**
 * Flush buffered tool arguments at finish boundaries.
 *
 * Kiro/CodeWhisperer streams toolUseEvent.input as PARTIAL OBJECTS that grow over time
 * (e.g. {command:"cat /home"} then {command:"cat /home/wxsys"}). Re-stringifying each one
 * and emitting it as an OpenAI argument delta produces overlapping prefixes that
 * concatenate into unparseable garbage downstream ("Unterminated string").
 *
 * Fix: defer object-form payloads into state.toolArgsBuffered keyed by toolCallId, keep
 * only the latest canonical, and emit ONCE here as the complete arguments string (the
 * final object is the source of truth — intermediate states are noise). String-form
 * payloads are already concatenable deltas and are emitted incrementally.
 */
export function flushBufferedToolArgs(
  state: Pick<KiroStreamState, "toolArgsBuffered" | "toolArgsEmitted">,
  controller: { enqueue: (chunk: Uint8Array) => void },
  ctx: { responseId: string; created: number; model: string }
): void {
  if (!state.toolArgsBuffered || state.toolArgsBuffered.size === 0) return;
  const { responseId, created, model } = ctx;
  for (const [toolCallId, info] of state.toolArgsBuffered) {
    const alreadyEmitted = state.toolArgsEmitted.get(toolCallId) || "";
    if (info.canonical && info.canonical !== alreadyEmitted) {
      const argsChunk: JsonRecord = {
        id: responseId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: info.toolIndex,
                  function: { arguments: info.canonical },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      };
      controller.enqueue(TEXT_ENCODER.encode(`data: ${JSON.stringify(argsChunk)}\n\n`));
      state.toolArgsEmitted.set(toolCallId, info.canonical);
    }
  }
  state.toolArgsBuffered.clear();
}

function buildKiroFinishChunk(
  state: KiroStreamState,
  responseId: string,
  created: number,
  model: string,
  includeUsage: boolean
): JsonRecord {
  const finishChunk: JsonRecord = {
    id: responseId,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: resolveKiroFinishReason(state),
      },
    ],
  };

  if (includeUsage && state.usage) {
    finishChunk.usage = state.usage;
  }

  return finishChunk;
}

/**
 * Kiro emits the authoritative completion reason in `metadataEvent.stopReason`.
 * Prefer it over local output heuristics: a generation can reach MAX_TOKENS
 * after emitting tool-use-like content, and reporting `tool_calls` in that case
 * would invite an invalid continuation instead of accurately marking truncation.
 */
function resolveKiroFinishReason(
  state: Pick<KiroStreamState, "hasToolCalls" | "stopReason">
): "stop" | "length" | "tool_calls" {
  switch (state.stopReason?.trim().toUpperCase()) {
    case "TOOL_USE":
    case "TOOL_CALLS":
      return "tool_calls";
    case "MAX_TOKENS":
    case "MAX_OUTPUT_TOKENS":
      return "length";
    case "END_TURN":
    case "STOP_SEQUENCE":
    case "STOP":
    case "COMPLETE":
    case "FINISHED":
      return "stop";
    default:
      return state.hasToolCalls ? "tool_calls" : "stop";
  }
}

function readKiroMetadataStopReason(payload: JsonRecord | null): string | undefined {
  if (!payload) return undefined;

  if (typeof payload.stopReason === "string" && payload.stopReason.trim()) {
    return payload.stopReason;
  }

  const nestedMetadata = payload.metadataEvent;
  if (!nestedMetadata || typeof nestedMetadata !== "object" || Array.isArray(nestedMetadata)) {
    return undefined;
  }

  const nestedStopReason = (nestedMetadata as JsonRecord).stopReason;
  return typeof nestedStopReason === "string" && nestedStopReason.trim()
    ? nestedStopReason
    : undefined;
}

/**
 * Kiro's fallback input-token budget when the model is absent from the registry.
 * Mirrors the registry's own `defaultContextLength` and kiro-gateway's
 * DEFAULT_MAX_INPUT_TOKENS.
 */
const KIRO_DEFAULT_MAX_INPUT_TOKENS = 200000;

/**
 * Input-token budget for a Kiro model, used to turn `contextUsagePercentage`
 * into an absolute token count.
 *
 * Kiro reports only a percentage, so the budget it is a percentage OF decides the
 * result. A fixed 200000 undercounts every model with a larger window by the
 * ratio of the two windows — claude-sonnet-5 (1M) by 5x, gpt-5.6-* (272k) by
 * ~26% — and those numbers land in usage_history and the API-key token-limit
 * counters.
 */
function resolveKiroMaxInputTokens(model: string): number {
  const entry = getRegistryEntry("kiro");
  const modelEntry = entry?.models?.find((m) => m.id === model);
  return modelEntry?.contextLength || entry?.defaultContextLength || KIRO_DEFAULT_MAX_INPUT_TOKENS;
}

/**
 * Synthesize a usage block when Kiro sent no token counts of its own.
 *
 * Live `generateAssistantResponse` traffic carries no token counts at all — only
 * `contextUsageEvent.contextUsagePercentage` and a `meteringEvent` credit figure
 * (verified against the live API: frames are assistantResponseEvent /
 * metadataEvent / contextUsageEvent / meteringEvent). So these numbers are
 * ESTIMATES, derived the same way kiro-gateway derives them: the percentage
 * yields the total, the response text yields the completion, and the prompt is
 * the remainder.
 *
 * Subtracting matters: the percentage already covers the whole context, so
 * adding a separately-estimated completion on top would double-count it and
 * inflate `total_tokens`.
 */
function ensureKiroUsage(state: KiroStreamState, model: string) {
  if (state.usage?.total_tokens !== undefined) return;
  const estimatedOutputTokens =
    state.totalContentLength && state.totalContentLength > 0
      ? Math.max(1, Math.floor(state.totalContentLength / 4))
      : 0;

  const estimatedTotalTokens =
    state.contextUsagePercentage && state.contextUsagePercentage > 0
      ? Math.floor((state.contextUsagePercentage * resolveKiroMaxInputTokens(model)) / 100)
      : 0;

  if (estimatedTotalTokens <= 0 && estimatedOutputTokens <= 0) return;
  // Without a percentage there is no total to split, so the output estimate is
  // all that is known and stands on its own.
  if (estimatedTotalTokens <= 0) {
    state.usage = {
      ...state.usage,
      prompt_tokens: 0,
      completion_tokens: estimatedOutputTokens,
      total_tokens: estimatedOutputTokens,
    };
    return;
  }

  const promptTokens = Math.max(0, estimatedTotalTokens - estimatedOutputTokens);

  state.usage = {
    ...state.usage,
    prompt_tokens: promptTokens,
    completion_tokens: estimatedOutputTokens,
    total_tokens: promptTokens + estimatedOutputTokens,
  };
}

/**
 * Resolve the RUNTIME AWS region for a Kiro/CodeWhisperer connection.
 *
 * The runtime region is the region of the Amazon Q Developer profile (embedded in the
 * profileArn — always us-east-1 or eu-central-1), NOT the IAM Identity Center / OIDC token
 * region. An enterprise IdC instance may live in eu-north-1 (or any region), but the Q Developer
 * profile that serves generateAssistantResponse only exists in us-east-1 / eu-central-1, so a
 * runtime call must target the profileArn's region — routing to q.{idcRegion}.amazonaws.com
 * (a host that does not exist) is what caused "no limits + 502 on every request". Delegates to
 * the shared resolver (profileArn region → valid stored profile region → us-east-1). The IdC
 * token region is used only for oidc.{region} token mint/refresh, elsewhere.
 */
export function resolveKiroRegion(
  credentials: { providerSpecificData?: unknown } | null | undefined
): string {
  return resolveKiroRuntimeRegion(
    (credentials?.providerSpecificData || {}) as { region?: unknown; profileArn?: unknown }
  );
}

function isKiroRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Kiro only accepts image attachments on the current user message. The normal
 * OpenAI translator already removes them from history, but direct native Kiro
 * payloads bypass that translator. Clone only changed branches so callers keep
 * their original request body intact.
 */
function stripHistoricalKiroImages(conversationState: unknown): unknown {
  if (!isKiroRecord(conversationState) || !Array.isArray(conversationState.history)) {
    return conversationState;
  }

  let sanitizedHistory: unknown[] | undefined;
  for (const [index, entry] of conversationState.history.entries()) {
    if (!isKiroRecord(entry) || !isKiroRecord(entry.userInputMessage)) continue;
    if (!Object.hasOwn(entry.userInputMessage, "images")) continue;

    if (!sanitizedHistory) sanitizedHistory = [...conversationState.history];
    const userInputMessage = { ...entry.userInputMessage };
    delete userInputMessage.images;
    sanitizedHistory[index] = { ...entry, userInputMessage };
  }

  return sanitizedHistory ? { ...conversationState, history: sanitizedHistory } : conversationState;
}

// Re-exported from the shared region module so existing importers (and tests) that pull
// kiroRuntimeHost from this executor keep working.
export { kiroRuntimeHost };

/**
 * Status codes for which trying the next candidate endpoint may succeed where the
 * current one failed (auth/profile mismatch, not a payload problem). Mirrors
 * 9router's KIRO_ENDPOINT_FALLBACK_STATUSES — a 400 (malformed body) is deliberately
 * excluded since resending the same body to another host cannot fix it.
 */
const KIRO_ENDPOINT_FALLBACK_STATUSES = new Set([401, 403, 404]);

/**
 * KiroExecutor - Executor for Kiro AI (AWS CodeWhisperer)
 * Uses AWS CodeWhisperer streaming API with AWS EventStream binary format
 */
export class KiroExecutor extends BaseExecutor {
  constructor(providerId = "kiro") {
    super(providerId, PROVIDERS[providerId] || PROVIDERS.kiro);
  }

  buildHeaders(credentials: ProviderCredentials, stream = true) {
    void stream;
    const headers: Record<string, string> = {
      ...getKiroServiceHeaders(),
      ...this.config.headers,
      "Amz-Sdk-Request": "attempt=1; max=3",
      "Amz-Sdk-Invocation-Id": uuidv4(),
      "x-amzn-bedrock-cache-control": "enable",
      "anthropic-beta": "prompt-caching-2024-07-31",
    };

    const authMethod =
      typeof credentials.providerSpecificData?.authMethod === "string"
        ? credentials.providerSpecificData.authMethod
        : undefined;
    const isApiKey = authMethod === "api_key";
    const token = isApiKey
      ? credentials.apiKey || credentials.accessToken
      : credentials.accessToken;

    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
      // Long-lived Kiro/CodeWhisperer API keys authenticate with `tokentype: API_KEY`.
      if (isApiKey) headers["tokentype"] = "API_KEY";

      // Enterprise / Microsoft Entra "Your organization" (external_idp) logins send an
      // org-IdP-issued access token. CodeWhisperer only binds it to the Amazon Q Developer
      // profile when the request carries `TokenType: EXTERNAL_IDP`; without it every call
      // returns `ValidationException: Invalid ARN <clientId>` (the service falls back to the
      // token's client id as the resource ARN). AWS SSO (Builder ID / IDC) and social tokens
      // must NOT send this header, so it is gated on the persisted authMethod.
      if (isExternalIdpAuthMethod(authMethod)) {
        headers[KIRO_EXTERNAL_IDP_TOKEN_TYPE_HEADER] = KIRO_EXTERNAL_IDP_TOKEN_TYPE_VALUE;
      }
    }

    return headers;
  }

  transformRequest(model: string, body: unknown, stream: boolean, credentials: unknown): unknown {
    void stream;
    void credentials;
    const b = body as Record<string, unknown>;

    // Kiro API is strict and rejects any unknown top-level fields (like 'tools', 'stream', 'model', etc.)
    // We only preserve the fields specifically built by the openai-to-kiro translator.
    const kiroPayload: Record<string, unknown> = {};
    if (b.conversationState !== undefined) {
      kiroPayload.conversationState = stripHistoricalKiroImages(b.conversationState);
    }
    const creds = credentials as Record<string, unknown> | undefined;
    const authMethod = (creds?.providerSpecificData as Record<string, unknown> | undefined)
      ?.authMethod;
    if (b.profileArn !== undefined) {
      kiroPayload.profileArn = b.profileArn;
    } else if ((creds?.providerSpecificData as Record<string, unknown> | undefined)?.profileArn) {
      kiroPayload.profileArn = (creds?.providerSpecificData as Record<string, unknown>).profileArn;
    } else if (authMethod === "builder-id") {
      // Builder ID is the only profile-less Kiro auth method. Resolve its fallback
      // transiently here so stored OAuth/token metadata remains clean and quota
      // tracking can continue to distinguish genuinely profile-less accounts.
      kiroPayload.profileArn = DEFAULT_PROFILE_ARN;
    }
    if (b.inferenceConfig !== undefined) kiroPayload.inferenceConfig = b.inferenceConfig;
    // Thinking control: `additionalModelRequestFields` ({output_config.effort,
    // thinking:{type:"adaptive"}, max_tokens}) is a recognized top-level field on
    // GenerateAssistantResponse — it steers adaptive reasoning. Built by the
    // openai-to-kiro translator only when the request asked for thinking.
    if (b.additionalModelRequestFields !== undefined)
      kiroPayload.additionalModelRequestFields = b.additionalModelRequestFields;

    // Fallback: if somehow conversationState isn't there, return the rest without model
    // (for backward compatibility if something else bypasses the translator)
    if (!kiroPayload.conversationState) {
      const { model: _model, ...rest } = b;
      return rest;
    }

    return kiroPayload;
  }

  /**
   * Custom execute for Kiro - handles AWS EventStream binary response
   */
  async execute({
    model,
    body,
    stream,
    credentials,
    signal,
    log,
    upstreamExtraHeaders,
  }: ExecuteInput) {
    // Route to the region-specific CodeWhisperer/Amazon Q endpoint. Enterprise IAM Identity
    // Center accounts (e.g. eu-central-1) are rejected by the default us-east-1 host; only the
    // regional endpoint accepts the region-bound token + profileArn.
    const region = resolveKiroRegion(credentials);
    const regionalUrl = `${kiroRuntimeHost(region)}/generateAssistantResponse`;

    // The Kiro IDE's own branded gateway (runtime.*.kiro.dev) only exists for
    // us-east-1 and only accepts Kiro OIDC/social tokens — it rejects
    // TokenType=API_KEY and external-IdP/IdC SSO tokens outright (403 "bearer
    // token invalid"), so those auth methods go straight to the region-resolved
    // CodeWhisperer/Amazon Q surface (mirrors 9router's getOrderedBaseUrls in
    // open-sse/executors/kiro.js). For everything else, try the branded gateway
    // first — it is the surface the native Kiro IDE itself talks to — and fall
    // back to the raw AWS host on an auth/profile-shaped failure.
    const authMethod =
      typeof credentials.providerSpecificData?.authMethod === "string"
        ? credentials.providerSpecificData.authMethod
        : undefined;
    const isCodeWhispererOnly =
      authMethod === "api_key" || authMethod === "idc" || isExternalIdpAuthMethod(authMethod);
    const kiroGatewayUrl = kiroRuntimeEndpoint(region);
    const candidateUrls =
      region === "us-east-1" && !isCodeWhispererOnly
        ? [kiroGatewayUrl, regionalUrl]
        : [regionalUrl];

    const headers = this.buildHeaders(credentials, stream);
    mergeUpstreamExtraHeaders(headers, upstreamExtraHeaders);
    const transformedBody = await this.transformRequest(model, body, stream, credentials);
    const requestBody = JSON.stringify(transformedBody);

    let response!: Response;
    let url = candidateUrls[0];
    for (let i = 0; i < candidateUrls.length; i++) {
      url = candidateUrls[i];
      response = await fetch(url, {
        method: "POST",
        headers,
        body: requestBody,
        signal,
      });
      const hasFallback = i + 1 < candidateUrls.length;
      if (response.ok || !hasFallback || !KIRO_ENDPOINT_FALLBACK_STATUSES.has(response.status)) {
        break;
      }
    }

    if (!response.ok) {
      return { response, url, headers, transformedBody };
    }

    // For Kiro, we need to transform the binary EventStream to SSE.
    // Create a TransformStream to convert binary to SSE text.
    //
    // When the user enabled thinking, Claude on Kiro streams its reasoning
    // **inline** as `<thinking>…</thinking>` blocks inside
    // `assistantResponseEvent.content` rather than as separate
    // `reasoningContentEvent` frames. We pass a hint so the transform stream
    // can split that inline reasoning into the OpenAI `delta.reasoning_content`
    // channel.
    const tb = transformedBody as Record<string, unknown>;
    const userContent =
      ((
        (
          (tb?.conversationState as Record<string, unknown>)?.currentMessage as Record<
            string,
            unknown
          >
        )?.userInputMessage as Record<string, unknown>
      )?.content as string) || "";
    const thinkingExpected =
      userContent.includes("<thinking_mode>enabled</thinking_mode>") ||
      Boolean(tb?.additionalModelRequestFields) ||
      model.includes("-thinking");
    const transformedResponse = this.transformEventStreamToSSE(response, model, {
      thinkingExpected,
    });

    return { response: transformedResponse, url, headers, transformedBody };
  }

  /**
   * Transform AWS EventStream binary response to SSE text stream.
   * Using TransformStream instead of ReadableStream.pull() to avoid Workers timeout.
   *
   * @param response        Upstream raw fetch response (binary EventStream).
   * @param model           Logical model id (kept in OpenAI chunks for clients).
   * @param opts
   * @param opts.thinkingExpected  When true, scan inbound
   *   `assistantResponseEvent.content` for inline `<thinking>…</thinking>` (and variants)
   *   blocks and split them into the OpenAI `delta.reasoning_content` channel.
   *   Required for Claude on Kiro when `<thinking_mode>enabled</thinking_mode>`
   *   is in the system prompt, or when models return inline thinking tags.
   */
  transformEventStreamToSSE(
    response: Response,
    model: string,
    opts: KiroEventStreamTransformOptions = {}
  ) {
    const thinkingExpected = opts.thinkingExpected !== undefined ? opts.thinkingExpected : true;
    const maxEventStreamFrameBytes = resolveKiroEventStreamLimit(
      opts.maxEventStreamFrameBytes,
      KIRO_MAX_EVENTSTREAM_FRAME_BYTES
    );
    const maxEventStreamBufferBytes = resolveKiroEventStreamLimit(
      opts.maxEventStreamBufferBytes,
      KIRO_MAX_EVENTSTREAM_BUFFER_BYTES
    );
    const maxEventStreamResponseBytes = resolveKiroEventStreamLimit(
      opts.maxEventStreamResponseBytes,
      KIRO_MAX_EVENTSTREAM_RESPONSE_BYTES
    );
    // A transport read can legally aggregate many complete EventStream frames.
    // Bound the queue by the total response ceiling, then enforce the smaller
    // incomplete-frame ceiling only when parsing stops on a partial frame.
    const buffer = new ByteQueue(maxEventStreamResponseBytes);
    let totalEventStreamBytes = 0;
    let chunkIndex = 0;
    const responseId = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const state: KiroStreamState = {
      endDetected: false,
      finishEmitted: false,
      startEmitted: false,
      stopSeen: false,
      hasToolCalls: false,
      toolCallIndex: 0,
      seenToolIds: new Map(),
      toolArgsEmitted: new Map(),
      toolArgsBuffered: new Map(),
      generatedToolIdCounter: 0,
      pendingWrapperToolCalls: new Map(),
      hasReasoningContent: false,
      reasoningChunkCount: 0,
      thinking: thinkingExpected ? { thinkingMode: false, pendingTag: "" } : undefined,
    };

    const getToolCallId = (toolUse: JsonRecord): string => {
      if (typeof toolUse.toolUseId === "string" && toolUse.toolUseId) {
        return toolUse.toolUseId;
      }
      state.generatedToolIdCounter += 1;
      return `call_${created}_${state.generatedToolIdCounter}`;
    };

    const emitToolCallStart = (
      controller: TransformStreamDefaultController,
      toolCallId: string,
      toolName: string,
      toolIndex: number
    ) => {
      const startChunk: JsonRecord = {
        id: responseId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {
              ...(chunkIndex === 0 ? { role: "assistant" } : {}),
              tool_calls: [
                {
                  index: toolIndex,
                  id: toolCallId,
                  type: "function",
                  function: { name: toolName, arguments: "" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      };
      chunkIndex += 1;
      controller.enqueue(encodeSse(`data: ${JSON.stringify(startChunk)}\n\n`));
    };

    const emitToolCallArguments = (
      controller: TransformStreamDefaultController,
      toolIndex: number,
      argumentsStr: string
    ) => {
      const argsChunk: JsonRecord = {
        id: responseId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: toolIndex, function: { arguments: argumentsStr } }],
            },
            finish_reason: null,
          },
        ],
      };
      chunkIndex += 1;
      controller.enqueue(encodeSse(`data: ${JSON.stringify(argsChunk)}\n\n`));
    };

    const failInvalidToolCall = (controller: TransformStreamDefaultController, message: string) => {
      const error = {
        error: {
          message,
          type: "invalid_request_error",
          code: "invalid_kiro_tool_call",
        },
      };
      state.invalidToolCall = true;
      state.finishEmitted = true;
      controller.enqueue(encodeSse(`data: ${JSON.stringify(error)}\n\n`));
      controller.enqueue(encodeSse("data: [DONE]\n\n"));
      controller.terminate();
    };

    const failKiroEventStreamProtocol = (
      controller: TransformStreamDefaultController,
      error: KiroEventStreamProtocolError
    ) => {
      const errorPayload = {
        error: {
          message: error.message,
          type: error.type,
          code: error.code,
          param: null,
        },
      };
      controller.enqueue(TEXT_ENCODER.encode(`data: ${JSON.stringify(errorPayload)}\n\n`));
      controller.error(error);
    };

    const flushPendingWrapperToolCalls = (
      controller: TransformStreamDefaultController
    ): boolean => {
      for (const toolCall of state.pendingWrapperToolCalls.values()) {
        const toolInput = getBufferedKiroToolInput(toolCall);
        try {
          validateKiroToolCallWrapperInput(toolInput);
        } catch (error) {
          failInvalidToolCall(controller, error instanceof Error ? error.message : String(error));
          return false;
        }

        const toolIndex = state.toolCallIndex++;
        state.seenToolIds.set(toolCall.toolCallId, toolIndex);
        emitToolCallStart(controller, toolCall.toolCallId, toolCall.toolName, toolIndex);
        const argumentsStr =
          typeof toolInput === "string" ? toolInput : JSON.stringify(toolInput ?? {});
        if (argumentsStr) emitToolCallArguments(controller, toolIndex, argumentsStr);
      }
      state.pendingWrapperToolCalls.clear();
      return true;
    };

    const transformStream = new TransformStream(
      {
        async transform(chunk, controller) {
          if (chunk.length > maxEventStreamResponseBytes - totalEventStreamBytes) {
            failKiroEventStreamProtocol(
              controller,
              new KiroEventStreamProtocolError(
                "kiro_eventstream_response_too_large",
                `Kiro EventStream response exceeded ${maxEventStreamResponseBytes} bytes`
              )
            );
            return;
          }
          totalEventStreamBytes += chunk.length;

          try {
            buffer.push(chunk);
          } catch (error) {
            if (error instanceof KiroEventStreamProtocolError) {
              failKiroEventStreamProtocol(controller, error);
              return;
            }
            throw error;
          }

          // A valid upstream read can contain many EventStream frames. Keep
          // draining complete frames rather than retaining them behind an
          // arbitrary iteration ceiling; yield periodically so a large burst
          // cannot monopolize the event loop.
          let iterations = 0;
          const yieldInterval = 1000;
          while (buffer.length >= 4) {
            iterations++;
            if (iterations % yieldInterval === 0) await Promise.resolve();
            const totalLength = buffer.peekUint32BE(0);

            if (totalLength === null) break;
            if (totalLength < 16) {
              failKiroEventStreamProtocol(
                controller,
                new KiroEventStreamProtocolError(
                  "kiro_eventstream_invalid_frame_length",
                  `Kiro EventStream declared invalid frame length: ${totalLength}`
                )
              );
              return;
            }
            if (totalLength > maxEventStreamFrameBytes) {
              failKiroEventStreamProtocol(
                controller,
                new KiroEventStreamProtocolError(
                  "kiro_eventstream_frame_too_large",
                  `Kiro EventStream frame exceeded ${maxEventStreamFrameBytes} bytes`
                )
              );
              return;
            }
            if (totalLength > buffer.length) {
              if (buffer.length > maxEventStreamBufferBytes) {
                failKiroEventStreamProtocol(
                  controller,
                  new KiroEventStreamProtocolError(
                    "kiro_eventstream_buffer_too_large",
                    `Kiro EventStream incomplete frame exceeded ${maxEventStreamBufferBytes} bytes`
                  )
                );
                return;
              }
              break;
            }

            const eventData = buffer.read(totalLength);
            if (!eventData) break;

            const event = parseEventFrame(eventData);
            if (!event) continue;

            const streamException = extractEventStreamException(event);
            if (streamException) {
              const errorObj = Object.assign(
                new Error(
                  `[Kiro] EventStream exception: ${streamException.exceptionType} - ${streamException.message}`
                ),
                {
                  status: streamException.statusCode,
                  statusCode: streamException.statusCode,
                  code: streamException.errorCode,
                  type: streamException.errorType,
                  exceptionType: streamException.exceptionType,
                  isKiroEventStreamException: true,
                }
              );

              const errorPayload = {
                error: {
                  message: `[Kiro] ${streamException.exceptionType}: ${streamException.message}`,
                  type: streamException.errorType,
                  code: streamException.errorCode,
                  param: null,
                },
              };
              controller.enqueue(TEXT_ENCODER.encode(`data: ${JSON.stringify(errorPayload)}\n\n`));
              controller.error(errorObj);
              return;
            }

            // Emit a role-only start chunk on the FIRST successfully-parsed AWS
            // EventStream frame. CodeWhisperer sends framing/metadata events before
            // the first content token, and on large/agentic contexts the gap before
            // that first `assistantResponseEvent` can be many seconds. The backend
            // stream-readiness gate (ensureStreamReadiness) holds the ENTIRE response
            // from the client until it observes a useful SSE frame, so without an
            // early frame the client sees a frozen connection for that whole window
            // (up to STREAM_READINESS_TIMEOUT_MS — 180s as configured by VibeProxy),
            // then a burst — the "minutes instead of seconds, not streaming" symptom.
            // A role-only `chat.completion.chunk` is a non-ping structured payload, so
            // it satisfies hasStreamReadinessSignal and hands the stream off
            // immediately. Mirrors the early lifecycle frame other executors already
            // emit (Claude message_start / OpenAI response.created). The downstream
            // idle timeout still guards genuine post-start stalls.
            if (!state.startEmitted) {
              state.startEmitted = true;
              const startChunk: JsonRecord = {
                id: responseId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [
                  {
                    index: 0,
                    delta: { role: "assistant" },
                    finish_reason: null,
                  },
                ],
              };
              chunkIndex++;
              controller.enqueue(TEXT_ENCODER.encode(`data: ${JSON.stringify(startChunk)}\n\n`));
            }

            const eventType = event.headers[":event-type"] || "";

            // Track total content length for token estimation
            if (!state.totalContentLength) state.totalContentLength = 0;
            if (!state.contextUsagePercentage) state.contextUsagePercentage = 0;

            // Native reasoning frames. Verified against the live CodeWhisperer
            // stream (2026-07): with adaptive thinking enabled (via
            // additionalModelRequestFields), Kiro streams reasoning as a dedicated
            // `reasoningContentEvent` frame carrying `{ text, signature }` — NOT
            // inline `<thinking>` tags and NOT `assistantResponseEvent`. Some
            // models/variants instead use a `reasoningText` object or a flat
            // `{ text }` (cf. javargasm/pi-kiro `src/event-parser.ts`). OmniRoute
            // had no handler for this event, so the reasoning was silently dropped;
            // route it to the OpenAI `reasoning_content` channel.
            {
              const rp = event.payload as Record<string, unknown> | undefined;
              const rt = rp?.reasoningText;
              const rc = rp?.reasoningContent;
              const red = rp?.redactedContent;
              const hasVisibleAssistantContent =
                eventType === "assistantResponseEvent" &&
                typeof rp?.content === "string" &&
                rp.content.length > 0;
              const isReasoningEvent =
                eventType === "reasoningContentEvent" ||
                rt !== undefined ||
                rc !== undefined ||
                red !== undefined;
              if (isReasoningEvent) {
                let nativeReasoning = "";
                if (typeof rc === "string") {
                  nativeReasoning = rc;
                } else if (rc && typeof rc === "object") {
                  const rco = rc as { text?: unknown; reasoningText?: unknown };
                  if (typeof rco.text === "string") {
                    nativeReasoning = rco.text;
                  } else if (typeof rco.reasoningText === "string") {
                    nativeReasoning = rco.reasoningText;
                  }
                } else if (rt && typeof rt === "object") {
                  const rto = rt as { text?: unknown; Text?: unknown };
                  nativeReasoning =
                    typeof rto.text === "string"
                      ? rto.text
                      : typeof rto.Text === "string"
                        ? rto.Text
                        : "";
                } else if (typeof rt === "string") {
                  nativeReasoning = rt;
                } else if (typeof rp?.text === "string" && !rp?.content) {
                  nativeReasoning = rp.text as string;
                }
                if (nativeReasoning) {
                  state.hasReasoningContent = true;
                  const reasoningDelta: JsonRecord =
                    (state.reasoningChunkCount ?? 0) === 0 && chunkIndex === 0
                      ? { role: "assistant", reasoning_content: nativeReasoning }
                      : { reasoning_content: nativeReasoning };
                  const chunk: JsonRecord = {
                    id: responseId,
                    object: "chat.completion.chunk",
                    created,
                    model,
                    choices: [{ index: 0, delta: reasoningDelta, finish_reason: null }],
                  };
                  chunkIndex++;
                  state.reasoningChunkCount = (state.reasoningChunkCount ?? 0) + 1;
                  controller.enqueue(TEXT_ENCODER.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                }
                // Consume standalone reasoning frames (including signature-only or redacted
                // ones), but preserve visible text when Kiro combines both in one assistant frame.
                if (!hasVisibleAssistantContent) continue;
              }
            }

            // Handle assistantResponseEvent
            if (eventType === "assistantResponseEvent") {
              const content =
                typeof event.payload?.content === "string" ? event.payload.content : "";
              if (!content) {
                continue;
              }
              state.totalContentLength += content.length;

              if (thinkingExpected && state.thinking) {
                // Claude on Kiro emits reasoning inline as `<thinking>…</thinking>`
                // when `<thinking_mode>enabled</thinking_mode>` is in the system prompt.
                // Split it into the OpenAI `reasoning_content` channel so downstream
                // consumers see the same shape they would get from a native reasoning model.
                const thinkingState = state.thinking;
                splitInlineThinking(
                  thinkingState,
                  content,
                  (text) => {
                    if (!text) return;
                    const chunk: JsonRecord = {
                      id: responseId,
                      object: "chat.completion.chunk",
                      created,
                      model,
                      choices: [
                        {
                          index: 0,
                          delta:
                            chunkIndex === 0
                              ? { role: "assistant", content: text }
                              : { content: text },
                          finish_reason: null,
                        },
                      ],
                    };
                    chunkIndex++;
                    controller.enqueue(TEXT_ENCODER.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                  },
                  (reasoning) => {
                    if (!reasoning) return;
                    state.hasReasoningContent = true;
                    const reasoningDelta: JsonRecord =
                      (state.reasoningChunkCount ?? 0) === 0 && chunkIndex === 0
                        ? { role: "assistant", reasoning_content: reasoning }
                        : { reasoning_content: reasoning };
                    const chunk: JsonRecord = {
                      id: responseId,
                      object: "chat.completion.chunk",
                      created,
                      model,
                      choices: [
                        {
                          index: 0,
                          delta: reasoningDelta,
                          finish_reason: null,
                        },
                      ],
                    };
                    chunkIndex++;
                    state.reasoningChunkCount = (state.reasoningChunkCount ?? 0) + 1;
                    controller.enqueue(TEXT_ENCODER.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                  }
                );
              } else {
                const chunk: JsonRecord = {
                  id: responseId,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: chunkIndex === 0 ? { role: "assistant", content } : { content },
                      finish_reason: null,
                    },
                  ],
                };
                chunkIndex++;
                controller.enqueue(TEXT_ENCODER.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              }
            }

            // Handle codeEvent
            if (eventType === "codeEvent" && event.payload?.content) {
              const chunk: JsonRecord = {
                id: responseId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [
                  {
                    index: 0,
                    delta: { content: event.payload.content },
                    finish_reason: null,
                  },
                ],
              };
              chunkIndex++;
              controller.enqueue(TEXT_ENCODER.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            }

            // Handle toolUseEvent
            if (eventType === "toolUseEvent" && event.payload) {
              state.hasToolCalls = true;
              const toolUse = event.payload;
              const toolUses = Array.isArray(toolUse) ? toolUse : [toolUse];

              for (const rawToolUse of toolUses) {
                const singleToolUse = rawToolUse as JsonRecord;
                let toolName: string;
                try {
                  toolName = validateKiroToolName(singleToolUse);
                } catch (error) {
                  failInvalidToolCall(
                    controller,
                    error instanceof Error ? error.message : String(error)
                  );
                  return;
                }

                const toolCallId = getToolCallId(singleToolUse);
                const toolInput = singleToolUse.input;

                if (toolName === KIRO_TOOL_CALL_WRAPPER) {
                  let pending = state.pendingWrapperToolCalls.get(toolCallId);
                  if (!pending) {
                    if (state.seenToolIds.has(toolCallId)) {
                      failInvalidToolCall(
                        controller,
                        "Invalid Kiro tool_call payload: duplicate toolUseId reused by wrapper"
                      );
                      return;
                    }
                    pending = { toolCallId, toolName };
                    state.pendingWrapperToolCalls.set(toolCallId, pending);
                  }
                  try {
                    appendBufferedKiroToolInput(pending, toolInput);
                  } catch (error) {
                    failInvalidToolCall(
                      controller,
                      error instanceof Error ? error.message : String(error)
                    );
                    return;
                  }
                  continue;
                }

                if (state.pendingWrapperToolCalls.has(toolCallId)) {
                  failInvalidToolCall(
                    controller,
                    "Invalid Kiro tool_call payload: mixed wrapper and direct tool fragments"
                  );
                  return;
                }

                let toolIndex;
                const isNewTool = !state.seenToolIds.has(toolCallId);

                if (isNewTool) {
                  toolIndex = state.toolCallIndex++;
                  state.seenToolIds.set(toolCallId, toolIndex);
                  emitToolCallStart(controller, toolCallId, toolName, toolIndex);
                } else {
                  toolIndex = state.seenToolIds.get(toolCallId) as number;
                }

                if (toolInput !== undefined) {
                  if (typeof toolInput === "string") {
                    // String-form payloads are already concatenable incremental deltas —
                    // emit immediately and track what we've sent.
                    state.toolArgsEmitted.set(
                      toolCallId,
                      (state.toolArgsEmitted.get(toolCallId) || "") + toolInput
                    );

                    const argsChunk = {
                      id: responseId,
                      object: "chat.completion.chunk",
                      created,
                      model,
                      choices: [
                        {
                          index: 0,
                          delta: {
                            tool_calls: [
                              {
                                index: toolIndex,
                                function: {
                                  arguments: toolInput,
                                },
                              },
                            ],
                          },
                          finish_reason: null,
                        },
                      ],
                    };
                    chunkIndex++;
                    controller.enqueue(
                      TEXT_ENCODER.encode(`data: ${JSON.stringify(argsChunk)}\n\n`)
                    );
                  } else if (typeof toolInput === "object" && toolInput !== null) {
                    // Object-form payloads are PARTIAL OBJECTS that grow over time. Buffer
                    // the latest canonical and flush once at a finish boundary, otherwise the
                    // overlapping JSON prefixes concatenate into unparseable garbage.
                    state.toolArgsBuffered.set(toolCallId, {
                      toolIndex,
                      canonical: JSON.stringify(toolInput),
                    });
                  }
                }
              }
            }

            // Handle messageStopEvent
            if (eventType === "messageStopEvent") {
              if (!flushPendingWrapperToolCalls(controller)) return;
              flushBufferedToolArgs(state, controller, { responseId, created, model });
              state.stopSeen = true;
            }

            // Handle contextUsageEvent to extract contextUsagePercentage
            if (eventType === "contextUsageEvent") {
              const contextUsage =
                typeof event.payload?.contextUsagePercentage === "number"
                  ? event.payload.contextUsagePercentage
                  : 0;
              if (contextUsage <= 0) {
                continue;
              }
              state.contextUsagePercentage = contextUsage;
              // Mark that we received context usage event
              state.hasContextUsage = true;
            }

            // Handle meteringEvent - mark that we received it
            if (eventType === "meteringEvent") {
              state.hasMeteringEvent = true;
            }

            // Kiro's metadataEvent is the source of truth for completion. The
            // wire format uses values such as TOOL_USE, END_TURN, and
            // MAX_TOKENS; preserve it until the terminal OpenAI SSE chunk is
            // emitted rather than guessing solely from whether a tool frame was
            // observed. Some Kiro payload variants wrap this under metadataEvent.
            if (eventType === "metadataEvent") {
              const stopReason = readKiroMetadataStopReason(event.payload);
              if (stopReason) state.stopReason = stopReason;
            }

            // Handle token usage. Kiro reports it under more than one frame: the
            // `metricsEvent` shape covered by unit tests, and a `metadataEvent`
            // carrying a nested `usage` object — the shape observed on live
            // API-key traffic (see tests/unit/executor-kiro.test.ts, the
            // "live API-key event shape" case, whose frames are
            // assistantResponseEvent / metadataEvent / contextUsageEvent /
            // meteringEvent with no metricsEvent at all). Reading only
            // `metricsEvent` meant cache tokens were never picked up in
            // production even after their field names were corrected, because
            // the branch holding that code never ran.
            if (eventType === "metricsEvent" || eventType === "metadataEvent") {
              const metrics =
                event.payload?.metricsEvent ||
                event.payload?.usage ||
                (event.payload?.metadataEvent as JsonRecord)?.usage ||
                event.payload;
              if (metrics && typeof metrics === "object") {
                const readNumber = (...candidates: unknown[]) =>
                  candidates.find((value) => typeof value === "number") as number | undefined;

                // Bedrock-style (`inputTokens`) and OpenAI-style
                // (`prompt_tokens`) spellings both appear across Kiro frames.
                const inputTokens = readNumber(
                  (metrics as JsonRecord).inputTokens,
                  (metrics as JsonRecord).prompt_tokens
                );
                const outputTokens = readNumber(
                  (metrics as JsonRecord).outputTokens,
                  (metrics as JsonRecord).completion_tokens
                );

                const cacheReadTokens = readNumber(
                  (metrics as JsonRecord).cacheReadInputTokens,
                  (metrics as JsonRecord).cacheReadTokens,
                  (metrics as JsonRecord).cache_read_input_tokens
                );

                const cacheCreationTokens = readNumber(
                  (metrics as JsonRecord).cacheWriteInputTokens,
                  (metrics as JsonRecord).cacheCreationTokens,
                  (metrics as JsonRecord).cache_creation_input_tokens
                );

                const hasNewTotals = inputTokens !== undefined || outputTokens !== undefined;
                const previousUsage = state.usage || {};
                const mergedInputTokens = inputTokens ?? previousUsage.prompt_tokens;
                const mergedOutputTokens = outputTokens ?? previousUsage.completion_tokens;
                const usage: Partial<UsageSummary> = {
                  ...previousUsage,
                  ...(hasNewTotals && {
                    prompt_tokens: mergedInputTokens ?? 0,
                    completion_tokens: mergedOutputTokens ?? 0,
                    total_tokens: (mergedInputTokens ?? 0) + (mergedOutputTokens ?? 0),
                  }),
                  ...(cacheReadTokens !== undefined && {
                    cache_read_input_tokens: cacheReadTokens,
                  }),
                  ...(cacheCreationTokens !== undefined && {
                    cache_creation_input_tokens: cacheCreationTokens,
                  }),
                };

                if (
                  hasNewTotals ||
                  cacheReadTokens !== undefined ||
                  cacheCreationTokens !== undefined
                ) {
                  state.usage = usage;
                }
              }
            }
          }
        },

        flush(controller) {
          if (!flushPendingWrapperToolCalls(controller)) return;
          if (state.invalidToolCall) return;
          if (buffer.length > 0) {
            failKiroEventStreamProtocol(
              controller,
              new KiroEventStreamProtocolError(
                "kiro_eventstream_incomplete_frame",
                "Kiro EventStream ended with an incomplete frame"
              )
            );
            return;
          }
          // Flush any buffered tool arguments (partial-object payloads) before finishing —
          // idempotent against toolArgsEmitted if messageStopEvent already flushed them.
          flushBufferedToolArgs(state, controller, { responseId, created, model });

          // Drain any pending inline-thinking tag fragment so we don't drop
          // trailing characters when the stream ends mid-tag (e.g. `<thi`).
          if (thinkingExpected && state.thinking) {
            const thinkingState = state.thinking;
            flushPendingThinking(
              thinkingState,
              (text) => {
                if (!text) return;
                const chunk: JsonRecord = {
                  id: responseId,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
                };
                chunkIndex++;
                controller.enqueue(TEXT_ENCODER.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              },
              (reasoning) => {
                if (!reasoning) return;
                const chunk: JsonRecord = {
                  id: responseId,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [
                    { index: 0, delta: { reasoning_content: reasoning }, finish_reason: null },
                  ],
                };
                chunkIndex++;
                controller.enqueue(TEXT_ENCODER.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              }
            );
          }

          // Emit finish chunk if not already sent
          if (!state.finishEmitted) {
            state.finishEmitted = true;
            ensureKiroUsage(state, model);
            const finishChunk = buildKiroFinishChunk(state, responseId, created, model, true);
            controller.enqueue(TEXT_ENCODER.encode(`data: ${JSON.stringify(finishChunk)}\n\n`));
          }

          // Send final done message
          controller.enqueue(TEXT_ENCODER.encode("data: [DONE]\n\n"));
        },
      },
      { highWaterMark: 16384 },
      { highWaterMark: 16384 }
    );

    // Pipe response body through transform stream
    const transformedStream = response.body.pipeThrough(transformStream);

    return new Response(transformedStream, {
      status: response.status,
      statusText: response.statusText,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  async refreshCredentials(credentials: ProviderCredentials, log?: ExecutorLog | null) {
    if (credentials.providerSpecificData?.authMethod === "api_key") return null;
    if (!credentials.refreshToken) return null;

    try {
      // Delegate to the central refresh service so reactive 401/403 recovery shares
      // the same per-connection mutex, rotation handling, CAS guard, and atomic
      // onCredentialsRefreshed persistence as proactive refreshes.
      const result = await getAccessToken("kiro", credentials, log);

      if (!result || result.error) return result;

      // If client was re-registered (expired/invalid clientId/clientSecret after DB import,
      // TTL expiry, or browser conflict), update providerSpecificData with new credentials (#2524).
      if (result._newClientId) {
        const updatedPsd = {
          ...(credentials.providerSpecificData || {}),
          clientId: result._newClientId,
          clientSecret: result._newClientSecret,
          clientSecretExpiresAt: result._newClientSecretExpiresAt,
        };
        return {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          expiresIn: result.expiresIn,
          providerSpecificData: updatedPsd,
        };
      }

      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log?.error?.("TOKEN", `Kiro refresh error: ${err.message}`);
      return null;
    }
  }
}

export default KiroExecutor;
