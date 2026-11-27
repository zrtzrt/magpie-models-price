// apply-options.js - Applies the saves a page made to this plugin's options.
//
// A page cannot reach the disk (its CSP is connect-src 'none'), so a save is
// stored by magpie as this plugin's options. A page-only plugin starts no
// plugin host, so nothing runs at the reload that save causes: this module is
// the apply step, called by `magpie-models-price apply` (or its watch).
//
// Only the keys this save changed are written. A page save used to call
// applyGlobalModeIfChanged, whose scan rewrote the whole price table and
// replaced prices the user had set in magpie's own editor (PR #1576 review).
const fs = require('fs');
const path = require('path');
const matcher = require('./matcher');

const MODES = new Set(['api-only', 'all-equivalent']);

// What this plugin has already applied, kept in its own cache file rather than
// in magpie's plugins.json: writing that file from here makes magpie reload the
// plugin host, so recording a save would itself look like another save.
function appliedFile() {
  return matcher.paths.cacheDir ? path.join(matcher.paths.cacheDir, 'models-price-applied.json') : '';
}

function readApplied() {
  try {
    const file = appliedFile();
    if (!file || !fs.existsSync(file)) return {};
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function writeApplied(state) {
  const file = appliedFile();
  if (!file) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    console.error('Failed to record the applied save:', err.message);
    return false;
  }
}

// applySavedOptions applies one save made in the page, and nothing else.
function applySavedOptions(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const token = typeof opts.applyToken === 'string' ? opts.applyToken : '';
  if (!token) return { applied: false, reason: 'no save to apply' };
  if (token === readApplied().token) return { applied: false, reason: 'already applied' };

  const out = { applied: true, token, mode: '', prices: 0, peakProviders: 0, conflicts: [], error: '', peakError: '' };
  try {
    if (MODES.has(opts.mode)) out.mode = opts.mode;
    // Only the keys this save changed are written. A page save used to call
    // applyGlobalModeIfChanged, whose scan rewrote the whole price table and
    // replaced prices the user had set in magpie's own editor (PR #1576 review).
    // Only priceChanges is a page save. The fallback to customPrices read the
    // plugin's whole stored price map as if the save had changed all of it: a
    // token left over from a 1.4.x page then wrote every price back over what
    // magpie's editor had set (gpt-5 went from 0.5/4 to 1.25/10). A save with
    // no priceChanges changed no price.
    const priceChanges = opts.priceChanges && typeof opts.priceChanges === 'object'
      ? opts.priceChanges
      : {};
    const removedPrices = Array.isArray(opts.removedPrices) ? opts.removedPrices : [];
    const result = matcher.applyPriceChanges(priceChanges, removedPrices);
    out.prices = result.count;

    // An empty modelPeaks is the normal page payload for a price-only save; do
    // not try to sync it (a missing providers.json used to make that fail and
    // kept the token unrecorded, so the same save ran again on every reload).
    if (opts.modelPeaks && typeof opts.modelPeaks === 'object' && Object.keys(opts.modelPeaks).length > 0) {
      const peak = matcher.syncModelPeakWindows(opts.modelPeaks);
      if (!peak.ok) {
        out.peakError = peak.error || 'peak sync failed';
      } else {
        out.peakProviders = peak.results.filter((x) => x.status === 'written').length;
        out.conflicts = peak.results.filter((x) => x.status === 'conflict').map((x) => x.provider);
      }
    }
  } catch (err) {
    out.error = err.message;
    return out;
  }
  // The price write went through, so record the token even when the optional
  // peak sync had nowhere to write: otherwise every reload retries this save.
  writeApplied({
    token,
    at: new Date().toISOString(),
    mode: out.mode,
    prices: out.prices,
    peakError: out.peakError || undefined
  });
  return out;
}

// plugins.json entries that are this package, in the order magpie lists them.
function pluginEntries() {
  const file = matcher.paths.configDir ? path.join(matcher.paths.configDir, 'plugins.json') : '';
  if (!file || !fs.existsSync(file)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(data && data.plugins) ? data.plugins : [];
    return list.filter((p) => p && typeof p.spec === 'string' && p.spec.includes('magpie-models-price'));
  } catch {
    return [];
  }
}

// applyPendingOptions applies every page save this machine has not applied yet.
// A token is the save's identity: an unchanged page sends none, so a reload for
// any other reason writes nothing.
function applyPendingOptions() {
  const results = [];
  const entries = pluginEntries();
  const pending = [];
  for (const entry of entries) {
    const options = entry.options && typeof entry.options === 'object' ? entry.options : {};
    const token = typeof options.applyToken === 'string' ? options.applyToken : '';
    if (!token || token === readApplied().token) continue;
    pending.push({ spec: entry.spec, token, options });
  }
  // Oldest first: the token starts with Date.now() in base 36.
  pending.sort((a, b) => String(a.token).localeCompare(String(b.token)));
  for (const item of pending) {
    const result = applySavedOptions(item.options);
    results.push({ spec: item.spec, token: item.token, result });
  }
  return results;
}

module.exports = { applySavedOptions, applyPendingOptions, pluginEntries, readApplied, writeApplied, appliedFile };
