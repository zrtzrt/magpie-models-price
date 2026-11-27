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

function sourceMtime(packageDir) {
  const paths = [
    matcher.paths && matcher.paths.providersState,
    matcher.paths && matcher.paths.providersConfig,
    matcher.paths && matcher.paths.settings,
    matcher.paths && matcher.paths.models,
    matcher.paths && matcher.paths.usage,
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
        let models = 0;
        try {
          const text = fs.readFileSync(target, 'utf8');
          const m = text.match(/__MAGPIE_MODELS_DATA__ = (\[[\s\S]*?\]);\n/);
          if (m) models = JSON.parse(m[1]).length;
        } catch {}
        return { ok: true, file: target, models, generated: false, ms: Date.now() - started };
      }
    }

    const report = matcher.scanAll();
    const usage = matcher.getUsageData();
    const js =
      ';(function(g){\n' +
      '  g.__MAGPIE_MODELS_DATA__ = ' + JSON.stringify(report) + ';\n' +
      '  g.__MAGPIE_USAGE_SUMMARY__ = ' + JSON.stringify(usage.totalSummary) + ';\n' +
      '  g.__MAGPIE_BARE_USAGE__ = ' + JSON.stringify(usage.bareUsage) + ';\n' +
      '  g.__MAGPIE_PEAK_FACTOR__ = ' + JSON.stringify(matcher.PEAK_FACTOR) + ';\n' +
      '  g.__MAGPIE_MODELS_GENERATED_AT__ = ' + JSON.stringify(new Date().toISOString()) + ';\n' +
      '})(typeof window !== "undefined" ? window : globalThis);\n';

    fs.mkdirSync(targetDir, { recursive: true });
    const tmp = path.join(targetDir, '.' + OUTPUT + '.' + process.pid + '.tmp');
    fs.writeFileSync(tmp, js, 'utf8');
    fs.renameSync(tmp, target);
    return { ok: true, file: target, models: report.length, generated: true, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, file: target, models: 0, generated: false, ms: Date.now() - started, error: err.message };
  }
}

module.exports = { writePageData, OUTPUT };
