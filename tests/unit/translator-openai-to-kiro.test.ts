import test from "node:test";
import assert from "node:assert/strict";

const { buildKiroPayload } = await import("../../open-sse/translator/request/openai-to-kiro.ts");
const { toKiroToolUseId, resolveKiroAssistantMessageId } = await import(
  "../../open-sse/translator/request/openai-to-kiro/messageHelpers.ts"
);

function buildSamplePayload() {
  return buildKiroPayload(
    "claude-sonnet-4",
    {
      messages: [
        { role: "system", content: "Rules" },
        { role: "user", content: "Hello" },
        { role: "assistant", content: "I can help" },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"/tmp/a"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "file contents" },
        {
          role: "user",
          content: [
            { type: "text", text: "Thanks" },
            {
              type: "tool_result",
              tool_use_id: "call_1",
              content: [{ type: "text", text: "done" }],
            },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "read_file",
            description: "Read",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
            },
          },
        },
      ],
      temperature: 0.2,
      top_p: 0.7,
      max_tokens: 2048,
    },
    false,
    { providerSpecificData: { profileArn: "arn:aws:demo" } }
  );
}

test("OpenAI -> Kiro builds a conversation payload with deterministic structure", () => {
  const result = buildSamplePayload();

  assert.equal(result.profileArn, "arn:aws:demo");
  assert.deepEqual(result.inferenceConfig, {
    maxTokens: 2048,
    temperature: 0.2,
    topP: 0.7,
  });
  assert.equal(result.conversationState.chatTriggerType, "MANUAL");
  assert.match(result.conversationState.conversationId, /^[0-9a-f-]{36}$/);
  assert.equal(result.conversationState.currentMessage.userInputMessage.modelId, "claude-sonnet-4");
  assert.equal(result.conversationState.currentMessage.userInputMessage.origin, "KIRO_CLI");
  assert.match(
    result.conversationState.currentMessage.userInputMessage.content,
    /^\[Context: Current time is .*Z\]\n\nThanks$/
  );
});

test("OpenAI -> Kiro preserves prior history, tool uses and accumulated tool results", () => {
  const result = buildSamplePayload();

  assert.equal(result.conversationState.history.length, 2);
  assert.deepEqual(result.conversationState.history[0], {
    userInputMessage: {
      // #2306: the system prompt ("Rules") is wrapped in <system-reminder> before
      // being merged into the Kiro user turn, instead of leaking as raw user text.
      content: "<system-reminder>\nRules\n</system-reminder>\n\nHello",
      modelId: "claude-sonnet-4",
      origin: "KIRO_CLI",
    },
  });
  const asstTurn = result.conversationState.history[1].assistantResponseMessage;
  assert.equal(asstTurn.content, "I can help");
  assert.match(asstTurn.messageId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(asstTurn.toolUses, [
    {
      toolUseId: toKiroToolUseId("call_1"),
      name: "read_file",
      input: { path: "/tmp/a" },
    },
  ]);

  const context = result.conversationState.currentMessage.userInputMessage.userInputMessageContext;
  assert.equal((context.toolResults as any).length, 2);
  assert.deepEqual(context.toolResults[0], {
    toolUseId: toKiroToolUseId("call_1"),
    status: "success",
    content: [{ text: "file contents" }],
  });
  assert.deepEqual(context.toolResults[1], {
    toolUseId: toKiroToolUseId("call_1"),
    status: "success",
    content: [{ text: "done" }],
  });
  assert.equal(context.tools[0].toolSpecification.name, "read_file");
  assert.deepEqual(context.tools[0].toolSpecification.inputSchema.json, {
    type: "object",
    properties: { path: { type: "string" } },
  });
});

test("OpenAI -> Kiro maps invalid or empty assistant tool call arguments to empty input", () => {
  const invalidResult = buildKiroPayload(
    "claude-sonnet-4",
    {
      messages: [
        { role: "user", content: "Call a tool" },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_invalid",
              type: "function",
              function: { name: "read_file", arguments: "{not-json" },
            },
          ],
        },
        { role: "user", content: "continue" },
      ],
    },
    false,
    null
  );

  assert.deepEqual(
    (invalidResult.conversationState.history[1] as any).assistantResponseMessage.toolUses[0].input,
    {}
  );

  const emptyResult = buildKiroPayload(
    "claude-sonnet-4",
    {
      messages: [
        { role: "user", content: "Call a tool" },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_empty",
              type: "function",
              function: { name: "read_file", arguments: "" },
            },
          ],
        },
        { role: "user", content: "continue" },
      ],
    },
    false,
    null
  );

  assert.deepEqual(
    (emptyResult.conversationState.history[1] as any).assistantResponseMessage.toolUses[0].input,
    {}
  );

  const toolUseResult = buildKiroPayload(
    "claude-sonnet-4",
    {
      messages: [
        { role: "user", content: "Call a tool" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_tool_use",
              name: "read_file",
              input: "{not-json",
            },
          ],
        },
        { role: "user", content: "continue" },
      ],
    },
    false,
    null
  );

  assert.deepEqual(
    (toolUseResult.conversationState.history[1] as any).assistantResponseMessage.toolUses[0].input,
    {}
  );
});

test("OpenAI -> Kiro uses a neutral filler currentMessage when the request ends with assistant history (#5231)", () => {
  const result = buildKiroPayload(
    "claude-sonnet-4",
    {
      messages: [
        { role: "user", content: "First user" },
        { role: "assistant", content: "Assistant answer" },
      ],
    },
    false,
    null
  );

  assert.match(
    result.conversationState.currentMessage.userInputMessage.content,
    /^\[Context: Current time is .*Z\]\n\n\.\.\.$/
  );
  assert.deepEqual(result.conversationState.history, [
    {
      userInputMessage: { content: "First user", modelId: "claude-sonnet-4", origin: "KIRO_CLI" },
    },
    {
      assistantResponseMessage: {
        content: "Assistant answer",
        messageId: resolveKiroAssistantMessageId({ content: "Assistant answer" }, 1),
      },
    },
  ]);
});

test("OpenAI -> Kiro derives a stable conversationId for the same first history turn", () => {
  const first = buildSamplePayload();
  const second = buildSamplePayload();

  assert.equal(
    (first.conversationState as any).history[0].userInputMessage.content,
    "<system-reminder>\nRules\n</system-reminder>\n\nHello"
  );
  assert.equal(
    (second as any).conversationState.history[0].userInputMessage.content,
    "<system-reminder>\nRules\n</system-reminder>\n\nHello"
  );
  assert.equal(first.conversationState.conversationId, second.conversationState.conversationId);
});

