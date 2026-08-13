const STAGE_NAMES = ['Prompt assembly', 'Structured generation', 'Schema validation', 'Repair re-prompt', 'Location resolution', 'Routing'];
const C = { ok: '#7fae6a', run: '#e2703a', fail: '#e5695c', idle: '#6d5c4e', muted: '#a49383', fg: '#f0e8e0' };

const TYPES = [
  { id: 'recon', label: 'Recon-Q', dot: '#e2703a' },
  { id: 'strike', label: 'Strike-FPV', dot: '#e5695c' },
  { id: 'cargo', label: 'Cargo-VTOL', dot: '#7fae6a' },
];
const FORMS = [
  { id: 'wedge', label: 'Wedge', glyph: '∧' },
  { id: 'line', label: 'Line', glyph: '———' },
  { id: 'ring', label: 'Ring', glyph: '◯' },
  { id: 'column', label: 'Column', glyph: '⋮' },
];

const SAMPLES = [
  { n: '1', text: 'Launch 4 drones from Alpha, survey Sector 7, land at nearest LZ with clear approach.', expect: 'Expect: all five fields populated' },
  { n: '2', text: 'Send 2 drones to patrol the north perimeter.', expect: 'Expect: origin null, landing default applied' },
  { n: '3', text: 'Get a few drones over to Sector 9 for recon.', expect: 'Expect: flagged — ambiguous drone count' },
];

// Place data now lives in ao.js, shared verbatim with the server so the map, the prompt
// and the validator cannot disagree about which places exist.
const { BASES, LZS, GRID, SECTORS, PERIMETER, LANDMARKS } = AO;

//: Where a manual deploy goes when no parsed command is on screen. An explicit default,
//: not a lookup miss — resolveTarget() no longer invents a location for unknown names.
const MANUAL_DEFAULT_TARGET = 'Sector 5';

function generateObstacles() {
  const clearOf = [...BASES, ...LZS]; // AO.BASES is an array of {name, lat, lng}
  const n = 5 + Math.floor(Math.random() * 4); // 5-8
  const obs = [];
  for (let i = 0; i < n; i++) {
    let lat, lng, ok, tries = 0;
    do {
      lat = GRID.lat0 + Math.random() * (GRID.lat1 - GRID.lat0);
      lng = GRID.lng0 + Math.random() * (GRID.lng1 - GRID.lng0);
      ok = clearOf.every((p) => Math.hypot(p.lat - lat, p.lng - lng) > 0.012);
      tries++;
    } while (!ok && tries < 20);
    const radius = 0.0035 + Math.random() * 0.0035; // ~390-780m no-fly buffer
    const height = 110 + Math.round(Math.random() * 260); // 110-370m AGL, cosmetic
    obs.push({ id: 'OBST-' + (i + 1), lat, lng, radius, height });
  }
  return obs;
}
const OBSTACLES = generateObstacles();

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return { dist: Math.hypot(px - cx, py - cy), t, cx, cy };
}

// Deterministic fallback: nudge waypoints out of any obstacle's no-fly radius.
function routeAroundObstacles(points, obstacles) {
  const routed = [points[0]];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const hits = [];
    (obstacles || OBSTACLES).forEach((o) => {
      const { dist, t, cx, cy } = distToSegment(o.lat, o.lng, a[0], a[1], b[0], b[1]);
      const clearance = o.radius * 1.35;
      if (dist < clearance && t > 0.02 && t < 0.98) {
        let dx = cx - o.lat, dy = cy - o.lng;
        const mag = Math.hypot(dx, dy) || 1e-6;
        dx /= mag; dy /= mag;
        hits.push({ t, point: [o.lat + dx * clearance, o.lng + dy * clearance] });
      }
    });
    hits.sort((h1, h2) => h1.t - h2.t);
    hits.forEach((h) => routed.push(h.point));
    routed.push(b);
  }
  return routed;
}

