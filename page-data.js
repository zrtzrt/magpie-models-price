// page-data.js - Builds the model list the page draws, on this machine.
//
// The page is sandboxed with connect-src 'none': it cannot read files or call
// any API. The model list therefore has to be generated here, where Node can
// read magpie's own providers-state.json and the models.dev catalog. It is
// written as page/models-data.js next to the page and loaded by index.html:
// a local, runtime artifact, never part of the npm package (package.json's
// files list leaves it out and check.js rejects it in a tarball).
//
// This generator is read-only. The old page/generate-data.js also called
// matcher.applyGlobalMode and rewrote settings.json on every run; that is
// exactly what PR #1576 asked to stop, so it must not come back here.
const fs = require('fs');
const path = require('path');
const matcher = require('./matcher');

const OUTPUT = 'models-data.js';
// The usage snapshot is its own file: it changes every time a call is logged,
// the model list only when providers or the catalog do. Keeping them apart lets
// the host refresh the numbers without paying for a catalog scan.
const USAGE_OUTPUT = 'usage-data.js';

// sourceMtime is what the model list depends on: magpie's providers and the
// catalog. usage.jsonl is deliberately absent — magpie appends to it on every
// gateway request, so counting it here rebuilt the whole list (a catalog scan
// plus a full log parse) after every request, on the host's one thread. The
// page reads its usage from usage-data.js, which has its own reader below.
function sourceMtime(packageDir) {
  const paths = [
    matcher.paths && matcher.paths.providersState,
    matcher.paths && matcher.paths.providersConfig,
    matcher.paths && matcher.paths.settings,
    matcher.paths && matcher.paths.models,
    path.join(packageDir, 'page-data.js'),
    path.join(packageDir, 'matcher.js'),
    path.join(packageDir, 'package.json')
  ].filter(Boolean);
  let newest = 0;
  for (const file of paths) {
    try {
      const st = fs.statSync(file);
      if (st.mtimeMs > newest) newest = st.mtimeMs;
    } catch {}
  }
  return newest;
}

// writePageData builds page/models-data.js from this machine's Magpie
// providers and the public models.dev catalog. It writes only that file.
// opts.pageDir writes it into another page folder (the copy magpie loads when
// this runs from an npx cache). Returns { ok, file, models, generated, ms, error }.
function writePageData(packageDir, opts = {}) {
  const started = Date.now();
  const targetDir = opts.pageDir ? path.resolve(opts.pageDir) : path.join(packageDir, 'page');
  const target = path.join(targetDir, OUTPUT);
  try {
    if (!opts.force && fs.existsSync(target)) {
      const out = fs.statSync(target);
      const src = sourceMtime(packageDir);
      // regenerating on every host reload costs ~0.7s; a file newer than every
      // input and less than five minutes old is good enough. The page refreshes
      // its usage live through usage:day, so only the model list needs this.
      if (out.mtimeMs >= src && Date.now() - out.mtimeMs < 5 * 60 * 1000) {
        // The count comes from this process's own last build. Reading the file
        // back to count its rows meant parsing an 840 KB script on every 2 s
        // tick, on the host thread every plugin shares.
        if (modelsCache && modelsCache.file === target && modelsCache.mtimeMs === out.mtimeMs) {
          return { ok: true, file: target, models: modelsCache.models, generated: false, ms: Date.now() - started };
        }
        let models = 0;
        try {
          const text = fs.readFileSync(target, 'utf8');
          const m = text.match(/__MAGPIE_MODELS_DATA__ = (\[[\s\S]*?\]);\n/);
          if (m) models = JSON.parse(m[1]).length;
        } catch {}
        modelsCache = { file: target, mtimeMs: out.mtimeMs, models };
        return { ok: true, file: target, models, generated: false, ms: Date.now() - started };
      }
    }

    const report = matcher.scanAll();
    // No usage here: it changes on every call, and the page loads it from
    // usage-data.js (writeUsageData). A model list that carried a usage
    // snapshot was stale by the next request and dragged a full log parse
    // along with every rebuild.
    const js =
      ';(function(g){\n' +
      '  g.__MAGPIE_MODELS_DATA__ = ' + JSON.stringify(report) + ';\n' +
      '  g.__MAGPIE_PEAK_FACTOR__ = ' + JSON.stringify(matcher.PEAK_FACTOR) + ';\n' +
      '  g.__MAGPIE_MODELS_GENERATED_AT__ = ' + JSON.stringify(new Date().toISOString()) + ';\n' +
      '})(typeof window !== "undefined" ? window : globalThis);\n';

    fs.mkdirSync(targetDir, { recursive: true });
    const tmp = path.join(targetDir, '.' + OUTPUT + '.' + process.pid + '.tmp');
    fs.writeFileSync(tmp, js, 'utf8');
    fs.renameSync(tmp, target);
    try {
      modelsCache = { file: target, mtimeMs: fs.statSync(target).mtimeMs, models: report.length };
    } catch {
      modelsCache = null;
    }
    return { ok: true, file: target, models: report.length, generated: true, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, file: target, models: 0, generated: false, ms: Date.now() - started, error: err.message };
  }
}