test("OpenAI -> Kiro still returns a valid payload for minimal requests", () => {
  const result = buildKiroPayload(
    "claude-sonnet-4",
    {
      messages: [{ role: "user", content: "Hi" }],
    },
    false,
    null
  );

  assert.equal(result.conversationState.history.length, 0);
  assert.match(
    result.conversationState.currentMessage.userInputMessage.content,
    /^\[Context: Current time is .*Z\]\n\nHi$/
  );
  assert.equal(result.conversationState.currentMessage.userInputMessage.modelId, "claude-sonnet-4");
});

test("OpenAI -> Kiro merges adjacent user history turns after role normalization", () => {
  const result = buildKiroPayload(
    "claude-sonnet-4",
    {
      messages: [
        { role: "system", content: "System rules" },
        { role: "user", content: "First question" },
        { role: "assistant", content: "Answer 1" },
        { role: "tool", tool_call_id: "call_orphan", content: "tool log" },
        { role: "user", content: "Follow-up" },
      ],
    },
    false,
    null
  );

  const history = result.conversationState.history as Array<{
    userInputMessage?: { content: string };
    assistantResponseMessage?: { content: string };
  }>;

  for (let i = 1; i < history.length; i++) {
    assert.equal(
      Boolean(history[i - 1].userInputMessage) && Boolean(history[i].userInputMessage),
      false,
      "history should not contain adjacent userInputMessage turns"
    );
  }

  const firstUser = history[0].userInputMessage;
  assert.ok(firstUser, "first history turn should be a user turn");
  assert.equal(
    firstUser.content,
    "<system-reminder>\nSystem rules\n</system-reminder>\n\nFirst question"
  );
  assert.equal(history[1].assistantResponseMessage?.content, "Answer 1");
});

test("OpenAI -> Kiro synthesizes tools schema when body.tools is omitted but history has tool_calls", () => {
  const result = buildKiroPayload(
    "claude-opus-4.7",
    {
      messages: [
        { role: "user", content: "Start" },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "tooluse_1",
              type: "function",
              function: { name: "edit", arguments: '{"path":"x"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "tooluse_1", content: "ok" },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "tooluse_2",
              type: "function",
              function: { name: "bash", arguments: '{"cmd":"ls"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "tooluse_2", content: "listing" },
        { role: "user", content: "Continue" },
      ],
    },
    false,
    null
  );

  const ctx = result.conversationState.currentMessage.userInputMessage.userInputMessageContext as {
    tools?: Array<{ toolSpecification: { name: string } }>;
  };
  const tools = ctx?.tools;
  assert.ok(tools, "synthesized tools schema should be attached to currentMessage");
  const names = tools.map((t) => t.toolSpecification.name).sort();
  assert.deepEqual(names, ["bash", "edit"]);
});

test("OpenAI -> Kiro does not override body.tools when caller already provides a schema", () => {
  const result = buildKiroPayload(
    "claude-opus-4.7",
    {
      messages: [
        { role: "user", content: "Start" },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "tooluse_1",
              type: "function",
              function: { name: "read_file", arguments: "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "tooluse_1", content: "ok" },
        { role: "user", content: "Continue" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "read_file",
            description: "Real description",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        },
      ],
    },
    false,
    null
  );

  const ctx = result.conversationState.currentMessage.userInputMessage.userInputMessageContext as {
    tools?: Array<{ toolSpecification: { name: string; description: string } }>;
  };
  const tools = ctx.tools;
  assert.ok(tools);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].toolSpecification.description, "Real description");
});

test("OpenAI -> Kiro synthesizes tools from Anthropic-style tool_use content blocks", () => {
  const result = buildKiroPayload(
    "claude-opus-4.7",
    {
      messages: [
        { role: "user", content: "Start" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Calling tools" },
            { type: "tool_use", id: "tu_1", name: "search", input: { q: "x" } },
            { type: "tool_use", id: "tu_2", name: "open_file", input: { path: "a" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_1", content: [{ type: "text", text: "hit" }] },
            { type: "tool_result", tool_use_id: "tu_2", content: [{ type: "text", text: "ok" }] },
          ],
        },
        { role: "user", content: "continue" },
      ],
    },
    false,
    null
  );

  const ctx = result.conversationState.currentMessage.userInputMessage.userInputMessageContext as {
    tools?: Array<{ toolSpecification: { name: string } }>;
  };
  const tools = ctx?.tools;
  assert.ok(tools, "tools should be synthesized from tool_use content blocks");
  const names = tools.map((t) => t.toolSpecification.name).sort();
  assert.deepEqual(names, ["open_file", "search"]);
});

test("OpenAI -> Kiro attaches tools to currentMessage when history has no user turn to carry them", () => {
  const result = buildKiroPayload(
    "claude-opus-4.7",
    {
      messages: [
        {
          role: "assistant",
          tool_calls: [
            { id: "tc_1", type: "function", function: { name: "edit", arguments: "{}" } },
          ],
        },
      ],
    },
    false,
    null
  );

  const cm = result.conversationState.currentMessage.userInputMessage;
  const ctx = cm.userInputMessageContext as {
    tools?: Array<{ toolSpecification: { name: string } }>;
  };
  assert.ok(ctx?.tools, "tools should be attached to currentMessage fallback");
  assert.equal(ctx.tools!.length, 1);
  assert.equal(ctx.tools![0].toolSpecification.name, "edit");
});

test("OpenAI -> Kiro strips additionalProperties and empty required from tool schemas", () => {
  const result = buildKiroPayload(
    "claude-sonnet-4",
    {
      messages: [{ role: "user", content: "Hi" }],
      tools: [
        {
          type: "function",
          function: {
            name: "test_tool",
            description: "Test",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string", additionalProperties: false },
                nested: {
                  type: "object",
                  properties: { id: { type: "string" } },
                  additionalProperties: true,
                },
              },
              required: [],
              additionalProperties: false,
            },
          },
        },
      ],
    },
    false,
    null
  );

  const schema = result.conversationState.currentMessage.userInputMessage.userInputMessageContext
    ?.tools?.[0]?.toolSpecification?.inputSchema?.json as any;

  assert.ok(schema, "schema should exist");
  assert.equal(
    schema.additionalProperties,
    undefined,
    "top-level additionalProperties should be stripped"
  );
  assert.equal(schema.required, undefined, "empty required should be omitted");
  assert.equal(
    schema.properties.path.additionalProperties,
    undefined,
    "nested additionalProperties should be stripped"
  );
  assert.equal(
    schema.properties.nested.additionalProperties,
    undefined,
    "deep nested additionalProperties should be stripped"
  );
});

test("OpenAI -> Kiro merges consecutive assistant messages", () => {
  const result = buildKiroPayload(
    "claude-sonnet-4",
    {
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Part 1" },
        { role: "assistant", content: "Part 2" },
        { role: "user", content: "Continue" },
      ],
    },
    false,
    null
  );

  const history = result.conversationState.history as any[];
  assert.equal(history.length, 2, "consecutive assistants should be merged into one");
  assert.equal(history[0].userInputMessage.content, "Hello");
  assert.equal(history[1].assistantResponseMessage.content, "Part 1\n\nPart 2");
});

