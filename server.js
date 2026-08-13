require('dotenv').config();
const express = require('express');
const path = require('path');
const AO = require('./public/ao.js');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const TASK_TYPES = AO.TASK_TYPES;
const LANDING = AO.LANDING;
const STAGE_NAMES = ['Prompt assembly', 'Structured generation', 'Schema validation', 'Repair re-prompt', 'Location resolution', 'Routing'];

const SCHEMA_PROMPT = `{
  "drone_count": integer >= 1,
  "origin": string | null,
  "task_type": one of ${JSON.stringify(TASK_TYPES)},
  "target_sector": string,
  "landing_constraint": one of ${JSON.stringify(LANDING)},
  "confidence": "high" | "low",
  "ambiguous_fields": array of field names left ambiguous by the source text
}`;

const FEWSHOT = `Example 1
Tasking: "Launch 4 drones from Alpha, survey Sector 7, land at nearest LZ with clear approach."
JSON: {"drone_count":4,"origin":"Alpha","task_type":"survey","target_sector":"Sector 7","landing_constraint":"nearest_clear_approach","confidence":"high","ambiguous_fields":[]}

Example 2
Tasking: "Send 2 drones to patrol the north perimeter."
JSON: {"drone_count":2,"origin":null,"task_type":"patrol","target_sector":"north_perimeter","landing_constraint":"any_available","confidence":"high","ambiguous_fields":[]}

Example 3
Tasking: "Get a few drones over to Sector 9 for recon."
JSON: {"drone_count":null,"origin":null,"task_type":"recon","target_sector":"Sector 9","landing_constraint":"any_available","confidence":"low","ambiguous_fields":["drone_count"]}`;

const SYSTEM = `You are a C2 tasking parser. Convert one English drone-swarm tasking into a single structured mission command JSON object.

Schema:
${SCHEMA_PROMPT}

Rules:
- Return ONLY the JSON object. No prose, no code fences.
- Never invent a value the source text does not support. If a field is stated vaguely ("a few", "some", "several", "a couple"), set it to null, list its name in ambiguous_fields, and set confidence to "low".
- origin is null when no launch point is stated. landing_constraint defaults to "any_available" when unstated — that default is not ambiguity.
- target_sector keeps the operator's label ("Sector 7") or a snake_case form of a described area ("north_perimeter").

${AO.promptRoster()}

${FEWSHOT}`;

function extractJson(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) { return null; }
}

function validate(obj) {
  const errs = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return ['output is not a JSON object'];
  const amb = Array.isArray(obj.ambiguous_fields) ? obj.ambiguous_fields : [];
  const dc = obj.drone_count;
  if (dc === null || dc === undefined) {
    if (!amb.includes('drone_count')) errs.push('drone_count is null but not listed in ambiguous_fields');
  } else if (!Number.isInteger(dc) || dc < 1) errs.push('drone_count must be an integer >= 1');
  if (!('origin' in obj)) errs.push('origin missing (use null when unstated)');
  else if (obj.origin !== null && typeof obj.origin !== 'string') errs.push('origin must be a string or null');
  if (!TASK_TYPES.includes(obj.task_type)) errs.push('task_type must be one of ' + TASK_TYPES.join(', '));
  if (typeof obj.target_sector !== 'string' || !obj.target_sector.trim()) {
    if (!amb.includes('target_sector')) errs.push('target_sector must be a non-empty string');
  }
  if (!LANDING.includes(obj.landing_constraint)) errs.push('landing_constraint must be one of ' + LANDING.join(', '));
  if (obj.confidence !== 'high' && obj.confidence !== 'low') errs.push('confidence must be "high" or "low"');
  return errs;
}

/**
 * Check every stated place against the gazetteer.
 *
 * A place the gazetteer does not know is a hallucination that schema validation cannot
 * catch — "Sector 47" and origin "Zulu" are perfectly well-formed strings. Callers must
 * never issue a repair re-prompt for this: re-asking would only pressure the model into
 * swapping an invented place for a real-looking one, which is the very failure this
 * guards against. An unknown place goes straight to human review.
 *
 * Shared by /api/parse and /api/resolve so a human-completed command is held to exactly
 * the same standard as a model-produced one.
 */
