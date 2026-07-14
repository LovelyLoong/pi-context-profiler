import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

const USAGE_FIELDS = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "reasoning",
  "totalTokens",
];

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function metricNumber(metric, key) {
  return finite(metric?.[key]) ?? 0;
}

function addMetric(target, metric) {
  target.serializedBytes += metricNumber(metric, "serializedBytes");
  target.roughTokenEstimate += metricNumber(metric, "roughTokenEstimate");
}

function increment(map, key, amount = 1) {
  map[key] = (map[key] ?? 0) + amount;
}

function isoTimestamp(value) {
  if (typeof value !== "string") return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function boundedTop(items, limit, score) {
  return items
    .sort((left, right) => score(right) - score(left))
    .slice(0, limit);
}

function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) {
    return { count: 0, min: null, p50: null, p90: null, max: null, mean: null };
  }

  const percentile = (quantile) => {
    const position = (sorted.length - 1) * quantile;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    const interpolated = sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
    return Math.round(interpolated);
  };

  return {
    count: sorted.length,
    min: sorted[0],
    p50: percentile(0.5),
    p90: percentile(0.9),
    max: sorted.at(-1),
    mean: Math.round(sorted.reduce((total, value) => total + value, 0) / sorted.length),
  };
}

function createAccumulator(filePath, detailed) {
  return {
    fileName: basename(filePath),
    detailed,
    sessionId: undefined,
    firstTimestamp: undefined,
    lastTimestamp: undefined,
    recordCount: 0,
    partialTrailingRecordSkipped: false,
    eventCounts: {},
    providerRequests: 0,
    agentRuns: 0,
    toolResultCount: 0,
    toolErrorCount: 0,
    responseStatus: {},
    compactionEvents: 0,
    usageSamples: 0,
    finalActiveInputTokens: undefined,
    peakActiveInputTokens: undefined,
    previousActiveInputTokens: undefined,
    activeInputDrops: [],
    finalContextUsageTokens: undefined,
    peakContextUsageTokens: undefined,
    finalContextUsagePercent: undefined,
    peakContextUsagePercent: undefined,
    contextWindow: undefined,
    cumulativeUsage: Object.fromEntries(USAGE_FIELDS.map((field) => [field, 0])),
    packageVersions: new Set(),
    models: new Set(),
    providers: new Set(),
    contextSnapshot: {
      finalBytes: undefined,
      peakBytes: undefined,
      finalRoughTokens: undefined,
      peakRoughTokens: undefined,
      previousBytes: undefined,
      growth: [],
      drops: [],
    },
    providerPayload: {
      finalBytes: undefined,
      peakBytes: undefined,
      finalRoughTokens: undefined,
      peakRoughTokens: undefined,
    },
    tools: new Map(),
    toolsByRequest: new Map(),
    detailedToolResults: [],
    latestUsage: undefined,
    latestContextUsage: undefined,
    latestProvider: undefined,
    largestMessages: [],
  };
}

function updateTimestamps(state, timestamp) {
  const normalized = isoTimestamp(timestamp);
  if (!normalized) return;
  if (!state.firstTimestamp || normalized < state.firstTimestamp) state.firstTimestamp = normalized;
  if (!state.lastTimestamp || normalized > state.lastTimestamp) state.lastTimestamp = normalized;
}

function precedingToolResults(state, requestIndex) {
  if (requestIndex === undefined) return null;
  const batch = state.toolsByRequest.get(requestIndex);
  if (!batch) return null;
  return {
    count: batch.count,
    contentBytes: batch.contentBytes,
    contentRoughTokens: batch.contentRoughTokens,
    byTool: [...batch.byTool.entries()]
      .map(([toolName, value]) => ({ toolName, ...value }))
      .sort((left, right) => right.contentRoughTokens - left.contentRoughTokens),
  };
}

