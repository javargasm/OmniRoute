import test from "node:test";
import assert from "node:assert/strict";

const { buildKiroPayload } = await import("../../open-sse/translator/request/openai-to-kiro.ts");
const { toKiroToolUseId } = await import(
  "../../open-sse/translator/request/openai-to-kiro/messageHelpers.ts"
);

test("openai-to-kiro: synthesizes error toolResult when client omits a tool result in final turn", () => {
  const tools = [
    {
      type: "function",
      function: {
        name: "tool_a",
        description: "Tool A",
        parameters: { type: "object", properties: { x: { type: "string" } } },
      },
    },
    {
      type: "function",
      function: {
        name: "tool_b",
        description: "Tool B",
        parameters: { type: "object", properties: { y: { type: "string" } } },
      },
    },
  ];

  const body = {
    messages: [
      { role: "user", content: "Run tools" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_a",
            type: "function",
            function: { name: "tool_a", arguments: '{"x":"1"}' },
          },
          {
            id: "call_b",
            type: "function",
            function: { name: "tool_b", arguments: '{"y":"2"}' },
          },
        ],
      },
      // Client only responded with tool_a, omitting tool_b
      { role: "tool", tool_call_id: "call_a", content: "result a" },
    ],
    tools,
  };

  const payload = buildKiroPayload("gpt-5.6-terra", body, false, {});
  const currentResults =
    payload?.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext
      ?.toolResults;

  assert.ok(Array.isArray(currentResults), "currentMessage should have toolResults");
  assert.equal(currentResults.length, 2, "Both tool calls should be answered");

  const expectedIdA = toKiroToolUseId("call_a");
  const expectedIdB = toKiroToolUseId("call_b");

  const resultA = currentResults.find((r: { toolUseId?: string }) => r.toolUseId === expectedIdA);
  const resultB = currentResults.find((r: { toolUseId?: string }) => r.toolUseId === expectedIdB);

  assert.ok(resultA, "resultA should exist");
  assert.equal(resultA.status, "success");
  assert.deepEqual(resultA.content, [{ text: "result a" }]);

  assert.ok(resultB, "resultB should exist as synthetic error");
  assert.equal(resultB.status, "error");
  assert.ok(resultB.content[0]?.text?.includes("omitted or cancelled"));
});

test("openai-to-kiro: synthesizes error toolResult in intermediate history turns", () => {
  const body = {
    messages: [
      { role: "user", content: "Step 1" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_hist_1",
            type: "function",
            function: { name: "tool_1", arguments: "{}" },
          },
          {
            id: "call_hist_2",
            type: "function",
            function: { name: "tool_2", arguments: "{}" },
          },
        ],
      },
      // Only call_hist_1 answered
      { role: "tool", tool_call_id: "call_hist_1", content: "output 1" },
      // Conversation continued with another assistant turn
      { role: "assistant", content: "Next step" },
      { role: "user", content: "Final user prompt" },
    ],
  };

  const payload = buildKiroPayload("claude-sonnet-4", body, false, {});
  const history = payload?.conversationState?.history || [];

  // Find the user turn that followed the first assistant tool_calls
  const userTurn = history.find(
    (h: {
      userInputMessage?: {
        userInputMessageContext?: { toolResults?: Array<{ toolUseId?: string }> };
      };
    }) => h?.userInputMessage?.userInputMessageContext?.toolResults
  );

  assert.ok(userTurn, "Should find user turn with toolResults in history");
  const histResults = userTurn.userInputMessage.userInputMessageContext.toolResults;
  assert.equal(histResults.length, 2, "Should have 2 toolResults in history turn");

  const id1 = toKiroToolUseId("call_hist_1");
  const id2 = toKiroToolUseId("call_hist_2");

  const r1 = histResults.find((r: { toolUseId?: string }) => r.toolUseId === id1);
  const r2 = histResults.find((r: { toolUseId?: string }) => r.toolUseId === id2);

  assert.ok(r1, "r1 should exist with success");
  assert.equal(r1.status, "success");

  assert.ok(r2, "r2 should exist as synthetic error");
  assert.equal(r2.status, "error");
});

test("openai-to-kiro: leaves all toolResults untouched when all tool_calls are fulfilled", () => {
  const body = {
    messages: [
      { role: "user", content: "Run tools" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_x",
            type: "function",
            function: { name: "tool_x", arguments: "{}" },
          },
          {
            id: "call_y",
            type: "function",
            function: { name: "tool_y", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_x", content: "result x" },
      { role: "tool", tool_call_id: "call_y", content: "result y" },
    ],
  };

  const payload = buildKiroPayload("gpt-5.6-terra", body, false, {});
  const currentResults =
    payload?.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext
      ?.toolResults;

  assert.ok(Array.isArray(currentResults));
  assert.equal(currentResults.length, 2);
  assert.equal(currentResults[0].status, "success");
  assert.equal(currentResults[1].status, "success");
});
