# Portable inspection v1

This guide specifies the read-only producer contract for compatible hosts that subscribe to the session-scoped Pi event bus. The channel names retain the `workbench` prefix, but the contract does not require a Workbench runtime dependency. The [terminal inspector](agent-inspector.md) remains TUI-only. Portable inspection provides no child controls or artifact access and does not change the [subagent tool](subagent-tool.md) or its results.

The package develops against Pi 1.5.0. The deterministic publication fixture passes with Pi 1.5.0 and 1.4.0, using each selected SDK's directly used Pi dependencies and TypeBox. This checks the fixture scenario, not every SDK API or Workbench host acceptance.

The package publishes as `org.tb-pi-package.subagent`. Repository-owned [conformance examples](../extensions/subagent/inspection/inspection-conformance-fixtures.json) define valid and invalid messages. The corpus has `version: 1` and a `cases` array. Each case has a unique `name`, a `target` of `request` or `publication`, an `expectedValid` boolean, and the literal `message`. The expected result covers stateless message validation, not revision ordering or attachment history. Compatible hosts must validate the same cases independently, without importing this extension's runtime code.

## Terms and scope

A provider publishes a bounded view of activities it owns. An activity is one observed run, not an agent definition. A chain produces one activity per observed step; steps share the originating tool-call ID when known. Never invent future steps or parent links. An item is an ordered visible assistant response or tool activity. The session bus defines session ownership; no payload chooses a workspace or session.

The protocol is observation only. It has no child controls, artifact access, usage accounting, raw tool arguments, private reasoning, prompts, or arbitrary result details. Tool names and visible output may contain sensitive information. No general secret redaction is promised. Consumers render text as text, not HTML or terminal control sequences.

## Transport and validation

The host emits JSON values on `workbench.inspection.v1.request`; providers emit JSON values on `workbench.inspection.v1.publish`. Values must be plain JSON objects with no unknown properties, `null`, non-finite numbers, cycles, functions, or undefined values. The object bus does not expose duplicate keys from any earlier serialization; duplicate-key detection is outside this contract. All strings contain Unicode scalar values only, with no unpaired surrogates. An absent optional property is distinct from an empty string or empty array. Optional values, when present, must satisfy their field constraints. All object keys below are required unless marked `?`. JSON object key order is immaterial.

All integer fields are JSON integers between 0 and 9,007,199,254,740,991 inclusive unless a smaller range is specified. IDs are case-sensitive ASCII strings matching `[A-Za-z0-9._:-]{1,128}`. Do not truncate or hash IDs silently. An unrepresentable required identity causes that activity or provider to be omitted; report it as described below. `providerId` is a stable, globally distinctive producer name, such as `org.example.subagent`. Its uniqueness on a bus is required, not a security guarantee. `generation`, `epoch`, and `requestId` use the same ID grammar and must be freshly generated with at least 128 bits of randomness represented as ASCII. They are opaque, not counters.

Text limits below count UTF-8 bytes of the decoded string, not JSON escape characters or UTF-16 units. Truncation must preserve complete Unicode scalars. Each message also has a 524,288-byte ceiling measured as UTF-8 bytes of its complete compact JSON serialization, including keys, punctuation, and escaping. A receiver must validate this ceiling before accepting the message. String and aggregate bounds still apply when the encoded message fits. A provider must account for JSON escaping, not estimate from decoded text. There is no compression allowance. A host may apply a separate total session budget across providers.

## Exact message shapes

The notation below describes JSON values, not imported TypeScript types. `?` means the property may be absent. Arrays retain order. No other fields are permitted at any level.