function observeSnapshot(state, record) {
  const bytes = finite(record.profile?.metric?.serializedBytes);
  const roughTokens = finite(record.profile?.metric?.roughTokenEstimate);
  if (bytes !== undefined) {
    if (state.contextSnapshot.previousBytes !== undefined) {
      const deltaBytes = bytes - state.contextSnapshot.previousBytes;
      const deltaRoughTokens = Math.round(deltaBytes / 4);
      const requestIndex = finite(record.requestIndex);
      const point = {
        requestIndex,
        deltaBytes,
        deltaRoughTokens,
        precedingToolResults: precedingToolResults(state, requestIndex),
      };
      if (deltaBytes >= 0) state.contextSnapshot.growth.push(point);
      else state.contextSnapshot.drops.push(point);
    }
    state.contextSnapshot.previousBytes = bytes;
    state.contextSnapshot.finalBytes = bytes;
    state.contextSnapshot.peakBytes = Math.max(state.contextSnapshot.peakBytes ?? 0, bytes);
  }
  if (roughTokens !== undefined) {
    state.contextSnapshot.finalRoughTokens = roughTokens;
    state.contextSnapshot.peakRoughTokens = Math.max(
      state.contextSnapshot.peakRoughTokens ?? 0,
      roughTokens,
    );
  }

  if (state.detailed) {
    state.largestMessages = [...(record.profile?.items ?? [])]
      .map((item) => ({
        index: item.index,
        role: item.role,
        toolName: item.toolName,
        bytes: finite(item.metric?.serializedBytes) ?? 0,
        roughTokens: finite(item.metric?.roughTokenEstimate) ?? 0,
      }))
      .sort((left, right) => right.bytes - left.bytes)
      .slice(0, 20);
  }
}

function observeProviderRequest(state, record) {
  state.providerRequests += 1;
  const bytes = finite(record.profile?.metric?.serializedBytes);
  const roughTokens = finite(record.profile?.metric?.roughTokenEstimate);
  if (bytes !== undefined) {
    state.providerPayload.finalBytes = bytes;
    state.providerPayload.peakBytes = Math.max(state.providerPayload.peakBytes ?? 0, bytes);
  }
  if (roughTokens !== undefined) {
    state.providerPayload.finalRoughTokens = roughTokens;
    state.providerPayload.peakRoughTokens = Math.max(
      state.providerPayload.peakRoughTokens ?? 0,
      roughTokens,
    );
  }
  if (state.detailed) state.latestProvider = record.profile;
}

function observeUsage(state, record) {
  state.usageSamples += 1;
  const usage = record.usage ?? {};
  for (const field of USAGE_FIELDS) {
    state.cumulativeUsage[field] += finite(usage[field]) ?? 0;
  }

  const activeInputTokens = finite(usage.activeInputTokens);
  if (activeInputTokens !== undefined) {
    if (
      state.previousActiveInputTokens !== undefined
      && activeInputTokens < state.previousActiveInputTokens
    ) {
      state.activeInputDrops.push({
        requestIndex: finite(record.requestIndex),
        deltaTokens: activeInputTokens - state.previousActiveInputTokens,
      });
    }
    state.previousActiveInputTokens = activeInputTokens;
    state.finalActiveInputTokens = activeInputTokens;
    state.peakActiveInputTokens = Math.max(state.peakActiveInputTokens ?? 0, activeInputTokens);
  }

  const contextTokens = finite(record.contextUsage?.tokens);
  if (contextTokens !== undefined) {
    state.finalContextUsageTokens = contextTokens;
    state.peakContextUsageTokens = Math.max(state.peakContextUsageTokens ?? 0, contextTokens);
  }
  const contextPercent = finite(record.contextUsage?.percent);
  if (contextPercent !== undefined) {
    state.finalContextUsagePercent = contextPercent;
    state.peakContextUsagePercent = Math.max(state.peakContextUsagePercent ?? 0, contextPercent);
  }
  state.contextWindow = finite(record.contextUsage?.contextWindow) ?? state.contextWindow;
  if (typeof usage.model === "string") state.models.add(usage.model);
  if (typeof usage.provider === "string") state.providers.add(usage.provider);
  if (state.detailed) {
    state.latestUsage = usage;
    state.latestContextUsage = record.contextUsage;
  }
}

