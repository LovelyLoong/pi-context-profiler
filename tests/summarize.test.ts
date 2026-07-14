import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../scripts/summarize.mjs", import.meta.url));

function record(sessionId: string, timestamp: string, event: string, details = {}) {
  return {
    schemaVersion: 1,
    packageVersion: "0.1.0",
    timestamp,
    event,
    sessionId,
    ignoredBody: "fixture-secret-never-output",
    ...details,
  };
}

function writeLog(root: string, sessionId: string, records: unknown[], partialTail = false) {
  const content = `${records.map((item) => JSON.stringify(item)).join("\n")}\n${
    partialTail ? "{\"incomplete\":" : ""
  }`;
  writeFileSync(join(root, `${sessionId}.ndjson`), content);
}

function runSummary(...args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    assert.fail(`Summary did not return valid JSON: ${String(error)}`);
  }
}

test("batch summary reports exact usage distributions and rough tool attribution", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-context-summary-"));
  try {
    writeLog(root, "session-a", [
      record("session-a", "2026-07-14T00:00:00.000Z", "session_start"),
      record("session-a", "2026-07-14T00:00:01.000Z", "context_snapshot", {
        requestIndex: 1,
        profile: {
          metric: { serializedBytes: 1_000, roughTokenEstimate: 250 },
          items: [{ index: 0, role: "user", metric: { serializedBytes: 100, roughTokenEstimate: 25 } }],
        },
      }),
      record("session-a", "2026-07-14T00:00:02.000Z", "provider_request", {
        requestIndex: 1,
        profile: { metric: { serializedBytes: 2_000, roughTokenEstimate: 500 } },
      }),
      record("session-a", "2026-07-14T00:00:03.000Z", "tool_result", {
        nextRequestIndex: 2,
        profile: {
          toolName: "memory_search",
          isError: false,
          input: { serializedBytes: 100, roughTokenEstimate: 25 },
          content: { serializedBytes: 800, roughTokenEstimate: 200 },
          details: { serializedBytes: 20, roughTokenEstimate: 5 },
        },
      }),
      record("session-a", "2026-07-14T00:00:03.500Z", "compaction", {
        reason: "threshold",
        willRetry: false,
        tokensBefore: 900,
        summary: { serializedBytes: 100, roughTokenEstimate: 25 },
      }),
      record("session-a", "2026-07-14T00:00:04.000Z", "assistant_usage", {
        requestIndex: 1,
        usage: {
          input: 10,
          output: 5,
          cacheRead: 90,
          cacheWrite: 0,
          reasoning: 3,
          totalTokens: 108,
          activeInputTokens: 100,
          provider: "test-provider",
          model: "test-model",
        },
        contextUsage: { tokens: 105, contextWindow: 1_000, percent: 10.5 },
      }),
      record("session-a", "2026-07-14T00:00:05.000Z", "context_snapshot", {
        requestIndex: 2,
        profile: {
          metric: { serializedBytes: 3_000, roughTokenEstimate: 750 },
          items: [{ index: 0, role: "toolResult", toolName: "memory_search", metric: { serializedBytes: 800, roughTokenEstimate: 200 } }],
        },
      }),
      record("session-a", "2026-07-14T00:00:06.000Z", "provider_request", {
        requestIndex: 2,
        profile: { metric: { serializedBytes: 4_000, roughTokenEstimate: 1_000 } },
      }),
      record("session-a", "2026-07-14T00:00:07.000Z", "tool_result", {
        nextRequestIndex: 3,
        profile: {
          toolName: "read",
          isError: true,
          input: { serializedBytes: 50, roughTokenEstimate: 13 },
          content: { serializedBytes: 400, roughTokenEstimate: 100 },
          details: { serializedBytes: 10, roughTokenEstimate: 3 },
        },
      }),
      record("session-a", "2026-07-14T00:00:08.000Z", "assistant_usage", {
        requestIndex: 2,
        usage: {
          input: 20,
          output: 6,
          cacheRead: 180,
          cacheWrite: 0,
          reasoning: 4,
          totalTokens: 210,
          activeInputTokens: 200,
          provider: "test-provider",
          model: "test-model",
        },
        contextUsage: { tokens: 206, contextWindow: 1_000, percent: 20.6 },
      }),
    ], true);

    writeLog(root, "session-b", [
      record("session-b", "2026-07-15T00:00:00.000Z", "session_start", {
        packageVersion: "0.2.0",
      }),
      record("session-b", "2026-07-15T00:00:01.000Z", "context_snapshot", {
        requestIndex: 1,
        profile: { metric: { serializedBytes: 2_000, roughTokenEstimate: 500 }, items: [] },
      }),
      record("session-b", "2026-07-15T00:00:02.000Z", "provider_request", {
        requestIndex: 1,
        profile: { metric: { serializedBytes: 2_500, roughTokenEstimate: 625 } },
      }),
      record("session-b", "2026-07-15T00:00:03.000Z", "tool_result", {
        nextRequestIndex: 2,
        profile: {
          toolName: "memory_search",
          isError: false,
          input: { serializedBytes: 120, roughTokenEstimate: 30 },
          content: { serializedBytes: 1_200, roughTokenEstimate: 300 },
          details: { serializedBytes: 20, roughTokenEstimate: 5 },
        },
      }),
      record("session-b", "2026-07-15T00:00:04.000Z", "assistant_usage", {
        requestIndex: 1,
        usage: {
          input: 30,
          output: 7,
          cacheRead: 270,
          cacheWrite: 0,
          reasoning: 5,
          totalTokens: 312,
          activeInputTokens: 300,
          provider: "test-provider",
          model: "test-model",
        },
        contextUsage: { tokens: 307, contextWindow: 1_000, percent: 30.7 },
      }),
    ]);

    writeLog(root, "session-empty", [
      record("session-empty", "2026-07-15T12:00:00.000Z", "session_start"),
    ]);
    writeLog(root, "session-old", [
      record("session-old", "2026-07-10T00:00:00.000Z", "session_start"),
      record("session-old", "2026-07-10T00:00:01.000Z", "provider_request", {
        requestIndex: 1,
        profile: { metric: { serializedBytes: 9_999, roughTokenEstimate: 2_500 } },
      }),
    ]);

    const summary = runSummary(
      "--dir",
      root,
      "--since",
      "2026-07-14T00:00:00.000Z",
      "--until",
      "2026-07-15T23:59:59.999Z",
      "--top",
      "10",
    );

    assert.deepEqual(summary.selection, {
      directoryName: root.split(/[\\/]/).at(-1),
      since: "2026-07-14T00:00:00.000Z",
      until: "2026-07-15T23:59:59.999Z",
      minimumProviderRequests: 1,
      packageVersion: null,
      discoveredSessionLogs: 4,
      includedSessions: 2,
      excludedByTime: 1,
      excludedByRequestCount: 1,
      excludedByPackageVersion: 0,
    });
    assert.deepEqual(summary.aggregate.exactUsage.finalActiveInputTokens, {
      count: 2,
      min: 200,
      p50: 250,
      p90: 290,
      max: 300,
      mean: 250,
    });
    assert.deepEqual(summary.aggregate.packageVersions, {
      "0.1.0": 2,
      "0.2.0": 1,
    });
    assert.equal(summary.aggregate.exactUsage.cumulative.input, 60);
    assert.equal(summary.aggregate.exactUsage.cumulative.cacheRead, 540);
    assert.equal(summary.aggregate.toolErrors, 1);
    assert.equal(summary.aggregate.compactionEvents, 1);
    assert.equal(summary.aggregate.roughSizeAttribution.toolResultsByTool[0].toolName, "memory_search");
    assert.equal(
      summary.aggregate.roughSizeAttribution.toolResultsByTool[0].content.serializedBytes,
      2_000,
    );
    assert.equal(
      summary.aggregate.roughSizeAttribution.toolResultsByTool[0].content.meanPerCallRoughTokens,
      250,
    );
    assert.equal(
      summary.aggregate.roughSizeAttribution.toolResultsByTool[0].content.maxPerCallRoughTokens,
      300,
    );
    const largestGrowth = summary.aggregate.roughSizeAttribution.largestContextGrowth[0];
    assert.equal(largestGrowth.deltaBytes, 2_000);
    assert.equal(largestGrowth.precedingToolResults.count, 1);
    assert.equal(largestGrowth.precedingToolResults.byTool[0].toolName, "memory_search");
    assert.equal(summary.sessions[0].partialTrailingRecordSkipped, true);
    assert.equal(JSON.stringify(summary).includes("fixture-secret-never-output"), false);
    assert.equal(JSON.stringify(summary).includes(root), false);

    const versionFiltered = runSummary(
      "--dir",
      root,
      "--since",
      "2026-07-14T00:00:00.000Z",
      "--until",
      "2026-07-15T23:59:59.999Z",
      "--package-version",
      "0.2.0",
    );
    assert.equal(versionFiltered.selection.includedSessions, 0);
    assert.equal(versionFiltered.selection.excludedByPackageVersion, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("single-file summary keeps the original detailed entry points", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-context-summary-single-"));
  try {
    writeLog(root, "session-one", [
      record("session-one", "2026-07-14T00:00:00.000Z", "session_start"),
      record("session-one", "2026-07-14T00:00:01.000Z", "context_snapshot", {
        requestIndex: 1,
        profile: {
          metric: { serializedBytes: 100, roughTokenEstimate: 25 },
          items: [{ index: 0, role: "user", metric: { serializedBytes: 50, roughTokenEstimate: 13 } }],
        },
      }),
      record("session-one", "2026-07-14T00:00:02.000Z", "provider_request", {
        requestIndex: 1,
        profile: { metric: { serializedBytes: 200, roughTokenEstimate: 50 } },
      }),
      record("session-one", "2026-07-14T00:00:03.000Z", "assistant_usage", {
        requestIndex: 1,
        usage: { input: 40, cacheRead: 60, cacheWrite: 0, activeInputTokens: 100 },
        contextUsage: { tokens: 100, contextWindow: 1_000, percent: 10 },
      }),
    ]);

    const summary = runSummary(join(root, "session-one.ndjson"));
    assert.equal(summary.sessionId, "session-one");
    assert.equal(summary.requests, 1);
    assert.equal(summary.latestUsage.activeInputTokens, 100);
    assert.equal(summary.largestMessages[0].bytes, 50);
    assert.equal(summary.session.fileName, "session-one.ndjson");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