```text
Request = Attach | Detach
Attach = { version: 1, kind: "attach", requestId: Id, generation: Id }
Detach = { version: 1, kind: "detach", requestId: Id, generation: Id }

Publication = Snapshot | Batch
Common = { version: 1, providerId: Id, epoch: Id, generation: Id, revision: Integer }
Snapshot = Common & {
  kind: "snapshot", requestId: Id,
  capabilities: ["replacement", "removal"],
  activities: Activity[0..64], omittedActivities: Integer
}
Batch = Common & {
  kind: "batch", upserts: Activity[0..64], removals: Id[0..64],
  omittedActivities: Integer
}
Activity = {
  id: Id, title: Text1_256, task?: Text0_4096,
  parentId?: Id, toolCallId?: Id,
  state: "unknown" | "queued" | "running" | "completed" | "failed" | "aborted" | "timed-out",
  cleanup?: "unknown",
  model?: Model, thinking?: Thinking,
  items: Item[0..100], omittedItems: Integer,
  truncated: boolean
}
Model = {
  requested?: Text1_256,
  resolved?: Text1_256[0..16],
  attempted?: Text1_256[0..16],
  observedDispatch?: Text1_256[0..16],
  observedResponse?: Text1_256[0..16],
  truncated: boolean
}
Thinking = "child-default" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
Item = Response | Tool
Response = { kind: "response", sequence: PositiveInteger, text: Text0_16384, truncated: boolean }
Tool = {
  kind: "tool", sequence: PositiveInteger, id: Id, name: Text1_256,
  state: "running" | "completed" | "failed" | "aborted",
  output: Text0_16384, truncated: boolean
}
```

`TextA_B` means a string of A through B UTF-8 bytes. `PositiveInteger` is 1 through the maximum safe integer. A batch must have at least one upsert or removal, or change `omittedActivities` from the preceding accepted state. `capabilities` must have exactly the two strings in the order shown. This fixed list announces the supported operations, not optional extensions. No standalone announcement or error message exists in v1.

Within an activity, the sum of UTF-8 bytes of `task`, response `text`, and tool `output` must not exceed 16,384. Other strings have their own limits. Item sequences must be strictly increasing and unique within that activity. Tool IDs must be unique among the activity's tool items. Activity IDs in a snapshot or batch are unique; batch upsert and removal IDs must be disjoint. A parent ID may reference an omitted or unobserved activity and must not equal the activity's own ID. IDs are never reused within a provider epoch, including after removal. Lists in model metadata retain source order and may be empty only when the producer knows the list is empty. Values are not inferred from each other.

`title` is a producer-supplied display label, not identity. `task` absent means unavailable or not supplied; `""` is known empty. `state: "unknown"` means execution state is not established. `cleanup: "unknown"` means cleanup cannot be verified. Absence does not mean cleanup succeeded. Terminal states are completed, failed, aborted, and timed-out; they describe execution, not quality of work or confirmed descendant cleanup. The source store's `timed out` maps to `timed-out`. Do not invent `stopping` from a stop request.

Model fields distinguish the requested selection, ordered resolved selections from `ModelProvenance.resolved`, ordered attempted launch selections, observed Pi dispatch identities, and provider response model IDs. Absence means unknown or unavailable, not a negative observation. An explicitly empty array means the source established that the corresponding list was empty at projection time. If a resolved or attempted selection uses the child's default model and has no concrete model ID, the producer omits that entire list and sets model `truncated` to true. It does not report the list as empty or publish only its concrete entries. Dispatch and response identities do not prove successful output or the physical model. `thinking` is the resolved launch setting; `child-default` means no explicit level was passed. Its absence means unknown. Never use these fields for reasoning content.

`truncated` on a response or tool means its text/output was shortened by the producer or was already known shortened at source. Activity `truncated` means any of its task, title, items, or source activity content was shortened or unavailable because of a bound, including when the source only exposes a coarse truncation flag. Model `truncated` means some model metadata was shortened or omitted due to a bound. An omitted model object does not imply no model. `omittedItems` counts items known omitted from the source snapshot by projection, not unknown items previously dropped by the source; the activity truncation flag covers the latter. An empty item array does not prove that no earlier items existed. `omittedActivities` counts known retained source activities excluded from the current published set, including identity or size failures. It is not an execution count and never includes activities the provider has not observed.

## Attachment and revisions