function observeToolResult(state, record) {
  state.toolResultCount += 1;
  const profile = record.profile ?? {};
  const toolName = typeof profile.toolName === "string" ? profile.toolName : "unknown";
  const current = state.tools.get(toolName) ?? {
    toolName,
    count: 0,
    errors: 0,
    input: { serializedBytes: 0, roughTokenEstimate: 0 },
    content: {
      serializedBytes: 0,
      roughTokenEstimate: 0,
      maxPerCallRoughTokens: 0,
    },
    details: { serializedBytes: 0, roughTokenEstimate: 0 },
  };
  current.count += 1;
  if (profile.isError === true) {
    current.errors += 1;
    state.toolErrorCount += 1;
  }
  addMetric(current.input, profile.input);
  addMetric(current.content, profile.content);
  addMetric(current.details, profile.details);
  const contentBytes = metricNumber(profile.content, "serializedBytes");
  const contentRoughTokens = metricNumber(profile.content, "roughTokenEstimate");
  current.content.maxPerCallRoughTokens = Math.max(
    current.content.maxPerCallRoughTokens,
    contentRoughTokens,
  );
  state.tools.set(toolName, current);

  const nextRequestIndex = finite(record.nextRequestIndex);
  if (nextRequestIndex !== undefined) {
    const batch = state.toolsByRequest.get(nextRequestIndex) ?? {
      count: 0,
      contentBytes: 0,
      contentRoughTokens: 0,
      byTool: new Map(),
    };
    batch.count += 1;
    batch.contentBytes += contentBytes;
    batch.contentRoughTokens += contentRoughTokens;
    const toolBatch = batch.byTool.get(toolName) ?? {
      count: 0,
      contentBytes: 0,
      contentRoughTokens: 0,
    };
    toolBatch.count += 1;
    toolBatch.contentBytes += contentBytes;
    toolBatch.contentRoughTokens += contentRoughTokens;
    batch.byTool.set(toolName, toolBatch);
    state.toolsByRequest.set(nextRequestIndex, batch);
  }

  if (state.detailed) {
    state.detailedToolResults.push({
      toolName,
      bytes: metricNumber(profile.content, "serializedBytes"),
      roughTokens: metricNumber(profile.content, "roughTokenEstimate"),
      nextRequestIndex: finite(record.nextRequestIndex),
    });
  }
}

function consumeRecord(state, record) {
  state.recordCount += 1;
  if (!state.sessionId && typeof record.sessionId === "string") state.sessionId = record.sessionId;
  if (typeof record.packageVersion === "string") state.packageVersions.add(record.packageVersion);
  updateTimestamps(state, record.timestamp);
  const event = typeof record.event === "string" ? record.event : "unknown";
  increment(state.eventCounts, event);

  switch (event) {
    case "agent_start_profile":
      state.agentRuns += 1;
      break;
    case "context_snapshot":
      observeSnapshot(state, record);
      break;
    case "provider_request":
      observeProviderRequest(state, record);
      break;
    case "provider_response":
      increment(state.responseStatus, String(record.status ?? "unknown"));
      break;
    case "tool_result":
      observeToolResult(state, record);
      break;
    case "assistant_usage":
      observeUsage(state, record);
      break;
    case "compaction":
    case "session_compact":
      state.compactionEvents += 1;
      break;
    default:
      break;
  }
}