test("OpenAI -> Kiro prepends synthetic user when conversation starts with assistant", () => {
  const result = buildKiroPayload(
    "claude-sonnet-4",
    {
      messages: [
        { role: "assistant", content: "Greeting" },
        { role: "user", content: "Hello" },
      ],
    },
    false,
    null
  );

  const history = result.conversationState.history as any[];
  assert.equal(history.length, 2);
  assert.equal(history[0].userInputMessage.content, "(empty)");
  assert.equal(history[0].userInputMessage.origin, "KIRO_CLI");
  assert.equal(history[1].assistantResponseMessage.content, "Greeting");
});

test("OpenAI -> Kiro converts orphaned tool results to text", () => {
  const result = buildKiroPayload(
    "claude-sonnet-4",
    {
      messages: [
        { role: "user", content: "First" },
        { role: "assistant", content: "Answer" },
        { role: "tool", tool_call_id: "orphan_1", content: "result data" },
        { role: "user", content: "Follow-up" },
      ],
    },
    false,
    null
  );

  const currentMsg = result.conversationState.currentMessage.userInputMessage;
  assert.match(
    currentMsg.content,
    new RegExp(`Follow-up\\n\\n\\[Tool Result \\(${toKiroToolUseId("orphan_1")}\\)\\]\\nresult data$`)
  );
  assert.equal(
    currentMsg.userInputMessageContext,
    undefined,
    "orphaned toolResults should be removed from context"
  );
});

test("OpenAI -> Kiro includes origin on all history user messages", () => {
  const result = buildKiroPayload(
    "claude-sonnet-4",
    {
      messages: [
        { role: "user", content: "A" },
        { role: "assistant", content: "B" },
        { role: "user", content: "C" },
      ],
    },
    false,
    null
  );

  const history = result.conversationState.history as any[];
  assert.equal(history[0].userInputMessage.origin, "KIRO_CLI");
  assert.equal(history[1].assistantResponseMessage.content, "B");
  // Note: last user message becomes currentMessage, not history
  assert.equal(history.length, 2);
});

// ── Defeito 1: status hardcoded como "success" ──────────────────────────────

test("OpenAI -> Kiro maps tool_result is_error:true to status:'error'", () => {
  const result = buildKiroPayload(
    "claude-sonnet-4",
    {
      messages: [
        { role: "user", content: "Run a tool" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_err", name: "bash", input: { cmd: "fail" } }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_err",
              is_error: true,
              content: [{ type: "text", text: "Command not found" }],
            },
          ],
        },
        { role: "user", content: "What happened?" },
      ],
    },
    false,
    null
  );

  const ctx = result.conversationState.currentMessage.userInputMessage.userInputMessageContext as {
    toolResults?: Array<{ toolUseId: string; status: string; content: Array<{ text: string }> }>;
  };
  assert.ok(ctx?.toolResults, "toolResults should be present");
  const errorResult = ctx.toolResults!.find((tr) => tr.toolUseId === toKiroToolUseId("call_err"));
  assert.ok(errorResult, "tool result for call_err should exist");
  assert.equal(errorResult!.status, "error", "is_error:true must map to status:'error'");
  assert.equal(errorResult!.content[0].text, "Command not found");
});

test("OpenAI -> Kiro maps tool_result is_error:false to status:'success'", () => {
  const result = buildKiroPayload(
    "claude-sonnet-4",
    {
      messages: [
        { role: "user", content: "Run a tool" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_ok", name: "bash", input: { cmd: "echo hi" } }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_ok",
              is_error: false,
              content: [{ type: "text", text: "hi" }],
            },
          ],
        },
        { role: "user", content: "Done" },
      ],
    },
    false,
    null
  );

  const ctx = result.conversationState.currentMessage.userInputMessage.userInputMessageContext as {
    toolResults?: Array<{ toolUseId: string; status: string }>;
  };
  const okResult = ctx?.toolResults?.find((tr) => tr.toolUseId === toKiroToolUseId("call_ok"));
  assert.ok(okResult, "tool result for call_ok should exist");
  assert.equal(okResult!.status, "success");
});

// ── Defeito 2: conteúdo não-texto colapsa para string vazia ─────────────────

test("OpenAI -> Kiro serializes image tool_result content to non-empty text", () => {
  const result = buildKiroPayload(
    "claude-sonnet-4",
    {
      messages: [
        { role: "user", content: "Analyze image" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_img", name: "capture_screen", input: {} }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_img",
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/png", data: "abc123" },
                },
              ],
            },
          ],
        },
        { role: "user", content: "What do you see?" },
      ],
    },
    false,
    null
  );

  const ctx = result.conversationState.currentMessage.userInputMessage.userInputMessageContext as {
    toolResults?: Array<{ toolUseId: string; content: Array<{ text: string }> }>;
  };
  const imgResult = ctx?.toolResults?.find((tr) => tr.toolUseId === toKiroToolUseId("call_img"));
  assert.ok(imgResult, "tool result should exist");
  const text = imgResult!.content[0].text;
  assert.ok(text && text.length > 0, `text must not be empty for image content, got: '${text}'`);
});

test("OpenAI -> Kiro serializes JSON-object tool_result content to non-empty text", () => {
  const result = buildKiroPayload(
    "claude-sonnet-4",
    {
      messages: [
        { role: "user", content: "Search files" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "call_json", name: "list_files", input: { path: "/tmp" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_json",
              content: [{ type: "json", data: { files: ["a.txt", "b.ts"] } }],
            },
          ],
        },
        { role: "user", content: "Thanks" },
      ],
    },
    false,
    null
  );

  const ctx = result.conversationState.currentMessage.userInputMessage.userInputMessageContext as {
    toolResults?: Array<{ toolUseId: string; content: Array<{ text: string }> }>;
  };
  const jsonResult = ctx?.toolResults?.find((tr) => tr.toolUseId === toKiroToolUseId("call_json"));
  assert.ok(jsonResult, "tool result should exist");
  const text = jsonResult!.content[0].text;
  assert.ok(text && text.length > 0, `text must be non-empty, got: '${text}'`);
});

test("OpenAI -> Kiro uses placeholder text when tool_result content is empty array", () => {
  const result = buildKiroPayload(
    "claude-sonnet-4",
    {
      messages: [
        { role: "user", content: "Do something" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_empty", name: "no_output_tool", input: {} }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_empty",
              content: [],
            },
          ],
        },
        { role: "user", content: "Continue" },
      ],
    },
    false,
    null
  );

  const ctx = result.conversationState.currentMessage.userInputMessage.userInputMessageContext as {
    toolResults?: Array<{ toolUseId: string; content: Array<{ text: string }> }>;
  };
  const emptyResult = ctx?.toolResults?.find((tr) => tr.toolUseId === toKiroToolUseId("call_empty"));
  assert.ok(emptyResult, "tool result should exist");
  const text = emptyResult!.content[0].text;
  assert.ok(text && text.length > 0, `placeholder text must be non-empty, got: '${text}'`);
});

