// matcher.js - Core logic for matching Magpie models with models.dev data & pricing modes
const fs = require('fs');
const os = require('os');
const path = require('path');

// Magpie resolves its own folders in internal/appdir: $XDG_CONFIG_HOME/magpie and
// $XDG_CACHE_HOME/magpie when those are set and absolute, else ~/.config/magpie
// and ~/.cache/magpie, with USERPROFILE as Windows' home (homeVar()). Reading the
// same folders is what makes the prices written here the ones magpie loads: a
// plugin that always used ~/.config ignored an XDG_CONFIG_HOME user entirely and
// wrote into a folder magpie never reads.
function resolveHomeDir() {
  for (const candidate of [process.env.HOME, process.env.USERPROFILE]) {
    if (candidate && path.isAbsolute(candidate)) return candidate;
  }
  try {
    const fallback = os.homedir();
    if (fallback && path.isAbsolute(fallback)) return fallback;
  } catch {}
  return '';
}

// xdgDir is magpie's folder for one of its two trees, "" when there is no home
// folder to put it under: an empty home must fail a write loudly rather than
// scatter relative .config folders into whatever the working folder happens to be.
function xdgDir(envName, fallbackName) {
  const named = process.env[envName];
  if (named && path.isAbsolute(named)) return path.join(named, 'magpie');
  const home = resolveHomeDir();
  return home ? path.join(home, fallbackName, 'magpie') : '';
}

const HOME = resolveHomeDir();
const CONFIG_DIR = xdgDir('XDG_CONFIG_HOME', '.config');
const CACHE_DIR = xdgDir('XDG_CACHE_HOME', '.cache');
const CACHE_MODELS_PATH = path.join(CACHE_DIR, 'models.json');
const PROVIDERS_STATE_PATH = path.join(CACHE_DIR, 'providers-state.json');
const PROVIDERS_CONFIG_PATH = path.join(CONFIG_DIR, 'providers.json');
const SETTINGS_PATH = path.join(CONFIG_DIR, 'settings.json');
const USAGE_PATH = path.join(CONFIG_DIR, 'usage.jsonl');
const PLUGINS_PATH = path.join(CONFIG_DIR, 'plugins.json');

function readSettings() {
  if (!fs.existsSync(SETTINGS_PATH)) return {};
  return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
}

/**
 * Write a JSON file through a temp file in the same directory, fsynced and
 * renamed over it: a reader (magpie itself, reading settings on every request)
 * never sees a half-written file, which its Load discards whole, taking the
 * user's settings back to the defaults.
 */
function writeJsonAtomic(filePath, value, defaultMode = 0o600) {
  if (!path.isAbsolute(filePath)) {
    // Reached only when no home folder could be resolved: writing here would put
    // magpie's settings under the working folder, where nothing reads them.
    throw new Error('cannot write ' + path.basename(filePath) + ': no home folder (HOME / USERPROFILE / os.homedir())');
  }
  const dir = path.dirname(filePath);
  // A first run has no ~/.config/magpie yet, and an XDG folder magpie itself
  // creates lazily may be missing too: openSync of the temp file would throw
  // ENOENT and the price would silently never be saved.
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, '.' + path.basename(filePath) + '.' + process.pid + '.' + Date.now() + '.tmp');
  let mode = defaultMode;
  try { mode = fs.statSync(filePath).mode & 0o777; } catch {}
  const data = JSON.stringify(value, null, 2);
  let fd;
  try {
    fd = fs.openSync(tmp, 'w', mode);
    fs.writeFileSync(fd, data, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, filePath);
  } catch (err) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

function writeSettingsAtomic(settings) {
  writeJsonAtomic(SETTINGS_PATH, settings);
}

// The plugin's own options, as the page saves them: magpie keeps them in
// plugins.json. A plugin server is not handed them (input.magpie.options is a
// provider auth plugin's options, keyed by provider), so they are read from the
// file the page writes, each time they are wanted: a mode or a price set in
// the page then reaches the running server without a restart.
function findPluginEntry(data, packageDir = '') {
  const list = Array.isArray(data && data.plugins) ? data.plugins : [];
  const mine = list.filter((p) => p && typeof p.spec === 'string' && p.spec.includes('magpie-models-price'));
  if (mine.length === 0) return null;
  if (packageDir) {
    const exact = mine.find((p) => p.spec === packageDir);
    if (exact) return exact;
  }
  return mine.find((p) => !p.off) || mine[0];
}

function readPluginOptions(packageDir = '') {
  try {
    if (!fs.existsSync(PLUGINS_PATH)) return null;
    const data = JSON.parse(fs.readFileSync(PLUGINS_PATH, 'utf8'));
    const entry = findPluginEntry(data, packageDir);
    return entry ? (entry.options || {}) : null;
  } catch {
    return null;
  }
}

// Write only when something actually differs: plugins.json is watched by Magpie,
// and every write makes it reload the plugin host (the page reloads with it).
// Toggling a switch a second time, or saving an unchanged price, must not.
function writePluginOptions(patch, packageDir = '') {
  if (!fs.existsSync(PLUGINS_PATH)) return false;
  const data = JSON.parse(fs.readFileSync(PLUGINS_PATH, 'utf8'));
  const entry = findPluginEntry(data, packageDir);
  if (!entry) return false;
  const current = entry.options || {};
  const changed = Object.keys(patch || {}).some(
    (k) => stableStringify(current[k]) !== stableStringify(patch[k])
  );
  if (!changed) return true;
  entry.options = { ...current, ...patch };
  writeJsonAtomic(PLUGINS_PATH, data);
  return true;
}

// Order-independent serialisation: two modelPrices maps with the same entries
// compare equal even when their keys were inserted in a different order.
function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .filter((k) => value[k] !== undefined)
      .map((k) => JSON.stringify(k) + ':' + stableStringify(value[k]))
      .join(',') + '}';
  }
  return JSON.stringify(value);
}

/**
 * Change modelPrices only: the file is read again right before the write, so a
 * setting magpie saved meanwhile (theme, window, a provider's editor) is kept
 * rather than rolled back to the snapshot this process read a minute ago.
 * Nothing is written when the prices are the ones already on disk: settings.json
 * is magpie's own file, it is watched, and rewriting it every 60 s costs a full
 * re-serialisation and races with magpie's own writes.
 */
function updateModelPrices(mutate) {
  const settings = readSettings();
  const before = settings.modelPrices && Object.keys(settings.modelPrices).length
    ? settings.modelPrices
    : undefined;
  const next = mutate({ ...(settings.modelPrices || {}) }) || {};
  const after = Object.keys(next).length > 0 ? next : undefined;
  if (stableStringify(before) === stableStringify(after)) return before || {};
  if (after) settings.modelPrices = after;
  else delete settings.modelPrices;
  writeSettingsAtomic(settings);
  return settings.modelPrices || {};
}

/**
 * What settings.ModelPrice can hold: input, output, cache_read, cache_write
 * and optional tiers. Anything else (an "offpeak" object) magpie's JSON decode
 * drops, and its next save writes away; peak hours are magpie's own
 * (catalog.Peak), applied to the price as stored.
 */