There is one logical host receiver per session bus. Before emitting attach, the host installs its listener. It chooses a new generation for each attachment lifetime. Each request has a fresh request ID, except an exact retry reuses its original ID and payload. A provider starts with a fresh epoch on creation or reload and revision 0. It subscribes once on a valid attach and synchronously captures a consistent immutable projection and revision, then publishes a snapshot echoing the request ID and generation. It sends that snapshot before any batch for that attachment. While detached, no projection serialization, publication, or publication timer runs. Source changes accumulate in the source store; on attach the provider captures the current bounded projection and synchronizes it before sending the snapshot.

Repeating the same attach is idempotent: it causes a fresh current snapshot with the same request ID, without a second subscription or a revision increment solely for the request. A new attach request ID for the same generation also asks for a current snapshot. A valid attach with a different generation replaces the previous attachment, cancels its pending publication, and sends a snapshot for the new generation. The host must not reuse a request ID for a different request during an attachment. The provider retains only the last valid request ID and payload for conflict detection, using O(1) state. If the next valid request reuses that ID with a different payload, the provider ignores it. The provider does not detect conflicts with older requests; the host remains responsible for avoiding them. Receivers match snapshots to an outstanding attach request, generation, and provider. Delayed duplicate snapshots at a revision older than their current accepted revision are ignored; equal revision snapshots must represent the same projected state. A newer snapshot replaces the full provider view atomically.

Detach applies only when its generation matches the current attachment. It is idempotent and has no acknowledgement. It removes the subscription and timers without cancelling work. A stale detach does nothing. Providers ignore malformed requests and unknown versions without changing attachment state or executing tools. After detach, hosts ignore delayed messages for that generation. If a provider registers after an attach, the host retries the same attach or sends a new attach for that generation; there is no discovery broadcast.

The revision belongs to `(session bus, providerId, epoch)`, not the host generation. It starts at 0 and advances exactly once per committed projected-state change, whether that state is first delivered by a batch or a snapshot. A change means a difference in the published set, a published record, or the omission count. Requests alone never advance it. Before an answering snapshot, the provider commits the current projection; if it differs from the last committed state, the provider advances the revision once and the snapshot carries that revision. The provider need not emit an older pending batch to the requesting host. A newly attached host starts from the snapshot revision; an existing host accepts a matching newer snapshot as a full replacement. Do not wrap revisions; on exhaustion stop publication and require a fresh provider epoch.

For an accepted epoch, the next batch must have revision exactly one greater than the accepted revision. Ignore duplicates and older batches. On a gap, invalid batch, or conflicting same-revision content, retain the last good view, mark it stale, and request a new snapshot with a fresh request ID. Do not apply later batches until a matching valid snapshot arrives. A provider epoch change replaces the old view only on a valid matching snapshot; ignore batches for an unknown epoch and request a snapshot. Two live providers claiming the same provider ID are a conflict: do not merge their records; mark that provider unavailable until a fresh attachment resolves the conflict. Epoch is not an authentication mechanism. Arbitrary trusted in-process code can spoof or disrupt events.

## Projection, bounds, and lifecycle

Maintain at most 64 published activities, with active (`unknown`, `queued`, `running`) first, then terminal activities. Within each group select most recently created first, with ID ascending as the deterministic tie-breaker. Selection is stable unless source membership or state changes; do not reorder on each token. Snapshot ordering follows that selection. Preserve item sequence order and retain the most recent 100 items. For text budgets retain the most recent complete Unicode scalars of each text; allocate the aggregate 16 KiB to newest items first, then task. Mark affected fields and activity truncated. If an ID, title, or mandatory structure cannot be represented safely, omit the activity and increment the omission count. Do not silently change its identity. For bounded model arrays retain the most recent 16 entries and mark model truncation; bound each entry to 256 UTF-8 bytes and mark truncation. Titles and tool names are bounded to 256 bytes with activity truncation set. The publisher may reduce text further or omit lower-priority selected activities to meet the encoded message ceiling, setting the same markers and omission count. The compact encoded snapshot must also fit within 491,520 bytes. This reserves 32,768 bytes for batch envelope differences and up to 64 removal IDs. Relative to the complete new-state snapshot, the batch upserts are a subset of its activities. Each removal ID needs at most 130 bytes with quotes, plus at most 63 commas, for 8,383 bytes total. Allow another 1,024 bytes for all fixed envelope, key, punctuation, and kind differences, including empty-array syntax. IDs use unescaped ASCII. The conservative extra bound is therefore 9,407 bytes, below the 32,768-byte reserve. If the snapshot is too large, reduce text or omit lower-priority activities until it fits. If even the envelope cannot be encoded, stop publication and use the failure behavior below.

