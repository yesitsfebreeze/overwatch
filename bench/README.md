# Causal replay

Run with Bun, without a model or network call:

```sh
bun bench/replay.ts transcript.jsonl --sidecar=usage.json
bun bench/replay.ts transcript.jsonl --prefix=1000 --write=2 --read=0.1 --reset-cache=false
bun test bench/replay.check.ts
```

The input is Claude-style transcript JSONL with `type: user|assistant`, `message.content`, stable `requestId` or `message.id`, and optional returned `message.usage`. Sidechain/agent records contribute observed worker usage but are excluded from main-context simulations. Supply worker log files together in the input if they were recorded separately. Raw SSE deltas are not the supported input format. Complete block records and cumulative text snapshots are merged; duplicate record content and stable tool IDs are not appended twice. Usage snapshots for one request are cumulative: each field retains its highest observed value. Missing fields remain unknown, including cache fields; explicit zero is retained. Records without stable request identities are counted and flagged as unidentified, so their attribution cannot be verified.

Three counterfactuals are reported: **original recorded context**, **live-only transformation**, and **deterministic folding without Jev**. Original means the supplied record; it cannot recover content already removed before logging. Replay follows arrivals, takes a fresh immutable snapshot before each request, and never attaches future results to earlier calls. Tool results are counted once, using the same canonical sizing helper as runtime. The live transform also shares runtime's exemptions, structured/error limits, and exact-page handling. Folding uses runtime's planner, growth predicate, and cumulative archived paths. No grader is invoked and no Jev-selected fold is claimed.

These are canonical textual payload character estimates divided by four, **not provider token counts or billing measurements**. Structured media bytes are excluded and counted separately in coverage; original media content remains intact for live projection. Media tokenization, message framing, and unlogged system/tool schemas are unavailable. The prefix defaults to unknown/excluded; `--prefix` adds an explicit assumption. `--input`, `--write`, and `--read` set weighting assumptions, not prices. The cache model assumes an unchanged message prefix is reusable and optionally resets conversation cache after a fold. It does not prove provider cache behavior or expiry. Neither weighted estimates nor removed context establish net savings.

`--minimum`, `--growth`, `--keep`, `--live`, and `--index` configure simulated thresholds and budgets. Replay follows linear arrival order; branch ancestry and manual compaction are not reconstructed. Only recorded `end_turn` boundaries trigger the growth heuristic; idle/manual folds and changed generated behavior are not reconstructed. Archival is assumed successful. Actual main/worker output usage is reported independently, rather than omitted from or folded into estimated input costs.

`--sidecar` accepts either one #17 usage snapshot or its JSONL events. Events are deduplicated by session, operation ID, batch, and attempt, then filtered to transcript sessions. A snapshot is never added to its own events. Returned grader usage and its coverage remain separate from counterfactual estimates. Missing/unmatched sidecars mean **unavailable**, not zero. Small fixtures here are synthetic and contain no user conversation data.