function sanitizePrice(price) {
  const out = {
    input: Number(price.input) || 0,
    output: Number(price.output) || 0,
    cache_read: Number(price.cache_read) || 0,
    cache_write: Number(price.cache_write) || 0
  };
  if (Array.isArray(price.tiers) && price.tiers.length > 0) out.tiers = price.tiers;
  return out;
}

// Preferred official makers in models.dev
const OFFICIAL_MAKERS = [
  'deepseek', 'google', 'anthropic', 'openai', 'zhipu', 'zhipuai',
  'moonshot', 'moonshotai', 'bytedance', 'volcengine', 'baichuan',
  'minimax', 'stepfun', 'xiaomi', 'tencent', 'qwen', 'alibaba'
];

function getVendorHints(target) {
  const t = target.toLowerCase();
  const hints = [];
  if (t.includes('qwen') || t.startsWith('qwenwork/') || t.includes('blian')) hints.push('qwen', 'alibaba', 'bailian');
  if (t.includes('deepseek')) hints.push('deepseek');
  if (t.includes('gemini') || t.startsWith('gemini/')) hints.push('google');
  if (t.includes('claude')) hints.push('anthropic');
  if (t.includes('gpt-') || t.includes('codex/')) hints.push('openai');
  if (t.includes('kimi')) hints.push('moonshot', 'moonshotai');
  if (t.includes('glm')) hints.push('zhipu', 'zhipuai', 'glm', 'bigmodel');
  if (t.includes('doubao') || t.includes('seed-') || t.includes('huoshan')) hints.push('volcengine', 'bytedance', 'doubao');
  if (t.includes('minimax')) hints.push('minimax');
  if (t.includes('mimo')) hints.push('xiaomi');
  if (t.includes('hy3') || t.includes('hy4') || t.includes('hunyuan')) hints.push('tencent');
  if (t.includes('step-')) hints.push('stepfun');
  return hints;
}

