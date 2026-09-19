/* ============================================================================
   SPM APA — Shared sign-in (spm-auth.js) · v1.0 · 2026-09-18
   ============================================================================
   ONE session for every player app. All apps live on southportlandmetroapa.github.io, so localStorage is shared:
   this file keeps the session token under ONE key ('spm.session.v1') and talks to the apa-mailer GAS auth_* actions.
   Sign in on any app → signed in on all of them. Log out anywhere → logged out everywhere (storage event).
   Server side: spm_auth.sessions (brief tools/claude/briefs/2026-09-18-spm-auth-sso.md).

   Load: <script src="https://southportlandmetroapa.github.io/shared/spm-auth.js"></script>
   API:
     spmAuth.boot({ app })            → Promise<{ signedIn, token, member_number, first_name, name, error }>
                                         reads ?token= (and strips it), else the shared key, else adopts a legacy per-app key
     spmAuth.requestLink(identifier, app, hp) → Promise<{ ok, first_name | error }>   (magic link to the address on file)
     spmAuth.whoami(token)            → Promise<{ ok, me:{ member_number, first_name, name, email, phone } }>  (own record only)
     spmAuth.logout(token)            → revokes server-side + clears the shared key everywhere
     spmAuth.get() / set(t) / clear() → the shared key (adopting + purging legacy keys)
     spmAuth.onChange(fn)             → fn(tokenOrNull) when another tab/app signs in or out
     spmAuth.isAuthErr(msg)           → true only for the auth sentences (never a substring of "session")
   Apps may keep their own *_verify / *_link_request actions (they read and write the same table); only the STORAGE
   must go through here — that is what makes it single sign-on.
   ============================================================================ */
(function () {
  var KEY = 'spm.session.v1';
  var LEGACY = ['crewcall_session', 'nickpick_session', 'countmein_session', 'teamchanges_session', 'skillcheck.session.v1', 'fairplay.session.v1'];
  var GAS_URL = 'https://script.google.com/macros/s/AKfycbzGTzkBRTrIIP_tD6sbtOOUmNZkXDdtxPoO4c8fdWt5h3tZFueNSISPv8Q3LWStx73Whw/exec';
  var isUuid = function (t) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(t || '')); };
  /* text/plain body, never application/json (a JSON content-type triggers a CORS preflight GAS cannot answer) */
  var gas = function (action, extra) {
    var body = Object.assign({ action: action }, extra || {});
    return fetch(GAS_URL, { method: 'POST', body: JSON.stringify(body) }).then(function (r) { return r.json(); })
      .catch(function () { return { ok: false, error: 'Network hiccup. Check your connection and try again.' }; });
  };
  function get() {
    try {
      var t = localStorage.getItem(KEY);
      if (!isUuid(t)) { for (var i = 0; i < LEGACY.length; i++) { var v = localStorage.getItem(LEGACY[i]); if (isUuid(v)) { t = v; localStorage.setItem(KEY, t); break; } } }
      return isUuid(t) ? t : null;
    } catch (e) { return null; }
  }
  function set(t) { try { localStorage.setItem(KEY, t); LEGACY.forEach(function (k) { localStorage.removeItem(k); }); } catch (e) {} }
  function clear() { try { localStorage.removeItem(KEY); LEGACY.forEach(function (k) { localStorage.removeItem(k); }); } catch (e) {} }
  var isAuthErr = function (e) { return /session is no longer valid|sign in again|signed out|link is not valid|link expired/i.test(e || ''); };
  function boot(opts) {
    opts = opts || {};
    var urlToken = null;
    try { urlToken = new URLSearchParams(location.search).get('token'); if (urlToken) history.replaceState(null, '', location.pathname + (location.hash || '')); } catch (e) {}
    var tok = isUuid(urlToken) ? urlToken : get();
    if (!tok) return Promise.resolve({ signedIn: false, error: urlToken ? 'That link did not work. Request a fresh one.' : null });
    return gas('auth_verify', { token: tok }).then(function (r) {
      if (!r.ok) { if (isAuthErr(r.error) || !urlToken) { if (get() === tok) clear(); } return { signedIn: false, error: urlToken ? (r.error || 'That link did not work. Request a fresh one.') : null }; }
      set(tok);
      return { signedIn: true, token: tok, member_number: r.member_number, first_name: r.first_name || '', name: r.name || '' };
    });
  }
  function requestLink(identifier, app, hp) { return gas('auth_link_request', { identifier: identifier, app: app, hp: hp || '' }); }
  function whoami(token) { return gas('auth_whoami', { token: token || get() }); }
  function logout(token) { var t = token || get(); clear(); return t ? gas('auth_logout', { token: t }) : Promise.resolve({ ok: true }); }
  function onChange(fn) { try { window.addEventListener('storage', function (e) { if (e.key === KEY || LEGACY.indexOf(e.key) >= 0) fn(get()); }); } catch (e) {} }
  window.spmAuth = { KEY: KEY, boot: boot, requestLink: requestLink, whoami: whoami, logout: logout, get: get, set: set, clear: clear, onChange: onChange, isAuthErr: isAuthErr, gas: gas, VERSION: '1.0' };
})();
