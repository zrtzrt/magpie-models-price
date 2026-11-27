// check.js - Self-test suite for magpie-models-price
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const matcher = require('./matcher');

console.log('🧪 开始运行自动化单元测试...');

// envAt is the environment a subprocess reads magpie's folders from when the
// test means "this temp folder is the user's home": XDG_CONFIG_HOME and
// XDG_CACHE_HOME have to be cleared, because they take priority over the home
// folder (as they do in magpie's appdir), and a CI runner or a developer with
// XDG set would otherwise have the tests read and write their real config.
function envAt(home) {
  // Loading index.js in a test must not write page/models-data.js into the
  // checkout (the plugin host builds it on the user's machine, not here).
  return { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: '', XDG_CACHE_HOME: '', MAGPIE_MODELS_PRICE_NO_PAGE_DATA: '1' };
}

// 1. 验证 catalog 加载
console.log('1. 测试 models.dev 缓存加载与回退...');
const catalog = matcher.loadCatalog();
assert(Array.isArray(catalog) && catalog.length > 0, 'Catalog 应该成功加载且不为空');
console.log('   ✓ Catalog 加载成功，包含模型条目:', catalog.length);

// 2. 验证 Magpie 活跃模型解析与路由组排除
console.log('2. 测试 Magpie 活跃模型读取与路由组过滤...');
const models = matcher.getMagpieModels();
assert(Array.isArray(models), 'Models 应该返回数组');
assert(!models.some(m => m.id === 'never-stuck' || m.fullName.includes('/never-stuck') || m.id.startsWith('group/')), '路由组(如 never-stuck 等)不应被错误识别为供应商模型');
console.log('   ✓ 活跃模型读取成功，当前包含:', models.length, '个，已成功排除所有路由组与负载均衡端点');

// 3. 验证核心厂商智能匹配算法
console.log('3. 测试智能匹配规则...');
const m1 = matcher.matchModel('workbuddy/deepseek-v4.1-flash', catalog);
assert(m1 !== null && m1.match.provider.includes('deepseek'), 'DeepSeek 应精准匹配到 deepseek 原厂或官方规约');
console.log('   ✓ DeepSeek 匹配成功 ->', m1.match.provider + '/' + m1.match.model);

const m2 = matcher.matchModel('antigravity/claude-opus-4-6-thinking', catalog);
assert(m2 !== null && m2.match.provider === 'anthropic', 'Claude Opus 应精准匹配到 anthropic');
console.log('   ✓ Claude 匹配成功 ->', m2.match.provider + '/' + m2.match.model);

const m3 = matcher.matchModel('antigravity/gemini-3.8-flash-tiered', catalog);
assert(m3 !== null && m3.match.provider === 'google', 'Gemini 应精准匹配到 google');
console.log('   ✓ Gemini 匹配成功 ->', m3.match.provider + '/' + m3.match.model);

// 4. 验证定价状态检测
console.log('4. 测试定价状态检测...');
const statuses = matcher.getPricingStatus([
  { fullName: 'deepseek/deepseek-chat', free: false, listPrice: null },
  { fullName: 'test/free-model', free: true, listPrice: null }
]);
assert(statuses.length === 2, '应该成功返回 2 个模型状态');
console.log('   ✓ 状态检测校验通过');

// 5. 验证峰谷：与 Magpie 的 catalog.Peak 一致（存的是闲时价，高峰 ×2）
console.log('5. 测试峰谷归属与时段计算（按模型族，Magpie: 闲时价 ×2）...');
assert.strictEqual(matcher.PEAK_FACTOR, 2, 'PEAK_FACTOR 应为 2');

assert(matcher.peakRuleFor('deepseek', 'deepseek-v4-pro').supported === true, 'DeepSeek 官方渠道应按小时计费');
// 峰谷判定改成按「模型族」后，中转渠道转售的 DeepSeek 同样分峰谷：
// 官方价目表里分时定价的是模型，不是渠道。中转/订阅渠道转售别的模型（如 GLM）仍然全天同价。
assert(matcher.peakRuleFor('workbuddy', 'deepseek-v4-pro').supported === true, '中转渠道转售的 DeepSeek 系模型应参与峰谷');
assert(matcher.peakRuleFor('workbuddy', 'glm-5.3').supported === false, '中转渠道转售的非 DeepSeek 模型应全天同价');
assert(matcher.peakRuleFor('ollama-cloud', 'deepseek-v4-pro').supported === true, 'Ollama Cloud 的 DeepSeek 应按小时计费');
assert(matcher.peakRuleFor('ollama-cloud', 'glm-5.3').supported === false, 'Ollama Cloud 的 GLM 应全天同价');

// 周六 (2026-11-14 10:00 UTC+8)
const satStatus = matcher.checkOffPeakStatus(new Date('2026-11-14T02:00:00Z'));
assert(satStatus.isOffPeak === true && satStatus.peakFactor === 1, '周末全天应按闲时价');

// 工作日周一 10:30 UTC+8 (高峰)
const monPeakStatus = matcher.checkOffPeakStatus(new Date('2026-11-09T02:30:00Z'));
assert(monPeakStatus.isOffPeak === false && monPeakStatus.peakFactor === 2, '周一上午10:30应为高峰 ×2');

// 工作日周一 13:00 UTC+8 (午休闲时)
const monLunchStatus = matcher.checkOffPeakStatus(new Date('2026-11-09T05:00:00Z'));
assert(monLunchStatus.isOffPeak === true && monLunchStatus.peakFactor === 1, '周一中午13:00应为闲时');

// 工作日周一 21:00 UTC+8 (夜间闲时)
const monNightStatus = matcher.checkOffPeakStatus(new Date('2026-11-09T13:00:00Z'));
assert(monNightStatus.isOffPeak === true && monNightStatus.peakFactor === 1, '周一晚21:00应为闲时');

const clean = matcher.sanitizePrice({ input: 1, output: 2, cache_read: 0.1, cache_write: 0, offpeak: { enabled: true, input: 0.5 } });
assert.deepStrictEqual(Object.keys(clean).sort(), ['cache_read', 'cache_write', 'input', 'output'], 'offpeak 等 Magpie 不认识的字段不应写入');

console.log('   ✓ 峰谷归属与时段校验通过（DeepSeek 系 ×2；其余模型全天同价）');

// 5b. 原子写：只改 modelPrices，其他设置原样保留，且不留临时文件
console.log('5b. 测试 settings.json 原子写与只合并 modelPrices...');
const os = require('os');
const { execFileSync } = require('child_process');
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-price-'));
const cfgDir = path.join(tmpHome, '.config/magpie');
fs.mkdirSync(cfgDir, { recursive: true });
const tmpSettings = path.join(cfgDir, 'settings.json');
fs.writeFileSync(tmpSettings, JSON.stringify({ theme: 'dark', window: { w: 1 }, modelPrices: { 'a/b': { input: 1, output: 2, cache_read: 0, cache_write: 0 } } }, null, 2));
execFileSync(process.execPath, ['-e', `
  const m = require(${JSON.stringify(path.join(__dirname, 'matcher.js'))});
  m.applyPrice('c/d', '3,4,0.3,0');
  m.resetPrice('a/b');
`], { env: envAt(tmpHome), stdio: 'pipe' });
const afterWrite = JSON.parse(fs.readFileSync(tmpSettings, 'utf8'));
assert.strictEqual(afterWrite.theme, 'dark', '原子写不应改动 theme 等其他设置');
assert.deepStrictEqual(afterWrite.window, { w: 1 }, '原子写不应改动 window 等其他设置');
assert.strictEqual(afterWrite.modelPrices['a/b'], undefined, 'resetPrice 应删除该条价格');
assert.deepStrictEqual(afterWrite.modelPrices['c/d'], { input: 3, output: 4, cache_read: 0.3, cache_write: 0 });
assert.strictEqual(fs.readdirSync(cfgDir).filter((f) => f.endsWith('.tmp')).length, 0, '不应留下临时文件');
console.log('   ✓ 原子写校验通过（其他设置保留、无临时文件残留）');

