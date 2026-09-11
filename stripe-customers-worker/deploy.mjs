#!/usr/bin/env node
/* deploy.mjs — deploy the stripe-customers Worker and set its two secrets
 * without the key ever appearing in a shell history or a file:
 *   STRIPE_RAK            ← env STRIPE_RAK, else the Windows User registry scope
 *   SUPABASE_SERVICE_KEY  ← decoded-role match (role === service_role) from the
 *                           memory keys file — never picked by label
 * Requires `npx wrangler login` done once in this account (OAuth; a browser step
 * only a human can do). Run from anywhere:
 *   node Apps/shared/stripe-customers-worker/deploy.mjs
 */
import { execSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const sh = (cmd, input) => spawnSync(cmd, { cwd: DIR, shell: true, input, encoding: 'utf8' });

function rak() {
  if (process.env.STRIPE_RAK) return process.env.STRIPE_RAK.trim();
  try { return execSync(`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('STRIPE_RAK','User')"`, { encoding: 'utf8' }).trim(); } catch { return ''; }
}
function serviceKey() {
  const f = readFileSync(process.env.USERPROFILE + '/.claude/projects/C--Users-ptsol-OneDrive-APA/memory/reference_supabase_keys.md', 'utf8');
  for (const k of f.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) || []) {
    try { if (JSON.parse(Buffer.from(k.split('.')[1], 'base64').toString()).role === 'service_role') return k; } catch {}
  }
  return '';
}

const who = sh('npx wrangler whoami');
if (/Not logged in|Failed to fetch auth token/.test(who.stdout + who.stderr)) {
  console.error('wrangler is not logged in — run `npx wrangler login` (opens a browser), then re-run this script.');
  process.exit(2);
}
const RAK = rak(), SVC = serviceKey();
if (!/^rk_(live|test)_/.test(RAK)) { console.error('STRIPE_RAK missing or not a restricted key'); process.exit(2); }
if (!SVC) { console.error('service_role key not found'); process.exit(2); }

const dep = sh('npx wrangler deploy');
process.stdout.write(dep.stdout); process.stderr.write(dep.stderr);
if (dep.status !== 0) process.exit(dep.status);

for (const [name, value] of [['STRIPE_RAK', RAK], ['SUPABASE_SERVICE_KEY', SVC]]) {
  const r = sh('npx wrangler secret put ' + name, value + '\n');
  if (r.status !== 0) { console.error('secret ' + name + ' failed:\n' + r.stderr); process.exit(r.status); }
  console.log('secret ' + name + ' set');
}
const h = await (await fetch('https://stripe-customers.spmapa.workers.dev/health')).json().catch(e => ({ error: e.message }));
console.log('health:', JSON.stringify(h));
process.exit(h.ok && h.key === 'restricted' ? 0 : 1);