// ── Defeito 3: instabilidade do toolUseId ───────────────────────────────────

test("OpenAI -> Kiro toolUseId round-trips between tool_use and tool_result in 2-turn conversation", () => {
  // Regressão para issue #2446: conversa 2 turnos (tool_use → tool_result → follow-up)
  const result = buildKiroPayload(
    "claude-sonnet-4",
    {
      messages: [
        { role: "user", content: "Create a folder on the desktop" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_01abc",
              name: "bash",
              input: { cmd: "mkdir ~/Desktop/new_folder" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_01abc",
              is_error: false,
              content: [{ type: "text", text: "" }],
            },
          ],
        },
        { role: "user", content: "Done! What next?" },
      ],
    },
    false,
    null
  );

  const historyAssistant = (result.conversationState.history as any[]).find(
    (h) => h.assistantResponseMessage?.toolUses
  );
  assert.ok(historyAssistant, "assistant turn with toolUses must be in history");
  const toolUse = historyAssistant.assistantResponseMessage.toolUses[0];
  const expectedId = toKiroToolUseId("toolu_01abc");
  assert.equal(toolUse.toolUseId, expectedId, "toolUseId must be preserved/canonicalized");

  const ctx = result.conversationState.currentMessage.userInputMessage.userInputMessageContext as {
    toolResults?: Array<{ toolUseId: string; status: string }>;
  };
  assert.ok(ctx?.toolResults, "toolResults must be present in currentMessage context");
  const tr = ctx.toolResults!.find((r) => r.toolUseId === expectedId);
  assert.ok(tr, `toolResult must reference the same toolUseId '${expectedId}'`);
  assert.equal(tr!.status, "success");
});

test("OpenAI -> Kiro does not inject the '(empty)' placeholder on a trailing tool-result-only turn", () => {
  // Regression for the same bug class as upstream decolua/9router#2183: an agentic
  // loop that ends in a tool-result turn with no follow-up user text must not have
  // its (otherwise legitimately-empty) user content replaced by a placeholder —
  // toolResults already give Kiro all the context it needs for this turn.
  const result = buildKiroPayload(
    "claude-sonnet-4",
    {
      messages: [
        { role: "user", content: "What is 2+2? Use the calc tool." },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "calc", arguments: '{"expr":"2+2"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "4" },
      ],
    },
    false,
    null
  );

  const current = result.conversationState.currentMessage.userInputMessage;
  const ctx = current.userInputMessageContext as {
    toolResults?: Array<{ toolUseId: string }>;
  };

  // The trailing tool-result turn must still carry its toolResults...
  assert.ok(ctx?.toolResults, "toolResults must be present in currentMessage context");
  assert.equal(ctx.toolResults![0].toolUseId, toKiroToolUseId("call_1"));

  // ...and the turn's own body (content minus the injected "[Context: ...]" time
  // prefix, which buildKiroPayload always prepends) must be empty — NOT the
  // literal "(empty)" placeholder, since tool-result context is present.
  const body = current.content.replace(/^\[Context: Current time is [^\]]*\]\n\n/, "");
  assert.equal(body, "");
  assert.ok(!current.content.includes("(empty)"), "must not contain the '(empty)' placeholder");
});

test("OpenAI -> Kiro generates stable non-random toolUseId when tool_call has no id", () => {
  const makePayload = () =>
    buildKiroPayload(
      "claude-sonnet-4",
      {
        messages: [
          { role: "user", content: "Start" },
          {
            role: "assistant",
            tool_calls: [
              {
                type: "function",
                function: { name: "read_file", arguments: '{"path":"/tmp/x"}' },
              },
            ],
          },
          { role: "user", content: "Continue" },
        ],
      },
      false,
      null
    );

  const id1 = (makePayload().conversationState.history as any[]).find(
    (h) => h.assistantResponseMessage?.toolUses
  )?.assistantResponseMessage?.toolUses?.[0]?.toolUseId;

  const id2 = (makePayload().conversationState.history as any[]).find(
    (h) => h.assistantResponseMessage?.toolUses
  )?.assistantResponseMessage?.toolUses?.[0]?.toolUseId;

  assert.ok(id1, "toolUseId must be set even when id is absent");
  assert.equal(id1, id2, "toolUseId must be deterministic (same input → same id)");
});

// Regression for #2446: an OpenAI-style `role:"tool"` message carrying NON-string
// (structured / array) content must not collapse to `content:[{ text: "" }]` —
// CodeWhisperer rejects an empty toolResult with 400 "Improperly formed request".
test("OpenAI -> Kiro serializes non-string role:tool content to non-empty text (#2446)", () => {
  const result = buildKiroPayload(
    "claude-sonnet-4",
    {
      messages: [
        { role: "user", content: "list the files" },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_mem",
              type: "function",
              function: { name: "read_memory", arguments: "{}" },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_mem",
          content: [
            { type: "text", text: "entry A" },
            { type: "text", text: "entry B" },
          ],
        },
        { role: "user", content: "thanks" },
      ],
    },
    true,
    null
  );

  const cs = result.conversationState as any;
  const contexts = [
    cs.currentMessage?.userInputMessage?.userInputMessageContext,
    ...(cs.history as any[]).map((h) => h.userInputMessage?.userInputMessageContext),
  ];
  const toolResults = contexts
    .map((c) => c?.toolResults)
    .find((tr) => Array.isArray(tr) && tr.some((r: any) => r.toolUseId === toKiroToolUseId("call_mem")));
  assert.ok(toolResults, "tool role must produce a toolResult");
  const result0 = toolResults.find((r: any) => r.toolUseId === toKiroToolUseId("call_mem"));
  const text = result0.content[0].text as string;
  assert.notEqual(text, "", "non-string tool content must not collapse to empty string");
  assert.match(text, /entry A/, "serialized content preserves the structured text blocks");
});

// Only Claude models support images in Kiro. Non-Claude Kiro models
// (deepseek-3.2, minimax-m2.5, glm-5, qwen3-coder-next) must NOT
// receive image attachments — attaching them is wrong for those models.
const PNG_DATA_URL = "data:image/png;base64,aGVsbG8=";

function buildImageRequest(model: string) {
  return buildKiroPayload(
    model,
    {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this picture" },
            { type: "image_url", image_url: { url: PNG_DATA_URL } },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } },
            { type: "image", image: PNG_DATA_URL },
          ],
        },
      ],
    },
    false,
    null
  );
}