async function readNdjson(filePath, onRecord) {
  const stream = createReadStream(filePath);
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let lineNumber = 0;

  const parseLine = (line) => {
    lineNumber += 1;
    const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (!normalized) return;
    try {
      onRecord(JSON.parse(normalized));
    } catch (error) {
      throw new Error(`Invalid NDJSON in ${basename(filePath)} at line ${lineNumber}: ${error.message}`);
    }
  };

  for await (const chunk of stream) {
    buffer += decoder.write(chunk);
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      parseLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
  }
  buffer += decoder.end();

  if (!buffer.trim()) return false;
  try {
    parseLine(buffer);
    return false;
  } catch {
    // appendNdjson writes newline-terminated records. A non-terminated invalid tail means
    // the active Pi process was observed between writes; omit only that incomplete tail.
    return true;
  }
}

function publicToolBucket(tool) {
  return {
    ...tool,
    input: { ...tool.input },
    content: {
      ...tool.content,
      meanPerCallRoughTokens: tool.count > 0
        ? Math.round(tool.content.roughTokenEstimate / tool.count)
        : 0,
    },
    details: { ...tool.details },
  };
}

function sessionOutput(state, top) {
  const toolResultsByTool = boundedTop(
    [...state.tools.values()].map(publicToolBucket),
    top,
    (item) => item.content.roughTokenEstimate,
  );
  const largestContextGrowth = boundedTop(
    state.contextSnapshot.growth,
    top,
    (item) => item.deltaBytes,
  );
  const largestContextDrop = boundedTop(
    state.contextSnapshot.drops,
    1,
    (item) => Math.abs(item.deltaBytes),
  )[0];
  const largestActiveInputDrop = boundedTop(
    state.activeInputDrops,
    1,
    (item) => Math.abs(item.deltaTokens),
  )[0];

  const activeInputDenominator = state.cumulativeUsage.input
    + state.cumulativeUsage.cacheRead
    + state.cumulativeUsage.cacheWrite;

  return {
    sessionId: state.sessionId,
    fileName: state.fileName,
    startedAt: state.firstTimestamp,
    endedAt: state.lastTimestamp,
    durationMs: state.firstTimestamp && state.lastTimestamp
      ? Date.parse(state.lastTimestamp) - Date.parse(state.firstTimestamp)
      : null,
    records: state.recordCount,
    partialTrailingRecordSkipped: state.partialTrailingRecordSkipped,
    events: state.eventCounts,
    agentRuns: state.agentRuns,
    providerRequests: state.providerRequests,
    usageSamples: state.usageSamples,
    toolResults: state.toolResultCount,
    toolErrors: state.toolErrorCount,
    responseStatus: state.responseStatus,
    compactionEvents: state.compactionEvents,
    packageVersions: [...state.packageVersions].sort((left, right) => left.localeCompare(right)),
    models: [...state.models].sort((left, right) => left.localeCompare(right)),
    providers: [...state.providers].sort((left, right) => left.localeCompare(right)),
    exactUsage: {
      finalActiveInputTokens: state.finalActiveInputTokens ?? null,
      peakActiveInputTokens: state.peakActiveInputTokens ?? null,
      finalContextUsageTokens: state.finalContextUsageTokens ?? null,
      peakContextUsageTokens: state.peakContextUsageTokens ?? null,
      finalContextUsagePercent: state.finalContextUsagePercent ?? null,
      peakContextUsagePercent: state.peakContextUsagePercent ?? null,
      contextWindow: state.contextWindow ?? null,
      cumulative: state.cumulativeUsage,
      cacheReadShare: activeInputDenominator > 0
        ? state.cumulativeUsage.cacheRead / activeInputDenominator
        : null,
      activeInputDropCount: state.activeInputDrops.length,
      largestActiveInputDrop: largestActiveInputDrop ?? null,
    },
    roughSizeAttribution: {
      contextSnapshot: {
        finalBytes: state.contextSnapshot.finalBytes ?? null,
        peakBytes: state.contextSnapshot.peakBytes ?? null,
        finalRoughTokens: state.contextSnapshot.finalRoughTokens ?? null,
        peakRoughTokens: state.contextSnapshot.peakRoughTokens ?? null,
        dropCount: state.contextSnapshot.drops.length,
        largestDrop: largestContextDrop ?? null,
      },
      providerPayload: {
        finalBytes: state.providerPayload.finalBytes ?? null,
        peakBytes: state.providerPayload.peakBytes ?? null,
        finalRoughTokens: state.providerPayload.finalRoughTokens ?? null,
        peakRoughTokens: state.providerPayload.peakRoughTokens ?? null,
      },
      largestContextGrowth,
      toolResultsByTool,
    },
  };
}