function resolveLocations(command, ambiguousFields, schemaInvalid) {
  const unresolved = [];
  const resolved = {};
  if (!command || schemaInvalid) return { unresolved, resolved };

  if (command.origin !== null && command.origin !== undefined) {
    const origin = AO.resolveOrigin(command.origin);
    if (origin) resolved.origin = origin;
    else unresolved.push({ field: 'origin', value: String(command.origin), reason: 'not a known launch base' });
  }
  if (!ambiguousFields.includes('target_sector') && typeof command.target_sector === 'string' && command.target_sector.trim()) {
    const target = AO.resolvePlace(command.target_sector);
    if (target) resolved.target_sector = target;
    else unresolved.push({ field: 'target_sector', value: command.target_sector, reason: 'not a known sector, area or landmark in this AO' });
  }
  return { unresolved, resolved };
}

/** Human-readable detail for the Location resolution stage row. */
function locationStageDetail(errs, unresolved, resolved) {
  if (errs.length) return 'skipped — schema invalid';
  if (unresolved.length) return unresolved.map((u) => `${u.field} "${u.value}" — ${u.reason}`).join('; ');
  const keys = Object.keys(resolved);
  return keys.length ? keys.map((k) => `${k} → ${resolved[k].canonical}`).join(' · ') : 'no locations stated';
}