function pathLength(path) {
  let d = 0;
  for (let i = 0; i < path.length - 1; i++) d += Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]);
  return d;
}
function pointAlongPath(path, t) {
  if (path.length === 1) return { lat: path[0][0], lng: path[0][1] };
  const total = pathLength(path);
  if (total === 0) return { lat: path[0][0], lng: path[0][1] };
  let remaining = Math.max(0, Math.min(1, t)) * total;
  for (let i = 0; i < path.length - 1; i++) {
    const segLen = Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]);
    if (remaining <= segLen || i === path.length - 2) {
      const frac = segLen === 0 ? 0 : Math.min(1, remaining / segLen);
      return { lat: path[i][0] + (path[i + 1][0] - path[i][0]) * frac, lng: path[i][1] + (path[i + 1][1] - path[i][1]) * frac };
    }
    remaining -= segLen;
  }
  return { lat: path[path.length - 1][0], lng: path[path.length - 1][1] };
}

async function planRoute(start, end) {
  try {
    const res = await fetch('/api/route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start, end, obstacles: OBSTACLES }),
    });
    const body = await res.json();
    if (body.ok && Array.isArray(body.waypoints) && body.waypoints.length >= 2) {
      return { path: body.waypoints.map((w) => [w.lat, w.lng]), source: 'llm' };
    }
  } catch (e) { /* fall through to geometric fallback */ }
  return { path: routeAroundObstacles([[start.lat, start.lng], [end.lat, end.lng]]), source: 'fallback' };
}

function resolveTarget(name) {
  const hit = AO.resolvePlace(name);
  if (hit) return hit;
  // Unreachable for a server-approved command: an unresolvable place is flagged and can
  // never be dispatched. Falling back to the AO centre here is what used to make an
  // invented sector look plausible on the map.
  return AO.resolvePlace(MANUAL_DEFAULT_TARGET);
}
function offsetOf(form, i, n, m) {
  if (form === 'line') return { x: (i - (n - 1) / 2) * m, y: 0 };
  if (form === 'ring') { const a = (2 * Math.PI * i) / n; return { x: Math.cos(a) * m * 1.4, y: Math.sin(a) * m * 1.4 }; }
  if (form === 'column') return { x: 0, y: -i * m };
  const k = Math.ceil(i / 2), side = i % 2 ? -1 : 1;
  return { x: (i === 0 ? 0 : side * k * m), y: -k * m };
}
const ease = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);
const lerp = (a, b, t) => a + (b - a) * t;

const state = {
  input: '', busy: false,
  stages: STAGE_NAMES.map((n) => ({ name: n, status: 'idle', detail: '' })),
  result: null, errors: [], ambiguous: [], unresolved: [], status: null, provenance: {}, routed: false, log: [],
  droneType: 'recon', count: 4, formation: 'wedge',
  deploying: false, missionLabel: '', missionColor: C.run,
};
let raf = 0;

function commandOnly(o) {
  if (!o) return {};
  return {
    drone_count: o.drone_count ?? null,
    origin: o.origin ?? null,
    task_type: o.task_type ?? null,
    target_sector: o.target_sector ?? null,
    landing_constraint: o.landing_constraint ?? 'any_available',
  };
}

function pickLZ(constraint, target, originBase) {
  if (constraint === 'return_to_origin') return { tag: 'ORIGIN', ...originBase };
  const pool = constraint === 'nearest_clear_approach' ? LZS.filter((z) => z.clear) : LZS;
  return pool.reduce((a, b) =>
    Math.hypot(a.lat - target.lat, a.lng - target.lng) < Math.hypot(b.lat - target.lat, b.lng - target.lng) ? a : b);
}

function reset() {
  state.stages = STAGE_NAMES.map((n) => ({ name: n, status: 'idle', detail: '' }));
  state.result = null; state.errors = []; state.ambiguous = []; state.unresolved = [];
  state.status = null; state.provenance = {}; state.routed = false;
}