export async function summarizeFile(filePath, options = {}) {
  const top = options.top ?? 20;
  const state = createAccumulator(resolve(filePath), options.detailed === true);
  state.partialTrailingRecordSkipped = await readNdjson(resolve(filePath), (record) => {
    consumeRecord(state, record);
  });
  const summary = sessionOutput(state, top);

  if (options.detailed !== true) return summary;
  return {
    sessionId: summary.sessionId,
    requests: summary.providerRequests,
    latestUsage: state.latestUsage,
    latestContextUsage: state.latestContextUsage,
    latestProvider: state.latestProvider,
    largestMessages: state.largestMessages,
    largestToolResults: boundedTop(
      state.detailedToolResults,
      top,
      (item) => item.bytes,
    ),
    session: summary,
  };
}

function combineTools(sessions, top) {
  const combined = new Map();
  for (const session of sessions) {
    for (const tool of session.roughSizeAttribution.toolResultsByTool) {
      const current = combined.get(tool.toolName) ?? {
        toolName: tool.toolName,
        count: 0,
        errors: 0,
        input: { serializedBytes: 0, roughTokenEstimate: 0 },
        content: {
          serializedBytes: 0,
          roughTokenEstimate: 0,
          maxPerCallRoughTokens: 0,
        },
        details: { serializedBytes: 0, roughTokenEstimate: 0 },
      };
      current.count += tool.count;
      current.errors += tool.errors;
      addMetric(current.input, tool.input);
      addMetric(current.content, tool.content);
      addMetric(current.details, tool.details);
      current.content.maxPerCallRoughTokens = Math.max(
        current.content.maxPerCallRoughTokens,
        tool.content.maxPerCallRoughTokens ?? 0,
      );
      combined.set(tool.toolName, current);
    }
  }
  return boundedTop(
    [...combined.values()].map(publicToolBucket),
    top,
    (item) => item.content.roughTokenEstimate,
  );
}

function sumUsage(sessions) {
  const result = Object.fromEntries(USAGE_FIELDS.map((field) => [field, 0]));
  for (const session of sessions) {
    for (const field of USAGE_FIELDS) result[field] += session.exactUsage.cumulative[field];
  }
  const activeInputDenominator = result.input + result.cacheRead + result.cacheWrite;
  return {
    ...result,
    cacheReadShare: activeInputDenominator > 0 ? result.cacheRead / activeInputDenominator : null,
  };
}

function countSessionValues(sessions, selector) {
  const counts = {};
  for (const session of sessions) {
    for (const value of selector(session)) increment(counts, value);
  }
  return counts;
}