async function callModel(messages) {
  const res = await fetch(`${process.env.OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.INTAKE_MODEL,
      messages,
      temperature: 0,
    }),
  });
  if (!res.ok) {
    throw new Error(`Model request failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.choices[0].message.content;
}

app.post('/api/parse', async (req, res) => {
  const tasking = (req.body.tasking || '').trim();
  if (!tasking) {
    return res.status(400).json({ status: 'error', message: 'tasking text is required' });
  }

  const stages = STAGE_NAMES.map((n) => ({ name: n, status: 'idle', detail: '' }));
  const setStage = (i, status, detail) => { stages[i] = { name: STAGE_NAMES[i], status, detail }; };

  try {
    setStage(0, 'ok', '3 few-shot pairs + 7-key schema');

    const baseMessages = [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Tasking: ${JSON.stringify(tasking)}` },
    ];

    let raw = await callModel(baseMessages);
    let parsed = extractJson(raw);
    setStage(1, parsed ? 'ok' : 'fail', parsed ? 'JSON object returned' : 'no parseable JSON in output');

    let errs = parsed ? validate(parsed) : ['output was not parseable JSON'];
    setStage(2, errs.length ? 'fail' : 'ok', errs.length ? errs.join('; ') : 'all fields valid against schema v1');

    if (errs.length) {
      const repairMessages = [
        ...baseMessages,
        { role: 'assistant', content: String(raw || '(no output)') },
        { role: 'user', content: `That output failed schema validation:\n- ${errs.join('\n- ')}\nReturn a corrected JSON object only.` },
      ];
      const repairRaw = await callModel(repairMessages);
      const repairParsed = extractJson(repairRaw);
      setStage(1, repairParsed ? 'ok' : 'fail', repairParsed ? 'JSON object returned (repair)' : 'no parseable JSON in repair output');
      const repairErrs = repairParsed ? validate(repairParsed) : ['repair output was not parseable JSON'];
      setStage(3, repairErrs.length ? 'fail' : 'ok', repairErrs.length ? 'after repair: ' + repairErrs.join('; ') : 'valid after one repair attempt');
      raw = repairRaw;
      parsed = repairParsed;
      errs = repairErrs;
    } else {
      setStage(3, 'idle', 'not needed');
    }

    const amb = parsed && Array.isArray(parsed.ambiguous_fields) ? parsed.ambiguous_fields : [];
    const lowConf = parsed && parsed.confidence === 'low';

    const { unresolved, resolved } = resolveLocations(parsed, amb, errs.length > 0);
    setStage(
      4,
      errs.length ? 'idle' : unresolved.length ? 'fail' : 'ok',
      locationStageDetail(errs, unresolved, resolved)
    );

    const flagged = errs.length > 0 || amb.length > 0 || lowConf || unresolved.length > 0;
    setStage(5, flagged ? 'fail' : 'ok', flagged
      ? (errs.length ? 'schema validation failed twice → human review'
        : unresolved.length ? 'unknown location → human review'
        : 'low confidence on ' + (amb.join(', ') || 'unnamed field') + ' → human review')
      : 'cleared — dispatch to deploy the swarm');

    return res.json({
      status: flagged ? 'flagged_for_review' : 'ok',
      command: parsed,
      errors: errs,
      ambiguous: amb,
      unresolved,
      resolved,
      stages,
      raw,
    });
  } catch (e) {
    return res.status(500).json({ status: 'error', message: e.message, stages });
  }
});

//: Fields a human reviewer may supply. `confidence` and `ambiguous_fields` are excluded
//: deliberately — those are the model's report about itself, not values to hand-edit.
const RESOLVABLE_FIELDS = ['drone_count', 'origin', 'task_type', 'target_sector', 'landing_constraint'];

/**
 * Complete a flagged command with operator-supplied values.
 *
 * This is the PRD's human-review destination, not the excluded multi-turn dialogue: a
 * person supplies what the tasking left unclear, and the model is not consulted again.
 * No model call happens here.
 *
 * The merged command is re-validated through exactly the same validate() and
 * resolveLocations() the parser uses. The dialog's constrained dropdowns are a
 * convenience, not the enforcement — a hand-crafted request with drone_count 0 or an
 * invented sector is rejected here just as a model's would be.
 */
app.post('/api/resolve', (req, res) => {
  const tasking = (req.body.tasking || '').trim();
  const base = req.body.command;
  const overrides = req.body.overrides || {};

  if (!base || typeof base !== 'object' || Array.isArray(base)) {
    return res.status(400).json({ status: 'error', message: 'a command object is required' });
  }

  const command = { ...base };
  const provenance = {};
  RESOLVABLE_FIELDS.forEach((f) => { provenance[f] = 'model'; });
  Object.keys(overrides).forEach((f) => {
    if (!RESOLVABLE_FIELDS.includes(f)) return;
    command[f] = overrides[f];
    provenance[f] = 'operator';
  });

  // A field the operator has now supplied is no longer ambiguous. Confidence follows
  // from what is left, so a fully resolved command is not held back by the model's
  // original self-doubt.
  const priorAmbiguous = Array.isArray(base.ambiguous_fields) ? base.ambiguous_fields : [];
  const amb = priorAmbiguous.filter((f) => provenance[f] !== 'operator');
  command.ambiguous_fields = amb;
  command.confidence = amb.length ? 'low' : 'high';

  const errs = validate(command);
  const { unresolved, resolved } = resolveLocations(command, amb, errs.length > 0);
  const flagged = errs.length > 0 || amb.length > 0 || unresolved.length > 0;
  const supplied = Object.keys(provenance).filter((f) => provenance[f] === 'operator');

  const stages = [
    { name: STAGE_NAMES[0], status: 'idle', detail: 'not re-run — no model call' },
    { name: STAGE_NAMES[1], status: 'idle', detail: 'operator-supplied values' },
    { name: STAGE_NAMES[2], status: errs.length ? 'fail' : 'ok', detail: errs.length ? errs.join('; ') : 'all fields valid against schema v1' },
    { name: STAGE_NAMES[3], status: 'idle', detail: 'not applicable to operator review' },
    { name: STAGE_NAMES[4], status: errs.length ? 'idle' : unresolved.length ? 'fail' : 'ok', detail: locationStageDetail(errs, unresolved, resolved) },
    {
      name: STAGE_NAMES[5],
      status: flagged ? 'fail' : 'ok',
      detail: flagged
        ? 'still incomplete after review — not dispatchable'
        : `cleared by operator — ${supplied.length ? supplied.join(', ') + ' supplied by hand' : 'no changes needed'}`,
    },
  ];

  return res.json({
    status: flagged ? 'flagged_for_review' : 'ok',
    command,
    errors: errs,
    ambiguous: amb,
    unresolved,
    resolved,
    provenance,
    stages,
    raw: null,
    tasking,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));
