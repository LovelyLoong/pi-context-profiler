import assert from "node:assert/strict";
import test from "node:test";
import {
  profileAgentStart,
  profileAssistantUsage,
  profileMessages,
  profileProviderPayload,
  profileToolResult,
  summarizeMessages,
  summarizeProviderPayload,
} from "../src/profile.ts";

const SECRET = "sk-secret-value-never-log";

test("profiles provider payload without retaining content", () => {
  const payload = {
    model: "gpt-5.6-sol",
    instructions: `system ${SECRET}`,
    tools: [{ type: "function", name: "read", parameters: { secret: SECRET } }],
    input: [
      { role: "user", content: [{ type: "input_text", text: SECRET }] },
      { role: "tool", name: "memory_search", content: SECRET },
    ],
  };

  const profile = profileProviderPayload(payload) as Record<string, unknown>;
  const serialized = JSON.stringify(profile);
  assert.equal(serialized.includes(SECRET), false);
  assert.equal((profile.input as { itemCount: number }).itemCount, 2);
  assert.equal((profile.tools as { itemCount: number }).itemCount, 1);
  assert.equal(serialized.includes("memory_search"), true);
  assert.equal(serialized.includes("read"), true);
});

test("summarizes repeated context without retaining per-item profiles", () => {
  const messages = Array.from({ length: 1_000 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `${SECRET}-${index}`,
  }));
  const context = summarizeMessages(messages);
  const payload = summarizeProviderPayload({
    instructions: SECRET,
    input: messages,
    tools: [{ type: "function", name: "read", description: SECRET }],
  }) as Record<string, unknown>;
  const serializedContext = JSON.stringify(context);
  const serializedPayload = JSON.stringify(payload);

  assert.equal(context.itemCount, 1_000);
  assert.equal(context.byRole.user.count, 500);
  assert.equal(context.byRole.assistant.count, 500);
  assert.equal("items" in context, false);
  assert.equal("items" in (payload.input as object), false);
  assert.equal("items" in (payload.tools as object), false);
  assert.equal(serializedContext.includes(SECRET), false);
  assert.equal(serializedPayload.includes(SECRET), false);
  assert.equal(Buffer.byteLength(serializedContext) < 500, true);
  assert.equal(Buffer.byteLength(serializedPayload) < 2_000, true);
});

test("attributes agent messages by role and tool", () => {
  const profile = profileMessages([
    { role: "user", content: SECRET },
    { role: "assistant", content: [{ type: "thinking", thinking: SECRET }] },
    { role: "toolResult", toolName: "bash", content: [{ type: "text", text: SECRET }] },
  ]);

  assert.equal(profile.itemCount, 3);
  assert.equal(profile.byRole.user.count, 1);
  assert.equal(profile.byRole.assistant.count, 1);
  assert.equal(profile.byRole.toolResult.count, 1);
  assert.equal(profile.items[2]?.toolName, "bash");
  assert.equal(JSON.stringify(profile).includes(SECRET), false);
});

test("profiles system construction without complete paths or text", () => {
  const profile = profileAgentStart(
    SECRET,
    `system ${SECRET}`,
    {
      cwd: "C:/Users/Private/Project",
      selectedTools: ["read", "bash"],
      toolSnippets: { read: SECRET },
      contextFiles: [{ path: "C:/Users/Private/Project/AGENTS.md", content: SECRET }],
      skills: [{ name: "librarian", description: SECRET }],
    },
  );
  const serialized = JSON.stringify(profile);

  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes("C:/Users/Private/Project"), false);
  assert.equal(serialized.includes("AGENTS.md"), true);
  assert.equal(serialized.includes("librarian"), true);
});

test("extracts exact active-input usage", () => {
  const usage = profileAssistantUsage({
    role: "assistant",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    stopReason: "stop",
    usage: {
      input: 4_747,
      output: 4_191,
      cacheRead: 177_664,
      cacheWrite: 0,
      reasoning: 2_588,
      totalTokens: 186_602,
    },
  }) as { activeInputTokens: number };
  assert.equal(usage.activeInputTokens, 182_411);
  assert.equal(profileAssistantUsage({ role: "user" }), undefined);
});

test("profiles tool results without retaining arguments or output", () => {
  const profile = profileToolResult({
    toolCallId: "call-secret-id",
    toolName: "memory_search",
    input: { query: SECRET },
    content: [{ type: "text", text: SECRET }],
    details: { output: SECRET },
    isError: false,
  });
  const serialized = JSON.stringify(profile);

  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes("call-secret-id"), false);
  assert.equal(serialized.includes("memory_search"), true);
});