function aggregateSessions(sessions, top) {
  const value = (selector) => sessions.map(selector).filter(Number.isFinite);
  const growth = sessions.flatMap((session) =>
    session.roughSizeAttribution.largestContextGrowth.map((point) => ({
      sessionId: session.sessionId,
      requestIndex: point.requestIndex,
      deltaBytes: point.deltaBytes,
      deltaRoughTokens: point.deltaRoughTokens,
      precedingToolResults: point.precedingToolResults,
    }))
  );

  return {
    sessionCount: sessions.length,
    providerRequests: sessions.reduce((total, session) => total + session.providerRequests, 0),
    agentRuns: sessions.reduce((total, session) => total + session.agentRuns, 0),
    toolResults: sessions.reduce((total, session) => total + session.toolResults, 0),
    toolErrors: sessions.reduce((total, session) => total + session.toolErrors, 0),
    compactionEvents: sessions.reduce((total, session) => total + session.compactionEvents, 0),
    packageVersions: countSessionValues(sessions, (session) => session.packageVersions),
    models: countSessionValues(sessions, (session) => session.models),
    providers: countSessionValues(sessions, (session) => session.providers),
    exactUsage: {
      finalActiveInputTokens: distribution(value((session) => session.exactUsage.finalActiveInputTokens)),
      peakActiveInputTokens: distribution(value((session) => session.exactUsage.peakActiveInputTokens)),
      finalContextUsagePercent: distribution(value((session) => session.exactUsage.finalContextUsagePercent)),
      peakContextUsagePercent: distribution(value((session) => session.exactUsage.peakContextUsagePercent)),
      cumulative: sumUsage(sessions),
      activeInputDrops: sessions.reduce(
        (total, session) => total + session.exactUsage.activeInputDropCount,
        0,
      ),
    },
    roughSizeAttribution: {
      toolResultsByTool: combineTools(sessions, top),
      largestContextGrowth: boundedTop(growth, top, (item) => item.deltaBytes),
    },
  };
}

export async function summarizeDirectory(directory, options = {}) {
  const root = resolve(directory);
  const top = options.top ?? 20;
  const minimumProviderRequests = options.minimumProviderRequests ?? 1;
  const packageVersion = typeof options.packageVersion === "string"
    ? options.packageVersion.trim()
    : "";
  const since = options.since ? isoTimestamp(options.since) : undefined;
  const until = options.until ? isoTimestamp(options.until) : undefined;
  if (options.since && !since) throw new Error(`Invalid --since timestamp: ${options.since}`);
  if (options.until && !until) throw new Error(`Invalid --until timestamp: ${options.until}`);
  if (since && until && Date.parse(since) > Date.parse(until)) {
    throw new Error("--since must not be later than --until");
  }

  const entries = await readdir(root, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ndjson"))
    .map((entry) => resolve(root, entry.name))
    .sort((left, right) => left.localeCompare(right));

  const sessions = [];
  let excludedByTime = 0;
  let excludedByRequestCount = 0;
  let excludedByPackageVersion = 0;
  for (const file of files) {
    // Preserve every tool bucket until cross-session aggregation is complete. Per-session
    // ranking is trimmed only in the returned report, otherwise a frequently-small tool
    // could disappear before its totals are combined.
    const summary = await summarizeFile(file, { top: Number.MAX_SAFE_INTEGER });
    const startedAt = summary.startedAt ? Date.parse(summary.startedAt) : undefined;
    const inRange = startedAt !== undefined
      && (!since || startedAt >= Date.parse(since))
      && (!until || startedAt <= Date.parse(until));
    if (!inRange) {
      excludedByTime += 1;
      continue;
    }
    if (summary.providerRequests < minimumProviderRequests) {
      excludedByRequestCount += 1;
      continue;
    }
    if (packageVersion && !summary.packageVersions.includes(packageVersion)) {
      excludedByPackageVersion += 1;
      continue;
    }
    sessions.push(summary);
  }

  sessions.sort((left, right) => (left.startedAt ?? "").localeCompare(right.startedAt ?? ""));
  const aggregate = aggregateSessions(sessions, top);
  const rankedSessions = sessions.map((session) => ({
    ...session,
    roughSizeAttribution: {
      ...session.roughSizeAttribution,
      largestContextGrowth: session.roughSizeAttribution.largestContextGrowth.slice(0, top),
      toolResultsByTool: session.roughSizeAttribution.toolResultsByTool.slice(0, top),
    },
  }));
  return {
    schemaVersion: 1,
    mode: "batch",
    selection: {
      directoryName: basename(root),
      since: since ?? null,
      until: until ?? null,
      minimumProviderRequests,
      packageVersion: packageVersion || null,
      discoveredSessionLogs: files.length,
      includedSessions: sessions.length,
      excludedByTime,
      excludedByRequestCount,
      excludedByPackageVersion,
    },
    aggregate,
    sessions: rankedSessions,
  };
}
