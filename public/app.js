const STAGE_NAMES = ['Prompt assembly', 'Structured generation', 'Schema validation', 'Repair re-prompt', 'Routing'];
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

const BASES = { Alpha: { lat: 1.387, lng: 103.708 }, Bravo: { lat: 1.358, lng: 103.909 } };
const LZS = [
  { tag: 'LZ-1 Kranji', lat: 1.425, lng: 103.755, clear: true, note: 'clear approach' },
  { tag: 'LZ-2 Marina', lat: 1.28, lng: 103.871, clear: false, note: 'obstructed' },
  { tag: 'LZ-3 Changi', lat: 1.345, lng: 104.005, clear: true, note: 'clear approach' },
  { tag: 'LZ-4 Sentosa', lat: 1.249, lng: 103.83, clear: true, note: 'clear approach' },
];
const GRID = { lat0: 1.235, lat1: 1.455, lng0: 103.62, lng1: 104.04 };
const SECTORS = [];
for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
  const dLat = (GRID.lat1 - GRID.lat0) / 3, dLng = (GRID.lng1 - GRID.lng0) / 3;
  SECTORS.push({ n: r * 3 + c + 1, lat1: GRID.lat1 - r * dLat, lat0: GRID.lat1 - (r + 1) * dLat, lng0: GRID.lng0 + c * dLng, lng1: GRID.lng0 + (c + 1) * dLng });
}
const PERIMETER = [[1.448, 103.65], [1.44, 103.72], [1.452, 103.78], [1.44, 103.85], [1.428, 103.92], [1.42, 103.99]];

function resolveTarget(name) {
  const s = String(name || '');
  const m = /(\d)/.exec(s);
  if (/sector/i.test(s) && m) {
    const sec = SECTORS[parseInt(m[1], 10) - 1];
    if (sec) return { lat: (sec.lat0 + sec.lat1) / 2, lng: (sec.lng0 + sec.lng1) / 2, label: 'SECTOR ' + m[1] };
  }
  if (/north|perimeter/i.test(s)) return { lat: 1.443, lng: 103.8, label: 'NORTH PERIMETER' };
  return { lat: 1.345, lng: 103.83, label: s ? s.toUpperCase() : 'SECTOR 5' };
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
  result: null, errors: [], ambiguous: [], routed: false, log: [],
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
  state.result = null; state.errors = []; state.ambiguous = []; state.routed = false;
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
  for (let i = 1; i < 5; i++) state.stages[i] = { name: STAGE_NAMES[i], status: 'run', detail: '' };
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
      state.busy = false;
      render();
      return;
    }
    state.stages = body.stages && body.stages.length === 5 ? body.stages : state.stages;
    state.result = body.command || null;
    state.errors = body.errors || [];
    state.ambiguous = body.ambiguous || [];
    const cmd = commandOnly(state.result);
    if (body.status === 'ok' && Number.isInteger(cmd.drone_count)) {
      state.count = Math.min(12, cmd.drone_count);
    }
  } catch (e) {
    state.stages[1] = { name: STAGE_NAMES[1], status: 'fail', detail: e.message };
    state.errors = [e.message];
  }
  state.busy = false;
  render();
}

function deploy(cmd) {
  if (state.deploying) return;
  const n = Math.min(12, Math.max(1, Number.isInteger(cmd.drone_count) ? cmd.drone_count : state.count));
  const type = TYPES.find((t) => t.id === state.droneType) || TYPES[0];
  const base = BASES[/bravo/i.test(cmd.origin || '') ? 'Bravo' : 'Alpha'];
  const target = resolveTarget(cmd.target_sector);
  const lz = pickLZ(cmd.landing_constraint, target, base);
  const M = 0.0016;
  const T = { launch: 1.5, transit: 6.5, station: 10.5, land: 14, end: 15 };
  const desc = `${n} × ${type.label} · ${state.formation} → ${target.label}`;
  const formation = state.formation;

  MissionMap.setMission({ target: [target.lat, target.lng], label: target.label, path: [[base.lat, base.lng], [target.lat, target.lng], [lz.lat, lz.lng]], lz: [lz.lat, lz.lng] });
  state.deploying = true;
  state.missionLabel = desc + ' — launching';
  state.missionColor = C.run;
  renderMissionBanner();
  renderManualDeployButton();

  const t0 = performance.now();
  let lastPhase = 'launching';
  const tick = () => {
    const t = (performance.now() - t0) / 1000;
    let cx, cy, scale = 1, phase;
    if (t < T.launch) { phase = 'launching'; cx = base.lat; cy = base.lng; scale = 0.3 + 0.2 * (t / T.launch); }
    else if (t < T.transit) { phase = 'en route'; const p = ease((t - T.launch) / (T.transit - T.launch)); cx = lerp(base.lat, target.lat, p); cy = lerp(base.lng, target.lng, p); scale = Math.min(1, 0.5 + (t - T.launch)); }
    else if (t < T.station) { phase = 'on station — ' + (cmd.task_type || 'survey'); cx = target.lat; cy = target.lng; }
    else if (t < T.land) { phase = 'landing at ' + lz.tag; const p = ease((t - T.station) / (T.land - T.station)); cx = lerp(target.lat, lz.lat, p); cy = lerp(target.lng, lz.lng, p); scale = 1 - 0.85 * p; }
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
      drones.push({ lat: cx + o.y, lng: cy + o.x, color: type.dot });
    }
    MissionMap.setDrones(drones);
    if (phase !== lastPhase) { lastPhase = phase; state.missionLabel = desc + ' — ' + phase; renderMissionBanner(); }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}