async function run() {
  const tasking = state.input.trim();
  if (!tasking || state.busy) return;
  reset();
  state.busy = true;
  state.stages[0] = { name: STAGE_NAMES[0], status: 'run', detail: '' };
  render();
  await new Promise((r) => setTimeout(r, 120));
  state.stages[0] = { name: STAGE_NAMES[0], status: 'ok', detail: '3 few-shot pairs + 7-key schema' };
  for (let i = 1; i < STAGE_NAMES.length; i++) state.stages[i] = { name: STAGE_NAMES[i], status: 'run', detail: '' };
  render();

  try {
    const res = await fetch('/api/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tasking }),
    });
    const body = await res.json();
    if (!res.ok) {
      state.stages[1] = { name: STAGE_NAMES[1], status: 'fail', detail: body.message || 'request failed' };
      state.errors = [body.message || 'request failed'];
      state.status = 'error';
      state.busy = false;
      render();
      return;
    }
    state.stages = body.stages && body.stages.length === STAGE_NAMES.length ? body.stages : state.stages;
    state.result = body.command || null;
    state.errors = body.errors || [];
    state.ambiguous = body.ambiguous || [];
    state.unresolved = body.unresolved || [];
    state.status = body.status || null;
    state.provenance = {};
    const cmd = commandOnly(state.result);
    if (body.status === 'ok' && Number.isInteger(cmd.drone_count)) {
      state.count = Math.min(12, cmd.drone_count);
    }
  } catch (e) {
    state.stages[1] = { name: STAGE_NAMES[1], status: 'fail', detail: e.message };
    state.errors = [e.message];
    state.status = 'error';
  }
  state.busy = false;
  render();
}

