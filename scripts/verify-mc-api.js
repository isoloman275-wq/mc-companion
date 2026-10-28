#!/usr/bin/env node
/**
 * verify-mc-api.js — MC Companion API contract + TLS trust verifier
 * ===================================================================
 *
 * This is the SECOND artifact for the mc-companion project. It COMPOUNDS the
 * README (t_4c7ec082) which documents the Mission Control REST API contract
 * and the self-signed-CA trust chain. The README's troubleshooting section
 * tells an operator to "confirm the chain end-to-end from the phone's browser"
 * — this script turns that manual step into a machine-checkable QA harness:
 *
 *   1. TLS TRUST  — proves the bundled assets/mc_ca.crt actually validates the
 *      MC server's certificate (the exact chain the app depends on; mirrors the
 *      README "trust anchor not found" failure case).
 *   2. GET CONTRACT — hits every documented read endpoint and validates the
 *      response shape (HTTP 200 + expected top-level keys/types) against the
 *      real server.py route handlers.
 *   3. POST CONTRACT (opt-in, --write) — exercises /api/task/create then
 *      self-cleans with /api/task/delete so it never leaves junk on the board.
 *
 * Default mode is READ-ONLY (no mutations). Exit code 0 = all checks passed,
 * 1 = one or more failed (CI-ready).
 *
 * Usage:
 *   node scripts/verify-mc-api.js [--base https://<lan-host-ip>:8777]
 *                                 [--ca assets/mc_ca.crt]
 *                                 [--write] [--insecure] [--self-test]
 *
 *   --base      Target MC base URL. Default matches App.js DEFAULT_BASE
 *               (https://<lan-host-ip>:8777) so the check reflects exactly what
 *               a real phone would hit.
 *   --ca        Path to the bundled CA cert used to validate the TLS chain.
 *               Default: assets/mc_ca.crt (relative to repo root).
 *   --insecure  Skip TLS verification (use only for http:// or mock servers).
 *   --write     Also run the POST contract smoke test (create + self-delete).
 *   --self-test Run an in-process mock MC server and verify against it. Proves
 *               the harness works with zero external dependencies.
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

// ---- documented GET contract (verified against mission-control/server.py) ----
const GET_CHECKS = [
  {
    path: '/api/state',
    expect: {
      machines: 'array', daemons: 'array', tasks: 'array',
      drones: 'array', economy: 'any',
    },
  },
  { path: '/api/profiles', expect: { profiles: 'array' } },
  { path: '/api/approvals', expect: { approvals: 'array', gates: 'object' } },
  { path: '/api/logs/operator', expect: { lines: 'array' } },
];

function parseArgs(argv) {
  const args = {
    base: 'https://<lan-host-ip>:8777',
    ca: path.join(REPO_ROOT, 'assets', 'mc_ca.crt'),
    write: false,
    insecure: false,
    selfTest: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') args.base = argv[++i];
    else if (a === '--ca') args.ca = path.resolve(argv[++i]);
    else if (a === '--write') args.write = true;
    else if (a === '--insecure') args.insecure = true;
    else if (a === '--self-test') args.selfTest = true;
    else {
      console.error(`unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

/**
 * Perform one HTTP(S) request.
 * Returns { ok, status, json, ms, error }.
 * For https, uses the bundled CA (unless --insecure) so the TLS trust chain is
 * genuinely exercised — a mismatched/self-signed cert that the app can't trust
 * will surface here as a TLS error, exactly like on a real phone.
 */
function request(base, p, method = 'GET', body = null, caPath = null, insecure = false) {
  return new Promise((resolve) => {
    const url = new URL(p, base);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      timeout: 8000,
      headers: {},
    };
    if (body) {
      const s = JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(s);
      opts.body = s;
    }
    if (isHttps && !insecure) {
      if (!caPath || !fs.existsSync(caPath)) {
        resolve({ ok: false, status: 0, json: null, ms: 0, error: `CA cert not found: ${caPath}` });
        return;
      }
      opts.ca = fs.readFileSync(caPath);
      opts.rejectUnauthorized = true;
    }
    const t0 = Date.now();
    const req = lib.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) { /* non-json ok */ }
        resolve({ ok: true, status: res.statusCode, json, ms: Date.now() - t0, error: null });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (err) => {
      resolve({ ok: false, status: 0, json: null, ms: Date.now() - t0, error: err.message });
    });
    if (body) req.write(opts.body);
    req.end();
  });
}

function isType(v, t) {
  if (t === 'any') return v !== undefined && v !== null;
  if (t === 'array') return Array.isArray(v);
  if (t === 'object') return v !== null && typeof v === 'object' && !Array.isArray(v);
  return typeof v === t;
}

function checkShape(json, expect) {
  if (json === null) return { pass: false, detail: 'body was not JSON' };
  const missing = [];
  for (const [k, t] of Object.entries(expect)) {
    if (!isType(json[k], t)) missing.push(`${k}:${t}`);
  }
  if (missing.length) return { pass: false, detail: `shape mismatch -> ${missing.join(', ')}` };
  return { pass: true, detail: 'shape ok' };
}

async function runGetChecks(args) {
  const results = [];
  for (const c of GET_CHECKS) {
    const r = await request(args.base, c.path, 'GET', null, args.ca, args.insecure);
    let shape = { pass: false, detail: 'no response' };
    if (r.ok && r.status === 200) shape = checkShape(r.json, c.expect);
    results.push({
      endpoint: `GET ${c.path}`,
      status: r.ok ? r.status : 'ERR',
      ms: r.ms,
      pass: r.ok && r.status === 200 && shape.pass,
      detail: r.error ? `transport: ${r.error}` : (r.status !== 200 ? `HTTP ${r.status}` : shape.detail),
    });
  }
  return results;
}

