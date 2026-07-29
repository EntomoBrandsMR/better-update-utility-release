// engine/tokens.js — THE token module. SINGLE SOURCE for {{...}} resolution, shared by
// every execution context. Consumed three ways:
//   1. require()d by the main process (when needed),
//   2. interpolated VERBATIM into spawned children via ${TOKENS_SRC} (pool worker,
//      logout sweeper) — must be inlined BEFORE engine/steps.js, which calls these,
//   3. (R2b, planned) loaded by the renderer via <script src="engine/tokens.js"> so the
//      staging checker uses the SAME code, not a copy.
// No host globals required. Do NOT add a second copy of any of this anywhere.
//
// R6 system date tokens. {{TODAY}} is LIVE per resolution (crosses midnight mid-run);
// {{RUNDATE}} is frozen at pool start (runContext.runStartTs). Both accept ±N days:
// {{TODAY-1}}, {{RUNDATE+30}}. MM/DD/YYYY zero-padded, straight day arithmetic (the
// local-date constructor normalizes month/DST rollover). System tokens WIN over
// same-named columns; the save-time warning covers the collision. Returns null when
// ref is not a system date token so column resolution proceeds.
function buuSystemToken(ref, runContext){
  const m = /^(TODAY|RUNDATE)([+-]\d+)?$/.exec(String(ref||'').trim());
  if(!m) return null;
  let base;
  if(m[1] === 'TODAY') base = new Date();
  else {
    const ts = runContext && runContext.runStartTs;
    base = ts ? new Date(ts) : new Date();
  }
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + (m[2] ? parseInt(m[2], 10) : 0));
  return String(d.getMonth()+1).padStart(2,'0') + '/' + String(d.getDate()).padStart(2,'0') + '/' + d.getFullYear();
}

// THE resolver (was r() inside runStep; v3.0.2 trim rule preserved). Resolution order:
// {{CRED:*}} from the profile → system dates (buuSystemToken) → RUNID →
// PROFILE_USERNAME → row column (EXACT, case-sensitive) → '' — unknown tokens resolve
// EMPTY; that is the runner's contract, and the staging checker exists to catch them
// before a run does.
function resolveToken(v, ctx){
  if(!v) return '';
  const creds = (ctx && ctx.creds) || {};
  const row = (ctx && ctx.row) || {};
  const runContext = (ctx && ctx.runContext) || null;
  return String(v)
    .replace(/{{CRED:companyKey}}/g, creds.companyKey||'')
    .replace(/{{CRED:username}}/g, creds.username||'')
    .replace(/{{CRED:password}}/g, creds.password||'')
    .replace(/{{([^}]+)}}/g, function(_, ref){
      ref = String(ref).trim(); // v3.0.2: {{ Foo }} and {{Foo}} are the same token
      const _sys = buuSystemToken(ref, runContext); if(_sys !== null) return _sys;
      if(ref === 'RUNID') return (runContext && runContext.runId) || '';
      if(ref === 'PROFILE_USERNAME') return (runContext && runContext.profileUsername) || '';
      return row[ref] !== undefined ? String(row[ref]) : '';
    });
}

// Stamp-column resolver for the scrape steps (was TWO verbatim copies inside steps.js).
// A field containing {{...}} resolves through the row resolver r; a bare name is a
// direct row-column lookup (v2.2.7: '{{Old Acct #}}' was once read literally as a key).
function stampVal(f, r, row){
  if(!f) return '';
  const t = String(f).trim();
  if(t.indexOf('{{') >= 0) return r(t);
  return (row && row[t] !== undefined ? String(row[t]) : '');
}

// ── R2b: THE scanner ─────────────────────────────────────────────────────────
// ONE builtin rule: is ref a token the runner resolves WITHOUT a spreadsheet?
// (CRED:* is handled separately — it's a prefix, not an exact name.)
function isBuiltinToken(ref){
  const t = String(ref||'').trim();
  if (t === 'RUNID' || t === 'PROFILE_USERNAME') return true;
  return /^(TODAY|RUNDATE)([+-]\d+)?$/.test(t); // system dates incl. ±N — buuSystemToken's exact rule
}

// ONE field list: every step field whose value the runner passes through the resolver.
// Union of the four old renderer lists, fixed: pathCol → pathColumn (the ghost field
// that let fileupload tokens bypass the once-flow guard), afterSelector added, the
// scrape stamp columns added (stampVal resolves {{...}} in them), textedit/assert
// ghost fields (searchVal/replaceVal/expected) dropped pending the R5 taxonomy round.
const TOKEN_FIELDS = ['url','value','selector','matchText','containerSel','waitFor','afterSelector','waitSel','condCol','pathColumn','fileNameColumn','baseFolder','propCol','locCol','invCol','acctCol'];

// Column-token refs in ONE step: trimmed, deduped, CRED:*/builtins excluded.
function scanStepTokens(step){
  const out = [];
  if (!step) return out;
  for (const f of TOKEN_FIELDS) {
    const v = step[f];
    if (typeof v !== 'string' || !v) continue;
    let m; const re = /{{\s*([^}]+?)\s*}}/g;
    while ((m = re.exec(v))) {
      const t = String(m[1]).trim();
      if (t.indexOf('CRED:') === 0) continue;
      if (isBuiltinToken(t)) continue;
      if (out.indexOf(t) === -1) out.push(t);
    }
  }
  return out;
}

// Column-token refs across a whole flow (locked steps included — their CRED tokens
// are excluded by RULE, not by skipping the step).
function scanFlowTokens(steps){
  const seen = [];
  (steps || []).forEach(function(s){
    scanStepTokens(s).forEach(function(t){ if (seen.indexOf(t) === -1) seen.push(t); });
  });
  return seen;
}

// Runner-exact header match: trimmed + case-sensitive, because the runner's row lookup
// is row[ref] with the exact key — a wrong-case token types an EMPTY value at run time.
// Returns { referenced, missing, allMissing } (the shape staging has always used).
function matchTokensToHeaders(refs, headers){
  const have = new Set((headers || []).map(function(h){ return String(h).trim(); }));
  const referenced = (refs || []).slice();
  const missing = referenced.filter(function(t){ return !have.has(t); });
  return { referenced: referenced, missing: missing, allMissing: referenced.length > 0 && missing.length === referenced.length };
}

const __BUU_TOKENS_API = { buuSystemToken, resolveToken, stampVal, isBuiltinToken, TOKEN_FIELDS, scanStepTokens, scanFlowTokens, matchTokensToHeaders };
if (typeof module !== 'undefined' && module.exports) { module.exports = __BUU_TOKENS_API; }
if (typeof window !== 'undefined') { window.BUUTokens = __BUU_TOKENS_API; }