// 5c. 插件选项：server 从 plugins.json 读页面写的 mode（不是 input.magpie.options）
console.log('5c. 测试 plugins.json 插件选项读取与写入...');
const tmpHome2 = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-opts-'));
const cfgDir2 = path.join(tmpHome2, '.config/magpie');
fs.mkdirSync(cfgDir2, { recursive: true });
const tmpPlugins = path.join(cfgDir2, 'plugins.json');
fs.writeFileSync(tmpPlugins, JSON.stringify({ plugins: [
  { spec: '/somewhere/magpie-models-price', off: true, options: { mode: 'local-mode' } },
  { spec: 'magpie-models-price@latest', options: { mode: 'api-only', customPrices: { '*/x': { input: 1, output: 2, cache_read: 0, cache_write: 0 } } } }
] }, null, 2));
const optsOut = execFileSync(process.execPath, ['-e', `
  const m = require(${JSON.stringify(path.join(__dirname, 'matcher.js'))});
  m.writePluginOptions({ mode: 'all-equivalent' }, 'magpie-models-price@latest');
  console.log(JSON.stringify(m.readPluginOptions('magpie-models-price@latest')));
`], { env: envAt(tmpHome2), encoding: 'utf8' });
const optsAfter = JSON.parse(optsOut.trim());
assert.strictEqual(optsAfter.mode, 'all-equivalent', '写入的 mode 应被读回');
assert.strictEqual(optsAfter.customPrices['*/x'].input, 1, '写入不应丢掉其他选项');
const pjAfter = JSON.parse(fs.readFileSync(tmpPlugins, 'utf8'));
assert.strictEqual(pjAfter.plugins[0].options.mode, 'local-mode', '另一个插件的选项不应被改动');
assert.strictEqual(pjAfter.plugins[1].options.mode, 'all-equivalent');
assert.strictEqual(fs.readdirSync(cfgDir2).filter((f) => f.endsWith('.tmp')).length, 0, '不应留下临时文件');
console.log('   ✓ 插件选项读取/写入校验通过（按 spec 精确匹配、保留其他键）');



// 6. 验证模型按标识分组与多渠道聚合
console.log('6. 测试模型按标识聚合 (Grouping by bareModel)...');
const sampleModels = [
  { model: 'antigravity/gemini-3.8-flash', provider: 'antigravity', providerName: 'Antigravity' },
  { model: 'ai-studio/gemini-3.8-flash', provider: 'ai-studio', providerName: 'Google AI Studio' },
  { model: 'gemini/gemini-3.8-flash', provider: 'gemini', providerName: 'Gemini CLI' },
  { model: 'trae-cn/claude-3-5-sonnet', provider: 'trae-cn', providerName: 'Trae CN' }
];

function getBareModel(fullName) {
  return fullName.includes('/') ? fullName.split('/').slice(1).join('/') : fullName;
}

function buildModelGroups(list) {
  const map = new Map();
  for (const item of list) {
    const bare = getBareModel(item.model);
    if (!map.has(bare)) map.set(bare, { bare, items: [] });
    map.get(bare).items.push(item);
  }
  return Array.from(map.values());
}

const groups = buildModelGroups(sampleModels);
assert.strictEqual(groups.length, 2, '应聚合为 2 款唯一模型');
const geminiGroup = groups.find(g => g.bare === 'gemini-3.8-flash');
assert(geminiGroup && geminiGroup.items.length === 3, 'gemini-3.8-flash 应包含 3 个供应商渠道');
console.log('   ✓ 模型按标识分组聚合校验通过 (151 款唯一模型聚合 187 渠道)');

// 7. 插件加载不写任何文件；只应用页面保存过的那一次（applyToken 门控）
console.log('7. 测试保存门控：载入不写盘、一次保存只应用一次...');
{
  const os = require('os');
  const { execFileSync } = require('child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-models-price-home-'));
  const settingsDir = path.join(home, '.config/magpie');
  const cacheDir = path.join(home, '.cache/magpie');
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  const settingsFile = path.join(settingsDir, 'settings.json');
  const providersFile = path.join(settingsDir, 'providers.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ theme: 'dark' }, null, 2));
  // A pay-as-you-go DeepSeek channel with no rateWindows: what the old first-run
  // default would have written to on its own.
  fs.writeFileSync(providersFile, JSON.stringify({ providers: [
    { id: 'opencode-zen-2', name: 'OpenCode Zen 2', models: [{ id: 'deepseek-v4.1-flash' }] }
  ] }, null, 2));
  fs.writeFileSync(path.join(cacheDir, 'providers-state.json'), JSON.stringify({ version: 1, providers: { providers: [
    { id: 'opencode-zen-2', name: 'OpenCode Zen 2', billingKind: 'payg', key: { set: true }, models: [{ id: 'deepseek-v4.1-flash' }] }
  ] } }, null, 2));
  const custom = { '*/model-a': { input: 1, output: 2, cache_read: 0, cache_write: 0 } };
  const script = `
    const fs = require('fs');
    const plugin = require(${JSON.stringify(path.join(__dirname, 'index.js'))});
    const settings = ${JSON.stringify(settingsFile)};
    const providers = ${JSON.stringify(providersFile)};
    const custom = ${JSON.stringify(custom)};
    const read = (f) => fs.readFileSync(f, 'utf8');
    const mtime = (f) => fs.statSync(f).mtimeMs;
    (async () => {
      const before = { s: read(settings), p: read(providers) };
      // 1. Loading with no options at all: a fresh install writes nothing.
      await plugin({ magpie: { options: async () => null } }, {});
      const plain = { s: read(settings), p: read(providers) };
      // 2. Options with a mode but no token (an older version's, or one edited by
      //    hand): still nothing, because the user made no save here.
      await plugin({}, { mode: 'api-only', customPrices: custom });
      const noToken = { s: read(settings), p: read(providers) };
      // 3. A save from the page: applied once, at the reload it caused.
      await plugin({}, { mode: 'api-only', customPrices: custom, applyToken: 'save-1' });
      const first = read(settings);
      const firstMtime = mtime(settings);
      // 4. Another reload with the same token (magpie starting, a plugin
      //    toggled): nothing is written again.
      await plugin({}, { mode: 'api-only', customPrices: custom, applyToken: 'save-1' });
      const sameMtime = mtime(settings) === firstMtime;
      // 5. A second save with a changed price writes again. (Changing only the
      //    display mode must not rewrite the price table.)
      await plugin({}, { mode: 'all-equivalent', customPrices: { '*/model-a': { input: 3, output: 4, cache_read: 0, cache_write: 0 } }, applyToken: 'save-2' });
      const secondMtime = mtime(settings) > firstMtime;
      process.stdout.write(JSON.stringify({
        untouchedOnLoad: plain.s === before.s && plain.p === before.p,
        untouchedWithoutToken: noToken.s === before.s && noToken.p === before.p,
        wrote: first.includes('*/model-a'),
        peakUntouched: read(providers) === before.p,
        sameMtime,
        secondMtime
      }));
      process.exit(0);
    })().catch((e) => { console.error(e); process.exit(1); });
  `;
  const out = JSON.parse(execFileSync(process.execPath, ['-e', script], { env: envAt(home) }).toString().trim().split('\n').pop());
  assert(out.untouchedOnLoad, '插件载入本身不应写 settings.json 或 providers.json');
  assert(out.untouchedWithoutToken, '没有 applyToken 的选项（旧版遗留/手改）不应触发写盘');
  assert(out.wrote, '页面保存后应把价格写进 settings.json');
  assert(out.peakUntouched, '未经用户设置的渠道峰谷时段不应被自动写入 providers.json');
  assert(out.sameMtime, '同一个 applyToken 只应应用一次，重载不应重复写盘');
  assert(out.secondMtime, '新的 applyToken 应再次应用');
  fs.rmSync(home, { recursive: true, force: true });
  console.log('   ✓ 载入零写盘、保存只应用一次、未设置项不被改写');
}