test("OpenAI -> Kiro attaches images for Claude models", () => {
  const result = buildImageRequest("claude-sonnet-4.6");
  const images = result.conversationState.currentMessage.userInputMessage.images;
  assert.ok(Array.isArray(images), "Claude models must keep image attachments");
  // Three image blocks (image_url + Anthropic base64 + AI SDK-style) → 3 entries
  assert.equal(images.length, 3, "all three supported image part shapes are attached");
  assert.equal(images[0].format, "png");
  assert.ok(images[0].source.bytes, "image bytes are preserved for Claude");
});

test("OpenAI -> Kiro drops images for non-Claude models (deepseek)", () => {
  const result = buildImageRequest("deepseek-3.2");
  const images = result.conversationState.currentMessage.userInputMessage.images;
  assert.ok(
    images === undefined || images.length === 0,
    `non-Claude Kiro models must NOT receive image attachments, got: ${JSON.stringify(images)}`
  );
  // The accompanying text must still survive.
  assert.match(
    result.conversationState.currentMessage.userInputMessage.content,
    /Describe this picture/,
    "text content is preserved even when images are dropped"
  );
});

test("OpenAI -> Kiro drops images for other non-Claude Kiro models", () => {
  for (const model of ["glm-5", "minimax-m2.5", "qwen3-coder-next"]) {
    const result = buildImageRequest(model);
    const images = result.conversationState.currentMessage.userInputMessage.images;
    assert.ok(
      images === undefined || images.length === 0,
      `${model} must NOT receive image attachments, got: ${JSON.stringify(images)}`
    );
  }
});

test("OpenAI -> Kiro canonicalizes only Kiro-supported image formats", () => {
  const image = (media_type: string, data: string) => ({
    type: "image",
    source: { type: "base64", media_type, data },
  });
  const result = buildKiroPayload(
    "claude-sonnet-4.6",
    {
      messages: [
        {
          role: "user",
          content: [
            image("image/png", "png"),
            image("image/jpeg", "jpeg"),
            image("image/jpg", "jpg"),
            image("image/gif", "gif"),
            image("image/webp", "webp"),
            image("image/svg+xml", "svg"),
            image("application/pdf", "pdf"),
            image("image/vnd.microsoft.icon", "ico"),
          ],
        },
      ],
    },
    false,
    null
  );

  const images = result.conversationState.currentMessage.userInputMessage.images;
  assert.deepEqual(
    images?.map((entry) => entry.format),
    ["png", "jpeg", "jpeg", "gif"],
    "unsupported images are omitted and the first four valid images retain order"
  );
  assert.deepEqual(
    images?.map((entry) => entry.source.bytes),
    ["png", "jpeg", "jpg", "gif"]
  );
});

test("OpenAI -> Kiro requires image MIME types and base64 data URLs", () => {
  const image = (media_type: string, data: string) => ({
    type: "image",
    source: { type: "base64", media_type, data },
  });
  const result = buildKiroPayload(
    "claude-sonnet-4.6",
    {
      messages: [
        {
          role: "user",
          content: [
            image("application/png", "wrong-primary-type"),
            image("image/png", "direct-source"),
            { type: "image_url", image_url: { url: "data:image/png,not-base64" } },
            { type: "image_url", image_url: { url: "data:application/png;base64,aGVsbG8=" } },
            { type: "image_url", image_url: { url: "data:image/gif;base64,Z2lm" } },
          ],
        },
      ],
    },
    false,
    null
  );

  assert.deepEqual(
    result.conversationState.currentMessage.userInputMessage.images?.map((entry) => ({
      format: entry.format,
      bytes: entry.source.bytes,
    })),
    [
      { format: "png", bytes: "direct-source" },
      { format: "gif", bytes: "Z2lm" },
    ]
  );
});

test("OpenAI -> Kiro omits oversized and fifth-plus image attachments", () => {
  const image = (data: string, media_type = "image/png") => ({
    type: "image",
    source: { type: "base64", media_type, data },
  });
  const atLimit = "a".repeat(5_000_000);
  const aboveLimit = "b".repeat(5_000_001);
  const result = buildKiroPayload(
    "claude-sonnet-4.6",
    {
      messages: [
        {
          role: "user",
          content: [
            image("ignored-format", "image/svg+xml"),
            image(aboveLimit),
            image(atLimit),
            image("one"),
            image("two"),
            image("three"),
            image("four"),
            image("five"),
          ],
        },
      ],
    },
    false,
    null
  );

  const images = result.conversationState.currentMessage.userInputMessage.images;
  assert.deepEqual(
    images?.map((entry) => entry.source.bytes),
    [atLimit, "one", "two", "three"],
    "the size boundary is accepted, while invalid, oversized, and fifth-plus candidates are omitted"
  );
});

test("OpenAI -> Kiro strips images from history to prevent IMAGE_FORMAT_UNSUPPORTED while preserving currentMessage images", () => {
  const imageBlocks = (prefix: string) =>
    Array.from({ length: 5 }, (_, index) => ({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: `${prefix}-${index + 1}` },
    }));
  const body = {
    messages: [
      { role: "user", content: [{ type: "text", text: "first" }, ...imageBlocks("history-one")] },
      { role: "assistant", content: "acknowledged first" },
      { role: "user", content: [{ type: "text", text: "second" }, ...imageBlocks("history-two")] },
      { role: "assistant", content: "acknowledged second" },
      { role: "user", content: [{ type: "text", text: "third" }, ...imageBlocks("current")] },
    ],
  };
  const originalBody = structuredClone(body);
  const result = buildKiroPayload(
    "claude-sonnet-4.6",
    body,
    false,
    null
  );

  const historicalUsers = result.conversationState.history.filter((entry) => entry.userInputMessage);
  assert.equal(historicalUsers.length, 2);
  for (const historyUser of historicalUsers) {
    assert.equal(
      historyUser.userInputMessage?.images,
      undefined,
      "historical turns must NOT carry images because Kiro returns IMAGE_FORMAT_UNSUPPORTED"
    );
  }
  assert.deepEqual(
    result.conversationState.currentMessage.userInputMessage.images?.map(
      (entry) => entry.source.bytes
    ),
    ["current-1", "current-2", "current-3", "current-4"],
    "current message preserves image attachments up to the 4-image limit"
  );
  assert.deepEqual(body, originalBody, "translation must not mutate the OpenAI input body");
});

test("buildKiroPayload rejects the Anthropic-only [1m] context suffix before Bedrock", () => {
  const body = { messages: [{ role: "user", content: "Hello" }] };

  assert.throws(
    () => buildKiroPayload("claude-sonnet-5-thinking[1m]", body, true, {}),
    /\[1m\]' suffix is not supported by Kiro upstream/,
    "kr/* model ids carrying [1m] must be rejected, not forwarded to AWS Bedrock"
  );
});

