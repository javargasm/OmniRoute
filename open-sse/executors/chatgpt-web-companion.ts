import { randomUUID } from "node:crypto";
import { BaseExecutor, type ExecuteInput, type ExecutorExecuteResult } from "./base.ts";
import { getChatGptWebBridge } from "@/lib/chatgptWebBridge/bridgeServer.ts";
import type { BridgeTurnEvent } from "@/lib/chatgptWebBridge/types.ts";
import { buildErrorBody, sanitizeErrorMessage } from "../utils/error.ts";

const CHATGPT_COMPANION_URL = "https://chatgpt.com/?temporary-chat=true";
const OPENCODE_RUNTIME_PROMPT_MIN_CHARS = 8_000;
const OPENCODE_RUNTIME_MODEL_MARKER = "You are powered by the model named";
const OPENCODE_RUNTIME_MODEL_ID_MARKER = "The exact model ID is";
const OPENCODE_RUNTIME_ENVIRONMENT_MARKER = "Here is some useful information about the environment";

function textFromMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === undefined || content === null) return "";
  try {
    return JSON.stringify(content) ?? "";
  } catch {
    return String(content);
  }
}

/**
 * OpenCode builds a large system message containing workspace, tool, and runtime
 * instructions. The Companion cannot execute those tools, and pasting the entire
 * envelope into ChatGPT's composer can leave the browser response-less. Preserve
 * a custom agent preamble when one exists, but discard OpenCode's generated tail.
 */
function stripOpenCodeRuntimeEnvelope(text: string): string | null {
  if (
    text.length < OPENCODE_RUNTIME_PROMPT_MIN_CHARS ||
    !text.includes(OPENCODE_RUNTIME_MODEL_MARKER) ||
    !text.includes(OPENCODE_RUNTIME_MODEL_ID_MARKER) ||
    !text.includes(OPENCODE_RUNTIME_ENVIRONMENT_MARKER)
  ) {
    return null;
  }

  const preamble = text.slice(0, text.indexOf(OPENCODE_RUNTIME_MODEL_MARKER)).trim();
  // The built-in Build agent starts directly with OpenCode's own runtime
  // instruction. It carries no user-authored system guidance to retain.
  if (/^You are OpenCode[,.\s]/i.test(preamble)) return "";
  return preamble;
}

export function extractPromptFromInput(body: Record<string, unknown>): { prompt: string } {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const parts: string[] = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const role = (msg as { role?: string }).role;
    const content = (msg as { content?: unknown }).content;
    let text = textFromMessageContent(content);

    if (role === "system" || role === "developer") {
      const strippedRuntimeEnvelope = stripOpenCodeRuntimeEnvelope(text);
      if (strippedRuntimeEnvelope !== null) {
        text = strippedRuntimeEnvelope;
      }
    }

    if (!text.trim()) continue;

    if (role === "system" || role === "developer") {
      parts.push(`[System: ${text}]`);
    } else if (role === "user") {
      parts.push(text);
    } else if (role === "assistant") {
      parts.push(`Assistant: ${text}`);
    }
  }

  if (parts.length === 1 && !parts[0].startsWith("[System:")) {
    return { prompt: parts[0] };
  }

  const prompt = parts.length > 0 ? parts.join("\n\n") : String(body.prompt || "");
  return { prompt };
}

export class ChatGptWebCompanionExecutor extends BaseExecutor {
  constructor() {
    super("chatgpt-web-companion", {
      id: "chatgpt-web-companion",
      baseUrl: "https://chatgpt.com",
    });
  }

