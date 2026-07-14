import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import contextProfilerExtension from "../extensions/index.ts";
import { ContextProfilerRuntime } from "../src/runtime.ts";

type Handler = (event: any, context: ExtensionContext) => unknown;

class FakeExtensionApi {
  readonly handlers = new Map<string, Handler[]>();

  on(event: string, handler: Handler): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  emit(event: string, payload: unknown, context: ExtensionContext): unknown[] {
    return (this.handlers.get(event) ?? []).map((handler) => handler(payload, context));
  }
}

function fakeContext(): ExtensionContext {
  return {
    cwd: "C:/Users/Private/Project",
    model: {
      provider: "openai-codex",
      id: "gpt-5.6-sol",
      contextWindow: 356_000,
      maxTokens: 32_000,
    },
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionFile: () => "C:/Private/session.jsonl",
    },
    getContextUsage: () => ({
      tokens: 182_411,
      contextWindow: 356_000,
      percent: 51.239,
    }),
  } as unknown as ExtensionContext;
}

test("registers observers only and writes content-free correlated NDJSON", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-context-profiler-"));
  try {
    const api = new FakeExtensionApi();
    const errors: unknown[] = [];
    const runtime = new ContextProfilerRuntime(
      api as unknown as ExtensionAPI,
      {
        logRoot: root,
        now: () => new Date("2026-07-14T00:00:00.000Z"),
        onError: (error) => errors.push(error),
      },
    );
    runtime.register();

    assert.deepEqual(
      [...api.handlers.keys()].sort(),
      [
        "after_provider_response",
        "before_agent_start",
        "before_provider_request",
        "context",
        "message_end",
        "session_start",
        "tool_result",
      ],
    );

    const ctx = fakeContext();
    const secret = "sensitive-body-never-log";
    const payload = {
      instructions: secret,
      input: [{ role: "user", content: secret }],
      tools: [{ name: "read", description: secret }],
    };
    const payloadBefore = structuredClone(payload);

    api.emit("session_start", { reason: "startup" }, ctx);
    api.emit("before_agent_start", {
      prompt: secret,
      systemPrompt: secret,
      systemPromptOptions: { cwd: ctx.cwd, contextFiles: [] },
    }, ctx);
    api.emit("context", { messages: payload.input }, ctx);
    const returns = api.emit("before_provider_request", { payload }, ctx);
    api.emit("tool_result", {
      toolCallId: "call-1",
      toolName: "read",
      input: { path: secret },
      content: [{ type: "text", text: secret }],
      details: undefined,
      isError: false,
    }, ctx);
    api.emit("after_provider_response", {
      status: 200,
      headers: { authorization: secret, "content-type": "application/json" },
    }, ctx);
    api.emit("message_end", {
      message: {
        role: "assistant",
        usage: {
          input: 4_747,
          output: 4_191,
          cacheRead: 177_664,
          cacheWrite: 0,
          reasoning: 2_588,
          totalTokens: 186_602,
        },
      },
    }, ctx);

    assert.deepEqual(payload, payloadBefore);
    assert.deepEqual(returns, [undefined]);
    assert.deepEqual(errors, []);

    const log = readFileSync(join(root, "session-1.ndjson"), "utf8");
    assert.equal(log.includes(secret), false);
    assert.equal(log.includes(ctx.cwd), false);
    assert.equal(log.includes("authorization"), false);

    const latest = readFileSync(join(root, "latest.json"), "utf8");
    assert.equal(latest.includes(secret), false);
    assert.deepEqual(JSON.parse(latest), {
      schemaVersion: 1,
      timestamp: "2026-07-14T00:00:00.000Z",
      event: "assistant_usage",
      sessionId: "session-1",
      fileName: "session-1.ndjson",
    });

    const records = log.trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(
      records.map((record) => record.event),
      [
        "session_start",
        "agent_start_profile",
        "context_snapshot",
        "provider_request",
        "tool_result",
        "provider_response",
        "assistant_usage",
      ],
    );
    assert.equal(records[2].requestIndex, 1);
    assert.equal(records[3].requestIndex, 1);
    assert.equal(records[6].requestIndex, 1);
    assert.equal(records[6].usage.activeInputTokens, 182_411);
    assert.equal(records[5].headerCount, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the package entrypoint loads and registers observers only", () => {
  const api = new FakeExtensionApi();
  contextProfilerExtension(api as unknown as ExtensionAPI);

  assert.equal(api.handlers.size, 7);
  assert.equal(api.handlers.has("before_provider_request"), true);
  assert.equal(api.handlers.has("tool_result"), true);
});

test("logging failures never escape into Pi hooks", () => {
  const api = new FakeExtensionApi();
  const errors: unknown[] = [];
  const runtime = new ContextProfilerRuntime(
    api as unknown as ExtensionAPI,
    {
      logRoot: "ignored",
      appendRecord: () => {
        throw new Error("disk unavailable");
      },
      onError: (error) => errors.push(error),
    },
  );
  runtime.register();

  assert.doesNotThrow(() => {
    api.emit("session_start", { reason: "startup" }, fakeContext());
  });
  assert.equal(errors.length, 1);
});