function loadCatalog() {
  let raw = null;
  if (fs.existsSync(CACHE_MODELS_PATH)) {
    try {
      raw = JSON.parse(fs.readFileSync(CACHE_MODELS_PATH, 'utf8'));
    } catch {}
  }

  // Fallback for CI/testing when Magpie cache hasn't been created yet
  if (!raw) {
    return [
      { provider: 'deepseek', model: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', cost: { input: 0.15, output: 0.6, cache_read: 0.003, cache_write: 0 } },
      { provider: 'anthropic', model: 'claude-opus-4-6', name: 'Claude Opus 4.6', cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 } },
      { provider: 'google', model: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', cost: { input: 0.75, output: 3.75, cache_read: 0.075, cache_write: 0 } }
    ];
  }

  const list = [];
  for (const [providerId, provider] of Object.entries(raw)) {
    for (const [modelId, model] of Object.entries(provider.models || {})) {
      if (model.cost) {
        list.push({
          provider: providerId,
          model: modelId,
          name: model.name || modelId,
          cost: {
            input: model.cost.input ?? 0,
            output: model.cost.output ?? 0,
            cache_read: model.cost.cache_read ?? model.cost.cache?.read ?? 0,
            cache_write: model.cost.cache_write ?? model.cost.cache?.write ?? 0
          }
        });
      }
    }
  }
  return list;
}

function cleanModelName(str) {
  const rawName = str ? str.toLowerCase().replace(/^[a-z0-9_-]+\//, '') : '';
  if (rawName === 'hy4flash' || rawName === 'hy4-flash') return 'hy4-flash';
  if (rawName === 'hy4flash-free' || rawName === 'hy4-flash-free') return 'hy4-flash-free';
  if (rawName === 'deepseek-flash') return 'deepseek-v4-flash';

  let s = str.toLowerCase()
    .replace(/^[a-z0-9_-]+\//, '')
    .replace(/^(blian_|huoshan_|vlm_huoshan_)/, '')
    .replace(/(-\d{6,8}|-\d{4}-\d{2}-\d{2})$/, '')
    .replace(/-ga(-\d+)?$/, '')
    .replace(/-tiered$/, '')
    .replace(/-control$/, '')
    .replace(/-n$/, '')
    .replace(/-sg$/, '')
    .replace(/-preview.*$/, '')
    .replace(/-thinking$/, '')
    .replace(/-agent$/, '')
    .replace(/-flashx/, '-flash')
    .replace(/-code$/, '')
    .replace(/_advisor_doubao$/, '')
    .replace(/-free$/, '')
    .replace(/-disabled$/, '')
    .replace(/-1$/, '')
    .replace(/_/g, '-');

  s = s.replace(/qwen(\d)(\d)/, (_, a, b) => 'qwen' + a + '.' + b);
  s = s.replace(/glm-(\d)-(\d)/, (_, a, b) => 'glm-' + a + '.' + b);
  s = s.replace(/v4[.-]1/, 'v4');
  s = s.replace(/v4p1/, 'v4');
  s = s.replace(/doubao[_-]1[_-]6/i, 'doubao-seed-1.6');

  if (s.includes('2-0-lite') || s.includes('2.0-lite')) return 'doubao-seed-2.0-lite';
  if (s.includes('2-0-mini') || s.includes('2.0-mini')) return 'doubao-seed-2.0-mini';
  if (s.includes('hy-vision') || s.includes('hunyuan-vision')) return 'hunyuan-2.0-instruct';
  if (s === 'hy4' || s === 'hy4-preview' || s === 'hy4-free') return 'hunyuan-2.0-instruct';

  return s;
}

// Classify provider kind from runtime state (providers-state.json) or config
// entries (providers.json). The key flag matters: a provider can be 'plan'
// with an optional API key, while only pay-as-you-go providers with a real
// key are the "paid API" channels users mean by the API filter.
function providerKindOf(p = {}) {
  const id = String((p && p.id) || '').toLowerCase();
  const billing = String((p && (p.billingKind || p.billing_kind)) || '').toLowerCase();
  if (billing === 'payg' || billing === 'pay-as-you-go' || billing === 'api') return 'api';
  if (billing === 'plan' || billing === 'subscription' || billing === 'free') return 'subscription';
  const keySet = p && p.key && typeof p.key === 'object'
    ? p.key.set === true
    : typeof (p && p.key) === 'string' && p.key.trim().length > 0;
  if (keySet && !p.account) return 'api';
  if (p && p.account) return 'subscription';
  if (/free|plan/.test(id)) return 'subscription';
  return 'subscription';
}

/**
 * Classify provider kind: 'subscription' (OAuth, Plan, Credits, Free) vs 'api' (Paid Key / Pay-as-you-go)
 */
function getProviderClassifications() {
  if (!fs.existsSync(PROVIDERS_STATE_PATH)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(PROVIDERS_STATE_PATH, 'utf8'));
    const list = data.providers?.providers || [];
    const kinds = {};
    for (const p of list) {
      const kind = providerKindOf(p);
      const isSub = kind !== 'api';
      kinds[p.id] = {
        name: p.name || p.id,
        icon: p.icon || null,
        isSubscription: isSub,
        kind,
        planName: p.account?.plan || (p.key?.set ? 'API Key' : 'Account')
      };
    }
    return kinds;
  } catch {
    return {};
  }
}

/**
 * Retrieve routing group IDs configured in Magpie providers.json
 */
function getRoutingGroupIds() {
  const groupIds = new Set(['never-stuck', 'free']);
  if (fs.existsSync(PROVIDERS_CONFIG_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(PROVIDERS_CONFIG_PATH, 'utf8'));
      const groups = data.groups || [];
      for (const g of groups) {
        if (g && g.id) groupIds.add(g.id);
      }
    } catch {}
  }
  return groupIds;
}

/**
 * Detect whether a request log entry in usage.jsonl is a test probe, health check or internal tool call
 */
function isTestOrProbeRequest(r) {
  if (!r || typeof r !== 'object') return true;
  if (!r.provider || r.provider === 'unknown') return true;
  if (r.operation === 'execute_tool') return true;
  if (r.source === 'probe' || r.source === 'tool') return true;
  if (
    r.kind === 'tool' ||
    r.kind === 'mcp' ||
    r.kind === 'provider_test' ||
    r.kind === 'model_list' ||
    r.kind === 'connection_check' ||
    r.kind === 'api_detect'
  ) return true;
  if (typeof r.kind === 'string' && r.kind.toLowerCase().includes('test')) return true;
  if (typeof r.operation === 'string' && r.operation.toLowerCase().includes('test')) return true;

  // Test agents: internal Magpie probe daemon, curl manual connectivity checks, or headless probe clients
  if (r.agent === 'magpie' || r.agent === 'curl') return true;

  // Failed, cancelled, or error requests (e.g. 400, 404, 499, 500)
  if (r.status && Number(r.status) !== 200) return true;

  // Zero-token exchanges (dummy pings or probes that didn't run inference)
  const inT = r.in || 0;
  const outT = r.out || 0;
  if (inT === 0 && outT === 0) return true;

  // Automated batch connection probes from scripts (e.g. node test ping with trivial token payloads)
  if (r.agent === 'node' && outT <= 15 && inT <= 60) return true;

  return false;
}

function getMagpieModels() {
  const models = [];
  const seen = new Set();
  const providerDeclaredModels = new Set();
  const classifications = getProviderClassifications();
  const routingGroupIds = getRoutingGroupIds();

  if (fs.existsSync(PROVIDERS_STATE_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(PROVIDERS_STATE_PATH, 'utf8'));
      const providersList = data.providers?.providers || [];

      for (const p of providersList) {
        const providerId = p.id;
        const isProviderOn = !p.off;
        const pInfo = classifications[providerId] || { kind: 'api', name: providerId };
        const pModels = p.models || [];
        for (const m of pModels) {
          if (!m.id || m.id.startsWith('group/') || m.id === 'never-stuck') continue;
          const isModelOn = m.on !== false;
          const isEnabled = isProviderOn && isModelOn;
          const fullName = providerId + '/' + m.id;
          seen.add(fullName);
          providerDeclaredModels.add(fullName);
          models.push({
            provider: providerId,
            providerName: pInfo.name,
            providerIcon: p.icon || pInfo.icon || null,
            providerKind: pInfo.kind,
            id: m.id,
            fullName: fullName,
            name: m.name || m.id,
            free: !!m.free,
            listPrice: m.list || null,
            enabled: isEnabled,
            providerOff: !!p.off,
            modelOn: isModelOn
          });
        }
      }
    } catch {}
  }

  // Also include models observed in usage.jsonl or recent sessions/calls (excluding routing groups)
  if (fs.existsSync(USAGE_PATH)) {
    try {
      const content = fs.readFileSync(USAGE_PATH, 'utf8');
      const lines = content.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line);
          if (isTestOrProbeRequest(r)) continue;
          const prov = r.provider;
          const isGroupReq = r.req && (r.req.startsWith('group/') || r.req.startsWith('group:'));
          const candidates = [
            r.model,
            r.served,
            (!isGroupReq && r.req) ? (r.req.includes('/') ? r.req.split('/')[1] : r.req) : null
          ];
          for (const mId of candidates) {
            if (
              !mId ||
              mId === 'probe' ||
              mId === 'unknown' ||
              mId === 'auto' ||
              mId.startsWith('group/') ||
              mId === 'never-stuck' ||
              mId.includes('__') ||
              mId.includes('search') ||
              mId === 'find_tools' ||
              mId === 'Tavily' ||
              mId === 'web_fetch' ||
              mId.endsWith('-model')
            ) {
              continue;
            }
            const full = prov + '/' + mId;
            // Exclude routing group names that are not actually declared provider models
            if (routingGroupIds.has(mId) && !providerDeclaredModels.has(full)) {
              continue;
            }
            if (!seen.has(full)) {
              seen.add(full);
              const pInfo = classifications[prov] || { kind: 'subscription', name: prov };
              models.push({
                provider: prov,
                providerName: pInfo.name,
                providerIcon: pInfo.icon || null,
                providerKind: pInfo.kind,
                id: mId,
                fullName: full,
                name: mId,
                free: false,
                listPrice: null,
                enabled: true,
                providerOff: false,
                modelOn: true
              });
            }
          }
        } catch {}
      }
    } catch {}
  }

  // Always ensure known Antigravity & popular variants are registered
  const extraVariants = [
    { prov: 'antigravity', id: 'gemini-3.8-flash-control' },
    { prov: 'antigravity', id: 'gemini-3.8-flash-tiered' },
    { prov: 'antigravity', id: 'gemini-3.8-flash-n' }
  ];
  for (const item of extraVariants) {
    const full = item.prov + '/' + item.id;
    if (!seen.has(full)) {
      seen.add(full);
      const pInfo = classifications[item.prov] || { kind: 'subscription', name: item.prov };
      models.push({
        provider: item.prov,
        providerName: pInfo.name,
        providerIcon: pInfo.icon || null,
        providerKind: pInfo.kind,
        id: item.id,
        fullName: full,
        name: item.id,
        free: false,
        listPrice: null,
        enabled: true,
        providerOff: false,
        modelOn: true
      });
    }
  }

  return models;
}