// usageState is what the tail reader carries between ticks: the totals so far
// and the byte offset it reached. A 72 MB / 150k-line usage.jsonl (a real one
// here) took 274-816 ms to reparse; magpie appends to that file on every
// gateway request, so a host that reparsed it on each 2 s tick blocked every
// plugin's request on the shared host thread (PR #1576 third review). Reading
// only the appended bytes costs one read of the new lines, usually none.
let usageState = null;
let usageCache = null;
// modelsCache is the row count of the list this process last built or read,
// with the mtime it had then: the host asks on every tick, and re-parsing the
// generated script to count it is the same mistake as re-reading the log.
let modelsCache = null;

// writeUsageData writes page/usage-data.js: every call this machine logged,
// counted the way magpie counts them, by model name. The page used to take its
// per-model numbers from usage:day, which lists only twelve models per agent
// and so could never add up to the total it showed beside them.
function writeUsageData(packageDir, opts = {}) {
  const targetDir = opts.pageDir ? path.resolve(opts.pageDir) : path.join(packageDir, 'page');
  const target = path.join(targetDir, USAGE_OUTPUT);
  try {
    if (opts.force || !usageState || !usageCache || usageCache.file !== target) {
      usageState = { acc: matcher.newUsageAcc(), tail: { offset: 0, rest: '', ino: '' } };
      usageCache = null;
    }
    // Fold only what was appended since the last tick. The first call after a
    // host start reads the whole log once, which is the one cost that cannot
    // be avoided: the totals have to come from somewhere.
    const step = matcher.readUsageTail(usageState.acc, usageState.tail);
    usageState.acc = step.acc;
    if (usageCache && step.read === 0 && !step.reset) {
      return { ok: true, file: target, requests: usageCache.payload.totalSummary.requests, generated: false, read: 0 };
    }
    const u = usageState.acc;
    const unattributed = (u.bareUsage[matcher.UNATTRIBUTED] || {}).requests || 0;
    const payload = {
      v: 1,
      generatedAt: new Date().toISOString(),
      totalSummary: u.totalSummary,
      bareUsage: u.bareUsage,
      unattributed: unattributed
    };
    const js =
      ';(function(g){\n' +
      '  g.__MAGPIE_USAGE_DATA__ = ' + JSON.stringify(payload) + ';\n' +
      '})(typeof window !== "undefined" ? window : globalThis);\n';
    fs.mkdirSync(targetDir, { recursive: true });
    const tmp = path.join(targetDir, '.' + USAGE_OUTPUT + '.' + process.pid + '.tmp');
    fs.writeFileSync(tmp, js, 'utf8');
    fs.renameSync(tmp, target);
    usageCache = { file: target, payload: payload };
    return { ok: true, file: target, requests: payload.totalSummary.requests, generated: true, read: step.read };
  } catch (err) {
    return { ok: false, file: target, requests: 0, generated: false, error: err.message };
  }
}
module.exports = { writePageData, writeUsageData, OUTPUT, USAGE_OUTPUT };
