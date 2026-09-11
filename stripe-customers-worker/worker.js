// ══════════════════════════════════════════════════════════════════════
// stripe-customers — Cloudflare Worker
// Slate ▸ Stripe Customers tab backend (Slate 3.416, 2026-09-11)
//
// PURPOSE
//   Make every rostered SPM player of a session a Stripe Customer, with
//   metadata naming every team they are on and their role, WITHOUT ever
//   creating a duplicate and without the browser touching the Stripe key.
//
// ENDPOINTS
//   GET  /health                      → { ok, livemode, version }
//   POST /sync  { session_id, dry_run, only_apa? }
//        → { ok, session, roster, stripe_scanned, plan{…counts}, rows[…],
//            writes{created, updated, unchanged, skipped, errors} }
//
// AUTH  Authorization: Bearer <SUPABASE_SERVICE_KEY> — equality with the
//       Worker's own secret (house pattern: PatchCheck certs worker). The
//       caller (Slate) already holds that key; no second shared secret.
//
// READ-FIRST, DIFF-WRITE (the user's directive, and Stripe's reality —
// Stripe does NOT dedupe customers by email; two POSTs are two customers):
//   1. roster    ← Supabase: every team_membership of the session's SPM
//                  divisions joined to players (name, email). One entry per
//                  PLAYER; teams collapsed into metadata.
//   2. mirror    ← slate.stripe_customers (what WE created before).
//   3. stripe    ← ONE paginated sweep of GET /v1/customers (100/page),
//                  indexed by metadata.apa_number, then by exact email.
//                  Never the Search API (read-after-write lag, ~1 min).
//   4. plan      ← per player: create | update | unchanged | skip(no email)
//                  | adopt (a customer with our email but no apa metadata:
//                  claimed by OVERWRITING it, never duplicated).
//   5. write     ← create, or a FULL OVERWRITE of an existing customer from
//                  slate (name, email, description, all metadata; foreign
//                  metadata keys cleared) — serially, 429 → backoff.
//                  Create carries Idempotency-Key slate-cust-<apa>-v1.
//   6. mirror    ← upsert slate.stripe_customers for every written row.
//
// SUBREQUEST BUDGET (2026-09-11, escape 0911-stripe-subrequests): a Worker
//   invocation may make only N outbound fetches (50 on the free plan, 1000
//   paid). The first full sync tried 937 creates in one call and died at
//   "Too many subrequests" with 37 created and the mirror unwritten. Every
//   fetch now counts against SUBREQUEST_BUDGET; writes stop when the budget
//   is nearly spent, the mirror is flushed, and the response carries
//   `remaining` — the client calls /sync again until remaining == 0. Each
//   call re-sweeps, so a customer created in an earlier batch is found by
//   metadata.apa_number and is never created twice.
//
// METADATA SHAPE (values ≤ 500 chars — Stripe's limit; enforced here)
//   apa_number    "97218821"          member_number "18821"   source "slate"
//   session       "Fall 2026"
//   teams         "01008 Captain; 02311 Co-Captain; 03412 Member"
//   captain_of    "01008; 02311"      (empty string when none)
//   team_names    "01008 The Sharks; 02311 …"  (human aid; truncated)
//
// DEPLOY  npx wrangler deploy  (+ the two `wrangler secret put` in wrangler.toml)
// ══════════════════════════════════════════════════════════════════════

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};
const SPM_OPERATOR_ID = 1;
const SUBREQUEST_BUDGET = 48;         // free-plan cap is 50; keep 2 spare for the mirror flush
let _subrequests = 0;                 // per-invocation (module state is reset per isolate, and we reset in handleSync)
async function counted(url, init) { _subrequests++; return fetch(url, init); }
class BudgetExhausted extends Error {}
const META_MAX = 500;                 // Stripe metadata value limit
const ROLE_RANK = { 'Captain': 0, 'Co-Captain': 1, 'Member': 2 };

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