function getUsageData() {
  const channelUsage = {};
  const bareUsage = {};
  const totalSummary = {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    totalTokens: 0
  };

  if (!fs.existsSync(USAGE_PATH)) {
    return { channelUsage, bareUsage, totalSummary };
  }

  try {
    const content = fs.readFileSync(USAGE_PATH, 'utf8');
    const lines = content.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        // 严格排除测试请求与健康探针 (Magpie 自身健康探针、curl 手动测试、0 Token 请求、错误状态等)
        if (isTestOrProbeRequest(r)) continue;

        const isGroupReq = r.req && (r.req.startsWith('group/') || r.req.startsWith('group:'));
        const actualModel = (r.served && r.served !== 'auto') ? r.served : (r.model !== 'auto' ? r.model : null);
        const bare = actualModel || (!isGroupReq && r.req ? (r.req.includes('/') ? r.req.split('/')[1] : r.req) : null);
        if (
          !bare ||
          bare === 'unknown' ||
          bare === 'probe' ||
          bare === 'auto' ||
          bare === 'find_tools' ||
          bare === 'Tavily' ||
          bare === 'web_fetch' ||
          bare === 'never-stuck' ||
          bare.startsWith('group/') ||
          bare.endsWith('-model')
        ) {
          continue;
        }
        const req = (!isGroupReq && r.req && r.req.includes('/') && !r.req.startsWith('group/'))
          ? r.req
          : (r.provider + '/' + bare);
        const inT = r.in || 0;
        const outT = r.out || 0;
        const cRead = r.cache_read || 0;
        const cWrite = r.cache_write || 0;
        const sumT = inT + outT;

        totalSummary.requests++;
        totalSummary.inputTokens += inT;
        totalSummary.outputTokens += outT;
        totalSummary.cacheRead += cRead;
        totalSummary.totalTokens += sumT;

        if (!channelUsage[req]) {
          channelUsage[req] = {
            requests: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            lastAt: r.t
          };
        }
        channelUsage[req].requests++;
        channelUsage[req].inputTokens += inT;
        channelUsage[req].outputTokens += outT;
        channelUsage[req].cacheRead += cRead;
        channelUsage[req].cacheWrite += cWrite;
        channelUsage[req].totalTokens += sumT;
        if (r.t && (!channelUsage[req].lastAt || r.t > channelUsage[req].lastAt)) {
          channelUsage[req].lastAt = r.t;
        }

        const updateBare = (bKey) => {
          if (!bareUsage[bKey]) {
            bareUsage[bKey] = {
              requests: 0,
              inputTokens: 0,
              outputTokens: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              lastAt: r.t
            };
          }
          bareUsage[bKey].requests++;
          bareUsage[bKey].inputTokens += inT;
          bareUsage[bKey].outputTokens += outT;
          bareUsage[bKey].cacheRead += cRead;
          bareUsage[bKey].cacheWrite += cWrite;
          bareUsage[bKey].totalTokens += sumT;
          if (r.t && (!bareUsage[bKey].lastAt || r.t > bareUsage[bKey].lastAt)) {
            bareUsage[bKey].lastAt = r.t;
          }
        };

        updateBare(bare);
        const cleaned = cleanModelName(bare);
        if (cleaned && cleaned !== bare) {
          updateBare(cleaned);
        }
      } catch {}
    }
  } catch (e) {
    console.warn('Failed to read usage.jsonl:', e.message);
  }

  return { channelUsage, bareUsage, totalSummary };
}

function getCustomPrices() {
  if (!fs.existsSync(SETTINGS_PATH)) return {};
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    return s.modelPrices || {};
  } catch {
    return {};
  }
}

function getPricingStatus(models) {
  const customPrices = getCustomPrices();
  const result = [];

  for (const m of models) {
    const custom = customPrices[m.fullName] || customPrices['*/' + m.id];
    const isUnpriced = !m.free && !m.listPrice && !custom;

    let priceInfo = 'no price is known for it';
    if (m.free) {
      priceInfo = 'Free model ($0.00)';
    } else if (custom) {
      priceInfo = `Custom: $${custom.input}/$${custom.output} in/out (cache: $${custom.cache_read}/$${custom.cache_write})`;
    } else if (m.listPrice) {
      priceInfo = `List: $${m.listPrice.input}/$${m.listPrice.output} in/out`;
    }

    result.push({
      model: m.fullName,
      modelObj: m,
      isUnpriced,
      priceInfo
    });
  }
  return result;
}

function isOfficialMaker(providerId, hints = []) {
  const p = providerId.toLowerCase();
  if (hints.length > 0) {
    return hints.some(h => p === h || p.startsWith(h + '-') || p.endsWith('-' + h) || p.includes(h));
  }
  return OFFICIAL_MAKERS.some(m => p === m || p.startsWith(m + '-') || p.endsWith('-' + m));
}

function matchModel(target, catalog) {
  const bare = (target.includes('/') ? target.split('/')[1] : target).toLowerCase();
  const cleaned = cleanModelName(target);
  const hints = getVendorHints(target);

  const exactCandidates = catalog.filter(c => c.model.toLowerCase() === bare);
  const cleanedCandidates = catalog.filter(c => cleanModelName(c.model) === cleaned);
  const fuzzyCandidates = catalog.filter(c => {
    const cClean = cleanModelName(c.model);
    return c.model.toLowerCase().includes(cleaned) || cleaned.includes(cClean);
  });

  function pickBest(list) {
    if (!list.length) return null;
    const sorted = [...list].sort((a, b) => {
      // 0. Exact provider name match for vendor hint (e.g. 'google' === 'google' over 'google-vertex')
      const aExactProv = hints.some(h => a.provider.toLowerCase() === h) ? 1 : 0;
      const bExactProv = hints.some(h => b.provider.toLowerCase() === h) ? 1 : 0;
      if (aExactProv !== bExactProv) return bExactProv - aExactProv;

      // 1. Direct provider match for vendor hint (e.g. provider 'deepseek' for 'deepseek')
      const aProvHint = hints.some(h => a.provider.toLowerCase().includes(h) || h.includes(a.provider.toLowerCase())) ? 1 : 0;
      const bProvHint = hints.some(h => b.provider.toLowerCase().includes(h) || h.includes(b.provider.toLowerCase())) ? 1 : 0;
      if (aProvHint !== bProvHint) return bProvHint - aProvHint;

      // 2. Official maker preference
      const aOff = isOfficialMaker(a.provider) ? 1 : 0;
      const bOff = isOfficialMaker(b.provider) ? 1 : 0;
      if (aOff !== bOff) return bOff - aOff;

      // 3. Model name match for vendor hint
      const aModelHint = hints.some(h => a.model.toLowerCase().includes(h)) ? 1 : 0;
      const bModelHint = hints.some(h => b.model.toLowerCase().includes(h)) ? 1 : 0;
      if (aModelHint !== bModelHint) return bModelHint - aModelHint;

      const aNonZero = (a.cost.input > 0 || a.cost.output > 0) ? 1 : 0;
      const bNonZero = (b.cost.input > 0 || b.cost.output > 0) ? 1 : 0;
      return bNonZero - aNonZero;
    });
    return sorted[0];
  }

  const hintCleaned = cleanedCandidates.filter(c => hints.some(h => c.provider.toLowerCase().includes(h)));
  if (hintCleaned.length > 0) {
    const best = pickBest(hintCleaned);
    return { match: best, confidence: 'exact', reason: '原厂规约匹配 (' + best.provider + ')' };
  }

  const exactHit = pickBest(exactCandidates);
  if (exactHit) {
    return { match: exactHit, confidence: 'exact', reason: isOfficialMaker(exactHit.provider) ? '官方原厂精准匹配' : '渠道精准匹配 (' + exactHit.provider + ')' };
  }

  const cleanedHit = pickBest(cleanedCandidates);
  if (cleanedHit) {
    return { match: cleanedHit, confidence: 'high', reason: isOfficialMaker(cleanedHit.provider) ? '官方规格匹配' : '渠道规格匹配 (' + cleanedHit.provider + ')' };
  }

  const hintFuzzy = fuzzyCandidates.filter(c => hints.some(h => c.provider.toLowerCase().includes(h)));
  if (hintFuzzy.length > 0) {
    const best = pickBest(hintFuzzy);
    return { match: best, confidence: 'medium', reason: '关联厂商模型 (' + best.provider + ')' };
  }

  const fuzzyHit = pickBest(fuzzyCandidates);
  if (fuzzyHit) {
    return { match: fuzzyHit, confidence: 'medium', reason: '模糊推荐匹配 (' + fuzzyHit.provider + ')' };
  }

  return null;
}