An upsert replaces the complete activity record, never appends text. A removal deletes a previously published activity because it left source retention or the bounded published selection; it does not assert completion. A batch applies all removals and upserts atomically, then replaces the omission count. If selection changes, send both removals and replacements in the same batch. The snapshot reserve above makes the corresponding atomic batch fit within the 524,288-byte ceiling. Never split one logical revision across messages. If encoding still fails, use the publication failure behavior below. A host may request a snapshot at any time using attach. The provider must not increment revision for an unobserved transient state that was never committed to a publication or snapshot.

Coalesce nonterminal changes for at most 100 ms and keep only the latest pending projection. A terminal transition flushes promptly with its final visible content and supersedes any older pending record for that activity. A terminal record may later be removed due to retention or selection; terminal is not removal. If the activity is omitted by the bounded selection, increment the omission count rather than claiming that its terminal event was observed. Terminal publication is best effort, not an acknowledgement of receipt. A snapshot is a complete replacement of the bounded published set, not proof that omitted or removed work ended.

On session replacement, reload, or shutdown, invalidate the attachment before callbacks can emit, unsubscribe, clear timers, and dispose the provider. Do not synthesize terminal events. A new provider instance has a new epoch. Hosts retain last known state as observation unavailable until a new valid snapshot, separately from execution state. A browser disconnect alone is not session shutdown. Async runs may outlive the launch tool; observation detach does not stop them. There is no process recovery or artifact retrieval in this contract.

Projection, validation, and event delivery failures must not change execution or model-visible results. Catch failures at the publisher boundary, drop the affected publication, issue only a fixed bounded diagnostic without payload contents, and permit a fresh attach snapshot to resynchronize. If the final batch is lost, no later gap may reveal the loss. Recovery then requires the host to independently reattach or request a snapshot; this contract does not guarantee automatic recovery. The inspected Pi 1.4.0 and 1.5.0 event-bus implementation and declaration files are byte-identical. The inspected emit implementation launches async handlers, catches and logs handler errors, and does not await listeners. A resource loader accepts an injected event bus. The package develops against Pi 1.5.0. The deterministic fixture also passes with Pi 1.4.0; neither that scenario nor matching bus files establishes full SDK compatibility. Since listeners execute in a trusted process, arbitrary listener code may still block or disrupt the bus; this protocol cannot guarantee isolation. Publication order must be established before calling emit; completion of listener work is not ordered or acknowledged by emit. A receiver rejects malformed or oversized messages atomically and resynchronizes rather than partially applying them. No error reply is required.

## Message examples

The literal tokens below are syntactically valid examples. Randomness is a generation requirement and cannot be established from one observed value. Byte counts use the decoded strings.

Valid attach and matching empty snapshot:

```json
{
  "version": 1,
  "kind": "attach",
  "requestId": "req-0123456789abcdef0123456789abcdef",
  "generation": "gen-0123456789abcdef0123456789abcdef"
}
```

```json
{
  "version": 1,
  "kind": "snapshot",
  "requestId": "req-0123456789abcdef0123456789abcdef",
  "generation": "gen-0123456789abcdef0123456789abcdef",
  "providerId": "org.example.subagent",
  "epoch": "epoch-0123456789abcdef0123456789abcdef",
  "revision": 0,
  "capabilities": ["replacement", "removal"],
  "activities": [],
  "omittedActivities": 0
}
```