async function runPostChecks(args) {
  const results = [];
  // create a clearly-marked test task
  const title = `MC-API-VERIFY-${Date.now()}`;
  const cr = await request(args.base, '/api/task/create', 'POST', { title, assignee: 'default' }, args.ca, args.insecure);
  let createdId = null;
  if (cr.ok && cr.status === 200 && cr.json && cr.json.ok) {
    // best-effort: pull id from detail if present, else list + match by title
    createdId = title; // used only as a marker; cleanup below deletes by title scan
  }
  results.push({
    endpoint: `POST /api/task/create`,
    status: cr.ok ? cr.status : 'ERR',
    ms: cr.ms,
    pass: cr.ok && cr.status === 200 && cr.json && cr.json.ok === true,
    detail: cr.error ? `transport: ${cr.error}` : (cr.json ? `ok=${cr.json.ok}` : `HTTP ${cr.status}`),
  });
  // self-clean: archive + purge the test task we just made (match by title)
  const st = await request(args.base, '/api/state', 'GET', null, args.ca, args.insecure);
  let cleaned = 'skipped';
  if (st.ok && st.json && Array.isArray(st.json.tasks)) {
    const hit = st.json.tasks.find((t) => t.title === title || (t.body && String(t.body).includes(title)));
    if (hit && hit.id) {
      const del = await request(args.base, '/api/task/delete', 'POST', { ids: [hit.id] }, args.ca, args.insecure);
      cleaned = del.ok && del.json && del.json.ok ? `deleted ${hit.id}` : `delete failed (${del.status})`;
    }
  }
  results.push({
    endpoint: `POST /api/task/delete (self-clean)`,
    status: '-', ms: 0, pass: cleaned.startsWith('deleted'),
    detail: cleaned,
  });
  return results;
}

function printReport(header, rows) {
  console.log(`\n${header}`);
  console.log('-'.repeat(72));
  for (const r of rows) {
    const mark = r.pass ? 'PASS' : 'FAIL';
    const line = `${mark.padEnd(5)} ${String(r.status).padEnd(5)} ${String(r.ms).padStart(5)}ms  ${r.endpoint}`;
    console.log(line);
    if (!r.pass && r.detail) console.log(`        └─ ${r.detail}`);
  }
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.selfTest) {
    return runSelfTest();
  }

  console.log(`MC Companion API verifier`);
  console.log(`target : ${args.base}`);
  console.log(`ca     : ${args.insecure ? '(insecure — TLS NOT verified)' : args.ca}`);

  const getRows = await runGetChecks(args);
  printReport('GET contract (read-only)', getRows);

  let postRows = [];
  if (args.write) {
    postRows = await runPostChecks(args);
    printReport('POST contract (--write, self-cleaning)', postRows);
  }

  const all = [...getRows, ...postRows];
  const failed = all.filter((r) => !r.pass);
  console.log('\n' + '='.repeat(72));
  if (failed.length === 0) {
    console.log(`RESULT: PASS — ${all.length} check(s) green. MC endpoint + TLS trust verified.`);
    process.exit(0);
  } else {
    console.log(`RESULT: FAIL — ${failed.length}/${all.length} check(s) failed.`);
    process.exit(1);
  }
}

// ---- in-process mock MC server so the harness is self-verifying ----
function runSelfTest() {
  const tasks = []; // emulate server-side task store
  let nextId = 1;
  const mock = http.createServer((req, res) => {
    const p = req.url;
    const ok = (obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (p === '/api/state') ok({ booting: false, built_at: 1, machines: [], daemons: [], tasks, drones: [], economy: {} });
    else if (p === '/api/profiles') ok({ profiles: ['default'] });
    else if (p === '/api/approvals') ok({ approvals: [], gates: {} });
    else if (p === '/api/logs/operator') ok({ profile: 'operator', lines: [] });
    else if (p === '/api/task/create') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const d = JSON.parse(body || '{}');
        const id = `t_mock${nextId++}`;
        tasks.push({ id, title: d.title, assignee: d.assignee || null, body: d.body || null });
        ok({ ok: true, detail: id });
      });
    }
    else if (p === '/api/task/delete') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const d = JSON.parse(body || '{}');
        const ids = Array.isArray(d.ids) ? d.ids : [];
        for (let i = tasks.length - 1; i >= 0; i--) if (ids.includes(tasks[i].id)) tasks.splice(i, 1);
        ok({ ok: true, archived: '', purged: '' });
      });
    }
    else { res.writeHead(404); res.end('{}'); }
  });
  mock.listen(0, '127.0.0.1', async () => {
    const port = mock.address().port;
    const base = `http://127.0.0.1:${port}`;
    console.log(`SELF-TEST: mock MC server on ${base}`);
    const getRows = await runGetChecks({ base, ca: null, insecure: true });
    printReport('GET contract (self-test mock)', getRows);
    const postRows = await runPostChecks({ base, ca: null, insecure: true });
    printReport('POST contract (self-test mock)', postRows);
    mock.close();
    const all = [...getRows, ...postRows];
    const failed = all.filter((r) => !r.pass);
    console.log('\n' + '='.repeat(72));
    if (failed.length === 0) {
      console.log(`SELF-TEST RESULT: PASS — harness logic verified (${all.length} checks green).`);
      process.exit(0);
    } else {
      console.log(`SELF-TEST RESULT: FAIL — harness defect (${failed.length} failed).`);
      process.exit(1);
    }
  });
}

main();