async function deploy(cmd) {
  if (state.deploying) return;
  const n = Math.min(12, Math.max(1, Number.isInteger(cmd.drone_count) ? cmd.drone_count : state.count));
  const type = TYPES.find((t) => t.id === state.droneType) || TYPES[0];
  // A dispatched command has already had its origin resolved server-side; the fallback
  // covers only a legitimately null origin (nothing stated), never an unrecognised one —
  // those are flagged and cannot reach this function.
  const base = AO.resolveOrigin(cmd.origin) || AO.resolveOrigin('Alpha');
  const target = resolveTarget(cmd.target_sector);
  const lz = pickLZ(cmd.landing_constraint, target, base);
  const desc = `${n} × ${type.label} · ${state.formation} → ${target.label}`;
  const formation = state.formation;

  state.deploying = true;
  state.missionLabel = desc + ' — routing (LLM planning path around obstacles)…';
  state.missionColor = C.run;
  renderMissionBanner();
  renderManualDeployButton();

  const routed = await planRoute({ lat: base.lat, lng: base.lng }, { lat: target.lat, lng: target.lng });
  const transitPath = routed.path;
  const landPath = routeAroundObstacles([[target.lat, target.lng], [lz.lat, lz.lng]]);
  const fullPath = transitPath.concat(landPath.slice(1));

  const M = 26; // formation spacing in screen px — see MissionMap.pixelOffset
  const T = { launch: 1.5, transit: 6.5, station: 10.5, land: 14, end: 15 };

  MissionMap.setMission({ target: [target.lat, target.lng], label: target.label, path: fullPath, lz: [lz.lat, lz.lng] });
  state.missionLabel = desc + ` — launching (route: ${routed.source === 'llm' ? 'LLM-planned' : 'geometric fallback'}, ${transitPath.length} waypoints)`;
  renderMissionBanner();

  const t0 = performance.now();
  let lastPhase = 'launching';
  const tick = () => {
    const t = (performance.now() - t0) / 1000;
    let cx, cy, scale = 1, phase;
    if (t < T.launch) { phase = 'launching'; cx = base.lat; cy = base.lng; scale = 0.3 + 0.2 * (t / T.launch); }
    else if (t < T.transit) { phase = 'en route'; const p = ease((t - T.launch) / (T.transit - T.launch)); const pt = pointAlongPath(transitPath, p); cx = pt.lat; cy = pt.lng; scale = Math.min(1, 0.5 + (t - T.launch)); }
    else if (t < T.station) { phase = 'on station — ' + (cmd.task_type || 'survey'); cx = target.lat; cy = target.lng; }
    else if (t < T.land) { phase = 'landing at ' + lz.tag; const p = ease((t - T.station) / (T.land - T.station)); const pt = pointAlongPath(landPath, p); cx = pt.lat; cy = pt.lng; scale = 1 - 0.85 * p; }
    else {
      MissionMap.setDrones([]);
      MissionMap.setMission(null);
      state.deploying = false;
      state.missionLabel = desc + ' — complete, recovered at ' + lz.tag;
      state.missionColor = C.ok;
      renderMissionBanner();
      renderManualDeployButton();
      return;
    }
    const rot = formation === 'ring' ? t * 0.5 : 0;
    const drones = [];
    for (let i = 0; i < n; i++) {
      let o = offsetOf(formation, i, n, M * scale);
      if (rot) { const c = Math.cos(rot), s = Math.sin(rot); o = { x: o.x * c - o.y * s, y: o.x * s + o.y * c }; }
      // o.y is "north-positive"; screen y grows downward, hence the flip.
      const [lat, lng] = MissionMap.pixelOffset([cx, cy], o.x, -o.y);
      drones.push({ lat, lng, color: type.dot });
    }
    MissionMap.setDrones(drones);
    if (phase !== lastPhase) { lastPhase = phase; state.missionLabel = desc + ' — ' + phase; renderMissionBanner(); }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}

function operatorSuppliedFields() {
  return Object.keys(state.provenance).filter((f) => state.provenance[f] === 'operator');
}

function route(status, cmd, note) {
  const supplied = operatorSuppliedFields();
  const body = status === 'Flagged'
    ? (state.errors.length ? 'validation: ' + state.errors.join('; ') : 'ambiguous: ' + (state.ambiguous.join(', ') || 'unspecified') + ' — not guessed')
    : JSON.stringify({
      ...cmd,
      ...(supplied.length ? { operator_supplied: supplied } : {}),
      swarm: { type: state.droneType, formation: state.formation },
    }, null, 2);
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  // "Routed" means the result reached a terminal destination. A resolved command has
  // not — it is now awaiting dispatch, so it must not suppress the Dispatch button.
  state.routed = status === 'Dispatched' || status === 'Flagged';
  state.log.unshift({ id: Date.now() + Math.random(), status, time, input: note, body, color: status === 'Flagged' ? C.fail : C.ok });
  renderLog();
}

// ---------- human review dialog ----------

/**
 * What a reviewer has to supply before this command can be dispatched: places the
 * gazetteer rejected, fields the model flagged as vague, and any required field simply
 * left null. Ordered so the unknown-place cases (which show the rejected value) come
 * first.
 */
function fieldsNeedingInput() {
  const cmd = commandOnly(state.result);
  const seen = new Set();
  const needs = [];
  state.unresolved.forEach((u) => {
    if (seen.has(u.field)) return;
    seen.add(u.field);
    needs.push({ field: u.field, why: u.reason, rejected: u.value });
  });
  state.ambiguous.forEach((f) => {
    if (seen.has(f)) return;
    seen.add(f);
    needs.push({ field: f, why: 'stated vaguely — not guessed', rejected: null });
  });
  ['drone_count', 'task_type', 'target_sector'].forEach((f) => {
    if (seen.has(f) || cmd[f] !== null) return;
    seen.add(f);
    needs.push({ field: f, why: 'not stated in the tasking', rejected: null });
  });
  return needs;
}

function option(parent, label, value) {
  const o = document.createElement('option');
  o.textContent = label;
  o.value = value;
  parent.appendChild(o);
  return o;
}

/**
 * A constrained control per field. Places come from the gazetteer and enums from the
 * shared list the server validates against, so a reviewer cannot hand-type the very
 * hallucination the parser just rejected.
 */
function buildControl(field, current) {
  if (field === 'drone_count') {
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.max = '12';
    input.className = 'review-input';
    input.placeholder = 'How many drones? (1–12)';
    if (Number.isInteger(current)) input.value = String(current);
    input.dataset.field = field;
    return input;
  }

  const select = document.createElement('select');
  select.className = 'review-select';
  select.dataset.field = field;

  if (field === 'origin') {
    option(select, '— select launch base —', '');
    option(select, '(not stated)', '__null__');
    AO.BASES.forEach((b) => option(select, 'Base ' + b.name, b.name));
  } else if (field === 'target_sector') {
    option(select, '— select target —', '');
    AO.targetOptions().forEach((g) => {
      const group = document.createElement('optgroup');
      group.label = g.group;
      g.names.forEach((n) => option(group, n, n));
      select.appendChild(group);
    });
  } else if (field === 'task_type') {
    option(select, '— select task type —', '');
    AO.TASK_TYPES.forEach((t) => option(select, t, t));
  } else if (field === 'landing_constraint') {
    AO.LANDING.forEach((l) => option(select, l, l));
    select.value = current || 'any_available';
  }
  return select;
}

function renderReviewFields(needs) {
  const host = $('review-fields');
  host.innerHTML = '';
  const cmd = commandOnly(state.result);
  needs.forEach((need) => {
    const wrap = document.createElement('div');
    wrap.className = 'review-field';

    const head = document.createElement('div');
    head.className = 'review-field-head';
    const key = document.createElement('code');
    key.className = 'review-field-key';
    key.textContent = need.field;
    const why = document.createElement('span');
    why.className = 'review-field-why';
    why.textContent = need.why;
    head.append(key, why);
    wrap.appendChild(head);

    if (need.rejected !== null && need.rejected !== undefined) {
      const rejected = document.createElement('p');
      rejected.className = 'review-rejected';
      rejected.append(document.createTextNode('model produced '));
      const code = document.createElement('code');
      code.textContent = JSON.stringify(need.rejected);
      rejected.appendChild(code);
      rejected.append(document.createTextNode(' — rejected'));
      wrap.appendChild(rejected);
    }

    wrap.appendChild(buildControl(need.field, cmd[need.field]));
    host.appendChild(wrap);
  });
}

function renderReviewKnown(needFields) {
  const host = $('review-known');
  host.innerHTML = '';
  const cmd = commandOnly(state.result);
  Object.keys(cmd).forEach((k) => {
    if (needFields.includes(k)) return;
    const row = document.createElement('div');
    row.className = 'field-row';
    const key = document.createElement('code');
    key.className = 'field-key';
    key.textContent = k;
    const value = document.createElement('span');
    value.className = 'field-value';
    value.textContent = cmd[k] === null ? 'null' : JSON.stringify(cmd[k]);
    row.append(key, value);
    host.appendChild(row);
  });
}

function showReviewError(message) {
  const el = $('review-error');
  el.textContent = message;
  el.classList.remove('hidden');
}

function openReview() {
  if (!state.result && !state.errors.length) return;
  const blocked = state.errors.length > 0;
  const needs = blocked ? [] : fieldsNeedingInput();

  $('review-tasking').textContent = state.input.trim();
  $('review-error').classList.add('hidden');
  $('review-reason').textContent = blocked
    ? 'The model could not produce a schema-valid command, even after one repair attempt.'
    : `Held back because ${needs.map((n) => n.field).join(', ')} could not be taken from the tasking. `
      + `Supply ${needs.length > 1 ? 'them' : 'it'} to clear this command for dispatch.`;

  const blockedEl = $('review-blocked');
  blockedEl.classList.toggle('hidden', !blocked);
  if (blocked) {
    blockedEl.textContent = 'Re-issue the tasking with the missing detail stated explicitly. '
      + 'Hand-filling every field here would not be reviewing the parse — there is no trustworthy parse to review.';
  }

  $('review-needs').classList.toggle('hidden', blocked || needs.length === 0);
  $('review-known-wrap').classList.toggle('hidden', blocked);
  $('review-approve').disabled = blocked;

  renderReviewFields(needs);
  renderReviewKnown(needs.map((n) => n.field));
  $('review-overlay').classList.remove('hidden');
}

function closeReview() {
  $('review-overlay').classList.add('hidden');
}

function collectOverrides() {
  const overrides = {};
  let complete = true;
  $('review-fields').querySelectorAll('[data-field]').forEach((el) => {
    const field = el.dataset.field;
    const raw = el.value;
    if (raw === '' || raw === null || raw === undefined) { complete = false; return; }
    if (field === 'drone_count') {
      const n = parseInt(raw, 10);
      if (!Number.isInteger(n)) { complete = false; return; }
      overrides[field] = n;
    } else if (raw === '__null__') {
      overrides[field] = null;
    } else {
      overrides[field] = raw;
    }
  });
  return { overrides, complete };
}

/**
 * Send the operator's values to the server, which re-runs the same validation the
 * parser uses. The dropdowns above are a convenience; this round trip is the
 * enforcement, so an approved command is held to the same standard as a parsed one.
 */
async function approveReview() {
  const { overrides, complete } = collectOverrides();
  if (!complete) {
    showReviewError('Supply every field listed above before approving.');
    return;
  }
  const btn = $('review-approve');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  try {
    const res = await fetch('/api/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tasking: state.input.trim(), command: state.result, overrides }),
    });
    const body = await res.json();
    if (!res.ok) { showReviewError(body.message || 'resolve request failed'); return; }
    if (body.status !== 'ok') {
      const why = (body.errors || []).concat((body.unresolved || []).map((u) => `${u.field} "${u.value}" — ${u.reason}`));
      showReviewError('Still not dispatchable: ' + (why.join('; ') || 'unresolved'));
      return;
    }

    state.result = body.command;
    state.status = body.status;
    state.errors = body.errors || [];
    state.ambiguous = body.ambiguous || [];
    state.unresolved = body.unresolved || [];
    state.provenance = body.provenance || {};
    state.stages = body.stages && body.stages.length === STAGE_NAMES.length ? body.stages : state.stages;

    const cmd = commandOnly(state.result);
    if (Number.isInteger(cmd.drone_count)) state.count = Math.min(12, cmd.drone_count);
    route('Resolved', cmd, state.input.trim());
    closeReview();
    render();
  } catch (e) {
    showReviewError(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Approve for dispatch';
  }
}

// ---------- rendering ----------
const $ = (id) => document.getElementById(id);

function renderTypeOpts() {
  const el = $('type-opts');
  el.innerHTML = '';
  TYPES.forEach((t) => {
    const btn = document.createElement('button');
    btn.className = 'type-btn' + (state.droneType === t.id ? ' active' : '');
    btn.innerHTML = `<span class="type-dot" style="background:${t.dot}"></span>${t.label}`;
    btn.onclick = () => { state.droneType = t.id; renderTypeOpts(); };
    el.appendChild(btn);
  });
}

function renderFormOpts() {
  const el = $('form-opts');
  el.innerHTML = '';
  FORMS.forEach((f) => {
    const btn = document.createElement('button');
    btn.className = 'form-btn' + (state.formation === f.id ? ' active' : '');
    btn.innerHTML = `<span class="form-glyph">${f.glyph}</span>${f.label}`;
    btn.onclick = () => { state.formation = f.id; renderFormOpts(); };
    el.appendChild(btn);
  });
}

function renderSamples() {
  const el = $('samples');
  el.innerHTML = '';
  SAMPLES.forEach((s) => {
    const btn = document.createElement('button');
    btn.className = 'sample-btn';
    btn.innerHTML = `<span class="sample-n">${s.n}</span><span class="sample-text">${s.text}<span class="sample-expect">${s.expect}</span></span>`;
    btn.onclick = () => { state.input = s.text; $('tasking').value = s.text; reset(); render(); };
    el.appendChild(btn);
  });
}

function renderStages() {
  const el = $('stages');
  el.innerHTML = '';
  state.stages.forEach((st) => {
    const color = st.status === 'run' ? C.run : st.status === 'ok' ? C.ok : st.status === 'fail' ? C.fail : C.idle;
    const label = st.status === 'run' ? 'running' : st.status === 'ok' ? 'pass' : st.status === 'fail' ? 'fail' : 'idle';
    const row = document.createElement('div');
    row.className = 'stage-row';
    row.innerHTML = `
      <span class="stage-dot" style="background:${color};${st.status === 'run' ? 'animation:pulse 1s ease-in-out infinite' : ''}"></span>
      <div class="stage-body">
        <div class="stage-top"><span class="stage-name">${st.name}</span><span class="stage-status" style="color:${color}">${label}</span></div>
        ${st.detail ? `<p class="stage-detail">${st.detail}</p>` : ''}
      </div>`;
    el.appendChild(row);
  });
}

function renderCount() {
  $('count-slider').value = state.count;
  $('count-val').textContent = state.count;
  const cmd = commandOnly(state.result);
  $('count-note').textContent = 'Count — ' + (state.result && Number.isInteger(cmd.drone_count) ? 'synced from parsed command' : 'manual');
}

function renderManualDeployButton() {
  const btn = $('manual-deploy-btn');
  btn.textContent = state.deploying ? 'Swarm airborne…' : 'Deploy swarm manually';
  btn.disabled = state.deploying;
  const lastTarget = state.result && state.result.target_sector && !isFlagged() ? state.result.target_sector : 'Sector 5';
  $('manual-hint').textContent = `Manual deploy bypasses the NL pipeline and launches with these settings to ${lastTarget}.`;
}

function renderMissionBanner() {
  const banner = $('mission-banner');
  if (!state.missionLabel) { banner.classList.add('hidden'); return; }
  banner.classList.remove('hidden');
  $('mission-dot').style.background = state.missionColor;
  $('mission-dot').style.animation = state.deploying ? 'pulse 1s ease-in-out infinite' : 'none';
  $('mission-label').textContent = state.missionLabel;
}

/**
 * The server owns this verdict. Recomputing it here from errors/ambiguous/confidence
 * would miss any reason the client does not model — an unresolvable place name, for
 * one — and silently offer Dispatch on a command the server had already held back.
 */
function isFlagged() {
  if (state.status) return state.status !== 'ok';
  return !!state.result && (state.errors.length > 0 || state.ambiguous.length > 0 || state.result.confidence === 'low');
}

function renderVerdict() {
  const card = $('verdict');
  if (!state.result) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  const flagged = isFlagged();
  card.classList.toggle('ok', !flagged);
  card.classList.toggle('fail', flagged);
  const supplied = operatorSuppliedFields();
  $('verdict-title').textContent = flagged
    ? 'Flagged for human review'
    : (supplied.length ? 'Cleared by operator review' : 'Valid mission command');
  const attempts = state.stages[3].status === 'idle' ? 1 : 2;
  $('verdict-meta').textContent = supplied.length
    ? `${supplied.length} field${supplied.length > 1 ? 's' : ''} supplied by operator`
    : (attempts === 2 ? '2 model calls · 1 repair' : '1 model call · no repair');

  const unknownPlaces = state.unresolved.map((u) => `${u.field} "${u.value}" — ${u.reason}`).join('; ');
  const note = state.errors.length
    ? 'Schema validation failed after the repair attempt: ' + state.errors.join('; ')
    : unknownPlaces
      ? 'Unknown location: ' + unknownPlaces + '. Not plotted, not dispatched.'
      : (state.ambiguous.length ? 'Ambiguous in the tasking: ' + state.ambiguous.join(', ') + '. Held back rather than guessed.' : '');
  $('verdict-note').textContent = note;
  $('verdict-note').classList.toggle('hidden', !note);

  const cmd = commandOnly(state.result);
  const amb = state.ambiguous;
  const unknown = state.unresolved.map((u) => u.field);
  const grid = $('fields-grid');
  grid.innerHTML = '';
  Object.keys(cmd).forEach((k) => {
    const isDefault = k === 'landing_constraint' && cmd[k] === 'any_available' && !/land|lz|return/i.test(state.input);
    const value = cmd[k] === null ? 'null' : JSON.stringify(cmd[k]);
    const byOperator = state.provenance[k] === 'operator';
    const noteText = unknown.includes(k) ? 'unknown place — not on the map'
      : amb.includes(k) ? 'ambiguous — not guessed'
      : byOperator ? 'operator-supplied'
      : (cmd[k] === null ? (k === 'origin' ? 'not stated' : 'missing') : (isDefault ? 'schema default' : ''));
    const color = amb.includes(k) || unknown.includes(k) ? C.fail
      : byOperator ? C.run
      : (cmd[k] === null ? C.muted : C.fg);
    const row = document.createElement('div');
    row.className = 'field-row';
    row.innerHTML = `<code class="field-key">${k}</code><span class="field-value" style="color:${color}">${value}${noteText ? `<span class="field-note">${noteText}</span>` : ''}</span>`;
    grid.appendChild(row);
  });

  const canDispatch = !flagged && !state.routed;
  const mustReview = flagged && !state.routed;
  $('dispatch-row').classList.toggle('hidden', !canDispatch);
  $('review-row').classList.toggle('hidden', !mustReview);
}

function renderLog() {
  const el = $('log');
  const meta = $('log-meta');
  if (!state.log.length) {
    meta.textContent = '';
    el.innerHTML = '<div class="card"><p class="hint">No taskings processed yet. Parse a tasking or deploy manually to see commands routed here.</p></div>';
    return;
  }
  const deployed = state.log.filter((e) => e.status === 'Dispatched' || e.status === 'Manual').length;
  const flaggedCount = state.log.filter((e) => e.status === 'Flagged').length;
  const resolvedCount = state.log.filter((e) => e.status === 'Resolved').length;
  meta.textContent = `${deployed} deployed · ${flaggedCount} flagged`
    + (resolvedCount ? ` · ${resolvedCount} resolved` : '');
  el.innerHTML = '';
  state.log.forEach((e) => {
    const art = document.createElement('div');
    art.className = 'log-entry';
    art.innerHTML = `
      <div class="log-head"><span class="log-status" style="color:${e.color}">${e.status}</span><span class="log-time">${e.time}</span></div>
      <p class="log-input">${e.input}</p>
      <pre class="log-body">${e.body}</pre>`;
    el.appendChild(art);
  });
}

function render() {
  $('run-btn').textContent = state.busy ? 'Parsing…' : 'Parse tasking';
  $('run-btn').disabled = state.busy;
  renderStages();
  renderVerdict();
  renderCount();
  renderManualDeployButton();
  renderMissionBanner();
}

function switchTab(name) {
  const mission = name === 'mission';
  $('view-mission').classList.toggle('hidden', !mission);
  $('view-diagnostics').classList.toggle('hidden', mission);
  $('tab-mission').classList.toggle('active', mission);
  $('tab-diagnostics').classList.toggle('active', !mission);
  if (mission) {
    setTimeout(() => { const m = MissionMap.getMap(); if (m) m.invalidateSize(); }, 0);
  }
}

// ---------- wiring ----------
document.addEventListener('DOMContentLoaded', () => {
  MissionMap.init('map');
  MissionMap.setStatic({
    bases: BASES.map((b) => ({ name: 'BASE ' + b.name.toUpperCase(), lat: b.lat, lng: b.lng })),
    lzs: LZS, sectors: SECTORS, perimeter: PERIMETER, landmarks: LANDMARKS,
  });
  MissionMap.setObstacles(OBSTACLES);

  renderTypeOpts();
  renderFormOpts();
  renderSamples();
  renderLog();
  render();

  $('tasking').addEventListener('input', (e) => { state.input = e.target.value; });
  $('run-btn').addEventListener('click', run);
  $('clear-btn').addEventListener('click', () => { state.input = ''; $('tasking').value = ''; reset(); render(); });
  $('count-slider').addEventListener('input', (e) => { state.count = parseInt(e.target.value, 10) || 1; renderCount(); });

  $('tab-mission').addEventListener('click', () => switchTab('mission'));
  $('tab-diagnostics').addEventListener('click', () => switchTab('diagnostics'));

  $('manual-deploy-btn').addEventListener('click', () => {
    const lastTarget = state.result && state.result.target_sector && !isFlagged() ? state.result.target_sector : 'Sector 5';
    const mc = { drone_count: state.count, origin: 'Alpha', task_type: 'survey', target_sector: lastTarget, landing_constraint: 'any_available' };
    const typeLabel = (TYPES.find((t) => t.id === state.droneType) || {}).label;
    route('Manual', mc, `Manual deployment — ${state.count} × ${typeLabel}, ${state.formation}`);
    deploy(mc);
  });

  document.body.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'dispatch-btn') {
      const cmd = commandOnly(state.result);
      route('Dispatched', cmd, state.input.trim());
      renderVerdict();
      deploy(cmd);
    }
    if (e.target && e.target.id === 'flag-btn') openReview();
  });

  $('review-close').addEventListener('click', closeReview);
  $('review-approve').addEventListener('click', approveReview);
  $('review-reject').addEventListener('click', () => {
    route('Flagged', commandOnly(state.result), state.input.trim());
    closeReview();
    render();
  });
  $('review-overlay').addEventListener('click', (e) => {
    if (e.target === $('review-overlay')) closeReview();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('review-overlay').classList.contains('hidden')) closeReview();
  });
});