function scanAll() {
  const catalog = loadCatalog();
  const allModels = getMagpieModels();
  const statuses = getPricingStatus(allModels);
  const { channelUsage, bareUsage, totalSummary } = getUsageData();

  const report = [];
  for (const s of statuses) {
    const matchResult = matchModel(s.model, catalog);
    const peak = peakRuleFor(s.modelObj.provider, s.modelObj.id || s.modelObj.fullName || s.model);
    const bare = s.modelObj.id || (s.model.includes('/') ? s.model.split('/')[1] : s.model);
    const chUsage = channelUsage[s.model] || null;
    const bUsage = bareUsage[bare] || null;

    report.push({
      model: s.model,
      name: s.modelObj.name,
      provider: s.modelObj.provider,
      providerName: s.modelObj.providerName,
      providerIcon: s.modelObj.providerIcon || null,
      providerKind: s.modelObj.providerKind,
      enabled: s.modelObj.enabled !== false,
      isUnpriced: s.isUnpriced,
      currentPrice: s.priceInfo,
      peakRule: peak,
      // the shape the page's bundled data still carries
      offPeakPreset: { supported: peak.supported, factor: peak.factor, vendor: peak.vendor, name: peak.name },
      usage: chUsage,
      bareUsage: bUsage,
      matched: matchResult ? {
        provider: matchResult.match.provider,
        model: matchResult.match.model,
        name: matchResult.match.name,
        confidence: matchResult.confidence,
        reason: matchResult.reason,
        cost: matchResult.match.cost,
        priceString: [
          matchResult.match.cost.input,
          matchResult.match.cost.output,
          matchResult.match.cost.cache_read,
          matchResult.match.cost.cache_write
        ].join(',')
      } : null
    });
  }
  return report;
}

function applyPrice(model, priceString) {
  const parts = priceString.split(',').map(p => parseFloat(p.trim()) || 0);
  const priceObj = {
    input: parts[0] ?? 0,
    output: parts[1] ?? 0,
    cache_read: parts[2] ?? 0,
    cache_write: parts[3] ?? 0
  };

  updateModelPrices((prices) => {
    prices[model] = priceObj;
    return prices;
  });

  return `Applied ${model} -> $${priceObj.input}/$${priceObj.output}`;
}

function resetPrice(model) {
  const settings = readSettings();
  if (!settings.modelPrices || !settings.modelPrices[model]) {
    return `No custom price found for ${model}`;
  }
  updateModelPrices((prices) => {
    delete prices[model];
    return prices;
  });
  return `Reset price for ${model}`;
}

/**
 * Apply Global Pricing Mode:
 * - 'api-only': only write real prices for 'api' providers; subscription providers have prices set to 0 or removed
 * - 'all-equivalent': write market prices for all models
 * Returns { count, changed }; settings.json is left untouched when nothing changed.
 */
function applyGlobalModeIfChanged(mode, customOverrides = {}) {
  const report = scanAll();
  const newPrices = { ...(readSettings().modelPrices || {}) };

  if (mode === 'api-only') {
    // Only apply prices for paid API providers or explicit custom overrides
    for (const item of report) {
      if (item.providerKind === 'api') {
        if (customOverrides[item.model]) {
          newPrices[item.model] = sanitizePrice(customOverrides[item.model]);
        } else if (item.matched) {
          newPrices[item.model] = {
            input: item.matched.cost.input,
            output: item.matched.cost.output,
            cache_read: item.matched.cost.cache_read,
            cache_write: item.matched.cost.cache_write
          };
        }
      } else {
        // Subscription / free accounts: explicit zero so Magpie doesn't bill them
        newPrices[item.model] = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
      }
    }
  } else {
    // all-equivalent: all providers get their market value
    for (const item of report) {
      if (customOverrides[item.model]) {
        newPrices[item.model] = sanitizePrice(customOverrides[item.model]);
      } else if (item.matched) {
        newPrices[item.model] = {
          input: item.matched.cost.input,
          output: item.matched.cost.output,
          cache_read: item.matched.cost.cache_read,
          cache_write: item.matched.cost.cache_write
        };
      }
    }
  }

  // Apply every explicit custom override, wildcard or provider/model key alike.
  // A custom key whose model is missing from the current scan (channel disabled,
  // model renamed, or only present in usage history) used to be skipped, so the
  // price the user typed never reached Magpie and the row kept the old value.
  // The price the user typed always wins.
  for (const [k, v] of Object.entries(customOverrides)) {
    if (v) newPrices[k] = sanitizePrice(v);
  }

  // api-only: a model no paid API provider serves has no channel left to bill,
  // so its wildcard goes to 0 too. An exact provider/model key still wins for
  // the API channels that do serve it, and a subscription model whose wildcard
  // was left at the market value is what still showed a cost (#api-only).
  if (mode === 'api-only') {
    // Every key of a subscription provider goes to 0, including one left from a
    // model it no longer lists: otherwise a stale provider/model key still
    // answers before the wildcard and the row keeps a cost.
    const kinds = getProviderClassifications();
    for (const key of Object.keys(newPrices)) {
      if (key.startsWith('*/')) continue;
      const pid = key.split('/')[0];
      if (kinds[pid] && kinds[pid].kind === 'subscription') {
        newPrices[key] = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
      }
    }
    // A wildcard prices every provider with no key of its own: in this mode it
    // must not keep the market value of a model only subscription channels
    // serve, or a row without an exact key still shows a cost. A wildcard with
    // any paid provider/model key under it keeps its value.
    for (const key of Object.keys(newPrices)) {
      if (!key.startsWith('*/')) continue;
      const bare = key.slice(2);
      const paid = Object.keys(newPrices).some((k) => {
        if (k.startsWith('*/') || !k.endsWith('/' + bare)) return false;
        const v = newPrices[k];
        return v && (v.input > 0 || v.output > 0);
      });
      if (!paid) newPrices[key] = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
    }
  }

  // Add wildcard fallbacks for bare model names and cleaned names so any un-prefixed request matches
  for (const item of report) {
    if (newPrices[item.model]) {
      const bare = item.model.includes('/') ? item.model.split('/')[1] : item.model;
      if (!newPrices['*/' + bare]) {
        newPrices['*/' + bare] = newPrices[item.model];
      }
      const cleaned = cleanModelName(bare);
      if (cleaned && !newPrices['*/' + cleaned]) {
        newPrices['*/' + cleaned] = newPrices[item.model];
      }
      // Explicitly map common model suffix variants
      if (cleaned === 'gemini-3.8-flash') {
        const variants = ['control', 'tiered', 'n'];
        for (const v of variants) {
          const vName = `gemini-3.8-flash-${v}`;
          if (!newPrices['*/' + vName]) newPrices['*/' + vName] = newPrices[item.model];
          if (item.model.includes('/')) {
            const p = item.model.split('/')[0];
            if (!newPrices[`${p}/${vName}`]) newPrices[`${p}/${vName}`] = newPrices[item.model];
          }
        }
      }
    }
  }

  // Universal alias fallback for any observed channel/variant whose cleaned name has a price
  const allKnownModels = getMagpieModels();
  for (const m of allKnownModels) {
    const full = m.fullName;
    const bare = m.id;
    const cleaned = cleanModelName(bare);
    if (!newPrices[full]) {
      const basePrice = newPrices['*/' + cleaned] || newPrices[m.provider + '/' + cleaned];
      if (basePrice) {
        newPrices[full] = basePrice;
        if (!newPrices['*/' + bare]) {
          newPrices['*/' + bare] = basePrice;
        }
      }
    }
  }

  // Remove any unknown/ invalid keys or routing groups
  for (const k of Object.keys(newPrices)) {
    if (
      k.startsWith('unknown/') ||
      k === '*/unknown' ||
      k.includes('/unknown') ||
      k.includes('never-stuck') ||
      k.startsWith('group/') ||
      k.includes('/group/') ||
      k === '*/free'
    ) {
      delete newPrices[k];
    }
  }

  const before = readSettings().modelPrices || {};
  const written = updateModelPrices(() => newPrices);
  const changed = stableStringify(before) !== stableStringify(written);
  return { count: Object.keys(written).length, changed };
}

