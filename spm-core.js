// ============================================================================
// SPM APA — Shared Core JS (spm-core.js)
// ============================================================================
// Shared utilities for all standalone GitHub Pages apps in the APA project.
// Import via: <script src="https://southportlandmetroapa.github.io/shared/spm-core.js"></script>
//
// CONFIGURATION:
//   Set window.SPM_CONFIG BEFORE loading this script:
//   <script>
//     window.SPM_CONFIG = {
//       apiUrl: 'https://myapp.spmapa.workers.dev',  // required
//       contentType: 'text/plain',                    // optional, default 'text/plain'
//       adminToken: null,                             // optional, auto-injected into requests
//       statusElement: 'statusText'                   // optional, default 'statusText'
//     };
//   </script>
//
// PROVIDES:
//   SPM.esc(s)                 — HTML escape
//   SPM.callServer(action, p)  — fetch wrapper (POST to apiUrl, auto-inject adminToken)
//   SPM.setStatus(text)        — update status text element
//   Device detection            — adds 'mobile'/'tablet'/'desktop' class to <body>
//
// PLACEMENT:
//   Must be loaded inside <body> (not <head>) — device detection IIFE needs
//   document.body to exist.
// ============================================================================

window.SPM = window.SPM || {};

// -- esc: XSS-safe HTML escape --------------------------------------------
SPM.esc = function(s) {
  var d = document.createElement('div');
  d.textContent = String(s || '');
  return d.innerHTML;
};

// -- callServer: generic fetch wrapper ------------------------------------
// Reads SPM_CONFIG.apiUrl (required), SPM_CONFIG.adminToken (optional).
// Returns a Promise that resolves to the parsed JSON response.
SPM.callServer = function(action, params) {
  var cfg = window.SPM_CONFIG || {};
  if (!cfg.apiUrl) throw new Error('SPM_CONFIG.apiUrl is required');

  var body = Object.assign({ action: action }, params || {});
  if (cfg.adminToken) body.adminToken = cfg.adminToken;

  return fetch(cfg.apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': cfg.contentType || 'text/plain' },
    body: JSON.stringify(body),
    redirect: 'follow'
  }).then(function(r) {
    if (!r.ok) throw new Error('Network error: ' + r.status);
    return r.json();
  });
};

// -- setStatus: update status text element --------------------------------
SPM.setStatus = function(text) {
  var id = (window.SPM_CONFIG || {}).statusElement || 'statusText';
  var el = document.getElementById(id);
  if (el) el.textContent = text || '';
};

// -- Device detection IIFE ------------------------------------------------
// Sets 'mobile', 'tablet', or 'desktop' class on <body>.
// Breakpoints: mobile <768, tablet 768-1199, desktop >=1200.
// Touch override: large screen + touch + no fine pointer → tablet.
(function() {
  var sw = screen.width;
  var hasTouch = navigator.maxTouchPoints > 0;
  var cls;
  if (sw < 768) {
    cls = 'mobile';
  } else if (sw < 1200) {
    cls = 'tablet';
  } else {
    if (hasTouch && !window.matchMedia('(pointer: fine)').matches) {
      cls = 'tablet';
    } else {
      cls = 'desktop';
    }
  }
  document.body.classList.add(cls);
})();