test("buildKiroPayload accepts kr/* model ids without the [1m] suffix", () => {
  const body = { messages: [{ role: "user", content: "Hello" }] };

  assert.doesNotThrow(
    () => buildKiroPayload("claude-sonnet-4.5", body, true, {}),
    "model ids without [1m] must continue to build normally"
  );
});

test("buildKiroPayload strips the supported Thinking selector before upstream", () => {
  const body = { messages: [{ role: "user", content: "Hello" }] };

  const result = buildKiroPayload("claude-sonnet-5-thinking", body, true, {});
  assert.equal(
    result.conversationState.currentMessage.userInputMessage.modelId,
    "claude-sonnet-5",
    "the local -thinking alias must not be forwarded to Kiro"
  );
  assert.equal(
    result.additionalModelRequestFields?.output_config?.effort,
    "high",
    "the -thinking selector should still request Kiro adaptive thinking"
  );
});

// Regression for upstream decolua/9router PR #2270: the dash->dot normalization's
// trailing minor-version group must be bounded (1-2 digits), otherwise a
// date-suffixed Claude model id (e.g. claude-opus-4-20250514) gets corrupted into
// "claude-opus-4.20250514" because the unbounded `-(\d+)$` group swallows the
// 8-digit date as if it were a minor version.
test("buildKiroPayload normalizes short dash-suffixed minor versions to dots", () => {
  const body = { messages: [{ role: "user", content: "Hello" }] };

  const opus = buildKiroPayload("claude-opus-4-8", body, false, null);
  assert.equal(
    opus.conversationState.currentMessage.userInputMessage.modelId,
    "claude-opus-4.8",
    "1-digit minor version should normalize dash to dot"
  );

  const sonnet = buildKiroPayload("claude-sonnet-4-6", body, false, null);
  assert.equal(
    sonnet.conversationState.currentMessage.userInputMessage.modelId,
    "claude-sonnet-4.6",
    "1-digit minor version should normalize dash to dot (sonnet)"
  );
});

test("buildKiroPayload does not corrupt date-suffixed Claude model ids (#2270)", () => {
  const body = { messages: [{ role: "user", content: "Hello" }] };

  const result = buildKiroPayload("claude-opus-4-20250514", body, false, null);
  assert.equal(
    result.conversationState.currentMessage.userInputMessage.modelId,
    "claude-opus-4-20250514",
    "date-suffixed model ids (3+ digit trailing group) must NOT be dash->dot normalized"
  );
});

test("buildKiroPayload leaves already-two-dash Claude ids unchanged (#2270)", () => {
  const body = { messages: [{ role: "user", content: "Hello" }] };

  const result = buildKiroPayload("claude-opus-4-1-20250805", body, false, null);
  assert.equal(
    result.conversationState.currentMessage.userInputMessage.modelId,
    "claude-opus-4-1-20250805",
    "two-dash form (patch + date) must remain unchanged"
  );
});

test("buildKiroPayload enables thinking mode for Claude models via reasoning_effort", () => {
  const body = {
    messages: [{ role: "user", content: "Solve a hard problem" }],
    reasoning_effort: "high",
    max_tokens: 64000,
  };

  const result = buildKiroPayload("claude-sonnet-5", body, false, null); // only Kiro model accepting adaptive thinking (#6576)

  assert.ok(result.additionalModelRequestFields, "additionalModelRequestFields must be set");
  assert.equal(
    result.additionalModelRequestFields.thinking,
    undefined,
    "thinking field must be omitted for Claude to avoid suppressing reasoning"
  );
  assert.equal(result.additionalModelRequestFields.output_config.effort, "high");
  assert.equal(result.additionalModelRequestFields.max_tokens, 64000);
  assert.match(
    result.conversationState.currentMessage.userInputMessage.content,
    /<thinking_mode>enabled<\/thinking_mode>/,
    "thinking_mode directive must be injected into user content"
  );
  assert.match(
    result.conversationState.currentMessage.userInputMessage.content,
    /<max_thinking_length>\d+<\/max_thinking_length>/,
    "max_thinking_length directive must be injected into user content"
  );
});

test("buildKiroPayload reads reasoningEffort from body and options (OpenCode format) and maps ultra to max", () => {
  // Test options.reasoningEffort and ultra mapping on adaptive Claude model
  const body1 = {
    messages: [{ role: "user", content: "Hard task" }],
    options: { reasoningEffort: "ultra" },
  };
  const result1 = buildKiroPayload("kr/claude-sonnet-5", body1, false, null);
  assert.ok(result1.additionalModelRequestFields, "output_config must be forwarded from options");
  assert.equal(result1.additionalModelRequestFields.output_config.effort, "max", "ultra must map to max");

  // Test camelCase reasoningEffort on adaptive Claude model
  const body2 = {
    messages: [{ role: "user", content: "Hard task" }],
    reasoningEffort: "max",
  };
  const result2 = buildKiroPayload("claude-opus-5", body2, false, null);
  assert.ok(result2.additionalModelRequestFields, "output_config must be forwarded from camelCase");
  assert.equal(result2.additionalModelRequestFields.output_config.effort, "max");
  assert.match(
    result2.conversationState.currentMessage.userInputMessage.content,
    /<thinking_mode>enabled<\/thinking_mode>/
  );
});

test("buildKiroPayload enables prompt-only thinking for claude-sonnet-4.5 without sending additionalModelRequestFields", () => {
  const body = {
    messages: [{ role: "user", content: "Solve hard puzzle" }],
    options: { reasoningEffort: "max" },
  };
  const result = buildKiroPayload("claude-sonnet-4.5", body, false, null);
  // Must NOT attach additionalModelRequestFields (Kiro rejects with 400 - issue #6576)
  assert.equal(result.additionalModelRequestFields, undefined);
  // MUST inject prompt directive for thinking (opencode-kiro parity)
  assert.match(
    result.conversationState.currentMessage.userInputMessage.content,
    /<thinking_mode>enabled<\/thinking_mode>/,
    "prompt thinking directive must be injected"
  );
  assert.match(
    result.conversationState.currentMessage.userInputMessage.content,
    /<max_thinking_length>\d+<\/max_thinking_length>/
  );
});

test("buildKiroPayload does not send reasoning levels for Kiro GPT-5.6 models", () => {
  for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "kr/gpt-5.6-sol", "gpt-5-6-sol"]) {
    const result = buildKiroPayload(
      model,
      {
        messages: [{ role: "user", content: "Solve a hard problem" }],
        reasoning_effort: "max",
        max_tokens: 64000,
      },
      false,
      null
    );

    assert.equal(
      result.additionalModelRequestFields,
      undefined,
      "reasoning levels must NOT be sent to Kiro for GPT models"
    );
    assert.doesNotMatch(
      result.conversationState.currentMessage.userInputMessage.content,
      /<thinking_mode>/
    );
  }
});