function applyGlobalMode(mode, customOverrides = {}) {
  return applyGlobalModeIfChanged(mode, customOverrides).count;
}

/**
 * Peak & Off-Peak (分时峰谷) calculation helpers
 */
function getBeijingTime(date = new Date()) {
  const utc = date.getTime() + date.getTimezoneOffset() * 60000;
  return new Date(utc + 3600000 * 8);
}

// Peak hours are magpie's own (internal/catalog/peak.go): a stored price is
// the off-peak one, and a call in a vendor's peak hours costs PeakFactor (2)
// times it. Only a vendor that bills by the hour has them, as
// internal/provider/peak.go decides it by the provider's base URL. A relay or
// a subscription that resells the same model keeps one price all day.
const PEAK_FACTOR = 2;

// The peak windows belong to the model, not to the channel: the machine here
// only has relays and subscriptions, so a channel id never names a vendor.
// A model id that starts with deepseek- is billed by the hour wherever it is
// resold; everything else is flat. Ollama Cloud keeps its own UTC window.
const DEEPSEEK_MODEL_RE = /^deepseek-/;
const PEAK_BILLS = [
  { vendor: 'deepseek', match: DEEPSEEK_MODEL_RE, rule: 'deepseek', name: 'DeepSeek 系峰谷：闲时价 ×2' },
  {
    vendor: 'ollama-cloud',
    ids: ['ollama-cloud'],
    match: DEEPSEEK_MODEL_RE,
    rule: 'ollama',
    name: 'Ollama Cloud 峰谷：闲时价 ×2'
  }
];

// The bare model id a channel lists, lowercased, without a tag or a routing
// prefix: "opencode-zen/deepseek-v4-flash:free" -> "deepseek-v4-flash".
function peakModelKey(modelId = '') {
  const raw = String(modelId || '').toLowerCase().trim();
  if (!raw) return '';
  const last = raw.split('/').pop();
  return last.split(':')[0]
    // 渠道给模型加的前缀（blian_ / huoshan_ / vlm_huoshan_）不属于模型名，
    // 不剥离的话 mclaw/huoshan_deepseek_v4_1_flash 会被判成「非 DeepSeek」。
    .replace(/^(blian_|huoshan_|vlm_huoshan_)/, '')
    .replace(/_/g, '-');
}

// The peak bill a bare model id falls under, or null when it is flat priced.
function peakBillForModel(modelId = '') {
  const key = peakModelKey(modelId);
  if (!key) return null;
  for (const bill of PEAK_BILLS) {
    if (bill.match && bill.match.test(key)) return bill;
  }
  return null;
}

// The bill that applies to this channel's model: a vendor that names its own
// channel (Ollama Cloud's UTC window) wins over the model family's window,
// and without a model id there is nothing to bill by the hour.
function peakBillFor(providerId = '', modelId = '') {
  const p = String(providerId || '').toLowerCase();
  const key = peakModelKey(modelId);
  if (!key) return null;
  for (const bill of PEAK_BILLS) {
    if (!Array.isArray(bill.ids) || !bill.ids.includes(p)) continue;
    if (bill.match && bill.match.test(key)) return bill;
  }
  return peakBillForModel(key);
}

/**
 * Whether magpie bills this provider's model by the hour, and by which hours.
 * Magpie tells a vendor by the provider's base URLs; the plugin only has ids,
 * so a preset/id names it, and every other channel is flat (a subscription, a
 * relay) exactly as magpie prices it.
 */
function peakRuleFor(providerId = '', modelId = '') {
  const bill = peakBillFor(providerId, modelId);
  if (bill) {
    return { supported: true, hourly: true, factor: PEAK_FACTOR, vendor: bill.vendor, rule: bill.rule, name: bill.name };
  }
  return { supported: false, hourly: false, factor: 1, vendor: '', rule: '', name: '' };
}

// Without a model id, a channel that names a vendor still answers with that
// vendor's windows; the model gate only applies once a model is given.
function vendorBillById(providerId = '') {
  const p = String(providerId || '').toLowerCase();
  if (!p) return null;
  for (const bill of PEAK_BILLS) {
    if (Array.isArray(bill.ids) && bill.ids.includes(p)) return bill;
  }
  for (const bill of PEAK_BILLS) {
    if (bill.vendor === p) return bill;
  }
  return null;
}

// Whether a channel resells any deepseek model at all, and under which bill:
// a provider's peak flag is about its models, not about its own id.
function channelPeakBill(providerId = '') {
  const p = String(providerId || '').toLowerCase();
  if (!p) return null;
  try {
    if (!fs.existsSync(PROVIDERS_STATE_PATH)) return null;
    const data = JSON.parse(fs.readFileSync(PROVIDERS_STATE_PATH, 'utf8'));
    const list = data && data.providers && Array.isArray(data.providers.providers) ? data.providers.providers : [];
    const hit = list.find((x) => String((x && x.id) || '').toLowerCase() === p);
    if (!hit || hit.off) return null;
    // Only pay-as-you-go / API-key channels actually get Magpie's hourly peak
    // billing. A plan provider that resells a DeepSeek model is still a flat
    // subscription even though the model page shows its equivalent peak price.
    if (providerKindOf(hit) !== 'api') return null;
    for (const m of Array.isArray(hit.models) ? hit.models : []) {
      const bill = peakBillFor(p, (m && m.id) || '');
      if (bill) return bill;
    }
  } catch {}
  return null;
}

// The old name, for callers that still ask it with (modelName, provider).
function hasOffPeakPreset(modelName = '', provider = '') {
  return peakRuleFor(provider, modelName);
}