function route(status, cmd, note) {
  const body = status === 'Flagged'
    ? (state.errors.length ? 'validation: ' + state.errors.join('; ') : 'ambiguous: ' + (state.ambiguous.join(', ') || 'unspecified') + ' — not guessed')
    : JSON.stringify({ ...cmd, swarm: { type: state.droneType, formation: state.formation } }, null, 2);
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  state.routed = status !== 'Manual';
  state.log.unshift({ id: Date.now() + Math.random(), status, time, input: note, body, color: status === 'Flagged' ? C.fail : C.ok });
  renderLog();
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

function isFlagged() {
  return !!state.result && (state.errors.length > 0 || state.ambiguous.length > 0 || state.result.confidence === 'low');
}

function renderVerdict() {
  const card = $('verdict');
  if (!state.result) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  const flagged = isFlagged();
  card.classList.toggle('ok', !flagged);
  card.classList.toggle('fail', flagged);
  $('verdict-title').textContent = flagged ? 'Flagged for human review' : 'Valid mission command';
  const attempts = state.stages[3].status === 'idle' ? 1 : 2;
  $('verdict-meta').textContent = attempts === 2 ? '2 model calls · 1 repair' : '1 model call · no repair';

  const note = state.errors.length
    ? 'Schema validation failed after the repair attempt: ' + state.errors.join('; ')
    : (state.ambiguous.length ? 'Ambiguous in the tasking: ' + state.ambiguous.join(', ') + '. Held back rather than guessed.' : '');
  $('verdict-note').textContent = note;
  $('verdict-note').classList.toggle('hidden', !note);

  const cmd = commandOnly(state.result);
  const amb = state.ambiguous;
  const grid = $('fields-grid');
  grid.innerHTML = '';
  Object.keys(cmd).forEach((k) => {
    const isDefault = k === 'landing_constraint' && cmd[k] === 'any_available' && !/land|lz|return/i.test(state.input);
    const value = cmd[k] === null ? 'null' : JSON.stringify(cmd[k]);
    const noteText = amb.includes(k) ? 'ambiguous — not guessed' : (cmd[k] === null ? (k === 'origin' ? 'not stated' : 'missing') : (isDefault ? 'schema default' : ''));
    const color = amb.includes(k) ? C.fail : (cmd[k] === null ? C.muted : C.fg);
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
  meta.textContent = `${state.log.filter((e) => e.status !== 'Flagged').length} deployed · ${state.log.filter((e) => e.status === 'Flagged').length} flagged`;
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

// ---------- wiring ----------
document.addEventListener('DOMContentLoaded', () => {
  MissionMap.init('map');
  MissionMap.setStatic({
    bases: Object.entries(BASES).map(([name, p]) => ({ name: 'BASE ' + name.toUpperCase(), ...p })),
    lzs: LZS, sectors: SECTORS, perimeter: PERIMETER,
  });

  renderTypeOpts();
  renderFormOpts();
  renderSamples();
  renderLog();
  render();

  $('tasking').addEventListener('input', (e) => { state.input = e.target.value; });
  $('run-btn').addEventListener('click', run);
  $('clear-btn').addEventListener('click', () => { state.input = ''; $('tasking').value = ''; reset(); render(); });
  $('count-slider').addEventListener('input', (e) => { state.count = parseInt(e.target.value, 10) || 1; renderCount(); });

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
    if (e.target && e.target.id === 'flag-btn') {
      const cmd = commandOnly(state.result);
      route('Flagged', cmd, state.input.trim());
      renderVerdict();
    }
  });
});