test("buildKiroPayload drops temperature when thinking is enabled", () => {
  const body = {
    messages: [{ role: "user", content: "Solve a hard problem" }],
    reasoning_effort: "high",
    temperature: 0.5,
  };

  const result = buildKiroPayload("claude-sonnet-5", body, false, null);

  assert.ok(result.additionalModelRequestFields, "thinking must be enabled");
  assert.equal(
    result.inferenceConfig?.temperature,
    undefined,
    "temperature must be dropped when adaptive thinking is active"
  );
});

test("buildKiroPayload ignores thinking request for unsupported effort levels", () => {
  const body = {
    messages: [{ role: "user", content: "Hello" }],
    reasoning_effort: "invalid",
  };

  const result = buildKiroPayload("claude-opus-4.8", body, false, null);

  assert.equal(
    result.additionalModelRequestFields,
    undefined,
    "invalid effort must not enable thinking"
  );
});

test("buildKiroPayload maps body.thinking budget_tokens to effort level", () => {
  const body = {
    messages: [{ role: "user", content: "Deep reasoning" }],
    thinking: { type: "enabled", budget_tokens: 50000 },
  };

  const result = buildKiroPayload("claude-sonnet-5", body, false, null);

  assert.ok(result.additionalModelRequestFields, "thinking must be enabled from budget_tokens");
  assert.equal(result.additionalModelRequestFields.output_config.effort, "high");
});

test("buildKiroPayload leaves thinking off when no reasoning is requested", () => {
  const body = { messages: [{ role: "user", content: "Hi" }] };

  const result = buildKiroPayload("claude-opus-4.8", body, false, null);

  assert.equal(result.additionalModelRequestFields, undefined, "no thinking fields by default");
  assert.doesNotMatch(
    result.conversationState.currentMessage.userInputMessage.content,
    /<thinking_mode>/,
    "no directive injected by default"
  );
});

test("buildKiroPayload maps reasoning_effort to the same Kiro effort level (no +1 shift)", () => {
  const result = buildKiroPayload(
    "claude-sonnet-5",
    { messages: [{ role: "user", content: "hard" }], reasoning_effort: "medium" },
    false,
    null
  );

  assert.equal(result.additionalModelRequestFields.output_config.effort, "medium");
});

test("buildKiroPayload reads effort from Anthropic output_config.effort", () => {
  const result = buildKiroPayload(
    "claude-sonnet-5",
    { messages: [{ role: "user", content: "hard" }], output_config: { effort: "xhigh" } },
    false,
    null
  );

  assert.ok(result.additionalModelRequestFields, "output_config.effort must enable thinking");
  assert.equal(result.additionalModelRequestFields.output_config.effort, "xhigh");
});

test("buildKiroPayload defaults adaptive thinking (no effort) to high", () => {
  const result = buildKiroPayload(
    "claude-sonnet-5",
    { messages: [{ role: "user", content: "hard" }], thinking: { type: "adaptive" } },
    false,
    null
  );

  assert.equal(
    result.additionalModelRequestFields.output_config.effort,
    "high",
    "adaptive with no explicit effort defaults to Anthropic's documented default (high)"
  );
});

test("buildKiroPayload drops both temperature and top_p when thinking is enabled", () => {
  const result = buildKiroPayload(
    "claude-sonnet-5",
    {
      messages: [{ role: "user", content: "hard" }],
      reasoning_effort: "high",
      temperature: 0.5,
      top_p: 0.9,
    },
    false,
    null
  );

  assert.ok(result.additionalModelRequestFields, "thinking must be enabled");
  assert.equal(result.inferenceConfig?.temperature, undefined, "temperature must be dropped");
  assert.equal(result.inferenceConfig?.topP, undefined, "top_p must be dropped");
});

test("buildKiroPayload includes agentTaskType vibe on conversationState", () => {
  const result = buildKiroPayload("claude-sonnet-4.5", { messages: [{ role: "user", content: "hi" }] }, false, null);
  assert.equal(result.conversationState.agentTaskType, "vibe");
});