// Which window a call made at date falls in, as the vendor bills it. The
// holiday table DeepSeek's own rule needs is magpie's (catalog.cnHoliday); the
// page tells the weekday and weekend windows apart and leaves a holiday as a
// peak weekday.
function checkOffPeakStatus(date = new Date(), rule = 'deepseek') {
  const bj = getBeijingTime(date);
  const day = bj.getDay(); // 0 is Sun, 6 is Sat
  const hour = bj.getHours();
  const min = bj.getMinutes();
  const t = hour + min / 60;

  if (rule === 'night_22_08') {
    const isOff = t >= 22 || t < 8;
    return { isOffPeak: isOff, rule, peakFactor: isOff ? 1 : PEAK_FACTOR, hour, min, day, label: isOff ? '夜间闲时 (22:00-08:00)' : '白天正常' };
  }

  if (rule === 'ollama') {
    // Ollama Cloud: 12:00 to 18:00 UTC on weekdays, all weekend off-peak
    const utcHour = date.getUTCHours();
    const utcDay = date.getUTCDay();
    const isPeak = utcDay !== 0 && utcDay !== 6 && utcHour >= 12 && utcHour < 18;
    return { isOffPeak: !isPeak, rule, peakFactor: isPeak ? PEAK_FACTOR : 1, hour, min, day, label: isPeak ? 'Ollama 高峰 (UTC 12:00-18:00)' : 'Ollama 闲时 (按闲时价)' };
  }

  // Weekends are off-peak all day
  if (day === 0 || day === 6) {
    return { isOffPeak: true, rule, reason: 'weekend', peakFactor: 1, hour, min, day, label: '周末全天闲时（按闲时价）' };
  }

  // Workdays: peak 09:00-12:00 and 14:00-18:00; the rest off-peak
  const isPeak = (t >= 9 && t < 12) || (t >= 14 && t < 18);
  return {
    isOffPeak: !isPeak,
    rule,
    reason: isPeak ? 'workday_peak' : (t >= 12 && t < 14 ? 'lunch_offpeak' : 'night_offpeak'),
    peakFactor: isPeak ? PEAK_FACTOR : 1,
    hour,
    min,
    day,
    label: isPeak ? '工作日高峰（×2 计费）' : '闲时低谷（按闲时价）'
  };
}

/**
 * Compare the prices the page saved with the ones Magpie actually bills from.
 * Every custom key must land in settings.json modelPrices with the same four
 * unit prices; anything else means the price never took effect (the model was
 * missing from the scan, or another writer overwrote it).
 */
function verifyCustomPrices(customOverrides = {}) {
  const prices = readSettings().modelPrices || {};
  const fields = ['input', 'output', 'cache_read', 'cache_write'];
  let matched = 0;
  const mismatches = [];
  for (const [key, value] of Object.entries(customOverrides || {})) {
    if (!value) continue;
    const want = sanitizePrice(value);
    const got = prices[key];
    if (!got) {
      mismatches.push({ key, expected: want, actual: null, reason: 'missing' });
      continue;
    }
    const same = fields.every((f) => Math.abs((Number(got[f]) || 0) - (Number(want[f]) || 0)) < 1e-9);
    if (same) {
      matched += 1;
    } else {
      const actual = {};
      for (const f of fields) actual[f] = Number(got[f]) || 0;
      mismatches.push({ key, expected: want, actual, reason: 'differs' });
    }
  }
  return { checked: matched + mismatches.length, matched, mismatches };
}

// ---- 高峰时段与倍率（Magpie providers.json 的 rateWindows） ----
// Magpie 的 RateWindow：{ days:[0-6, 周日=0], start:"HH:MM", end:"HH:MM"（可 24:00），
// rate: 0 < r <= 1000 }；一个渠道最多 8 个，Start 晚于 End 表示跨零点。
// 这里只负责校验与读写，时段怎么计价仍由 Magpie 自己算（internal/provider/ratewindow.go）。
const RATE_WINDOWS_MAX = 8;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;

// 每个按小时计费渠道的官方时段（北京时间），倍率沿用 Magpie 的 PeakFactor。
function recommendedRateWindows(providerId, modelId = '') {
  const p = String(providerId || '').toLowerCase();
  const bill = peakBillFor(p, modelId) || (peakModelKey(modelId) ? null : (vendorBillById(p) || channelPeakBill(p)));
  if (!bill) return [];
  const weekdays = [1, 2, 3, 4, 5];
  if (bill.rule === 'ollama') {
    return [
      { days: weekdays, start: '20:00', end: '24:00', rate: PEAK_FACTOR },
      { days: weekdays, start: '00:00', end: '02:00', rate: PEAK_FACTOR }
    ];
  }
  return [
    { days: weekdays, start: '09:00', end: '12:00', rate: PEAK_FACTOR },
    { days: weekdays, start: '14:00', end: '18:00', rate: PEAK_FACTOR }
  ];
}

function normalizeRateWindows(windows) {
  const list = Array.isArray(windows) ? windows : [];
  if (list.length > RATE_WINDOWS_MAX) return { ok: false, error: 'at most ' + RATE_WINDOWS_MAX + ' windows' };
  const out = [];
  for (const w of list) {
    if (!w || typeof w !== 'object') return { ok: false, error: 'window must be an object' };
    const start = String(w.start || '');
    const end = String(w.end || '');
    if (!HHMM_RE.test(start) || !HHMM_RE.test(end)) return { ok: false, error: 'bad time: ' + start + '-' + end };
    const rate = Number(w.rate);
    if (!isFinite(rate) || rate <= 0 || rate > 1000) return { ok: false, error: 'rate out of range: ' + w.rate };
    if (Math.abs(rate * 1000 - Math.round(rate * 1000)) > 1e-9) return { ok: false, error: 'rate has more than 3 decimals' };
    let days = Array.isArray(w.days) ? w.days.map((x) => Number(x)) : [];
    days = days.filter((x) => Number.isInteger(x) && x >= 0 && x <= 6);
    days = Array.from(new Set(days)).sort((a, b) => a - b);
    const item = { start: start, end: end, rate: Math.round(rate * 1000) / 1000 };
    if (days.length) item.days = days;
    out.push(item);
  }
  return { ok: true, windows: out };
}

function readProvidersConfig() {
  if (!fs.existsSync(PROVIDERS_CONFIG_PATH)) return null;
  return JSON.parse(fs.readFileSync(PROVIDERS_CONFIG_PATH, 'utf8'));
}

// 列出可以设置时段倍率的渠道：已配置的 provider 全都在，按小时计费的带上官方时段建议。
function listRateWindowTargets() {
  const cfg = readProvidersConfig();
  const list = cfg && Array.isArray(cfg.providers) ? cfg.providers : [];
  return {
    providers: list.map((p) => {
      const bill = channelPeakBill(p.id || '');
      return {
        id: p.id || '',
        name: p.name || p.id || '',
        rateWindows: Array.isArray(p.rateWindows) ? p.rateWindows : [],
        recommended: recommendedRateWindows(p.id || ''),
        peak: !!bill,
        peakName: bill ? bill.name : ''
      };
    })
  };
}

// ---- 模型级峰谷设置（插件 options.modelPeaks） ----
// 页面按模型族保存 { enabled, rate, windows }；Magpie 只有渠道级 rateWindows，
// 因此这里把渠道内显式配置的模型汇总：配置一致才写渠道，冲突时报告并保持原样。
function normalizeModelPeakConfig(value) {
  if (typeof value === 'boolean') {
    return { enabled: value, rate: PEAK_FACTOR, windows: [] };
  }
  if (!value || typeof value !== 'object') return null;
  const rate = Number(value.rate);
  if (!isFinite(rate) || rate <= 0 || rate > 1000) return { error: 'rate out of range: ' + value.rate };
  if (Math.abs(rate * 1000 - Math.round(rate * 1000)) > 1e-9) return { error: 'rate has more than 3 decimals' };
  // 页面保存的 window 不带 rate（倍率是模型级），校验时补上再剥离。
  const checked = normalizeRateWindows((value.windows || []).map((w) => ({ ...w, rate })));
  if (!checked.ok) return checked;
  return {
    enabled: value.enabled !== false,
    rate: Math.round(rate * 1000) / 1000,
    windows: checked.windows.map((w) => ({ days: w.days || [], start: w.start, end: w.end }))
  };
}

