# Context projection A/B protocol

This protocol separates passive prevalence measurement from causal optimization tests. Do not enable multiple context-changing interventions in the same experiment.

## Phase 1: passive baseline

Collect 8–12 natural sessions that meet every eligibility rule:

- every record in the session was written by `pi-context-profiler` 0.2.0;
- at least one provider request completed;
- model is `gpt-5.6-sol` with `max` reasoning;
- the profiler remained passive and memory-search projection remained disabled;
- the session did not cross an extension reload boundary.

Cover at least these workload classes:

1. durable-memory retrieval;
2. codebase exploration with multiple read/search calls;
3. ordinary implementation or debugging;
4. long-form synthesis across prior evidence.

Generate the eligible cohort report with:

```sh
npm run summarize -- \
  --dir <context-profiler-log-directory> \
  --since <inclusive-ISO-start> \
  --min-requests 1 \
  --package-version 0.2.0 \
  --top 20
```

Use provider usage for exact active/cumulative tokens. Treat byte-based component attribution as a directional estimate, not tokenizer-exact accounting.

## Phase 2: isolated memory-search intervention

The first intervention is the opt-in `memorySearchProjection` implementation in the maintained private Hermes fork. Keep it disabled during baseline collection.

Control (A):

```json
{
  "memorySearchProjection": {
    "enabled": false
  }
}
```

Treatment (B), initial budget:

```json
{
  "memorySearchProjection": {
    "enabled": true,
    "maxOutputBytes": 16384,
    "maxEntryBytes": 4096,
    "detailPageBytes": 8192,
    "deduplicateWithinSession": true
  }
}
```

Short results that already fit the total budget pass through unchanged. Oversized results use relevant excerpts and stable IDs; selected entries remain recoverable through paged `id` detail calls.

## Pairing controls

For every A/B pair, keep all of the following fixed:

- prompt text;
- model and reasoning level;
- working directory;
- filesystem and Git snapshot;
- memory database snapshot;
- Pi/package versions other than the single intervention;
- healthy/broken session-index state;
- task instructions and available tools.

Use at least 3–5 representative prompts with 2–3 repeats per arm. Alternate A/B and B/A order to reduce ordering and cache bias. Record cache reads separately from active input.

## Metrics

Primary context metrics:

- final and peak active-input tokens;
- P50/P90 across paired runs;
- cumulative input, cache read, cache write, and output;
- memory-search result bytes and correlated next-request growth;
- provider-request, retry, and compaction counts.

Quality metrics:

- correctness and completeness;
- evidence coverage;
- missing durable facts;
- additional searches, retries, or user follow-ups;
- blind preference between paired answers where practical.

## Acceptance gate

Enable the intervention by default only if the paired evidence shows:

- at least 15–20% lower active context on memory-heavy tasks;
- at least 50% lower aggregate memory-search contribution;
- no material answer-quality regression;
- no more than about 10% increase in provider requests, retries, or follow-up retrieval;
- no new errors or unintended compactions.

If the gate fails, adjust only the projection budget or paging behavior and repeat the same pairs. Do not add generic tool-result projection or session-index changes to the same treatment arm.

## Later interventions

Evaluate separately and in this order:

1. generic tool-result projection for broad read/search/bash output;
2. session-index repair and bounded session-history retrieval;
3. compaction-threshold changes only if earlier interventions leave a demonstrated need.