test("buildKiroPayload sanitizes malformed toolCall IDs containing pipe characters", () => {
  const result = buildKiroPayload(
    "claude-sonnet-4.5",
    {
      messages: [
        { role: "user", content: "Run" },
        {
          role: "assistant",
          tool_calls: [
            { id: "call_abc|fc_def", type: "function", function: { name: "test", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_abc|fc_def", content: "ok" },
        { role: "user", content: "Next" },
      ],
    },
    false,
    null
  );
  const historyEntry = result.conversationState.history[1] as {
    assistantResponseMessage: { toolUses: Array<{ toolUseId: string }> };
  };
  const toolUse = historyEntry.assistantResponseMessage.toolUses[0];
  assert.match(toolUse.toolUseId, /^tooluse_[a-f0-9]+$/);
  assert.doesNotMatch(toolUse.toolUseId, /\|/);
});

test("buildKiroPayload attaches KIRO_PLACEHOLDER_TOOL when history has tool blocks but no tools declared", () => {
  const result = buildKiroPayload(
    "claude-sonnet-4.5",
    {
      messages: [
        { role: "user", content: "Query" },
        {
          role: "assistant",
          tool_calls: [{ id: "call_abc" }],
        },
        { role: "tool", tool_call_id: "call_abc", content: "done" },
        { role: "user", content: "Follow up" },
      ],
    },
    false,
    null
  );
  const tools = result.conversationState.currentMessage.userInputMessage.userInputMessageContext
    ?.tools as Array<{ toolSpecification: { name: string } }> | undefined;
  assert.ok(tools && tools.length > 0, "tools must be present in context to prevent TOOL_CONFIG_MISSING");
  assert.equal(tools[0].toolSpecification.name, "noop");
});

test("buildKiroPayload enables adaptive thinking for claude-opus-4.8", () => {
  const result = buildKiroPayload(
    "claude-opus-4.8",
    {
      messages: [{ role: "user", content: "Think carefully" }],
      reasoning_effort: "high",
    },
    false,
    null
  );
  assert.ok(result.additionalModelRequestFields, "additionalModelRequestFields must be set for opus 4.8");
  assert.equal(result.additionalModelRequestFields.output_config?.effort, "high");
  assert.match(result.conversationState.currentMessage.userInputMessage.content, /<thinking_mode>enabled<\/thinking_mode>/);
});

test("buildKiroPayload sets messageId on assistant message when responseId is provided", () => {
  const result = buildKiroPayload(
    "claude-sonnet-4.5",
    {
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Answer", responseId: "msg_01234567-89ab-4cde-8f01-23456789abcd" },
        { role: "user", content: "Followup" },
      ],
    },
    false,
    null
  );
  const asst = (
    result.conversationState.history[1] as { assistantResponseMessage: { messageId?: string } }
  ).assistantResponseMessage;
  assert.equal(asst.messageId, "01234567-89ab-4cde-8f01-23456789abcd");
});

test("buildKiroPayload generates valid UUID messageId for assistant messages without prior id", () => {
  const result = buildKiroPayload(
    "claude-sonnet-4.5",
    {
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Deterministic reply" },
        { role: "user", content: "Followup" },
      ],
    },
    false,
    null
  );
  const asst = (
    result.conversationState.history[1] as { assistantResponseMessage: { messageId: string } }
  ).assistantResponseMessage;
  assert.match(
    asst.messageId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    "assistant turn must receive valid UUID messageId"
  );
  assert.equal(asst.messageId, resolveKiroAssistantMessageId({ content: "Deterministic reply" }, 1));
});

test("buildKiroPayload replays native signed Kiro reasoning with its assistant linkage", () => {
  const responseId = "msg_01234567-89ab-4cde-8f01-23456789abcd";
  const result = buildKiroPayload(
    "claude-sonnet-4.5",
    {
      messages: [
        { role: "user", content: "Question" },
        {
          role: "assistant",
          content: "Visible answer",
          responseId,
          reasoningContent: {
            reasoningText: { text: "Signed private reasoning", signature: "kiro-signature" },
          },
        },
        { role: "user", content: "Follow up" },
      ],
    },
    false,
    null
  );

  const assistant = (
    result.conversationState.history[1] as {
      assistantResponseMessage: {
        content: string;
        messageId: string;
        reasoningContent?: unknown;
      };
    }
  ).assistantResponseMessage;
  assert.equal(assistant.content, "Visible answer");
  assert.equal(assistant.messageId, "01234567-89ab-4cde-8f01-23456789abcd");
  assert.deepEqual(assistant.reasoningContent, {
    reasoningText: { text: "Signed private reasoning", signature: "kiro-signature" },
  });
});

test("buildKiroPayload replays signed thinking blocks but omits unsigned reasoning", () => {
  const signed = buildKiroPayload(
    "claude-sonnet-4.5",
    {
      messages: [
        { role: "user", content: "Question" },
        {
          role: "assistant",
          responseId: "msg_01234567-89ab-4cde-8f01-23456789abcd",
          content: [
            { type: "thinking", thinking: "Block reasoning", signature: "block-signature" },
            { type: "text", text: "Visible answer" },
          ],
        },
        { role: "user", content: "Follow up" },
      ],
    },
    false,
    null
  );
  const signedAssistant = (
    signed.conversationState.history[1] as {
      assistantResponseMessage: { reasoningContent?: unknown };
    }
  ).assistantResponseMessage;
  assert.deepEqual(signedAssistant.reasoningContent, {
    reasoningText: { text: "Block reasoning", signature: "block-signature" },
  });

  const unsigned = buildKiroPayload(
    "claude-sonnet-4.5",
    {
      messages: [
        { role: "user", content: "Question" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Do not replay without an authentic signature" },
            { type: "text", text: "Visible answer" },
          ],
          reasoning_content: "also unsigned",
        },
        { role: "user", content: "Follow up" },
      ],
    },
    false,
    null
  );
  const unsignedAssistant = (
    unsigned.conversationState.history[1] as {
      assistantResponseMessage: { reasoningContent?: unknown };
    }
  ).assistantResponseMessage;
  assert.equal(unsignedAssistant.reasoningContent, undefined);
});

test("buildKiroPayload replays opaque redacted reasoning ahead of signed text", () => {
  const messageId = "01234567-89ab-4cde-8f01-23456789abcd";
  const result = buildKiroPayload(
    "claude-sonnet-4.5",
    {
      messages: [
        { role: "user", content: "Question" },
        {
          role: "assistant",
          messageId,
          content: [
            { type: "thinking", thinking: "Must stay opaque", signature: "ignored-signature" },
            { type: "redacted_thinking", data: "opaque-redaction" },
          ],
          redacted_content: "top-level-opaque-redaction",
        },
        { role: "user", content: "Follow up" },
      ],
    },
    false,
    null
  );

  const assistant = (
    result.conversationState.history[1] as {
      assistantResponseMessage: {
        content: string;
        messageId: string;
        reasoningContent?: unknown;
      };
    }
  ).assistantResponseMessage;
  assert.equal(assistant.content, "");
  assert.equal(assistant.messageId, messageId);
  assert.deepEqual(assistant.reasoningContent, {
    redactedContent: "top-level-opaque-redaction",
  });
});

test("buildKiroPayload keeps signed reasoning attached to its own adjacent assistant turn", () => {
  const reasoningResponseId = "msg_01234567-89ab-4cde-8f01-23456789abcd";
  const nextResponseId = "msg_89abcdef-0123-4abc-8def-0123456789ab";
  const result = buildKiroPayload(
    "claude-sonnet-4.5",
    {
      messages: [
        { role: "user", content: "Question" },
        {
          role: "assistant",
          content: "First answer",
          responseId: reasoningResponseId,
          reasoningContent: {
            reasoningText: { text: "First reasoning", signature: "first-signature" },
          },
        },
        { role: "assistant", content: "Second answer", responseId: nextResponseId },
        { role: "user", content: "Follow up" },
      ],
    },
    false,
    null
  );

  const assistants = result.conversationState.history.filter(
    (entry) => entry.assistantResponseMessage
  ) as Array<{
    assistantResponseMessage: {
      content: string;
      messageId: string;
      reasoningContent?: unknown;
    };
  }>;
  assert.equal(assistants.length, 2, "reasoning metadata keeps adjacent assistant turns distinct");
  assert.equal(assistants[0]?.assistantResponseMessage.messageId, "01234567-89ab-4cde-8f01-23456789abcd");
  assert.equal(assistants[1]?.assistantResponseMessage.messageId, "89abcdef-0123-4abc-8def-0123456789ab");
  assert.deepEqual(assistants[0]?.assistantResponseMessage.reasoningContent, {
    reasoningText: { text: "First reasoning", signature: "first-signature" },
  });
  assert.equal(assistants[1]?.assistantResponseMessage.reasoningContent, undefined);
});

test("toKiroToolUseId strictly canonicalizes call_123 and empty IDs deterministically", () => {
  const canonicalCall = toKiroToolUseId("call_123");
  assert.match(canonicalCall, /^tooluse_[a-f0-9]{22}$/, "call_123 must be hashed to tooluse_<sha256>");
  assert.equal(canonicalCall, toKiroToolUseId("call_123"), "hash must be deterministic across calls");

  const validKiroId = "tooluse_abc123DEF";
  assert.equal(toKiroToolUseId(validKiroId), validKiroId, "already valid tooluse_* ID must be preserved");

  const fallback1 = toKiroToolUseId("");
  const fallback2 = toKiroToolUseId("");
  assert.equal(fallback1, fallback2, "empty ID fallback must be strictly deterministic");
  assert.match(fallback1, /^tooluse_[a-f0-9]{22}$/);
});