// ── Supabase (service role) ───────────────────────────────────────────
async function sb(env, method, path, body, extraHeaders) {
  const r = await counted(env.SUPABASE_URL + '/rest/v1/' + path, {
    method,
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: 'Bearer ' + env.SUPABASE_SERVICE_KEY,
      'Accept-Profile': 'slate', 'Content-Profile': 'slate',
      'Content-Type': 'application/json',
      ...(extraHeaders || {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error('supabase ' + method + ' ' + path.split('?')[0] + ' → ' + r.status + ' ' + txt.slice(0, 200));
  return txt ? JSON.parse(txt) : null;
}

/* Every page of a PostgREST list — SETOF/table GETs cap at 1000 rows. */
async function sbAll(env, path) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const page = await sb(env, 'GET', path, undefined, { Range: from + '-' + (from + 999), 'Range-Unit': 'items' });
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out;
}

// ── Stripe ────────────────────────────────────────────────────────────
async function stripe(env, method, path, { body, idem } = {}) {
  const headers = { Authorization: 'Bearer ' + env.STRIPE_RAK, 'Stripe-Version': env.STRIPE_VERSION };
  let payload;
  if (body) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(body).toString(); }
  if (idem) headers['Idempotency-Key'] = idem;
  for (let attempt = 0; ; attempt++) {
    const r = await counted('https://api.stripe.com' + path, { method, headers, body: payload });
    if (r.status === 429 && attempt < 5) {          // rate limit / lock timeout → exponential backoff + jitter
      await new Promise(res => setTimeout(res, (250 << attempt) + Math.random() * 200));
      continue;
    }
    const json = await r.json().catch(() => ({}));
    return { status: r.status, json, reqId: r.headers.get('request-id') };
  }
}

/* The bulk read: every customer in the account, one sweep. */
async function stripeAllCustomers(env) {
  const all = [];
  let after = '';
  for (let page = 0; page < 500; page++) {           // 50k customers hard stop
    const r = await stripe(env, 'GET', '/v1/customers?limit=100' + (after ? '&starting_after=' + after : ''));
    if (r.status !== 200) throw new Error('stripe list → ' + r.status + ' ' + (r.json.error && r.json.error.message || ''));
    all.push(...r.json.data);
    if (!r.json.has_more) break;
    after = r.json.data[r.json.data.length - 1].id;
  }
  return all;
}

// ── Roster → per-player desired state ─────────────────────────────────
function clip(s) { s = String(s || ''); return s.length <= META_MAX ? s : s.slice(0, META_MAX - 1) + '…'; }

function desiredFor(p) {
  /* p: { apa, first, last, email, teams:[{team_number, team_name, role}] } */
  const teams = p.teams.slice().sort((a, b) => (ROLE_RANK[a.role] ?? 9) - (ROLE_RANK[b.role] ?? 9) || a.team_number.localeCompare(b.team_number));
  const name = (p.first + ' ' + p.last).replace(/\s+/g, ' ').trim();
  return {
    name,
    email: p.email,
    description: 'APA ' + p.apa,
    metadata: {
      apa_number:    p.apa,
      member_number: p.apa.slice(-5),
      source:        'slate',
      session:       clip(p.session),
      teams:         clip(teams.map(t => t.team_number + ' ' + t.role).join('; ')),
      captain_of:    clip(teams.filter(t => t.role === 'Captain' || t.role === 'Co-Captain').map(t => t.team_number).join('; ')),
      team_names:    clip(teams.map(t => t.team_number + ' ' + (t.team_name || '').trim()).join('; ')),
    },
  };
}

/* OVERWRITE semantics (user directive 2026-09-11): when a customer exists,
   slate's data on hand replaces name, email, description and EVERY metadata
   key; metadata keys Stripe holds that slate does not know are cleared (an
   empty value unsets a key). Returns the list of fields that differ and the
   FULL form to send — the write is the whole desired state, never a partial
   patch. A customer already identical to slate is not re-sent: that POST
   would change nothing, and 900+ no-op writes per sync is what the read-first
   sweep exists to avoid. */
function overwritePlan(cust, want) {
  const changes = [];
  if ((cust.name || '') !== want.name) changes.push('name');
  if ((cust.email || '') !== want.email) changes.push('email');
  if ((cust.description || '') !== want.description) changes.push('description');
  const m = cust.metadata || {};
  const form = toForm(want);
  for (const k of Object.keys(want.metadata)) if ((m[k] || '') !== want.metadata[k]) changes.push('metadata[' + k + ']');
  for (const k of Object.keys(m)) if (!(k in want.metadata)) { changes.push('-metadata[' + k + ']'); form['metadata[' + k + ']'] = ''; }
  return { changes, form };
}

function toForm(want) {
  const f = { name: want.name, email: want.email, description: want.description };
  for (const k of Object.keys(want.metadata)) f['metadata[' + k + ']'] = want.metadata[k];
  return f;
}

async function loadRoster(env, sessionId) {
  const sess = await sb(env, 'GET', 'sessions?select=id,name&id=eq.' + sessionId);
  if (!sess.length) throw new Error('no such session');
  const divs = await sbAll(env, 'divisions?select=id,division_number&session_id=eq.' + sessionId + '&operator_id=eq.' + SPM_OPERATOR_ID);
  if (!divs.length) return { session: sess[0], players: [] };
  const divIds = divs.map(d => d.id).join(',');
  const teams = await sbAll(env, 'teams?select=id,team_number,team_name,division_id&division_id=in.(' + divIds + ')');
  const teamById = new Map(teams.map(t => [t.id, t]));
  const teamIds = teams.map(t => t.id).join(',');
  const mems = teamIds ? await sbAll(env, 'team_memberships?select=team_id,member_number,role&team_id=in.(' + teamIds + ')') : [];
  const byApa = new Map();
  for (const m of mems) {
    const apa = String(m.member_number || '');
    if (!/^\d{8}$/.test(apa)) continue;             // identity trap: only 8-digit keys
    const t = teamById.get(m.team_id); if (!t) continue;
    if (!byApa.has(apa)) byApa.set(apa, { apa, teams: [] });
    byApa.get(apa).teams.push({ team_number: String(parseInt(t.team_number, 10)).padStart(5, '0'), team_name: t.team_name, role: m.role || 'Member' });
  }
  /* players in chunks (URL length) */
  const apas = [...byApa.keys()];
  for (let i = 0; i < apas.length; i += 200) {
    const rows = await sb(env, 'GET', 'players?select=member_number,first_name,last_name,email&member_number=in.(' + apas.slice(i, i + 200).join(',') + ')');
    for (const p of rows) {
      const e = byApa.get(String(p.member_number)); if (!e) continue;
      e.first = p.first_name || ''; e.last = p.last_name || ''; e.email = String(p.email || '').trim();
    }
  }
  const players = apas.map(a => ({ ...byApa.get(a), session: sess[0].name, first: byApa.get(a).first || '', last: byApa.get(a).last || '', email: byApa.get(a).email || '' }));
  players.sort((a, b) => (a.last + a.first).localeCompare(b.last + b.first));
  return { session: sess[0], players };
}

// ── /sync ─────────────────────────────────────────────────────────────
async function handleSync(request, env) {
  _subrequests = 0;
  const auth = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/, '');
  if (!auth || auth !== env.SUPABASE_SERVICE_KEY) return jsonResponse({ ok: false, error: 'unauthorized' }, 401);

  let body; try { body = await request.json(); } catch { return jsonResponse({ ok: false, error: 'invalid json' }, 400); }
  const sessionId = parseInt(body.session_id, 10);
  if (!sessionId) return jsonResponse({ ok: false, error: 'session_id required' }, 400);
  const dryRun = body.dry_run !== false;                        // default: PLAN ONLY
  const onlyApa = body.only_apa ? String(body.only_apa) : null;  // single-player drill

  // 1. roster
  const { session, players: allPlayers } = await loadRoster(env, sessionId);
  const players = onlyApa ? allPlayers.filter(p => p.apa === onlyApa) : allPlayers;

  // 2. our mirror
  const mirror = new Map((await sbAll(env, 'stripe_customers?select=apa_number,stripe_customer_id')).map(r => [r.apa_number, r.stripe_customer_id]));

  // 3. Stripe, one sweep, indexed
  const customers = await stripeAllCustomers(env);
  const byId = new Map(customers.map(c => [c.id, c]));
  const byApa = new Map();
  const byEmail = new Map();                                      // lowercase email → [customers without apa metadata]
  for (const c of customers) {
    const apa = c.metadata && c.metadata.apa_number;
    if (apa) { if (!byApa.has(apa)) byApa.set(apa, c); continue; }
    const e = String(c.email || '').trim().toLowerCase();
    if (e) { if (!byEmail.has(e)) byEmail.set(e, []); byEmail.get(e).push(c); }
  }

  // 4. plan
  const rows = [];
  for (const p of players) {
    const want = desiredFor(p);
    const row = { apa: p.apa, name: want.name, email: p.email, teams: p.teams.length, captain: want.metadata.captain_of !== '', action: '', customer_id: null, changes: [] };
    if (!p.email) { row.action = 'skip'; row.reason = 'no email'; rows.push(row); continue; }
    let cust = byApa.get(p.apa) || (mirror.has(p.apa) ? byId.get(mirror.get(p.apa)) : null);
    let adopt = false;
    if (!cust) {
      const cands = byEmail.get(p.email.toLowerCase()) || [];
      if (cands.length === 1) { cust = cands[0]; adopt = true; }
      else if (cands.length > 1) { row.action = 'skip'; row.reason = cands.length + ' Stripe customers already share this email — resolve in Stripe'; rows.push(row); continue; }
    }
    if (!cust) { row.action = 'create'; }
    else {
      row.customer_id = cust.id;
      const ow = overwritePlan(cust, want);
      row.changes = ow.changes;
      row.action = adopt ? 'adopt' : (row.changes.length ? 'update' : 'unchanged');
      row._form = ow.form;
    }
    row._want = want;
    rows.push(row);
  }
  const plan = { create: 0, update: 0, adopt: 0, unchanged: 0, skip: 0 };
  for (const r of rows) plan[r.action]++;

  // 5. write (unless dry run)
  const writes = { created: 0, updated: 0, adopted: 0, unchanged: plan.unchanged, skipped: plan.skip, errors: 0 };
  const mirrorUpserts = [];
  let remaining = 0, stopped = false;
  if (!dryRun) {
    const mirrorFlushCost = 1 + Math.floor(rows.length / 500);
    for (const r of rows) {
      const isWrite = r.action === 'create' || r.action === 'update' || r.action === 'adopt';
      if (isWrite && (stopped || _subrequests + 1 + mirrorFlushCost > SUBREQUEST_BUDGET)) {
        stopped = true; remaining++; r.result = 'deferred'; continue;   // next invocation picks it up
      }
      if (r.action === 'create') {
        const res = await stripe(env, 'POST', '/v1/customers', { body: toForm(r._want), idem: 'slate-cust-' + r.apa + '-v1' }).catch(e => ({ status: 0, json: { error: { message: String(e.message || e) } } }));
        if (res.status === 200) { r.customer_id = res.json.id; r.result = 'created'; writes.created++; mirrorUpserts.push({ apa_number: r.apa, stripe_customer_id: res.json.id, email: r.email, name: r.name, livemode: !!res.json.livemode, last_session_id: sessionId, last_sync_status: 'created', last_synced_at: new Date().toISOString() }); }
        else { r.result = 'error'; r.error = (res.json.error && res.json.error.message) || ('HTTP ' + res.status); writes.errors++; }
      } else if (r.action === 'update' || r.action === 'adopt') {
        const res = await stripe(env, 'POST', '/v1/customers/' + r.customer_id, { body: r._form }).catch(e => ({ status: 0, json: { error: { message: String(e.message || e) } } }));   // full overwrite
        if (res.status === 200) { r.result = r.action === 'adopt' ? 'adopted' : 'updated'; writes[r.result]++; mirrorUpserts.push({ apa_number: r.apa, stripe_customer_id: r.customer_id, email: r.email, name: r.name, livemode: !!res.json.livemode, last_session_id: sessionId, last_sync_status: r.result, last_synced_at: new Date().toISOString() }); }
        else { r.result = 'error'; r.error = (res.json.error && res.json.error.message) || ('HTTP ' + res.status); writes.errors++; }
      } else if (r.action === 'unchanged' && !mirror.has(r.apa) && r.customer_id) {
        /* already right in Stripe but missing from our mirror — record it, no Stripe write */
        mirrorUpserts.push({ apa_number: r.apa, stripe_customer_id: r.customer_id, email: r.email, name: r.name, livemode: true, last_session_id: sessionId, last_sync_status: 'unchanged', last_synced_at: new Date().toISOString() });
      }
    }
    // 6. mirror — UPSERT by apa_number (on_conflict + merge-duplicates, or PostgREST plain-INSERTs → 23505)
    for (let i = 0; i < mirrorUpserts.length; i += 500) {
      await sb(env, 'POST', 'stripe_customers?on_conflict=apa_number', mirrorUpserts.slice(i, i + 500), { Prefer: 'resolution=merge-duplicates,return=minimal' });
    }
  }

  for (const r of rows) { delete r._want; delete r._form; }
  return jsonResponse({ ok: true, dry_run: dryRun, session, roster: allPlayers.length, stripe_scanned: customers.length, plan, writes, remaining, subrequests: _subrequests, budget: SUBREQUEST_BUDGET, rows });
}

// ══════════════════════════════════════════════════════════════════════
// Router
// ══════════════════════════════════════════════════════════════════════
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    const path = new URL(request.url).pathname.replace(/\/$/, '');
    try {
      if (request.method === 'GET' && path === '/health') {
        return jsonResponse({ ok: true, version: env.STRIPE_VERSION, livemode: String(env.STRIPE_RAK || '').startsWith('rk_live_'), key: env.STRIPE_RAK ? 'restricted' : 'missing' });
      }
      if (request.method === 'POST' && path === '/sync') return await handleSync(request, env);
      return jsonResponse({ ok: false, error: 'not found' }, 404);
    } catch (e) {
      return jsonResponse({ ok: false, error: String(e.message || e) }, 500);
    }
  },
};
