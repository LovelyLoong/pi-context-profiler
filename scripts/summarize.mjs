import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const file = process.argv[2];
if (!file) {
  console.error("Usage: npm run summarize -- <context-profiler.ndjson>");
  process.exitCode = 1;
} else {
  const records = readFileSync(resolve(file), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  const latest = (event) => records.findLast((record) => record.event === event);
  const context = latest("context_snapshot");
  const provider = latest("provider_request");
  const usage = latest("assistant_usage");
  const toolResults = records
    .filter((record) => record.event === "tool_result")
    .map((record) => ({
      toolName: record.profile?.toolName,
      bytes: record.profile?.content?.serializedBytes ?? 0,
      roughTokens: record.profile?.content?.roughTokenEstimate ?? 0,
      nextRequestIndex: record.nextRequestIndex,
    }))
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, 20);
  const largestMessages = [...(context?.profile?.items ?? [])]
    .map((item) => ({
      index: item.index,
      role: item.role,
      toolName: item.toolName,
      bytes: item.metric?.serializedBytes ?? 0,
      roughTokens: item.metric?.roughTokenEstimate ?? 0,
    }))
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, 20);

  console.log(JSON.stringify({
    sessionId: records[0]?.sessionId,
    requests: records.filter((record) => record.event === "provider_request").length,
    latestUsage: usage?.usage,
    latestContextUsage: usage?.contextUsage,
    latestProvider: provider?.profile,
    largestMessages,
    largestToolResults: toolResults,
  }, null, 2));
}
