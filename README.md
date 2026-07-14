# pi-context-profiler

Passive, content-free context attribution for Pi. The extension observes Pi lifecycle events and writes local NDJSON metrics without modifying messages, provider payloads, tools, prompts, compaction, or model settings.

## Privacy contract

The profiler records:

- exact UTF-8/serialized byte counts;
- rough byte-based token estimates (`ceil(bytes / 4)`), explicitly not tokenizer-exact;
- SHA-256 hashes for equality/deduplication checks;
- message roles, content-part kinds, tool names, model/provider IDs, response status, and numeric usage;
- context-file basenames and hashes of complete paths, never complete paths.

It does **not** record prompt text, system-prompt text, tool arguments, tool-result text, file contents, provider response bodies, or response header values. Hashes are fingerprints, not encryption.

## Observed boundaries

Each session log can contain:

- `agent_start_profile`: user-prompt and system-prompt sizes plus system construction categories;
- `context_snapshot`: Pi Agent history immediately before provider conversion;
- `provider_request`: the actual provider payload structure and component sizes;
- `tool_result`: content/details sizes before the result enters later context;
- `assistant_usage`: exact provider usage and Pi context-window usage;
- `compaction_start` / `compaction`: trigger, retry state, exact pre-compaction tokens, and content-free summary/message metrics;
- lifecycle correlation records.

The comparison between `tool_result`, `context_snapshot`, and `provider_request` reveals whether output was retained, transformed, or projected before reaching the model.

## Storage

Default log location:

```text
~/.pi/agent/context-profiler/<session-id>.ndjson
```

`latest.json` points to the most recently updated session log without containing prompt or tool-result content. `PI_CODING_AGENT_DIR` changes the agent directory. `PI_CONTEXT_PROFILER_DIR` can override only the profiler output directory. Logs are local state and are not stored inside this package repository.

## Installation and activation

This repository is distributed from Git only and is intentionally marked `private` in `package.json` to prevent npm publication.

```powershell
git clone https://github.com/LovelyLoong/pi-context-profiler.git C:\PiWorkbench\packages\pi-context-profiler
Set-Location C:\PiWorkbench\packages\pi-context-profiler
npm ci
```

Add the local package path to Pi settings, then restart or reload Pi:

```json
"C:\\PiWorkbench\\packages\\pi-context-profiler"
```

The extension registers event observers only. It adds no LLM tool, slash command, keybinding, flag, system text, or custom provider.

## Summary

Inspect one session while preserving the original detailed report:

```sh
npm run summarize -- C:/Users/SkyUser/.pi/agent/context-profiler/<session-id>.ndjson
```

Build a cross-session baseline from sessions that started in an inclusive time range:

```sh
npm run summarize -- \
  --dir C:/Users/SkyUser/.pi/agent/context-profiler \
  --since 2026-07-14T00:00:00Z \
  --until 2026-07-17T23:59:59Z \
  --min-requests 1 \
  --package-version 0.2.0 \
  --top 20
```

A package-version filter includes only sessions whose records all use that exact profiler version, excluding sessions that crossed an extension reload boundary. The batch report includes profiler/model/provider version distributions, P50/P90/final/peak active-input usage, cumulative provider usage, cache-read share, compaction counts, context-growth points, and tool-result attribution by tool name. Provider usage is exact; component attribution remains the documented byte-based rough estimate. The reader streams complete NDJSON records and safely skips only an incomplete trailing record from a concurrently active session.

Both report modes contain metadata only. They output log basenames and session IDs, never complete log paths or source text.

## Verification

```sh
npm ci
npm run check
npm audit
```

For strict A/B work, follow the [A/B protocol](https://github.com/LovelyLoong/pi-context-profiler/blob/main/docs/ab-protocol.md): first collect a profiler-only, single-version baseline, then enable exactly one result-projection intervention while holding model, reasoning level, prompt, cwd, filesystem/memory snapshots, and session-index state fixed.