// 7b. 页面保存只写用户改动的键：settings.json 里用户自己设置的价格不能被覆盖，
// 页面没动过的 provider 不能被添加 (PR #1576 review)。
console.log('7b. 测试保存只应用页面改动的价格...');
{
  const os = require('os');
  const { execFileSync } = require('child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-models-price-home-'));
  const settingsDir = path.join(home, '.config/magpie');
  const cacheDir = path.join(home, '.cache/magpie');
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  const settingsFile = path.join(settingsDir, 'settings.json');
  const userPrice = { input: 0.5, output: 4, cache_read: 0.05, cache_write: 0 };
  fs.writeFileSync(settingsFile, JSON.stringify({ theme: 'dark', modelPrices: { 'openai/gpt-5': userPrice } }, null, 2));
  // No providers.json on purpose: a price-only save must still record its token.
  const script = `
    const fs = require('fs');
    const plugin = require(${JSON.stringify(path.join(__dirname, 'index.js'))});
    const settings = ${JSON.stringify(settingsFile)};
    const read = (f) => fs.readFileSync(f, 'utf8');
    const mtime = (f) => fs.statSync(f).mtimeMs;
    const save = { mode: 'all-equivalent', customPrices: { 'openai/gpt-5-mini': { input: 1.25, output: 10, cache_read: 0.125, cache_write: 0 } }, applyToken: 'save-review-1' };
    (async () => {
      await plugin({}, save);
      const after = JSON.parse(read(settings));
      const firstMtime = mtime(settings);
      await plugin({}, save);
      process.stdout.write(JSON.stringify({
        prices: after.modelPrices,
        sameMtime: mtime(settings) === firstMtime
      }));
      process.exit(0);
    })().catch((e) => { console.error(e); process.exit(1); });
  `;
  const out = JSON.parse(execFileSync(process.execPath, ['-e', script], { env: envAt(home) }).toString().trim().split('\n').pop());
  assert.deepStrictEqual(out.prices['openai/gpt-5'], userPrice, '用户自己在 settings.json 设的价格不能被页面保存覆盖');
  assert.deepStrictEqual(out.prices['openai/gpt-5-mini'], { input: 1.25, output: 10, cache_read: 0.125, cache_write: 0 }, '页面改动的价格应写入');
  assert.deepStrictEqual(Object.keys(out.prices).sort(), ['openai/gpt-5', 'openai/gpt-5-mini'], '不得添加用户没有的 provider 或模型键');
  assert.ok(out.sameMtime, '没有 providers.json 时价格保存也要记录 applyToken，重载不能再次应用');
  fs.rmSync(home, { recursive: true, force: true });
  console.log('   ✓ 用户价格不被覆盖、无 provider 不添加、无 providers.json 也只应用一次');
}

// 8. 页面模型级峰谷（从 page/app.js 里切出真实代码执行，避免复制一份逻辑）
console.log('8. 测试模型级峰谷状态与倍率...');
{
  const vm = require('vm');
  const code = fs.readFileSync(path.join(__dirname, 'page/app.js'), 'utf8');
  const start = code.indexOf('const PEAK_BILLS = [');
  const end = code.indexOf('function mergeLiveProviders(');
  assert(start > 0 && end > start, 'page/app.js 里应能找到峰谷模型族判定代码块');
  const block = code.slice(start, end);
  const prefix = [
    'const DEFAULT_PEAK_RATE = 2;',
    'let modelPeaks = {};',
    'function getBareModel(fullName){ return fullName && fullName.includes("/") ? fullName.split("/").slice(1).join("/") : (fullName || ""); }',
    'function $(id){ return null; }',
    'function t(k, f){ return f || k; }',
    ''
  ].join('\n');
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(
    prefix + '\n' + block + '\nthis.__api = { peakTargetKeyFor, peakApplies, peakFamilyOf, peakRateFor, peakConfigFor, setFamily: (k, v) => setPeakFamilyEnabled(k, v) };',
    ctx
  );
  const api = ctx.__api;
  const deepseekItem = { provider: 'deepseek', id: 'deepseek-v4-pro', model: 'deepseek/deepseek-v4-pro' };
  const relayDsItem = { provider: 'workbuddy', id: 'deepseek-v4-pro', model: 'workbuddy/deepseek-v4-pro' };
  const relayGlmItem = { provider: 'workbuddy', id: 'glm-5.3', model: 'workbuddy/glm-5.3' };
  const taggedItem = { provider: 'ollama-cloud', id: 'deepseek-v4-pro:cloud', model: 'ollama-cloud/deepseek-v4-pro:cloud' };

  // 默认应用：官方分时价的 DeepSeek 系模型默认开启；其他模型默认关闭但可以单独开启。
  assert.strictEqual(api.peakApplies(deepseekItem), true, 'DeepSeek 官方渠道的 DeepSeek 模型参与峰谷');
  assert.strictEqual(api.peakApplies(relayDsItem), true, '中转渠道转售的 DeepSeek 模型同样参与峰谷');
  assert.strictEqual(api.peakApplies(taggedItem), true, '带 :tag 的 DeepSeek 变体也能识别');
  assert.strictEqual(api.peakTargetKeyFor(relayDsItem), 'deepseek-v4-pro', '峰谷目标 key 是模型族裸名');
  assert.strictEqual(api.peakTargetKeyFor(relayGlmItem), 'glm-5.3', '非 DeepSeek 模型也有模型级 key');
  assert.strictEqual(api.peakApplies(relayGlmItem), false, '非 DeepSeek 模型默认不参与峰谷');
  assert.strictEqual(api.peakRateFor(relayDsItem), 2, 'DeepSeek 默认倍率为 2');
  assert.strictEqual(api.peakConfigFor(relayDsItem).windows.length, 2, 'DeepSeek 默认带两个工作日时段');

  // 每个模型可以单独开关、单独倍率
  api.setFamily('deepseek-v4-pro', false);
  assert.strictEqual(api.peakApplies(deepseekItem), false, '单独关闭该模型后不参与峰谷');
  api.setFamily('deepseek-v4-pro', true);
  assert.strictEqual(api.peakApplies(deepseekItem), true, '重新打开后恢复参与峰谷');
  api.setFamily('glm-5.3', true);
  assert.strictEqual(api.peakApplies(relayGlmItem), true, '非 DeepSeek 模型也可单独开启峰谷');
  api.setFamily('glm-5.3', false);
  assert.strictEqual(api.peakApplies(relayGlmItem), false, '关闭后恢复全天同价');
  console.log('   ✓ 模型级峰谷开关、默认时段与倍率通过');
}

console.log('8b. 测试高峰时段倍率（Magpie rateWindows）校验与推荐...');
{
  const m = require('./matcher');
  const rec = m.recommendedRateWindows('deepseek');
  assert.strictEqual(rec.length, 2, 'DeepSeek 官方应有 2 个推荐时段');
  assert.deepStrictEqual(rec[0].days, [1, 2, 3, 4, 5], '推荐时段应只覆盖工作日');
  assert.strictEqual(rec[0].rate, 2, '推荐倍率应为 Magpie 的 PeakFactor');
  const ollama = m.recommendedRateWindows('ollama-cloud');
  assert.strictEqual(ollama.length, 2, 'Ollama Cloud 应有 2 个推荐时段');
  assert.strictEqual(ollama[0].end, '24:00', 'Ollama Cloud 晚高峰应到 24:00');
  assert.deepStrictEqual(m.recommendedRateWindows('workbuddy', 'glm-5.3'), [], '非 DeepSeek 模型没有推荐时段');
  assert.strictEqual(m.recommendedRateWindows('workbuddy', 'deepseek-v4-pro').length, 2, '中转渠道的 DeepSeek 也有推荐时段');
  const ok = m.normalizeRateWindows([{ start: '09:00', end: '12:00', rate: 2, days: [1, 2, 2, 9] }]);
  assert.strictEqual(ok.ok, true, '合法窗口应通过');
  assert.deepStrictEqual(ok.windows[0].days, [1, 2], '星期应去重并丢弃非法值');
  assert.strictEqual(m.normalizeRateWindows([{ start: '9:00', end: '12:00', rate: 2 }]).ok, false, '时间必须 HH:MM');
  assert.strictEqual(m.normalizeRateWindows([{ start: '09:00', end: '12:00', rate: 0 }]).ok, false, '倍率必须大于 0');
  assert.strictEqual(m.normalizeRateWindows(Array.from({ length: 9 }, () => ({ start: '09:00', end: '10:00', rate: 2 }))).ok, false, '最多 8 个窗口');
  assert.strictEqual(m.setRateWindows('__no_such_provider__', []).ok, false, '未知渠道应拒绝写入');
  const mp = m.normalizeModelPeaks({
    'deepseek-v4-pro': { enabled: true, rate: 3, windows: [{ days: [1, 2, 2, 9], start: '09:00', end: '12:00' }] }
  });
  assert.strictEqual(mp.ok, true, '模型峰谷配置应通过');
  assert.strictEqual(mp.modelPeaks['deepseek-v4-pro'].rate, 3, '模型倍率应保留');
  assert.deepStrictEqual(mp.modelPeaks['deepseek-v4-pro'].windows[0].days, [1, 2], '模型时段星期应去重并丢弃非法值');
  assert.strictEqual(m.normalizeModelPeaks({ bad: { enabled: true, rate: 0, windows: [] } }).ok, false, '模型倍率必须大于 0');
  assert.strictEqual(m.normalizeModelPeaks({ bad: { enabled: true, rate: 2, windows: [{ start: '9:00', end: '10:00' }] } }).ok, false, '模型时段必须 HH:MM');
  console.log('   ✓ rateWindows/模型峰谷推荐、校验与未知渠道拒绝均通过');
}