Valid next batch, containing Unicode and a known empty output:

```json
{
  "version": 1,
  "kind": "batch",
  "generation": "gen-0123456789abcdef0123456789abcdef",
  "providerId": "org.example.subagent",
  "epoch": "epoch-0123456789abcdef0123456789abcdef",
  "revision": 1,
  "upserts": [
    {
      "id": "run-1",
      "title": "scout",
      "task": "Inspect café",
      "toolCallId": "call-1",
      "state": "running",
      "thinking": "child-default",
      "model": { "requested": "provider/model", "attempted": [], "truncated": false },
      "items": [
        { "kind": "response", "sequence": 1, "text": "Hello", "truncated": false },
        {
          "kind": "tool",
          "sequence": 2,
          "id": "tool-1",
          "name": "read",
          "state": "running",
          "output": "",
          "truncated": false
        }
      ],
      "omittedItems": 0,
      "truncated": false
    }
  ],
  "removals": [],
  "omittedActivities": 0
}
```

Valid removal after the previous batch. It means no longer published, not completed:

```json
{
  "version": 1,
  "kind": "batch",
  "generation": "gen-0123456789abcdef0123456789abcdef",
  "providerId": "org.example.subagent",
  "epoch": "epoch-0123456789abcdef0123456789abcdef",
  "revision": 2,
  "upserts": [],
  "removals": ["run-1"],
  "omittedActivities": 0
}
```

Valid detach:

```json
{
  "version": 1,
  "kind": "detach",
  "requestId": "req-fedcba9876543210fedcba9876543210",
  "generation": "gen-0123456789abcdef0123456789abcdef"
}
```

Invalid request: unsupported version, so it must not attach.

```json
{
  "version": 2,
  "kind": "attach",
  "requestId": "req-0123456789abcdef0123456789abcdef",
  "generation": "gen-0123456789abcdef0123456789abcdef"
}
```

Invalid activity: `null` is not absence and raw arguments are forbidden.

```json
{
  "id": "run-1",
  "title": "scout",
  "task": null,
  "state": "running",
  "items": [
    {
      "kind": "tool",
      "sequence": 1,
      "id": "t1",
      "name": "read",
      "state": "running",
      "output": "",
      "truncated": false,
      "args": { "path": "secret" }
    }
  ],
  "omittedItems": 0,
  "truncated": false
}
```

Invalid batch: the same ID cannot be upserted and removed in one atomic batch.

```json
{
  "version": 1,
  "kind": "batch",
  "generation": "gen-0123456789abcdef0123456789abcdef",
  "providerId": "org.example.subagent",
  "epoch": "epoch-0123456789abcdef0123456789abcdef",
  "revision": 2,
  "upserts": [
    {
      "id": "run-1",
      "title": "scout",
      "state": "completed",
      "items": [],
      "omittedItems": 0,
      "truncated": false
    }
  ],
  "removals": ["run-1"],
  "omittedActivities": 0
}
```

Invalid sequence after the snapshot and revision 1 above: revision 3 is a gap, even though this message is structurally valid. Request a snapshot, do not apply it.

```json
{
  "version": 1,
  "kind": "batch",
  "generation": "gen-0123456789abcdef0123456789abcdef",
  "providerId": "org.example.subagent",
  "epoch": "epoch-0123456789abcdef0123456789abcdef",
  "revision": 3,
  "upserts": [],
  "removals": ["run-1"],
  "omittedActivities": 0
}
```

Invalid activity: sequences are not strictly increasing.

```json
{
  "id": "run-1",
  "title": "scout",
  "state": "running",
  "items": [
    { "kind": "response", "sequence": 2, "text": "a", "truncated": false },
    { "kind": "response", "sequence": 1, "text": "b", "truncated": false }
  ],
  "omittedItems": 0,
  "truncated": false
}
```