function normalizeModelPeaks(map) {
  const out = {};
  if (!map || typeof map !== 'object' || Array.isArray(map)) return { ok: true, modelPeaks: out };
  for (const [key, value] of Object.entries(map)) {
    if (!key) continue;
    const cfg = normalizeModelPeakConfig(value);
    if (cfg && cfg.error) return { ok: false, error: key + ': ' + cfg.error };
    if (cfg) out[key] = cfg;
  }
  return { ok: true, modelPeaks: out };
}

function modelPeakKeyFor(modelId = '') {
  return cleanModelName(String(modelId || '').split('/').pop().split(':')[0]);
}

function modelPeakConfigFor(modelPeaks, providerId, modelId) {
  const key = modelPeakKeyFor(modelId);
  if (modelPeaks && Object.prototype.hasOwnProperty.call(modelPeaks, key)) {
    return normalizeModelPeakConfig(modelPeaks[key]);
  }
  const bill = peakBillFor(providerId, modelId);
  if (!bill) return { enabled: false, rate: PEAK_FACTOR, windows: [] };
  return { enabled: true, rate: PEAK_FACTOR, windows: recommendedRateWindows(providerId, modelId) };
}

function modelPeakConfigSignature(cfg) {
  return JSON.stringify({
    enabled: !!cfg.enabled,
    rate: Number(cfg.rate) || PEAK_FACTOR,
    windows: (cfg.windows || []).map((w) => ({
      days: Array.isArray(w.days) ? w.days.slice().sort((a, b) => a - b) : [],
      start: w.start,
      end: w.end
    }))
  });
}

function modelPeakWindowsToRateWindows(cfg) {
  if (!cfg || !cfg.enabled) return [];
  return (cfg.windows || []).map((w) => ({
    days: Array.isArray(w.days) ? w.days.slice() : [],
    start: w.start,
    end: w.end,
    rate: Number(cfg.rate) || PEAK_FACTOR
  }));
}

// providers-state.json 里各渠道实际挂载的模型；providers.json 的 models 常为空。
function readStateModelIds() {
  const out = {};
  try {
    if (!fs.existsSync(PROVIDERS_STATE_PATH)) return out;
    const data = JSON.parse(fs.readFileSync(PROVIDERS_STATE_PATH, 'utf8'));
    const list = data && data.providers && Array.isArray(data.providers.providers) ? data.providers.providers : [];
    for (const p of list) {
      const id = String((p && p.id) || '');
      if (!id) continue;
      out[id] = (Array.isArray(p.models) ? p.models : [])
        .map((m) => (typeof m === 'object' ? (m.id || m.model || '') : String(m || '')))
        .filter(Boolean);
    }
  } catch {}
  return out;
}

// 把 modelPeaks 汇总到 providers.json 的渠道 rateWindows。返回每个渠道的处理结果。
function syncModelPeakWindows(modelPeaks) {
  const checked = normalizeModelPeaks(modelPeaks);
  if (!checked.ok) return { ok: false, error: checked.error, results: [] };
  const cfg = readProvidersConfig();
  const list = cfg && Array.isArray(cfg.providers) ? cfg.providers : null;
  if (!list) return { ok: false, error: 'providers.json not found', results: [] };
  const stateModelIds = readStateModelIds();
  const results = [];
  for (const p of list) {
    const providerId = p.id || '';
    const declared = Array.isArray(p.models) ? p.models : [];
    const stateModels = stateModelIds[providerId] || [];
    const models = declared.length ? declared : stateModels.map((id) => ({ id }));
    if (!providerId || !models.length) continue;
    const configured = [];
    for (const m of models) {
      const modelId = typeof m === 'object' ? (m.id || m.model || '') : String(m || '');
      const key = modelPeakKeyFor(modelId);
      if (!key || !Object.prototype.hasOwnProperty.call(checked.modelPeaks, key)) continue;
      configured.push({ modelId, key, config: checked.modelPeaks[key] });
    }
    if (!configured.length) continue;
    const signature = modelPeakConfigSignature(configured[0].config);
    const conflict = configured.find((x) => modelPeakConfigSignature(x.config) !== signature);
    if (conflict) {
      results.push({
        provider: providerId,
        status: 'conflict',
        models: configured.map((x) => x.key),
        message: 'same provider has different model peak settings: ' + configured.map((x) => x.key).join(', ')
      });
      continue;
    }
    const windows = modelPeakWindowsToRateWindows(configured[0].config);
    const written = setRateWindows(providerId, windows);
    results.push({
      provider: providerId,
      status: written.ok ? (written.written ? 'written' : 'unchanged') : 'error',
      windows,
      affectedModels: models.length,
      error: written.ok ? undefined : written.error
    });
  }
  return { ok: true, results };
}

// 写一个渠道的 rateWindows：原子写 providers.json，内容相同不落盘。
function setRateWindows(id, windows) {
  const target = String(id || '');
  if (!target) return { ok: false, error: 'missing provider id' };
  const checked = normalizeRateWindows(windows);
  if (!checked.ok) return checked;
  const cfg = readProvidersConfig();
  const list = cfg && Array.isArray(cfg.providers) ? cfg.providers : null;
  if (!list) return { ok: false, error: 'providers.json not found' };
  const p = list.find((x) => (x.id || '') === target);
  if (!p) return { ok: false, error: 'unknown provider: ' + target };
  const before = JSON.stringify(p.rateWindows || []);
  const after = JSON.stringify(checked.windows);
  if (before === after) return { ok: true, written: false, windows: checked.windows };
  if (checked.windows.length) p.rateWindows = checked.windows;
  else delete p.rateWindows;
  writeJsonAtomic(PROVIDERS_CONFIG_PATH, cfg);
  return { ok: true, written: true, windows: checked.windows };
}

module.exports = {
  loadCatalog,
  cleanModelName,
  getMagpieModels,
  getPricingStatus,
  getProviderClassifications,
  getUsageData,
  matchModel,
  scanAll,
  applyPrice,
  resetPrice,
  applyGlobalMode,
  applyGlobalModeIfChanged,
  verifyCustomPrices,
  stableStringify,
  sanitizePrice,
  readSettings,
  updateModelPrices,
  readPluginOptions,
  writePluginOptions,
  getBeijingTime,
  checkOffPeakStatus,
  providerKindOf,
  listRateWindowTargets,
  setRateWindows,
  normalizeRateWindows,
  recommendedRateWindows,
  normalizeModelPeaks,
  syncModelPeakWindows,
  modelPeakKeyFor,
  peakRuleFor,
  channelPeakBill,
  vendorBillById,
  hasOffPeakPreset,
  PEAK_FACTOR,
  paths: {
    home: HOME,
    configDir: CONFIG_DIR,
    cacheDir: CACHE_DIR,
    settings: SETTINGS_PATH,
    cacheModels: CACHE_MODELS_PATH,
    providersState: PROVIDERS_STATE_PATH
  }
};