  override async execute(input: ExecuteInput): Promise<ExecutorExecuteResult> {
    const bridge = getChatGptWebBridge();
    const status = bridge.getStatus();

    if (status.activeBrowserCount === 0) {
      const errResponse = new Response(
        JSON.stringify(
          buildErrorBody(
            503,
            "ChatGPT Web Companion extension is not connected. Please open Google Chrome with the extension loaded at chrome://extensions and open https://chatgpt.com in a tab.",
            undefined,
            { type: "provider_error", code: "companion_extension_unavailable" }
          )
        ),
        { status: 503, headers: { "Content-Type": "application/json" } }
      );
      return {
        response: errResponse,
        url: CHATGPT_COMPANION_URL,
        headers: {},
        transformedBody: input.body,
      };
    }

    const model = input.model || "chatgpt-web";
    if (!bridge.hasCompatibleBrowserForModel(model)) {
      const errResponse = new Response(
        JSON.stringify(
          buildErrorBody(
            503,
            "No connected ChatGPT Web Companion browser supports the requested model.",
            undefined,
            { type: "provider_error", code: "model_not_supported" }
          )
        ),
        { status: 503, headers: { "Content-Type": "application/json" } }
      );
      return {
        response: errResponse,
        url: CHATGPT_COMPANION_URL,
        headers: {},
        transformedBody: input.body,
      };
    }

    const rawBody =
      input.body && typeof input.body === "object" ? (input.body as Record<string, unknown>) : {};
    const { prompt } = extractPromptFromInput(rawBody);

    const turn = bridge.enqueueTurn({
      requestId: randomUUID(),
      model,
      prompt,
      temporaryChat: true,
      responseFormat: "chat_completions",
    });

    if (input.signal) {
      input.signal.addEventListener(
        "abort",
        () => {
          bridge.cancelTurn(turn.id, "client_disconnected");
        },
        { once: true }
      );
    }

    const streamId = `chatcmpl-${turn.id}`;
    const created = Math.floor(Date.now() / 1000);

    if (input.stream) {
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();

          const unsubscribe = bridge.subscribeToTurn(turn.id, (event: BridgeTurnEvent) => {
            if (event.type === "text_delta" && event.delta) {
              const chunk = {
                id: streamId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [
                  {
                    index: 0,
                    delta: { content: event.delta },
                    finish_reason: null,
                  },
                ],
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            } else if (event.type === "reasoning_delta" && event.delta) {
              const chunk = {
                id: streamId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [
                  {
                    index: 0,
                    delta: { reasoning_content: event.delta },
                    finish_reason: null,
                  },
                ],
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            } else if (event.type === "completed") {
              const chunk = {
                id: streamId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [
                  {
                    index: 0,
                    delta: {},
                    finish_reason: event.finishReason || "stop",
                  },
                ],
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              unsubscribe();
              controller.close();
            } else if (event.type === "error" || event.type === "cancelled") {
              const errMessage =
                event.type === "error" ? event.message : `Turn cancelled: ${event.reason}`;
              const errChunk = {
                error: {
                  message: sanitizeErrorMessage(errMessage || "Turn failed in ChatGPT Web"),
                  type: "provider_error",
                },
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(errChunk)}\n\n`));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              unsubscribe();
              controller.close();
            }
          });
        },
      });

      return {
        response: new Response(stream, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
          },
        }),
        url: CHATGPT_COMPANION_URL,
        headers: {},
        transformedBody: input.body,
      };
    }

    // Non-streaming (JSON)
    const fullText = await new Promise<string>((resolve, reject) => {
      let text = "";
      const unsubscribe = bridge.subscribeToTurn(turn.id, (event: BridgeTurnEvent) => {
        if (event.type === "text_delta" && event.delta) {
          text += event.delta;
        } else if (event.type === "completed") {
          unsubscribe();
          resolve(text);
        } else if (event.type === "error") {
          unsubscribe();
          reject(new Error(event.message || "ChatGPT Web turn failed"));
        } else if (event.type === "cancelled") {
          unsubscribe();
          reject(new Error(`Turn cancelled: ${event.reason}`));
        }
      });
    });

    const responseBody = {
      id: streamId,
      object: "chat.completion",
      created,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: fullText,
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    };

    return {
      response: new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      url: CHATGPT_COMPANION_URL,
      headers: {},
      transformedBody: input.body,
    };
  }
}

export default ChatGptWebCompanionExecutor;
