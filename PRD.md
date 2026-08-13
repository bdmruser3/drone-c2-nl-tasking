# PRD: NL Tasking → Structured Mission Command

## Problem
Operators issue drone-swarm mission taskings as free text ("Launch 4 drones from Alpha, survey Sector 7, land at nearest LZ with clear approach"). The C2 allocation engine needs a structured, validated command object, not prose. Manual re-entry into a form is slow and introduces transcription errors during time-pressured operations. An LLM can bridge the gap by converting the operator's natural-language tasking directly into the structured command the allocation engine expects — but only if wrong or hallucinated fields are caught before they reach the engine.

## Input-to-Output Path
1. Operator writes a free-text tasking (one or more sentences).
2. LLM is prompted with the tasking + a fixed JSON schema + few-shot examples, and asked to return only a JSON object matching the schema.
3. Output JSON is validated against the schema (required fields present, types correct, enums respected).
4. If validation fails, the tasking + error is re-sent to the LLM once for a repair attempt. If it fails again, the item is flagged for human review instead of being passed to the allocation engine.
5. Valid JSON is passed downstream as the structured mission command.

## Example

**Input:**
```
Launch 4 drones from Alpha, survey Sector 7, land at nearest LZ with clear approach.
```

**Output:**
```json
{
  "drone_count": 4,
  "origin": "Alpha",
  "task_type": "survey",
  "target_sector": "Sector 7",
  "landing_constraint": "nearest_clear_approach"
}
```

## Acceptance Criteria
- Given a tasking that unambiguously specifies drone count, origin, task type, and target sector, the system produces a JSON object matching the schema with all fields correctly populated.
- Given a tasking missing an optional field (e.g., no landing constraint stated), the system produces valid JSON with that field set to a defined default (`"landing_constraint": "any_available"`) rather than omitting or inventing a value.
- Given a tasking with an ambiguous or unsupported field (e.g., drone count given as "a few"), the system either asks for clarification in place of guessing, or flags the output as low-confidence — it must never emit a silently guessed numeric value for a field the source text left ambiguous.
- 100% of outputs that reach the allocation engine (i.e., are not flagged) pass schema validation.

## Three Test Examples

| # | Input | Expected Output |
|---|-------|------------------|
| 1 | "Launch 4 drones from Alpha, survey Sector 7, land at nearest LZ with clear approach." | `{"drone_count":4,"origin":"Alpha","task_type":"survey","target_sector":"Sector 7","landing_constraint":"nearest_clear_approach"}` |
| 2 | "Send 2 drones to patrol the north perimeter." | `{"drone_count":2,"origin":null,"task_type":"patrol","target_sector":"north_perimeter","landing_constraint":"any_available"}` |
| 3 | "Get a few drones over to Sector 9 for recon." | Flagged for human review — "a few" is ambiguous drone count, must not be silently guessed |

## Non-Goals
- The app does not execute commands or communicate with real drones/hardware.
- The app does not perform the allocation itself (choosing which physical drone or LZ) — that stays in the existing allocation engine.
- The app does not handle multi-turn clarification dialogue with the operator; a flagged/ambiguous tasking is routed to a human, not re-negotiated by the LLM.
- The app does not support taskings in formats other than English free text (e.g., no voice input, no multi-language support).
- The app is not evaluated for latency/real-time performance — this is a functional demonstration, not a production-ready pipeline.

## Course Techniques
1. **Few-shot prompting** — example taskings paired with correct JSON outputs included in the prompt to anchor field mapping and formatting.
2. **Structured output / schema-constrained generation (function-calling style)** — the LLM is instructed to return only JSON conforming to a fixed schema, enabling automated validation.
3. **Output validation with repair loop** — a programmatic check against the schema, with one automated repair re-prompt before falling back to human review on persistent failure.