console.log('9. 测试页面插件 CSP 规范（magpie 页面沙盒）...');
{
  // magpie 把插件页放进 sandbox="allow-scripts" 的框架，CSP 里 connect-src 是 'none'，
  // 并且只给宿主自己内联/哈希过的脚本放行。这两条违反后的表现都是「页面白屏 / 功能静默失效」，
  // 很难从现象反推，所以直接断言源码。
  const pageDir = path.join(__dirname, 'page');
  const html = fs.readFileSync(path.join(pageDir, 'index.html'), 'utf8');

  const inline = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((m) => !/\bsrc\s*=/i.test(m[1]) && m[2].trim());
  assert.strictEqual(inline.length, 0, 'index.html 不允许内联 <script>：CSP 只放行宿主自己哈希的脚本');

  assert.ok(/<script src="theme-boot\.js"><\/script>/.test(html), 'index.html 必须引用 theme-boot.js');
  assert.ok(
    html.indexOf('theme-boot.js') < html.indexOf('style.css'),
    'theme-boot.js 必须在样式表之前，否则首帧还是会闪一下'
  );
  const boot = fs.readFileSync(path.join(pageDir, 'theme-boot.js'), 'utf8');
  assert.ok(/dataset\.theme/.test(boot), 'theme-boot.js 负责先设好 data-theme');

  const app = fs.readFileSync(path.join(pageDir, 'app.js'), 'utf8');
  // The page cannot reach any program of its own: its CSP is connect-src 'none',
  // so a fetch is blocked before it leaves the frame and only leaves a
  // "Refused to connect" line in the console. Every read goes through the host
  // bridge, and a save goes back through it too. There is nothing to probe.
  const fetches = [...app.matchAll(/\bfetch\s*\(/g)];
  assert.strictEqual(
    fetches.length,
    0,
    'app.js 不能有 fetch：插件页 CSP 是 connect-src \'none\'，只能走 magpie.read'
  );
  assert.ok(
    /magpie\.read\("usage:day"/.test(app),
    'app.js 必须通过 magpie.read("usage:day") 读全量用量'
  );
  assert.ok(
    /magpie\.options\.set\(/.test(app),
    'app.js 必须通过 magpie.options.set() 保存，页面自己写不了文件'
  );
  assert.ok(
    /applyToken/.test(app),
    'app.js 保存时必须带 applyToken：插件只应用一次，别的重载不重复写盘'
  );
  const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  assert.ok(
    /function refusal\(req\)/.test(server) && /if \(denied\)/.test(server),
    'server.js 必须在路由之前拒绝 Host/Origin/Content-Type 不合规的请求'
  );
  assert.ok(
    !/Access-Control-Allow-Origin': '\*'|Access-Control-Allow-Origin": "\*/.test(server),
    'server.js 不能回放通配 CORS 头'
  );

  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  const page = (manifest.magpie || {}).page || {};
  assert.ok(page.file && fs.existsSync(path.join(__dirname, page.file)), 'magpie.page.file 必须存在');
  assert.ok(page.icon, 'magpie.page.icon 必须给出，否则插件行没有图标');
  assert.ok(page.titles && page.titles.zh, 'magpie.page.titles.zh 是中文标签');
  console.log('   ✓ 无内联脚本、主题脚本外置、fetch 已门控、清单字段齐全');
}

// 10. 自定义价必须整份落进 settings.json，并能被自检函数核对到
console.log('10. 测试自定义价全量落盘与保存后自检...');
{
  const os = require('os');
  const { execFileSync } = require('child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-models-price-verify-'));
  const settingsDir = path.join(home, '.config/magpie');
  fs.mkdirSync(settingsDir, { recursive: true });
  const settingsFile = path.join(settingsDir, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ theme: 'dark' }, null, 2));
  // 一个通配符键 + 一个当前扫描不到模型的精确键：两者都必须进 settings.json，
  // 否则用户填的价会静默丢失，页面上却显示已保存。
  const custom = {
    '*/half-price-model': { input: 1, output: 2, cache_read: 0.1, cache_write: 0 },
    'ghost-provider/ghost-model': { input: 3, output: 4, cache_read: 0, cache_write: 0 }
  };
  const script = `
    const fs = require('fs');
    const matcher = require(${JSON.stringify(path.join(__dirname, 'matcher.js'))});
    const file = ${JSON.stringify(settingsFile)};
    const custom = ${JSON.stringify(custom)};
    matcher.applyGlobalModeIfChanged('all-equivalent', custom);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')).modelPrices || {};
    const ghost = saved['ghost-provider/ghost-model'] || null;
    const wildcard = saved['*/half-price-model'] || null;
    const report = matcher.verifyCustomPrices(custom);
    // 故意改坏一个键，自检必须报出来，而不是一律回「已生效」
    saved['*/half-price-model'] = { input: 0.5, output: 2, cache_read: 0.1, cache_write: 0 };
    fs.writeFileSync(file, JSON.stringify({ theme: 'dark', modelPrices: saved }, null, 2));
    const badReport = matcher.verifyCustomPrices(custom);
    process.stdout.write(JSON.stringify({
      ghost,
      wildcard,
      reportMatched: report.matched,
      reportChecked: report.checked,
      badMatched: badReport.matched,
      badKeys: (badReport.mismatches || []).map((m) => m.key)
    }));
  `;
  const out = JSON.parse(execFileSync(process.execPath, ['-e', script], { env: envAt(home) }).toString().trim());
  assert.deepStrictEqual(out.ghost, { input: 3, output: 4, cache_read: 0, cache_write: 0 }, '扫描不到的精确自定义键也必须落盘');
  assert.deepStrictEqual(out.wildcard, { input: 1, output: 2, cache_read: 0.1, cache_write: 0 }, '通配符自定义键照旧落盘');
  assert.strictEqual(out.reportChecked, 2, '自检应核对全部自定义键');
  assert.strictEqual(out.reportMatched, 2, '刚写入的价格应全部核对一致');
  assert.strictEqual(out.badMatched, 1, '被改坏的价格不应再算作一致');
  assert.deepStrictEqual(out.badKeys, ['*/half-price-model'], '自检应点出被改坏的键');
  fs.rmSync(home, { recursive: true, force: true });
  console.log('   ✓ 自定义价全量落盘、自检能识别不一致');
}

// 11. 弹窗必须明说「填的是峰价还是谷价」，峰谷卡片必须说明渠道是否真的参与
console.log('11. 测试价格口径提醒与峰谷覆盖提示...');
{
  const pageDir = path.join(__dirname, 'page');
  const html = fs.readFileSync(path.join(pageDir, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(pageDir, 'app.js'), 'utf8');
  const i18n = fs.readFileSync(path.join(pageDir, 'i18n.js'), 'utf8');
  const css = fs.readFileSync(path.join(pageDir, 'style.css'), 'utf8');

  assert.ok(/id="price-mode-banner"/.test(html), '弹窗顶部必须有口径横幅：填错谷价/峰价不会报错，只能靠提示');
  assert.ok(/id="input-cost-mode"/.test(html) && /id="output-cost-mode"/.test(html), '单价标签后必须有峰/谷角标');
  assert.ok(!/id="rate-card"/.test(html), '首页不应再有高峰时段卡片');
  assert.ok(/id="peak-model-toggle"/.test(html) && /id="peak-rate"/.test(html), '每个模型的定价弹窗必须有峰谷开关与倍率输入');
  assert.ok(/id="model-peak-windows"/.test(html), '每模型弹窗必须有时段列表容器');
  assert.ok(/function renderPriceModeBanner\(/.test(app), '必须有 renderPriceModeBanner()');
  assert.ok(/function renderEditingPeakWindows\(/.test(app), '必须有 renderEditingPeakWindows()');
  assert.ok(/\.price-mode-banner\[data-mode="peak"\]/.test(css), '峰价口径必须有独立的视觉区分');

  for (const key of [
    'price_mode_banner_offpeak',
    'price_mode_banner_peak',
    'price_mode_banner_flat',
    'price_mode_tag_offpeak',
    'price_mode_tag_peak',
    'price_mode_tag_flat',
    'toast_rate_saved_peak',
    'peak_coverage_none',
    'peak_coverage_has',
    'peak_editor_title',
    'peak_rate_label',
    'peak_windows_label',
    'peak_scope_note',
    'peak_badge_live_model',
    'peak_badge_live_multi',
    'peak_window_delete',
    'rate_max',
    'toast_price_verified',
    'toast_price_unverified'
  ]) {
    const hits = (i18n.match(new RegExp(key, 'g')) || []).length;
    assert.strictEqual(hits, 4, key + ' 必须在四种语言里都给出');
  }

  // 输入高峰价保存时，提示里必须同时给出落盘的闲时价，否则用户无从核对
  assert.ok(/toast_rate_saved_peak/.test(app), '高峰价保存后的提示必须说明已换算');
  console.log('   ✓ 口径横幅、角标、覆盖提示与四语言文案齐备');
}

// 12. 模型后缀智能归类、用量累加与排序语义
console.log('12. 测试模型后缀归类、用量累加与排序...');
{
  const vm = require('vm');
  const code = fs.readFileSync(path.join(__dirname, 'page/app.js'), 'utf8');
  const start = code.indexOf('function getBareModel(');
  const end = code.indexOf('function getProviderIconHtml(');
  assert(start > 0 && end > start, 'page/app.js 里应能找到分组与排序代码块');
  const block = code.slice(start, end);
  const prefix = [
    'const liveProviderNames = new Map();',
    'let customPrices = {};',
    'const DEFAULT_PEAK_RATE = 2;',
    'let modelPeaks = {};',
    'let peakInputMode = "offpeak";',
    'let globalMode = "all-equivalent";',
    'function $(id){ return null; }',
    'function t(k, f){ return f || k; }',
    'function showToast(){}',
    'function getModelPrice(item){',
    '  const c = customPrices[item.model];',
    '  if (c) return { type: "custom", input: c.input, output: c.output, cache_read: c.cache_read, cache_write: c.cache_write, hasPeak: false, baseInput: c.input };',
    '  if (item.matched && item.matched.cost) return { type: "matched", input: item.matched.cost.input, output: item.matched.cost.output, cache_read: 0, cache_write: 0, hasPeak: false, baseInput: item.matched.cost.input };',
    '  return null;',
    '}',
    ''
  ].join('\n');
  const ctx = { console, window: {} };
  vm.createContext(ctx);
  vm.runInContext(
    prefix + '\n' + block + '\nthis.__api = { buildModelGroups, sortGroups, cleanModelName, getBareModel, stripVariantSuffix, emptyUsage };',
    ctx
  );
  const api = ctx.__api;

  // 12a. 同一渠道里的变体后缀要归到同一族
  const items = [
    { provider: 'trae-cn', model: 'trae-cn/deepseek-v4-flash', name: 'DeepSeek V4 Flash', matched: { cost: { input: 0.15, output: 0.6 } }, enabled: true },
    { provider: 'trae-cn', model: 'trae-cn/deepseek-v4-flash-max', name: 'DeepSeek V4 Flash Max', matched: { cost: { input: 0.15, output: 0.6 } }, enabled: true },
    { provider: 'trae-cn', model: 'trae-cn/deepseek-v4-flash-official', name: 'DeepSeek V4 Flash Official', matched: { cost: { input: 0.15, output: 0.6 } }, enabled: true },
    { provider: 'trae-cn', model: 'trae-cn/deepseek-v4-flash-official-max', name: 'DeepSeek V4 Flash Official Max', matched: { cost: { input: 0.15, output: 0.6 } }, enabled: true },
    { provider: 'trae-cn', model: 'trae-cn/deepseek-v4-flash-261017-antidowngrade', name: 'antidowngrade', matched: { cost: { input: 0.15, output: 0.6 } }, enabled: true }
  ];
  const groups = api.buildModelGroups(items);
  assert.strictEqual(groups.length, 1, '同一渠道的 -max/-official/日期快照变体必须归到同一族，实际 ' + groups.length + ' 组');
  assert.strictEqual(groups[0].items.length, 5, '归族后该组应包含全部 5 个变体');

  // 12b. 正式模型名不能被误并（qwen4-max 是独立模型，不是 qwen4 的变体）
  const formal = [
    { provider: 'trae-cn', model: 'trae-cn/qwen4', name: 'Qwen4', matched: { cost: { input: 1, output: 2 } }, enabled: true },
    { provider: 'trae-cn', model: 'trae-cn/qwen4-max', name: 'Qwen4 Max', matched: { cost: { input: 3, output: 6 } }, enabled: true }
  ];
  const formalGroups = api.buildModelGroups(formal);
  assert.strictEqual(formalGroups.length, 2, 'qwen4 与 qwen4-max 是两份不同价目，不能被归成一组');

  // 12c. 用量必须按同族所有变体累加，不能只取一个键
  const usageItems = [
    { provider: 'trae-cn', model: 'trae-cn/deepseek-v4-flash', name: 'a', matched: { cost: { input: 1, output: 1 } }, enabled: true },
    { provider: 'trae-cn', model: 'trae-cn/deepseek-v4-flash-max', name: 'b', matched: { cost: { input: 1, output: 1 } }, enabled: true }
  ];
  const usageCtx = { console, window: { __MAGPIE_BARE_USAGE__: {
    'deepseek-v4-flash': { requests: 10, totalTokens: 1000, inputTokens: 600, outputTokens: 400, cacheRead: 0, cacheWrite: 0 },
    'deepseek-v4-flash-max': { requests: 5, totalTokens: 500, inputTokens: 300, outputTokens: 200, cacheRead: 0, cacheWrite: 0 }
  } } };
  vm.createContext(usageCtx);
  vm.runInContext(prefix + '\n' + block + '\nthis.__api = { buildModelGroups };', usageCtx);
  const usageGroups = usageCtx.__api.buildModelGroups(usageItems);
  assert.strictEqual(usageGroups.length, 1, '两个变体应归为一组');
  assert.strictEqual(usageGroups[0].usage.requests, 15, '组用量应为两个变体之和（10+5），实际 ' + usageGroups[0].usage.requests);
  assert.strictEqual(usageGroups[0].usage.totalTokens, 1500, '组 Token 应为两个变体之和（1000+500）');

  // 12c-2. 原始名和 cleanModelName 别名指向同一批调用时，组用量只能算一次
  const aliasItems = [
    { provider: 'trae-cn', model: 'trae-cn/deepseek-v4.1-flash-max', name: 'Alias', matched: { cost: { input: 1, output: 1 } }, enabled: true }
  ];
  const aliasCtx = { console, window: { __MAGPIE_BARE_USAGE__: {
    'deepseek-v4.1-flash-max': { requests: 4, totalTokens: 400, inputTokens: 300, outputTokens: 100, cacheRead: 0, cacheWrite: 0 },
    // matcher 旧实现会同时写这个别名键；页面不能把它和原始键相加
    'deepseek-v4-flash-max': { requests: 4, totalTokens: 400, inputTokens: 300, outputTokens: 100, cacheRead: 0, cacheWrite: 0 }
  } } };
  vm.createContext(aliasCtx);
  vm.runInContext(prefix + '\n' + block + '\nthis.__api = { buildModelGroups };', aliasCtx);
  const aliasGroups = aliasCtx.__api.buildModelGroups(aliasItems);
  assert.strictEqual(aliasGroups[0].usage.totalTokens, 400, '别名键不能和原始键重复相加，实际 ' + aliasGroups[0].usage.totalTokens);

  // 12d. 排序：default 保留「在用优先」分档，同档按 Token 降序
  const sortable = [
    { bare: 'a', name: 'A', usage: { requests: 100, totalTokens: 100 }, items: [{ enabled: true, matched: { cost: { input: 1, output: 1 } } }] },
    { bare: 'b', name: 'B', usage: { requests: 5, totalTokens: 90000 }, items: [{ enabled: true, matched: { cost: { input: 9, output: 9 } } }] },
    { bare: 'c', name: 'C', usage: { requests: 0, totalTokens: 0 }, items: [{ enabled: false, matched: { cost: { input: 2, output: 2 } } }] },
    { bare: 'd', name: 'D', usage: { requests: 0, totalTokens: 1000000 }, items: [{ enabled: false, matched: { cost: { input: 3, output: 3 } } }] }
  ];
  // vm 里创建的数组原型与宿主不同，deepStrictEqual 会因跨 realm 判不等，故用字符串比较
  const order = (list, type) => api.sortGroups(list, type).map((g) => g.bare).join(',');
  const byDefault = order(sortable, 'default');
  const byTokens = order(sortable, 'tokens-desc');
  assert.strictEqual(byDefault, 'b,a,d,c', '默认排序应先用优先档、档内按 Token 降序，实际 ' + byDefault);
  assert.strictEqual(byTokens, 'd,b,a,c', 'Token 排序应按 Token 降序，实际 ' + byTokens);
  assert.notStrictEqual(byDefault, byTokens, 'default 与 tokens-desc 不能是同一套排序');
  const i18nSrc = fs.readFileSync(path.join(__dirname, 'page/i18n.js'), 'utf8');
  assert.ok(!i18nSrc.includes('默认用量降序'), '文案不能再说默认是纯用量降序，实际默认还有「在用优先」分档');
  assert.strictEqual((i18nSrc.match(/sort_default:/g) || []).length, 4, 'sort_default 必须在四种语言里都给出');
  assert.strictEqual(order(sortable, 'price-asc'), 'a,c,d,b', '价格升序应按单价');
  assert.strictEqual(order(sortable, 'price-desc'), 'b,d,c,a', '价格降序应按单价');
  console.log('   ✓ 变体归族、正式名不误并、用量累加、三套排序语义均正确');
}

// 13. API 筛选归类与 DeepSeek 默认峰谷目标
function testApiFilterAndPeakDefaults() {
  console.log('13. 测试 API 筛选归类与 DeepSeek 默认峰谷...');
  assert.strictEqual(matcher.providerKindOf({ id: 'opencode-zen-2', billingKind: 'payg', key: { set: true } }), 'api');
  assert.strictEqual(matcher.providerKindOf({ id: 'trae-cn', billingKind: 'plan', account: { plan: 'Pro' } }), 'subscription');
  assert.strictEqual(matcher.providerKindOf({ id: 'workbuddy', key: '' }), 'subscription');
  assert.strictEqual(matcher.providerKindOf({ id: 'opencode-zen', key: 'sk-test' }), 'api');

  // The package must not carry a snapshot of the author's machine: the model
  // rows are generated locally at runtime by page-data.js and must never be
  // committed or packed. The generator itself ships; its output does not.
  assert.ok(!fs.existsSync(path.join(__dirname, 'page/generate-data.js')), 'page/generate-data.js 必须从仓库与包中移除');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  assert.ok(!/models-data|generate-data/.test(JSON.stringify(manifest.files || [])), 'package.json files 不得包含本机数据快照或生成器');
  const ignore = fs.readFileSync(path.join(__dirname, '.gitignore'), 'utf8').split(/\r?\n/);
  assert.ok(ignore.includes('page/models-data.js'), 'page/models-data.js 是运行时产物，必须写进 .gitignore');
  const iconFiles = fs.readdirSync(path.join(__dirname, 'page/icons'));
  assert.ok(iconFiles.length <= 2, 'page/icons 只能携带页面实际绘制的图标，实际 ' + iconFiles.length);

  // 峰谷目标读的是用户机器上的 Magpie 配置（providers.json / providers-state.json），
  // 直接断言会把「本机有配置」当成通过条件，CI 上必然失败。这里造一份临时配置，
  // 断言规则本身：按小时计费的 API 渠道算峰谷，订阅/免费渠道不算。
  const tmpHome3 = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-peak-'));
  fs.mkdirSync(path.join(tmpHome3, '.config/magpie'), { recursive: true });
  fs.mkdirSync(path.join(tmpHome3, '.cache/magpie'), { recursive: true });
  fs.writeFileSync(path.join(tmpHome3, '.config/magpie/providers.json'), JSON.stringify({ providers: [
    { id: 'opencode-zen-2', name: 'OpenCode Zen 2', key: 'sk-test' },
    { id: 'opencode-zen-free', name: 'OpenCode Zen Free' },
    { id: 'trae-cn', name: 'Trae CN' }
  ] }, null, 2));
  fs.writeFileSync(path.join(tmpHome3, '.cache/magpie/providers-state.json'), JSON.stringify({ version: 1, providers: { providers: [
    { id: 'opencode-zen-2', name: 'OpenCode Zen 2', billingKind: 'payg', key: { set: true }, models: [{ id: 'deepseek-v4.1-flash' }] },
    { id: 'opencode-zen-free', name: 'OpenCode Zen Free', billingKind: 'free', models: [{ id: 'deepseek-v4.1-flash' }] },
    { id: 'trae-cn', name: 'Trae CN', billingKind: 'plan', account: { plan: 'Pro' }, models: [{ id: 'deepseek-v4.1-flash' }] }
  ] } }, null, 2));
  const peakProbe = execFileSync(process.execPath, ['-e', `
    const m = require(${JSON.stringify(path.join(__dirname, 'matcher.js'))});
    const before = m.listRateWindowTargets().providers || [];
    // Loading the plugin must not write peak windows the user never set: the
    // first-run DeepSeek default this used to apply is gone (PR #1576 review).
    const plugin = require(${JSON.stringify(path.join(__dirname, 'index.js'))});
    (async () => {
      await plugin({ magpie: { options: async () => null } }, {});
      const after = m.listRateWindowTargets().providers || [];
      console.log(JSON.stringify({ before, after }));
      process.exit(0);
    })().catch((e) => { console.error(e); process.exit(1); });
  `], { env: envAt(tmpHome3), encoding: 'utf8' });
  const probe = JSON.parse(peakProbe.trim().split('\n').pop());
  const peaks = probe.before.filter((x) => x.peak).map((x) => x.id).sort();
  assert.deepStrictEqual(peaks, ['opencode-zen-2'], '只有按小时计费的 API 渠道才是峰谷目标，实际 ' + peaks.join(','));
  assert.ok(!peaks.includes('opencode-zen-free'), '免费订阅渠道不能误标为峰谷 API 渠道');
  assert.ok(!peaks.includes('trae-cn'), '包月订阅渠道不能误标为峰谷 API 渠道');
  const untouched = probe.after.every((x) => (x.rateWindows || []).length === 0);
  assert.ok(untouched, '插件载入不应把任何渠道的 rateWindows 写进 providers.json');
  console.log('   ✓ API 筛选仅命中 OpenCode，且载入不再自动写入默认峰谷时段');
}
testApiFilterAndPeakDefaults();

// 14. 统计刷新与 api-only 口径
console.log('14. 测试实时用量合并与 api-only 统计口径...');
{
  const vm = require('vm');
  const app = fs.readFileSync(path.join(__dirname, 'page/app.js'), 'utf8');
  const start = app.indexOf('function usageEntryFrom(');
  const end = app.indexOf('// 2.3 核心数据刷新控制器');
  assert(start > 0 && end > start, 'page/app.js 里应能找到用量归一化代码块');
  const block = app.slice(start, end);
  // No build-time snapshot is loaded now: start from an empty page state.
  const win = {};
  const ctx = { console, window: win };
  vm.createContext(ctx);
  vm.runInContext('let usagePeriod = "all";\n' + block + '\nthis.__api = { mergeLiveUsage, period: () => usagePeriod };', ctx);
  const api = ctx.__api;
  api.mergeLiveUsage({ period: 'all', calls: 38660, errors: 5, input: 600000000, output: 30000000, cacheRead: 5000000000, cost: 82.46, agents: [{ models: [{ model: 'deepseek-v4.1-flash', calls: 38000, input: 590000000, output: 29000000, cacheRead: 4900000000 }] }] });
  assert.strictEqual(win.__MAGPIE_USAGE_SUMMARY__.requests, 38660, '宿主 usage:day 全量调用数应覆盖静态快照');
  assert.strictEqual(win.__MAGPIE_USAGE_SUMMARY__.totalTokens, 630000000, '总 Token 应按 input+output 计算');
  assert.strictEqual(win.__MAGPIE_BARE_USAGE__['deepseek-v4.1-flash'].requests, 38000, '模型用量徽标应使用宿主实时值');
  assert.strictEqual(api.period(), 'all', 'usage:day 的区间应为全量');
  api.mergeLiveUsage({ period: '30d', calls: 30000, input: 500000000, output: 20000000, cacheRead: 0, models: [] });
  assert.strictEqual(win.__MAGPIE_USAGE_SUMMARY__.requests, 38660, '30 天 fallback 不能把全量历史改小');
  api.mergeLiveUsage({ summary: { requests: 123, totalTokens: 456, inputTokens: 300, outputTokens: 156, cacheRead: 0 }, models: { foo: { requests: 7, totalTokens: 70, inputTokens: 50, outputTokens: 20, cacheRead: 0 } } });
  assert.strictEqual(win.__MAGPIE_USAGE_SUMMARY__.requests, 123, '插件 /api/usage 结构仍应兼容');
  assert.strictEqual(win.__MAGPIE_BARE_USAGE__.foo.requests, 7, '插件 /api/usage 的模型用量应合并');

  const s2 = app.indexOf('function isBillingEffective(');
  const e2 = app.indexOf('  // 8. 统计数据刷新', s2);
  assert(s2 > 0 && e2 > s2, 'page/app.js 里应能找到 isBillingEffective');
  const ctx2 = { console };
  vm.createContext(ctx2);
  vm.runInContext('let globalMode = "api-only"; function getModelPrice(item){ return item.price || null; }\n' + app.slice(s2, e2) + '\nthis.__api = { isBillingEffective, setMode: (m) => { globalMode = m; } };', ctx2);
  assert.strictEqual(ctx2.__api.isBillingEffective({ providerKind: 'subscription', price: { type: 'subscription-free' } }), false, 'api-only 下订阅 $0 不算已生效计费');
  assert.strictEqual(ctx2.__api.isBillingEffective({ providerKind: 'subscription', price: { type: 'custom' } }), false, 'api-only 下订阅自定义价也不算真实 API 花费');
  assert.strictEqual(ctx2.__api.isBillingEffective({ providerKind: 'api', price: { type: 'matched' } }), true, '真实 API 价应算已生效计费');
  ctx2.__api.setMode('all-equivalent');
  assert.strictEqual(ctx2.__api.isBillingEffective({ providerKind: 'subscription', price: { type: 'subscription-free' } }), true, 'all-equivalent 下订阅等值价仍应计入');

  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  assert.ok((manifest.magpie.permissions || []).includes('usage:day'), 'manifest 必须声明 usage:day 权限');
  console.log('   ✓ 宿主全量用量覆盖初始状态、30d 不回退、api-only 统计口径正确');
}

// 15. 目录口径：与 magpie 的 appdir 一致（XDG_* 优先，其次主目录），且写盘自建目录
console.log('15. 测试配置目录解析与首次运行写入...');
{
  const os = require('os');
  const { execFileSync } = require('child_process');
  const probe = (env) => JSON.parse(execFileSync(process.execPath, ['-e',
    'const m = require(' + JSON.stringify(path.join(__dirname, 'matcher.js')) + ');' +
    'process.stdout.write(JSON.stringify(m.paths || null));'
  ], { env: { ...process.env, ...env }, encoding: 'utf8' }).trim());

  // XDG 优先：magpie 的 appdir.Config()/Cache() 认这两个变量，插件必须认同一份
  const xdgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-price-xdg-'));
  const xdgCfg = path.join(xdgRoot, 'cfg');
  const xdgCache = path.join(xdgRoot, 'cache');
  const xdgHome = path.join(xdgRoot, 'home');
  fs.mkdirSync(xdgHome, { recursive: true });
  const withXdg = probe({ HOME: xdgHome, XDG_CONFIG_HOME: xdgCfg, XDG_CACHE_HOME: xdgCache });
  assert.ok(withXdg, 'matcher 应导出 paths，供调用方按宿主同一口径定位目录');
  assert.strictEqual(withXdg.configDir, path.join(xdgCfg, 'magpie'), 'XDG_CONFIG_HOME 应决定配置目录');
  assert.strictEqual(withXdg.cacheDir, path.join(xdgCache, 'magpie'), 'XDG_CACHE_HOME 应决定缓存目录');
  assert.strictEqual(withXdg.settings, path.join(xdgCfg, 'magpie', 'settings.json'), 'settings.json 应落在 XDG 配置目录');

  // 相对路径的 XDG 变量被忽略（magpie 的 rooted() 也如此），回落到主目录
  const rel = probe({ HOME: xdgHome, XDG_CONFIG_HOME: 'relative/cfg', XDG_CACHE_HOME: 'relative/cache' });
  assert.strictEqual(rel.configDir, path.join(xdgHome, '.config', 'magpie'), '相对 XDG_CONFIG_HOME 应被忽略');

  // USERPROFILE 兜底：Windows 上 HOME 通常不存在
  const win = probe({ HOME: '', USERPROFILE: xdgHome, XDG_CONFIG_HOME: '', XDG_CACHE_HOME: '' });
  assert.strictEqual(win.configDir, path.join(xdgHome, '.config', 'magpie'), 'HOME 缺失时应由 USERPROFILE 兜底');

  // 首次运行：~/.config/magpie 尚不存在时也必须写得进去（原来 openSync 直接 ENOENT）
  const freshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-price-fresh-'));
  const freshOut = execFileSync(process.execPath, ['-e',
    'const m = require(' + JSON.stringify(path.join(__dirname, 'matcher.js')) + ');' +
    'try { m.applyGlobalMode("api-only", { "a/b": { input: 1, output: 2, cache_read: 0, cache_write: 0 } });' +
    '  process.stdout.write("written"); } catch (e) { process.stdout.write("threw:" + e.code); }'
  ], { env: { ...process.env, HOME: freshHome, XDG_CONFIG_HOME: '', XDG_CACHE_HOME: '' }, encoding: 'utf8' }).trim();
  assert.strictEqual(freshOut, 'written', '全新主目录下应自动创建配置目录并写入，而不是抛 ENOENT');
  const freshSettings = path.join(freshHome, '.config', 'magpie', 'settings.json');
  assert.ok(fs.existsSync(freshSettings), '全新主目录下 settings.json 应被创建');
  assert.ok(JSON.parse(fs.readFileSync(freshSettings, 'utf8')).modelPrices['a/b'], '写入的价格应可读回');
  fs.rmSync(xdgRoot, { recursive: true, force: true });
  fs.rmSync(freshHome, { recursive: true, force: true });
  console.log('   ✓ XDG 优先、USERPROFILE 兜底、首次运行自建目录均正确');
}

// 17. 运行时页面数据生成器：只生成模型清单，绝不写 settings.json
console.log('17. 测试页面模型数据生成器（运行时产物、只读配置）...');
{
  const os = require('os');
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-price-page-'));
  const tmpPkg = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-price-page-pkg-'));
  fs.mkdirSync(path.join(tmpHome, '.cache', 'magpie'), { recursive: true });
  fs.mkdirSync(path.join(tmpHome, '.config', 'magpie'), { recursive: true });
  fs.mkdirSync(path.join(tmpPkg, 'page'), { recursive: true });
  fs.writeFileSync(path.join(tmpHome, '.cache', 'magpie', 'providers-state.json'), JSON.stringify({
    version: 1,
    providers: { providers: [
      { id: 'workbuddy', name: 'WorkBuddy', billingKind: 'plan', account: { plan: 'Pro' }, models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }] },
      { id: 'opencode-zen', name: 'OpenCode Zen', billingKind: 'payg', key: { set: true }, models: [{ id: 'deepseek-v4.1-flash' }] }
    ] }
  }));
  const settingsBefore = JSON.stringify({ modelPrices: { 'keep/me': { input: 1, output: 2, cache_read: 0, cache_write: 0 } } }, null, 2);
  fs.writeFileSync(path.join(tmpHome, '.config', 'magpie', 'settings.json'), settingsBefore);
  const run = () => execFileSync(process.execPath, ['-e',
    'const p = require(' + JSON.stringify(path.join(__dirname, 'page-data.js')) + ');' +
    'const r = p.writePageData(' + JSON.stringify(tmpPkg) + ', { force: false });' +
    'console.log(JSON.stringify(r));'
  ], { env: envAt(tmpHome), encoding: 'utf8' }).trim().split('\n').pop();
  const first = JSON.parse(run());
  assert.ok(first.ok && first.generated, '首次生成应成功并真正写文件，实际 ' + JSON.stringify(first));
  assert.ok(first.models >= 2, '应生成两个渠道的模型，实际 ' + first.models);
  const generated = fs.readFileSync(path.join(tmpPkg, 'page', 'models-data.js'), 'utf8');
  assert.ok(generated.includes('__MAGPIE_MODELS_DATA__'), '生成文件应导出页面读取的全局数据');
  assert.ok(generated.includes('workbuddy/deepseek-v4.1-flash'), '生成文件应包含用户渠道的模型');
  assert.strictEqual(fs.readFileSync(path.join(tmpHome, '.config', 'magpie', 'settings.json'), 'utf8'), settingsBefore, '生成页面数据不能改写 settings.json');
  const second = JSON.parse(run());
  assert.ok(second.ok && !second.generated, '未过期的数据应直接复用，实际 ' + JSON.stringify(second));
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpPkg, { recursive: true, force: true });
  console.log('   ✓ 生成器包含渠道模型、不写价格、可复用缓存');
}
// 16. 服务只绑回环、CORS 只回显本地来源、静态文件不越出 public/
console.log('16. 测试本地服务边界（回环绑定 / CORS / 静态目录）...');
{
  const os = require('os');
  const http = require('http');
  const { spawn } = require('child_process');
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-price-srv-'));
  const port = 3400 + Math.floor(Math.random() * 200);
  // The server is started here rather than by running server.js, so the test can
  // read the address it actually bound: connecting from the machine's own
  // non-loopback address proves nothing on Windows, where such a connection
  // reaches a loopback-only listener anyway.
  const child = spawn(process.execPath, ['-e', [
    'const { startServer, server } = require(' + JSON.stringify(path.join(__dirname, 'server.js')) + ');',
    'startServer(' + port + ').then(() => {',
    '  const a = server.address();',
    "  console.log('bound=' + (a && a.address));",
    '});'
  ].join('\n')], {
    env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, XDG_CONFIG_HOME: '', XDG_CACHE_HOME: '', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let bound = '';
  const request = (opts, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, ...opts }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 15000);
    child.stdout.on('data', (d) => {
      const text = String(d);
      const hit = /bound=(\S+)/.exec(text);
      if (hit) { bound = hit[1]; clearTimeout(timer); resolve(); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error('server exited ' + code)); });
  });
  (async () => {
    await ready;
    // 回环绑定：直接看它绑到哪个地址，而不是靠外部地址能否连上来推断
    assert.strictEqual(bound, '127.0.0.1', '服务应只绑回环地址（局域网与 DNS rebinding 会借此改写价格）');
    const evil = await request({ method: 'OPTIONS', path: '/api/options', headers: { Origin: 'https://evil.example' } });
    assert.strictEqual(evil.headers['access-control-allow-origin'], undefined, '外部来源不应拿到 CORS 放行头');
    const local = await request({ method: 'OPTIONS', path: '/api/options', headers: { Origin: 'http://localhost:5173' } });
    assert.strictEqual(local.headers['access-control-allow-origin'], 'http://localhost:5173', '本地来源应被放行');
    assert.ok(String(local.headers.vary || '').toLowerCase().includes('origin'), 'CORS 响应应带 Vary: Origin');
    // The reviewer's own request: a text/plain POST from another origin needs no
    // preflight, so it arrives here and was answered before. It must be refused
    // outright now, not merely left without a CORS header.
    const evilPost = await request({ method: 'POST', path: '/api/options', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' } }, '{}');
    assert.strictEqual(evilPost.status, 403, '外部来源的写请求必须被拒绝，实际 ' + evilPost.status);
    assert.strictEqual(evilPost.headers['access-control-allow-origin'], undefined, '外部来源的写请求不应带放行头');
    const plainPost = await request({ method: 'POST', path: '/api/mode', headers: { Origin: 'https://evil.example', 'Content-Type': 'text/plain' } }, '{"mode":"all-equivalent"}');
    assert.strictEqual(plainPost.status, 403, '外部来源的 text/plain POST（无需预检）必须被拒绝，实际 ' + plainPost.status);
    const noOriginPlain = await request({ method: 'POST', path: '/api/mode', headers: { 'Content-Type': 'text/plain' } }, '{"mode":"all-equivalent"}');
    assert.strictEqual(noOriginPlain.status, 403, '非 JSON 的写请求必须被拒绝（跨站表单就是这样发的）');
    const rebind = await request({ method: 'GET', path: '/api/status', headers: { Host: 'evil.example:' + port } });
    assert.strictEqual(rebind.status, 403, 'Host 不是回环名字时应拒绝（DNS rebinding），实际 ' + rebind.status);
    const localJson = await request({ method: 'POST', path: '/api/options', headers: { Origin: 'http://127.0.0.1:' + port, 'Content-Type': 'application/json' }, host: '127.0.0.1', port }, '{"peakEnabled":false}');
    assert.notStrictEqual(localJson.status, 403, '本地来源的 JSON 写请求应放行，实际 ' + localJson.status);
    const traversal = await request({ path: '/..%2f..%2fmatcher.js' });
    assert.notStrictEqual(traversal.status, 200, '编码的 ../ 不应读到 public/ 之外的文件');
    const ok = await request({ path: '/index.html' });
    assert.strictEqual(ok.status, 200, 'public/ 内的静态文件应正常返回');
    child.kill();
    fs.rmSync(tmpHome, { recursive: true, force: true });
    console.log('   ✓ 仅回环监听、CORS 白名单、静态目录不可穿越');
    console.log('\n🎉 所有测试用例 100% 通过！兼容本地与 CI 环境。');
  })().catch((e) => {
    child.kill();
    fs.rmSync(tmpHome, { recursive: true, force: true });
    console.error(e);
    process.exit(1);
  });
}
