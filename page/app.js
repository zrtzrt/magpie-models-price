// app.js - Grouped Model Pricing Controller with Provider Icons, Collapsible Pricing, Provider Filter & Full i18n
(async () => {
  const $ = (id) => document.getElementById(id);
  const { t, setLocale, onLocaleChange, getLocale } = window.I18N_MODULE || {
    t: (k) => k,
    setLocale: () => {},
    onLocaleChange: () => {},
    getLocale: () => "zh"
  };

  let toastTimer = null;
  // The options the page last saved (or loaded), so a save that changes nothing
  // carries no new applyToken. Declared here because the bridge init below reads
  // the options it loaded and takes that as the baseline.
  let savedSignature = "";
  function showToast(msg) {
    const tEl = $("toast");
    if (!tEl) return;
    tEl.textContent = msg;
    tEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      tEl.hidden = true;
    }, 2500);
  }

  // The page cannot read files (its CSP is connect-src 'none') and
  // providers:list carries provider ids and names only. The model rows come
  // from page/models-data.js, generated locally by the plugin host on load
  // (page-data.js): not a build-time snapshot, and never shipped in the npm
  // package (PR #1576 review). An empty file still leaves the page usable.
  let rawModels = Array.isArray(window.__MAGPIE_MODELS_DATA__)
    ? window.__MAGPIE_MODELS_DATA__.map(normalizeModelItem).filter(Boolean)
    : [];
  const liveProviderNames = new Map();
  let liveProviders = [];
  let isRefreshing = false;
  let pluginOptions = {};
  let customPrices = {};
  // The prices the page last loaded or saved: the baseline for a save that only
  // sends the keys the user actually changed, and the keys they removed.
  let savedCustomPrices = {};
  let pendingRemovals = [];
  let globalMode = "all-equivalent"; // "all-equivalent" or "api-only"
  // 统计瓦片显示的用量区间：all = usage:day 全量历史；30d = 旧版 Magpie 的 summary 回退
  let usagePeriod = "all";
  // 峰谷默认倍率：只作为新模型的缺省值；每个模型都能在定价弹窗里单独设置倍率。
  // 落盘到 Magpie 的 modelPrices 永远是闲时价，高峰时段由渠道 rateWindows 按倍率计费。
  const DEFAULT_PEAK_RATE = 2;
  const peakFactor = DEFAULT_PEAK_RATE;
  // 每个模型族的峰谷设置：{ enabled, rate, windows:[{days:[0-6],start:"HH:MM",end:"HH:MM"}] }
  // key 用 cleanModelName 归一后的裸模型名；旧版的 peakTargets 布尔值会在 applyPeakOptions 里迁移。
  let modelPeaks = {};
  // 弹窗里当前编辑的模型对应的峰谷目标 key（弹窗内开关用）
  let editingPeakKey = null;
  let editingPeakWindows = [];
  try {
    const savedMode = localStorage.getItem("magpie_models_price_mode");
    if (savedMode === "api-only" || savedMode === "all-equivalent") {
      globalMode = savedMode;
    }
    const savedOpts = JSON.parse(localStorage.getItem("magpie_models_price_options") || "{}");
    if (savedOpts.modelPeaks && typeof savedOpts.modelPeaks === "object") {
      modelPeaks = savedOpts.modelPeaks;
    }
  } catch (e) {}
  let filter = "enabled";
  let selectedKind = "all"; // "all", "api", "subscription"
  let selectedPrice = "all"; // "all", "free", "paid", "unpriced"
  let defaultExpanded = false; // default collapsed; global buttons can override
  let search = "";
  let selectedProvider = "all";
  let currentSort = "default";
  let editingModel = null;
  let selectedScope = "specific";
  // 弹窗里四个价格输入框填的是闲时价（默认）还是高峰价
  let peakInputMode = "offpeak";
  const userToggledGroups = new Map(); // bareModel -> boolean (user explicit toggle override)

  function formatNumber(num) {
    if (num == null) return "0";
    return Number(num).toLocaleString();
  }

  function formatTokens(tokens) {
    if (!tokens || tokens <= 0) return "0";
    if (tokens >= 1e9) return (tokens / 1e9).toFixed(2) + "B";
    if (tokens >= 1e6) return (tokens / 1e6).toFixed(2) + "M";
    if (tokens >= 1e3) return (tokens / 1e3).toFixed(1) + "k";
    return String(tokens);
  }

  // 1. 初始化 Magpie 宿主通信规范 (Host PostMessage Handshake & Theme/Locale Sync)
  // 主题应用：initMagpieHostSync 里的 message 回调与外面的 magpie.ready 都要用，
  // 因此必须定义在模块作用域（原先嵌在 initMagpieHostSync 内部，导致 magpie.ready
  // 之后调用它直接 ReferenceError，被 catch 吞掉，启动时 options 从未读到）
  function applyHostTheme(data) {
    if (!data) return;
    const root = document.documentElement;
    if (data.dark !== undefined) {
      const theme = data.dark ? "dark" : "light";
      root.dataset.theme = theme;
      if (document.body) document.body.dataset.theme = theme;
      root.style.colorScheme = theme;
      const bg = data.tokens?.bg || (data.dark ? "#121214" : "#f5f5f7");
      root.style.backgroundColor = bg;
      if (document.body) document.body.style.backgroundColor = bg;
    }
    if (data.tokens) {
      for (const [k, v] of Object.entries(data.tokens)) {
        if (v) root.style.setProperty("--" + k, v);
      }
    }
    if (data.lang) {
      setLocale(data.lang);
    }
  }

  function initMagpieHostSync() {
    let callId = 1;
    const pendingCalls = new Map();

    window.addEventListener("message", (ev) => {
      const msg = ev.data;
      if (!msg || typeof msg !== "object" || msg.magpie !== 1) return;

      if (msg.id && pendingCalls.has(msg.id)) {
        const { resolve, reject } = pendingCalls.get(msg.id);
        pendingCalls.delete(msg.id);
        if (msg.error) reject(new Error(msg.error));
        else resolve(msg.result);
        return;
      }

      if (msg.event === "theme" && msg.data) {
        applyHostTheme(msg.data);
      }
    });

    function callHost(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = "call-" + callId++;
        pendingCalls.set(id, { resolve, reject });
        window.parent.postMessage({ magpie: 1, id, method, params }, "*");
        setTimeout(() => {
          if (pendingCalls.has(id)) {
            pendingCalls.delete(id);
            reject(new Error("Host call timed out: " + method));
          }
        }, 3000);
      });
    }

    callHost("hello")
      .then((res) => {
        if (res) applyHostTheme(res);
      })
      .catch(() => {});

    if (window.matchMedia) {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
        applyHostTheme({ dark: e.matches });
      });
    }
  }

  // 2. 初始化 Magpie bridge (如果存在)
  if (globalThis.magpie) {
    try {
      const theme = await magpie.ready;
      if (theme) {
        applyHostTheme(theme);
      }
      magpie.onTheme?.((tTheme) => {
        applyHostTheme(tTheme);
      });
      pluginOptions = (await magpie.options.get()) || {};
      applyPeakOptions(pluginOptions);
      customPrices = pluginOptions.customPrices || {};
      savedCustomPrices = JSON.parse(JSON.stringify(customPrices));
      globalMode = pluginOptions.mode || "all-equivalent";
      // The options just read are what is already applied: a save that changes
      // nothing must not carry a new applyToken, or opening the page and
      // touching nothing would write settings.json again.
      savedSignature = optionsSignature({
        mode: globalMode,
        modelPeaks,
        customPrices,
        priceChanges: {},
        removedPrices: []
      });
    } catch (e) {
      console.warn("Magpie bridge ready warning:", e);
    }
  }

  initMagpieHostSync();

  function getBareModel(fullName) {
    if (!fullName) return "";
    return fullName.includes("/") ? fullName.split("/").slice(1).join("/") : fullName;
  }

  // normalizeModelItem turns one row of the generated data (or of a future
  // providers:list that carries models) into the shape renderList expects.
  // Missing fields fall back to values that keep the row visible and priced.
  function normalizeModelItem(item) {
    if (!item || !item.provider || !item.model) return null;
    const model = String(item.model);
    const id = item.id || getBareModel(model);
    const price = item.matched && item.matched.cost ? item.matched.cost : null;
    return {
      provider: String(item.provider),
      providerName: item.providerName || item.provider,
      providerIcon: item.providerIcon || null,
      providerKind: item.providerKind || "subscription",
      model,
      id,
      name: item.name || id,
      enabled: item.enabled !== false,
      providerOff: !!item.providerOff,
      modelOn: item.modelOn !== false,
      free: !!item.free || /(^|-)free($|-)/i.test(getBareModel(model)),
      listPrice: item.listPrice || null,
      currentPrice: item.currentPrice || (price ? `List: $${price.input}/${price.output}` : "未定价"),
      matched: item.matched || null,
      isUnpriced: item.isUnpriced !== undefined ? !!item.isUnpriced : !price
    };
  }

  // 官方价目表里真正按「峰谷/分时」计价的是 DeepSeek 系模型：
  // DeepSeek 官方、Command Code、Ollama Cloud、阿里百炼的第三方 DeepSeek、
  // 火山方舟的 deepseek-v4.1-flash、腾讯 TokenHub 的 DeepSeek。
  // 高峰窗口统一是北京时间工作日 09:00-12:00 / 14:00-18:00，倍率 ×2
  // （Ollama Cloud 例外：工作日 12:00-18:00 UTC）。
  // 关键：判定必须落在「模型族」而不是渠道 id 上。用户机器上可能一个 DeepSeek
  // 官方渠道都没有（全是中转/订阅），按渠道 id 判定会让峰谷永远不生效。
  const PEAK_BILLS = [
    { vendor: "deepseek", name: "DeepSeek 系", rule: "weekdays", match: /^deepseek-/ },
    { vendor: "ollama-cloud", name: "Ollama Cloud", rule: "ollama", ids: ["ollama-cloud"], match: /^deepseek-/ }
  ];

  // 缺省时段：官方 DeepSeek 系工作日 09:00-12:00 / 14:00-18:00；Ollama Cloud 为 20:00-24:00 + 00:00-02:00。
  const DEFAULT_WEEKDAY_WINDOWS = [
    { days: [1, 2, 3, 4, 5], start: "09:00", end: "12:00" },
    { days: [1, 2, 3, 4, 5], start: "14:00", end: "18:00" }
  ];
  const DEFAULT_OLLAMA_WINDOWS = [
    { days: [1, 2, 3, 4, 5], start: "20:00", end: "24:00" },
    { days: [1, 2, 3, 4, 5], start: "00:00", end: "02:00" }
  ];

  function copyPeakWindows(windows) {
    return (Array.isArray(windows) ? windows : []).map((w) => ({
      days: Array.isArray(w.days) ? w.days.slice() : [],
      start: w.start || "09:00",
      end: w.end || "18:00"
    }));
  }

  function defaultPeakWindowsForFamily(family) {
    return copyPeakWindows(family && family.bill && family.bill.rule === "ollama" ? DEFAULT_OLLAMA_WINDOWS : DEFAULT_WEEKDAY_WINDOWS);
  }

  function defaultPeakWindowsForKey() {
    // 迁移旧配置时不知道渠道，统一按工作日官方时段；新模型从 peakConfigFor 取 family 的精确缺省。
    return copyPeakWindows(DEFAULT_WEEKDAY_WINDOWS);
  }

  // 一条模型属于哪个峰谷模型族。所有模型都有族 key（用于逐模型设置），
  // 但只有 bill 非空的（官方 DeepSeek 系）默认开启峰谷。
  function peakFamilyOf(item) {
    if (!item) return null;
    const bare = String(item.id || item.model || "").split("/").pop().split(":")[0];
    const key = cleanModelName(bare) || bare.toLowerCase();
    if (!key) return null;
    let bill = null;
    for (const candidate of PEAK_BILLS) {
      if (!candidate.match.test(key)) continue;
      if (candidate.ids) {
        const pid = String(item.provider || "").toLowerCase();
        if (!candidate.ids.includes(pid)) continue;
      }
      bill = candidate;
      break;
    }
    return { key, bill };
  }

  // 默认开启峰谷的模型族：调研确认有官方分时价的就是 DeepSeek 系。
  function defaultPeakTarget(key) {
    return PEAK_BILLS.some((bill) => bill.match.test(String(key || "")));
  }

  function normalizePeakConfig(value, familyKey) {
    if (typeof value === "boolean") {
      return { enabled: value, rate: DEFAULT_PEAK_RATE, windows: value ? defaultPeakWindowsForKey(familyKey) : [] };
    }
    if (!value || typeof value !== "object") {
      const on = defaultPeakTarget(familyKey);
      return { enabled: on, rate: DEFAULT_PEAK_RATE, windows: on ? defaultPeakWindowsForKey(familyKey) : [] };
    }
    const rate = Number(value.rate);
    const safeRate = Number.isFinite(rate) && rate > 0 && rate <= 1000 ? Math.round(rate * 1000) / 1000 : DEFAULT_PEAK_RATE;
    const windows = Array.isArray(value.windows) ? copyPeakWindows(value.windows) : [];
    return { enabled: value.enabled !== false, rate: safeRate, windows };
  }

  // 读取插件 options 里的峰谷设置；新格式 modelPeaks 优先，旧版 peakTargets 布尔值迁移。
  function applyPeakOptions(opts) {
    if (!opts || typeof opts !== "object") return;
    if (opts.modelPeaks && typeof opts.modelPeaks === "object") {
      modelPeaks = {};
      for (const [key, value] of Object.entries(opts.modelPeaks)) {
        if (key) modelPeaks[key] = normalizePeakConfig(value, key);
      }
    } else if (opts.peakTargets && typeof opts.peakTargets === "object") {
      // 旧版：peakEnabled 总开关 + 布尔值 map。迁移成模型级配置，旧开关为 false 时全部关闭。
      const globalOn = opts.peakEnabled === undefined ? true : !!opts.peakEnabled;
      modelPeaks = {};
      for (const [key, value] of Object.entries(opts.peakTargets)) {
        if (!key) continue;
        modelPeaks[key] = normalizePeakConfig(globalOn && !!value, key);
      }
    } else if (globalThis.magpie) {
      modelPeaks = {};
    }
  }

  // 该模型族的峰谷配置（未保存过则返回默认值：DeepSeek 默认开，其他默认关）。
  function peakConfigFor(item) {
    const family = peakFamilyOf(item);
    if (!family) return null;
    const saved = modelPeaks[family.key];
    if (saved) return { ...normalizePeakConfig(saved, family.key), key: family.key, family };
    const on = !!family.bill;
    return {
      key: family.key,
      family,
      enabled: on,
      rate: DEFAULT_PEAK_RATE,
      windows: on ? defaultPeakWindowsForFamily(family) : []
    };
  }

  // 这个模型族是否参与峰谷：显式保存优先，否则按官方价目表（DeepSeek 系默认开）。
  function peakFamilyEnabled(familyKey) {
    if (!familyKey) return false;
    if (Object.prototype.hasOwnProperty.call(modelPeaks, familyKey)) {
      return normalizePeakConfig(modelPeaks[familyKey], familyKey).enabled;
    }
    return defaultPeakTarget(familyKey);
  }

  function setPeakFamilyEnabled(familyKey, enabled) {
    if (!familyKey) return;
    const current = normalizePeakConfig(
      Object.prototype.hasOwnProperty.call(modelPeaks, familyKey) ? modelPeaks[familyKey] : defaultPeakTarget(familyKey),
      familyKey
    );
    modelPeaks[familyKey] = {
      ...current,
      enabled: !!enabled,
      windows: Array.isArray(current.windows) && current.windows.length ? current.windows : (enabled ? defaultPeakWindowsForKey(familyKey) : [])
    };
  }

  // 一条模型/渠道对应的峰谷目标 key（模型族归一后的裸名）；所有模型都有 key。
  function peakTargetKeyFor(item) {
    const family = peakFamilyOf(item);
    return family ? family.key : null;
  }

  // 峰谷换算是否生效：该模型启用且至少配置了一个时段。
  function peakApplies(item) {
    const config = peakConfigFor(item);
    return !!(config && config.enabled && config.windows.length);
  }

  function peakRateFor(item) {
    const config = peakConfigFor(item);
    return config && config.rate > 0 ? config.rate : DEFAULT_PEAK_RATE;
  }

  // 该模型是否按峰谷计费（兼容旧调用）。
  function isHourlyBilled(item) {
    return peakApplies(item);
  }

  // 判断某个时刻是否落在任一时段内（按本机时钟，与 Magpie 的 rateWindows 一致）。
  function peakRateAt(config, date = new Date()) {
    if (!config || !config.enabled || !Array.isArray(config.windows) || !config.windows.length) return 1;
    const day = date.getDay();
    const minutes = date.getHours() * 60 + date.getMinutes();
    const toMin = (s) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ""));
      if (!m) return null;
      return Number(m[1]) * 60 + Number(m[2]);
    };
    for (const w of config.windows) {
      const days = Array.isArray(w.days) && w.days.length ? w.days : [0, 1, 2, 3, 4, 5, 6];
      if (!days.includes(day)) continue;
      const start = toMin(w.start);
      const end = toMin(w.end);
      if (start == null || end == null) continue;
      const hit = end > start ? (minutes >= start && minutes < end) : (minutes >= start || minutes < end);
      if (hit) return config.rate;
    }
    return 1;
  }

  // 渠道内的「变体后缀」：trae-cn / workbuddy 这类中转会把同一个模型的加速版、
  // 官方版、自动路由版各挂一条（-max / -auto / -official / -highspeed ...），
  // 价格完全一样却各自成卡。这里把它们归到同一族，条件是「同渠道里去掉后缀后的
  // 基础模型确实存在」——qwen4-max、glm-5.3-max 这种本身就是正式名字的不会被误并。
  // 纯字符串后缀 + 正则后缀（日期快照、antidowngrade 之类的渠道标记）。
  // 正则只在其基础名确实存在于同一渠道时才会生效，所以不会误伤正式模型名。
  const VARIANT_SUFFIXES = ['-max', '-auto', '-official', '-highspeed', '-turbo-x'];
  const VARIANT_SUFFIX_PATTERNS = [
    /-\d{4}$/,            // -0731 / -1017 日期快照
    /-\d{6,8}$/,          // -202605 / -260731
    /-\d{4}-\d{2}-\d{2}$/,
    /-antidowngrade$/,
    /-preview$/,
    /-latest$/,
    /-stable$/,
    /-beta$/,
    /-v\d+$/
  ];

  // 该渠道里出现过的基础模型 → 它的价格指纹。归族必须同时满足两件事：
  // ① 去掉后缀后的名字在该渠道真实存在；② 两者价格完全一致。
  // 少了②就会把 qwen4（$1/$2）和 qwen4-max（$3/$6）这种同名不同价的两个模型并成一张卡。
  const providerBaseNames = new Map(); // provider -> Map<cleanModelName, priceKey>
  function priceKeyOf(item) {
    const c = (item && item.matched && item.matched.cost) || customPrices[item && item.model] || null;
    if (!c) return "";
    return [c.input, c.output, c.cache_read, c.cache_write].map((v) => (v == null ? 0 : Number(v))).join("/");
  }

  // 两份价是不是「同一个价」：允许 1% 相对误差。
  // 渠道换汇取整会让同一份公价出现 0.15 / 0.149716 这种差别，
  // 那是同一个价；而 0.15 与 0.44 是三倍差，属于不同产品，不能并。
  function samePriceKey(a, b) {
    if (!a || !b) return true; // 任一侧没价时按名字归族
    if (a === b) return true;
    const pa = a.split("/").map(Number);
    const pb = b.split("/").map(Number);
    if (pa.length !== pb.length) return false;
    for (let i = 0; i < pa.length; i++) {
      const x = pa[i];
      const y = pb[i];
      if (x === y) continue;
      const base = Math.max(Math.abs(x), Math.abs(y));
      if (base === 0) continue;
      if (Math.abs(x - y) / base > 0.01) return false;
    }
    return true;
  }
  function noteProviderBaseName(provider, cleaned, item) {
    if (!provider || !cleaned) return;
    let map = providerBaseNames.get(provider);
    if (!map) {
      map = new Map();
      providerBaseNames.set(provider, map);
    }
    const key = priceKeyOf(item);
    const prev = map.get(cleaned);
    // 同名多条时保留「无价」这一侧，让有价的那条有机会去匹配无价的基准
    if (prev === undefined || prev === "" || key === "") {
      if (prev === undefined || prev === "") map.set(cleaned, key);
    }
  }

  // 剥掉一层变体后缀；没命中返回 null
  function stripOneSuffix(cur) {
    for (const suffix of VARIANT_SUFFIXES) {
      if (!cur.endsWith(suffix)) continue;
      const base = cur.slice(0, -suffix.length);
      if (base) return base;
    }
    for (const re of VARIANT_SUFFIX_PATTERNS) {
      const m = cur.match(re);
      if (!m || m.index <= 0) continue;
      return cur.slice(0, m.index);
    }
    return null;
  }

  // 反复剥掉变体后缀，取「在该渠道里真实存在、且价格一致的最短基础名」。
  // deepseek-v4-flash-261017-antidowngrade → deepseek-v4-flash-261017 → deepseek-v4-flash
  // 中间名不必真实存在（日期快照本来就只挂在变体上），但最终基础名必须存在且同价。
  function stripVariantSuffix(provider, cleaned, item) {
    if (!cleaned) return cleaned;
    const map = providerBaseNames.get(provider);
    if (!map) return cleaned;
    const ownKey = priceKeyOf(item);
    let cur = cleaned;
    let best = null;
    for (let guard = 0; guard < 6; guard++) {
      const next = stripOneSuffix(cur);
      if (!next || next === cur) break;
      cur = next;
      if (!map.has(cur)) continue;
      const baseKey = map.get(cur);
      // 基准没价（或本条没价）时按名字归族；两边都有价则必须完全一致
      if (samePriceKey(baseKey, ownKey)) best = cur;
    }
    return best || cleaned;
  }

  function cleanModelName(str) {
    if (!str) return "";
    const rawName = str ? str.toLowerCase().replace(/^[a-z0-9_-]+\//, '') : '';
    if (rawName === 'hy4flash' || rawName === 'hy4-flash') return 'hy4-flash';
    if (rawName === 'hy4flash-free' || rawName === 'hy4-flash-free') return 'hy4-flash-free';
    // DeepSeek 各家渠道对同一模型的叫法不同：deepseek-flash / deepseek-v4-flash /
    // deepseek-v4.1-flash / DeepSeek-V4-Flash 指的是同一份价目表（matched 都指向
    // deepseek-v4-flash）。不归一就会出现两张同名的卡，用量还被拆成两半。
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

  // Provider type: only a pay-as-you-go provider with a real API key is the
  // "付费 API" kind. A plan/account provider that happens to have a key field
  // must not leak into the API filter.
  function providerKindOf(p = {}) {
    const id = String((p && p.id) || "").toLowerCase();
    const billing = String((p && (p.billingKind || p.billing_kind)) || "").toLowerCase();
    if (billing === "payg" || billing === "pay-as-you-go" || billing === "api") return "api";
    if (billing === "plan" || billing === "subscription" || billing === "free") return "subscription";
    const keySet = p && p.key && typeof p.key === "object"
      ? p.key.set === true
      : typeof (p && p.key) === "string" && p.key.trim().length > 0;
    if (keySet && !p.account) return "api";
    if (p && p.account) return "subscription";
    if (/free|plan/.test(id)) return "subscription";
    return "subscription";
  }

  // 2.1 动态合并 Magpie 实时供应商列表 (Live Providers & Unpriced Channels Sync)
  // A page's providers:list gives only {id,name} (Magpie page reads carry no
  // models). The rows come from page/models-data.js; this only applies the live
  // names and the provider/model off state to them. A future Magpie whose
  // providers:list does carry models is still honoured: then the rows are built
  // from that list instead, so the page never depends on a build-time snapshot.
  function mergeLiveProviders(liveList) {
    if (!Array.isArray(liveList)) return;
    liveProviders = liveList;
    const byId = new Map();
    for (const p of liveList) {
      if (!p || !p.id) continue;
      byId.set(String(p.id), p);
      liveProviderNames.set(p.id, p.name || p.id);
    }

    const hasModelRows = liveList.some((p) => p && Array.isArray(p.models) && p.models.length > 0);
    if (hasModelRows) {
      rawModels = modelsFromLiveProviders(liveList);
    } else {
      for (const item of rawModels) {
        const p = byId.get(String(item.provider));
        if (!p) {
          // A provider that is no longer in magpie stays visible with its last
          // known price, but is marked off like a provider switched off.
          item.providerOff = true;
          item.enabled = false;
          continue;
        }
        item.providerName = p.name || item.providerName;
        // providers:list on a page carries no off flag; the generated rows
        // already know their enabled state, so only a live list that really
        // says off true/false may override it.
        if (typeof p.off === "boolean") {
          item.providerOff = p.off;
          item.modelOn = item.modelOn !== false;
          item.enabled = !p.off && item.modelOn;
        } else {
          item.enabled = item.enabled !== false;
        }
      }
    }

    // 免费渠道按同族付费模型的市场价展示（all-equivalent 语义）
    applyFreeEquivalentPricingForRows();
  }

  function modelsFromLiveProviders(liveList) {
    const models = [];
    const seen = new Set();
    for (const p of liveList) {
      if (!p || !p.id) continue;
      const pId = p.id;
      const pName = p.name || pId;
      const isProviderOn = !p.off;
      const pKind = providerKindOf(p);
      const pModels = Array.isArray(p.models) ? p.models : [];
      for (const m of pModels) {
        const mId = typeof m === "object" ? m.id : m;
        if (!mId) continue;
        const mName = (typeof m === "object" && m.name) ? m.name : mId;
        const fullName = pId + "/" + mId;
        if (seen.has(fullName)) continue;
        seen.add(fullName);
        const isModelOn = typeof m === "object" ? m.on !== false : true;
        const bare = getBareModel(fullName);
        const isFreeModel = (typeof m === "object" && m.free) || /(^|-)free($|-)/i.test(bare);
        const listPrice = (typeof m === "object" && (m.list || m.price || m.cost)) || null;
        const priceCost = listPrice ? {
          input: Number(listPrice.input) || 0,
          output: Number(listPrice.output) || 0,
          cache_read: Number(listPrice.cache_read ?? listPrice.cache?.read) || 0,
          cache_write: Number(listPrice.cache_write ?? listPrice.cache?.write) || 0,
          ...(Array.isArray(listPrice.tiers) && listPrice.tiers.length ? { tiers: listPrice.tiers } : {})
        } : null;
        const matched = priceCost ? {
          provider: pId,
          model: mId,
          name: mName,
          cost: priceCost
        } : null;
        models.push({
          provider: pId,
          providerName: pName,
          providerIcon: p.icon || null,
          providerKind: pKind,
          model: fullName,
          id: mId,
          name: mName,
          enabled: isProviderOn && isModelOn,
          providerOff: !!p.off,
          modelOn: isModelOn,
          free: isFreeModel,
          listPrice,
          currentPrice: matched
            ? (matched.cost.input || matched.cost.output
                ? "List: $" + matched.cost.input + "/$" + matched.cost.output
                : "Free model ($0.00)")
            : "未定价",
          matched,
          isUnpriced: !matched
        });
      }
    }
    return models;
  }

  // Rebuild the free-model equivalent prices over rawModels.
  function applyFreeEquivalentPricingForRows() {
    const barePriceIndex = new Map();
    const paidPriceIndex = new Map();
    for (const item of rawModels) {
      const c = item.matched && item.matched.cost;
      if (!c || item.free) continue;
      if ((Number(c.input) || 0) <= 0 && (Number(c.output) || 0) <= 0) continue;
      barePriceIndex.set(String(getBareModel(item.model)).toLowerCase(), c);
      paidPriceIndex.set(cleanModelName(item.model), c);
    }
    applyFreeEquivalentPricing(barePriceIndex, paidPriceIndex);
  }

  // 免费模型（hy4flash-free / hy4-flash-free / *-free）也要按同族付费模型的公价计价，
  // 而不是显示 $0/$0 —— 账单口径是「所有提供商等值公价」，免费只是不额外收费，
  // 它消耗的等价市值仍然要算进统计。无同族付费版时才保持 $0。
  // 这个函数同时覆盖两种情况：实时渠道合并出来的条目、以及静态基准数据里的条目
  // （没有 Magpie bridge 时只走静态数据，免费模型原本会一直是 $0）。
  function applyFreeEquivalentPricing(bareIndex, cleanIndex) {
    const barePriceIndex = bareIndex || new Map();
    const paidPriceIndex = cleanIndex || new Map();
    if (!bareIndex) {
      // 静态数据里自建索引
      for (const it of rawModels) {
        const c = it.matched && it.matched.cost;
        if (!c) continue;
        if ((Number(c.input) || 0) <= 0 && (Number(c.output) || 0) <= 0) continue;
        const b = getBareModel(it.model);
        if (b) barePriceIndex.set(String(b).toLowerCase(), c);
        paidPriceIndex.set(cleanModelName(it.model), c);
      }
    }
    const lookup = (bare) => {
      const noFree = String(bare || "").toLowerCase().replace(/-?free$/, "");
      return barePriceIndex.get(noFree)
        || barePriceIndex.get(String(bare).toLowerCase())
        || paidPriceIndex.get(noFree)
        || null;
    };

    for (const item of rawModels) {
      if (!isFreeModelItem(item)) continue;
      const c = item.matched && item.matched.cost;
      const alreadyPaid = c && ((Number(c.input) || 0) > 0 || (Number(c.output) || 0) > 0);
      if (alreadyPaid) continue;
      const bare = getBareModel(item.model);
      const eq = lookup(bare);
      if (!eq || ((Number(eq.input) || 0) <= 0 && (Number(eq.output) || 0) <= 0)) continue;
      item.matched = {
        ...(item.matched || {}),
        name: (item.matched && item.matched.name) || "等值公价 (免费)",
        cost: eq,
        equivalent: true
      };
      item.currentPrice = `List: $${eq.input}/$${eq.output}`;
      item.isUnpriced = false;
    }
  }

  // 2.2 动态合并用量数据 (Live Usage Summary Sync)
  // 三个来源结构并不一样：
  //  - 插件自建 /api/usage：{ summary:{...}, models:{bare:{...}}, channels }
  //  - Magpie 宿主 usage:summary：{ period, calls, errors, input, output, cacheRead, cost, models:[...] }
  //  - Magpie 宿主 usage:day from:"all"：{ calls, ..., agents:[{ models:[...] }] }
  // 以前只认第一种的 liveUsage.summary，Magpie 窗口里读到的宿主数据全被丢掉，
  // 「历史调用总数」就永远停在页面打开时的那份快照上。
  function usageEntryFrom(raw, fallbackCache = 0) {
    const s = raw && typeof raw === "object" ? raw : {};
    const input = Number(s.inputTokens ?? s.input ?? 0) || 0;
    const output = Number(s.outputTokens ?? s.output ?? 0) || 0;
    return {
      requests: Number(s.requests ?? s.calls ?? 0) || 0,
      inputTokens: input,
      outputTokens: output,
      cacheRead: Number(s.cacheRead ?? s.cache_read ?? fallbackCache ?? 0) || 0,
      cacheWrite: Number(s.cacheWrite ?? s.cache_write ?? 0) || 0,
      totalTokens: Number(s.totalTokens ?? s.tokens ?? input + output) || 0,
      lastAt: s.lastAt || s.last || undefined
    };
  }

  function mergeLiveUsage(liveUsage) {
    if (!liveUsage || typeof liveUsage !== "object") return;
    let summary = null;
    const modelMap = {};

    // (a) 插件自建服务 /api/usage
    if (liveUsage.summary && typeof liveUsage.summary === "object") {
      const s = liveUsage.summary;
      summary = {
        requests: Number(s.requests) || 0,
        inputTokens: Number(s.inputTokens) || 0,
        outputTokens: Number(s.outputTokens) || 0,
        cacheRead: Number(s.cacheRead) || 0,
        cacheWrite: Number(s.cacheWrite) || 0,
        totalTokens: Number(s.totalTokens) || 0,
        cost: Number(s.cost) || 0
      };
      usagePeriod = "all";
    }

    // (b) 宿主 usage:summary（只支持 today/7d/30d，旧版本 fallback）
    if (Array.isArray(liveUsage.models) && typeof liveUsage.calls === "number") {
      const input = Number(liveUsage.input) || 0;
      const output = Number(liveUsage.output) || 0;
      summary = {
        requests: Number(liveUsage.calls) || 0,
        inputTokens: input,
        outputTokens: output,
        cacheRead: Number(liveUsage.cacheRead) || 0,
        cacheWrite: Number(liveUsage.cacheWrite) || 0,
        totalTokens: input + output,
        cost: Number(liveUsage.cost) || 0,
        errors: Number(liveUsage.errors) || 0
      };
      usagePeriod = String(liveUsage.period || "today");
    }

    // (c) 宿主 usage:day from:"all"：全量历史，模型明细则在 agents[].models
    if (Array.isArray(liveUsage.agents) && typeof liveUsage.calls === "number") {
      const input = Number(liveUsage.input) || 0;
      const output = Number(liveUsage.output) || 0;
      summary = {
        requests: Number(liveUsage.calls) || 0,
        inputTokens: input,
        outputTokens: output,
        cacheRead: Number(liveUsage.cacheRead) || 0,
        cacheWrite: Number(liveUsage.cacheWrite) || 0,
        totalTokens: input + output,
        cost: Number(liveUsage.cost) || 0,
        errors: Number(liveUsage.errors) || 0
      };
      usagePeriod = "all";
      for (const agent of liveUsage.agents) {
        for (const m of (agent && Array.isArray(agent.models) ? agent.models : [])) {
          const key = String(m.model || m.id || "").toLowerCase();
          if (!key) continue;
          const entry = modelMap[key] || usageEntryFrom({});
          const cur = usageEntryFrom(m, entry.cacheRead);
          entry.requests += cur.requests;
          entry.inputTokens += cur.inputTokens;
          entry.outputTokens += cur.outputTokens;
          entry.cacheRead += cur.cacheRead;
          entry.cacheWrite += cur.cacheWrite;
          entry.totalTokens += cur.inputTokens + cur.outputTokens;
          modelMap[key] = entry;
        }
      }
    }

    // (d) 插件自建服务的 models 是对象；宿主 usage:summary 的 models 是数组，不能混
    if (liveUsage.models && !Array.isArray(liveUsage.models) && typeof liveUsage.models === "object") {
      for (const [key, raw] of Object.entries(liveUsage.models)) {
        modelMap[String(key).toLowerCase()] = usageEntryFrom(raw);
      }
    }

    if (summary) {
      const prev = window.__MAGPIE_USAGE_SUMMARY__ || {};
      // 30d fallback 不能把静态快照里的全量历史改小；全量 usage:day 才允许覆盖。
      const olderFallback = usagePeriod !== "all" && Number(summary.requests) < Number(prev.requests || 0);
      if (!olderFallback) {
        window.__MAGPIE_USAGE_SUMMARY__ = { ...prev, ...summary };
      }
    }
    if (Object.keys(modelMap).length) {
      window.__MAGPIE_BARE_USAGE__ = {
        ...(window.__MAGPIE_BARE_USAGE__ || {}),
        ...modelMap
      };
    }
  }

  // 2.3 核心数据刷新控制器 (Manual & Auto-Refresh)
  //
  // 页面只通过宿主 bridge 读写。插件不再自己起 HTTP 服务（那套只在
  // `node index.js ui` 的独立 Web UI 里用，由 public/index.html 自己驱动），
  // 而插件页的 CSP 是 connect-src 'none'，任何 fetch 都会被拦下、只在控制台
  // 留一行 "Refused to connect"。所以这里没有任何服务探测，只有 magpie.read。
  async function fetchLiveUsage() {
    // 宿主 bridge：
    // usage:day from:"all" 给全量历史；旧版 Magpie 没有这个 read 时退回 30 天 summary。
    if (globalThis.magpie && typeof magpie.read === "function") {
      try {
        const all = await magpie.read("usage:day", { from: "all" });
        if (all && typeof all === "object" && typeof all.calls === "number") return all;
      } catch (e) {
        console.warn("Failed to read usage:day:", e);
      }
      try {
        return await magpie.read("usage:summary", { period: "30d" });
      } catch (e) {
        console.warn("Failed to read usage:summary:", e);
      }
    }
    return null;
  }

  async function syncLiveMagpieData(isManual = false) {
    if (isRefreshing) return;
    isRefreshing = true;

    const refreshIcon = $("refresh-icon");
    if (refreshIcon) {
      refreshIcon.classList.remove("spin");
      void refreshIcon.offsetWidth;
      refreshIcon.classList.add("spin");
    }

    try {
      if (globalThis.magpie) {
        // 读取插件选项与定价
        try {
          pluginOptions = (await magpie.options.get()) || {};
          applyPeakOptions(pluginOptions);
          customPrices = pluginOptions.customPrices || {};
          savedCustomPrices = JSON.parse(JSON.stringify(customPrices));
          globalMode = pluginOptions.mode || "all-equivalent";
          savedSignature = optionsSignature({
            mode: globalMode,
            modelPeaks,
            customPrices,
            priceChanges: {},
            removedPrices: []
          });
        } catch (e) {
          console.warn("Failed to get magpie options:", e);
        }

        // 读取实时供应商与模型列表
        if (magpie.read) {
          try {
            const liveList = await magpie.read("providers:list");
            if (Array.isArray(liveList) && liveList.length > 0) {
              mergeLiveProviders(liveList);
            }
          } catch (e) {
            console.warn("Failed to read providers:list:", e);
          }
        }
      }

      // 实时用量统计：浏览器走本地服务，Magpie 窗口走 bridge。
      // 以前只放在 if (globalThis.magpie) 里，独立打开的 Web UI 永远不刷新。
      try {
        const liveUsage = await fetchLiveUsage();
        if (liveUsage && typeof liveUsage === "object") {
          mergeLiveUsage(liveUsage);
        }
      } catch (e) {
        console.warn("Failed to read live usage:", e);
      }

      updatePeakStatusBar();
      renderModeUI();
      renderProviderFilter();
      renderStats();
      renderList();

      if (isManual) {
        showToast(t("toast_refreshed"));
      }
    } catch (err) {
      console.error("syncLiveMagpieData error:", err);
      if (isManual) {
        showToast(err.message || "刷新数据失败");
      }
    } finally {
      setTimeout(() => {
        if (refreshIcon) refreshIcon.classList.remove("spin");
        isRefreshing = false;
      }, 700);
    }
  }

  // 3. 模型分组逻辑 (Group models by clean base model identity)
  function buildModelGroups(models) {
    const map = new Map();
    const bareUsageMap = window.__MAGPIE_BARE_USAGE__ || {};

    // 先登记每个渠道里出现过的基础模型名，供 stripVariantSuffix 判断
    // 「去掉后缀之后是不是真的存在这个模型」，避免误并 qwen4-max 这类正式名。
    providerBaseNames.clear();
    for (const it of models) {
      if (!it || !it.provider) continue;
      noteProviderBaseName(it.provider, cleanModelName(getBareModel(it.model)), it);
    }

    for (const item of models) {
      if (!item.provider || item.provider === "unknown" || item.provider === "group") continue;
      const bare = getBareModel(item.model);
      if (
        bare === "never-stuck" ||
        bare === "auto" ||
        bare.startsWith("group/") ||
        bare.endsWith("-model") ||
        item.model?.startsWith("group/") ||
        item.model?.includes("/never-stuck") ||
        item.model?.includes("/auto") ||
        item.id === "never-stuck" ||
        item.id === "auto"
      ) {
        continue;
      }
      const groupKey = stripVariantSuffix(item.provider, cleanModelName(bare) || bare, item);
      if (groupKey === "never-stuck" || groupKey === "auto" || groupKey.startsWith("group/") || groupKey.endsWith("-model")) continue;

      if (!map.has(groupKey)) {
        map.set(groupKey, {
          bare: groupKey,
          name: (item.name && item.name !== item.model && !item.name.includes('-control')) ? item.name : (item.matched?.name || groupKey),
          matched: item.matched,
          usage: emptyUsage(),
          items: []
        });
      }
      const g = map.get(groupKey);
      if ((!g.name || g.name === groupKey) && item.name && item.name !== item.model && !item.name.includes('-control')) {
        g.name = item.name;
      }
      if (!g.matched && item.matched) {
        g.matched = item.matched;
      }
      g.items.push(item);
    }

    // 用量按「所有同族变体」累加：一个组里可能同时有 deepseek-v4-flash、
    // deepseek-v4-flash-max、deepseek-v4-flash-official 等，它们各自的用量键
    // 在 /api/usage 里是分开的。原来只查 groupKey 一个键，导致组的调用量与
    // Token 数严重偏低，默认的「用量降序」排序因此完全失真。
    for (const g of map.values()) {
      // 只累加「每个渠道模型自己的原始键」，不能把 cleanModelName 的别名键也加进来：
      // matcher 为兼容查找会同时写原始键和归一化别名键，两个键指向同一批调用；一起
      // 求和会让同族 Token 翻倍（实测 836M 实际只有约 553M）。组裸名只在所有渠道
      // 模型名都匹配不上时兜底一次，避免和单项重复。
      const keys = new Set();
      for (const it of g.items) {
        const bareItem = getBareModel(it.model);
        keys.add(bareItem);
        keys.add(String(bareItem).toLowerCase());
        if (it.id) keys.add(String(it.id).toLowerCase());
      }
      const merged = emptyUsage();
      let matched = false;
      for (const key of keys) {
        const bu = bareUsageMap[key];
        if (!bu) continue;
        matched = true;
        merged.requests += bu.requests || 0;
        merged.totalTokens += bu.totalTokens || 0;
        merged.inputTokens += bu.inputTokens || 0;
        merged.outputTokens += bu.outputTokens || 0;
        merged.cacheRead += bu.cacheRead || 0;
        merged.cacheWrite += bu.cacheWrite || 0;
      }
      if (!matched && bareUsageMap[g.bare]) {
        const bu = bareUsageMap[g.bare];
        merged.requests += bu.requests || 0;
        merged.totalTokens += bu.totalTokens || 0;
        merged.inputTokens += bu.inputTokens || 0;
        merged.outputTokens += bu.outputTokens || 0;
        merged.cacheRead += bu.cacheRead || 0;
        merged.cacheWrite += bu.cacheWrite || 0;
      }
      g.usage = merged;
    }

    return Array.from(map.values());
  }

  function emptyUsage() {
    return {
      requests: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0
    };
  }

  // 组的代表单价：一律用「闲时基础价」，不用高峰时段换算后的显示价，
  // 否则同一份价目表在不同时刻排序会跳来跳去。
  function getGroupRepresentativeInputPrice(g) {
    for (const it of g.items) {
      const p = getModelPrice(it);
      if (!p) continue;
      if (typeof p.baseInput === "number") return p.baseInput;
      if (typeof p.input === "number") return p.input;
      if (p.type === "current") {
        const m = String(p.text || "").match(/\$([\d.]+)\s*\/\s*\$([\d.]+)/);
        if (m) return Number(m[1]);
      }
    }
    return null;
  }

  function sortGroups(list, sortType) {
    const sorted = [...list];
    if (sortType === "default") {
      // 默认「智能排序」：把正在用、能用的排前面。
      // 分档：① 已启用且有调用 → ② 有调用（渠道已停用）→ ③ 已启用但还没调用
      //       → ④ 有价格但未启用 → ⑤ 其他（未定价/未启用）。
      // 档内按 Token 消耗降序，再按调用次数，最后按名称 —— 用户看到的「836M 排在
      // 319M 后面」就是档内先比调用次数造成的；默认用量排序应以 Token 为先。
      const rank = (g) => {
        const used = (g.usage?.requests || 0) > 0;
        const enabled = g.items.some((it) => it.enabled);
        if (used && enabled) return 0;
        if (used) return 1;
        if (enabled) return 2;
        if (g.items.some((it) => !!getModelPrice(it))) return 3;
        return 4;
      };
      sorted.sort((a, b) => {
        const ra = rank(a);
        const rb = rank(b);
        if (ra !== rb) return ra - rb;
        const tb = b.usage?.totalTokens || 0;
        const ta = a.usage?.totalTokens || 0;
        if (tb !== ta) return tb - ta;
        const cb = b.usage?.requests || 0;
        const ca = a.usage?.requests || 0;
        if (cb !== ca) return cb - ca;
        return (a.name || a.bare).localeCompare(b.name || b.bare);
      });
    } else if (sortType === "tokens-desc") {
      // Token 消耗降序，相同再按次数
      sorted.sort((a, b) => {
        const tb = b.usage?.totalTokens || 0;
        const ta = a.usage?.totalTokens || 0;
        if (tb !== ta) return tb - ta;
        const cb = b.usage?.requests || 0;
        const ca = a.usage?.requests || 0;
        if (cb !== ca) return cb - ca;
        return (a.name || a.bare).localeCompare(b.name || b.bare);
      });
    } else if (sortType === "calls-desc") {
      sorted.sort((a, b) => {
        const cb = b.usage?.requests || 0;
        const ca = a.usage?.requests || 0;
        if (cb !== ca) return cb - ca;
        const tb = b.usage?.totalTokens || 0;
        const ta = a.usage?.totalTokens || 0;
        if (tb !== ta) return tb - ta;
        return (a.name || a.bare).localeCompare(b.name || b.bare);
      });
    } else if (sortType === "price-asc") {
      sorted.sort((a, b) => {
        const pa = getGroupRepresentativeInputPrice(a);
        const pb = getGroupRepresentativeInputPrice(b);
        if (pa === null && pb === null) return 0;
        if (pa === null) return 1;
        if (pb === null) return -1;
        return pa - pb;
      });
    } else if (sortType === "price-desc") {
      sorted.sort((a, b) => {
        const pa = getGroupRepresentativeInputPrice(a);
        const pb = getGroupRepresentativeInputPrice(b);
        if (pa === null && pb === null) return 0;
        if (pa === null) return 1;
        if (pb === null) return -1;
        return pb - pa;
      });
    } else if (sortType === "channels-desc") {
      sorted.sort((a, b) => b.items.length - a.items.length);
    } else if (sortType === "name-asc") {
      sorted.sort((a, b) => (a.name || a.bare).localeCompare(b.name || b.bare));
    }
    return sorted;
  }

  // 4. 供应商图标获取辅助函数 (基于 page/icons.js 官方资源与生成式彩色图标降级)
  function getProviderIconHtml(providerId, providerName, providerIcon) {
    if (typeof window.getIconSvg === "function") {
      const svg = window.getIconSvg(providerIcon || providerId, providerId);
      if (svg && !svg.includes("M8 2.2 13.2 5.1v5.8L8 13.8")) return svg;
    }
    const name = providerName || liveProviderNames.get(providerId) || providerId || "?";
    const initial = name.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, "").slice(0, 2).toUpperCase() || name.slice(0, 2).toUpperCase();
    let hash = 0;
    const str = String(providerId || "prov");
    for (let i = 0; i < str.length; i++) hash = (hash << 5) - hash + str.charCodeAt(i);
    const hue = Math.abs(hash) % 360;
    return `<svg viewBox="0 0 32 32" width="100%" height="100%" style="flex:none;line-height:1;border-radius:6px;">
      <rect width="32" height="32" rx="7" fill="hsl(${hue}, 60%, 42%)" />
      <text x="16" y="21" font-size="13" font-weight="bold" fill="#ffffff" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif">${initial}</text>
    </svg>`;
  }

  // 5. 峰谷分时计算：每个模型按自己的时段与倍率判断，时段用本机时钟（与 Magpie 一致）。
  function localTimeString(date = new Date()) {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }

  // 保留给 CLI / 旧调用：默认按 DeepSeek 工作日时段判断；页面价签用 peakRateAt(config)。
  function checkOffPeakStatus(date = new Date(), config = null) {
    const cfg = config || { enabled: true, rate: DEFAULT_PEAK_RATE, windows: DEFAULT_WEEKDAY_WINDOWS };
    const rate = peakRateAt(cfg, date);
    return {
      isOffPeak: rate <= 1,
      peakFactor: rate,
      hour: date.getHours(),
      min: date.getMinutes(),
      day: date.getDay(),
      timeStr: localTimeString(date),
      reason: rate > 1 ? "peak_window" : "offpeak"
    };
  }

  function activePeakModels(date = new Date()) {
    const seen = new Set();
    const active = [];
    for (const item of rawModels) {
      const config = peakConfigFor(item);
      if (!config || !config.enabled) continue;
      if (seen.has(config.key)) continue;
      const rate = peakRateAt(config, date);
      if (rate > 1) {
        seen.add(config.key);
        active.push({ key: config.key, rate });
      }
    }
    return active;
  }

  function updatePeakStatusBar() {
    const bar = $("peak-status-bar");
    const text = $("peak-text");
    const time = $("peak-time");
    if (!bar || !text) return;
    const now = new Date();
    const active = activePeakModels(now);
    const anyEnabled = rawModels.some((item) => {
      const config = peakConfigFor(item);
      return !!(config && config.enabled && config.windows.length);
    });
    if (!anyEnabled) {
      bar.className = "peak-status-bar is-offpeak";
      text.textContent = t("peak_badge_off");
    } else if (active.length) {
      bar.className = "peak-status-bar is-peak";
      text.textContent = active.length === 1
        ? t("peak_badge_live_model", { model: active[0].key, rate: active[0].rate })
        : t("peak_badge_live_multi", { count: active.length });
    } else {
      bar.className = "peak-status-bar is-offpeak";
      text.textContent = t("offpeak_badge_live");
    }
    if (time) time.textContent = "本地 " + localTimeString(now);
  }

  function editingPeakRate() {
    const input = $("peak-rate");
    const value = input ? Number(input.value) : NaN;
    if (Number.isFinite(value) && value > 0 && value <= 1000) return Math.round(value * 1000) / 1000;
    return editingModel ? peakRateFor(editingModel) : DEFAULT_PEAK_RATE;
  }

  // 弹窗当前状态是否按峰谷算（用于价签换算与提示，不等保存）。
  function editingPeakApplies() {
    const toggle = $("peak-model-toggle");
    return !!(editingPeakKey && toggle && toggle.checked && editingPeakWindows.length);
  }

  // 峰谷预览：Magpie 存的是闲时价，高峰时段按其渠道 rateWindows 的倍率计费。
  // 弹窗里可以选「上面填的是闲时价还是高峰价」：填高峰价时保存前 ÷ 倍率换成闲时价。
  function renderPriceModeBanner() {
    const banner = $("price-mode-banner");
    const isPeakInput = peakInputMode === "peak";
    const hourly = editingModel ? editingPeakApplies() : false;
    const tagKey = isPeakInput ? "price_mode_tag_peak" : "price_mode_tag_offpeak";
    const tagText = hourly ? t(tagKey) : t("price_mode_tag_flat");
    for (const id of ["input-cost-mode", "output-cost-mode", "cache-read-cost-mode", "cache-write-cost-mode"]) {
      const el = $(id);
      if (!el) continue;
      el.textContent = tagText;
      el.dataset.mode = hourly ? (isPeakInput ? "peak" : "offpeak") : "flat";
    }
    if (!banner) return;
    if (!hourly) {
      banner.hidden = false;
      banner.dataset.mode = "flat";
      banner.textContent = t("price_mode_banner_flat");
      return;
    }
    banner.hidden = false;
    banner.dataset.mode = isPeakInput ? "peak" : "offpeak";
    banner.textContent = t(isPeakInput ? "price_mode_banner_peak" : "price_mode_banner_offpeak", {
      factor: editingPeakRate()
    });
  }

  function updatePeakPreview() {
    renderPriceModeBanner();
    const hint = $("peak-hint");
    if (hint && hint.hidden) return;
    const inVal = parseFloat($("input-cost")?.value) || 0;
    const outVal = parseFloat($("output-cost")?.value) || 0;
    const rate = editingPeakRate();
    const preview = $("peak-price-preview");
    if (preview) {
      if (peakInputMode === "peak") {
        preview.textContent = `$${+(inVal / rate).toFixed(5)} / $${+(outVal / rate).toFixed(5)}`;
      } else {
        preview.textContent = `$${+(inVal * rate).toFixed(5)} / $${+(outVal * rate).toFixed(5)}`;
      }
    }
    const label = $("peak-price-label");
    if (label) label.textContent = t(peakInputMode === "peak" ? "peak_price_label_to_offpeak" : "peak_price_label", { factor: rate });
  }

  // 只同步状态与高亮，不动输入框里的数值
  function applyPeakInputModeUI(mode) {
    peakInputMode = mode === "peak" ? "peak" : "offpeak";
    const seg = $("peak-input-mode");
    if (seg) {
      for (const btn of seg.querySelectorAll("button[data-mode]")) {
        if (btn.dataset.mode === peakInputMode) btn.setAttribute("aria-selected", "true");
        else btn.removeAttribute("aria-selected");
      }
    }
    updatePeakPreview();
  }

  // 切换「填的是闲时价 / 高峰价」：已填数值按倍率一起换算，语义不变
  function setPeakInputMode(mode) {
    if (mode !== "peak" && mode !== "offpeak") return;
    if (mode === peakInputMode) return;
    const rate = editingPeakRate();
    const scale = mode === "peak" ? 1 / rate : rate;
    for (const id of ["input-cost", "output-cost", "cache-read-cost", "cache-write-cost"]) {
      const el = $(id);
      if (!el) continue;
      const v = parseFloat(el.value);
      if (!Number.isFinite(v)) continue;
      el.value = String(+(v * scale).toFixed(6));
    }
    applyPeakInputModeUI(mode);
  }

  // 6. 定价计算 (含实时峰谷切换)
  function getModelPrice(item) {
    const config = peakConfigFor(item);
    const hourly = peakApplies(item);
    const peakRate = config ? config.rate : DEFAULT_PEAK_RATE;
    const isPeakNow = hourly && peakRateAt(config, new Date()) > 1;
    const isSub = item.providerKind === "subscription";

    const specificCustom = customPrices[item.model];
    const bare = getBareModel(item.model);
    const wildcardCustom = customPrices["*/" + bare];
    const custom = specificCustom || wildcardCustom;
    const scope = specificCustom ? "specific" : wildcardCustom ? "wildcard" : null;

    if (globalMode === "api-only" && isSub && !specificCustom) {
      const origCost = item.matched?.cost || null;
      return {
        type: "subscription-free",
        input: 0,
        output: 0,
        cache_read: 0,
        cache_write: 0,
        hasPeak: false,
        isPeakActive: false,
        isSubFree: true,
        originalCost: origCost,
        text: "$0.00"
      };
    }

    // 自定义定价：存的是「闲时价」，高峰时段由 Magpie 的渠道 rateWindows 按倍率计费
    if (custom) {
      const baseIn = custom.input;
      const baseOut = custom.output;
      const peakIn = hourly ? +(baseIn * peakRate).toFixed(5) : baseIn;
      const peakOut = hourly ? +(baseOut * peakRate).toFixed(5) : baseOut;

      return {
        type: "custom",
        scope,
        input: isPeakNow ? peakIn : baseIn,
        output: isPeakNow ? peakOut : baseOut,
        cache_read: custom.cache_read,
        cache_write: custom.cache_write,
        hasPeak: hourly,
        isPeakActive: isPeakNow,
        peakRate,
        peakInput: peakIn,
        peakOutput: peakOut,
        baseInput: baseIn,
        baseOutput: baseOut
      };
    }

    // 官方匹配公价：models.dev 列的就是闲时价，高峰由 Magpie 的渠道 rateWindows 按倍率计费
    if (item.matched && item.matched.cost) {
      const c = item.matched.cost;
      const baseIn = c.input;
      const baseOut = c.output;
      const peakIn = hourly ? +(baseIn * peakRate).toFixed(5) : baseIn;
      const peakOut = hourly ? +(baseOut * peakRate).toFixed(5) : baseOut;

      return {
        type: "matched",
        input: isPeakNow ? peakIn : baseIn,
        output: isPeakNow ? peakOut : baseOut,
        cache_read: c.cache_read,
        cache_write: c.cache_write,
        hasPeak: hourly,
        isPeakActive: isPeakNow,
        peakRate,
        peakInput: peakIn,
        peakOutput: peakOut,
        baseInput: baseIn,
        baseOutput: baseOut
      };
    }

    if (item.currentPrice && !item.isUnpriced) {
      return {
        type: "current",
        text: item.currentPrice
      };
    }
    return null;
  }

  function renderModeUI() {
    if (globalMode === "api-only") {
      $("mode-btn-api").setAttribute("aria-selected", "true");
      $("mode-btn-all").removeAttribute("aria-selected");
      $("mode-desc-text").innerHTML = t("mode_desc_api");
    } else {
      $("mode-btn-all").setAttribute("aria-selected", "true");
      $("mode-btn-api").removeAttribute("aria-selected");
      $("mode-desc-text").innerHTML = t("mode_desc_all");
    }
  }

  // 7. 初始化与更新供应商下拉筛选
  function renderProviderFilter() {
    const select = $("provider-filter");
    if (!select) return;

    const provMap = new Map();
    for (const m of rawModels) {
      const provId = m.provider;
      if (!provId || provId === "unknown" || provId === "other") continue;
      const provName = m.providerName || liveProviderNames.get(provId) || provId;
      if (!provMap.has(provId)) {
        provMap.set(provId, { id: provId, name: provName, count: 0 });
      }
      provMap.get(provId).count++;
    }

    // 确保从 Magpie 实时读取到的新供应商（即便初始没有价格或模型）也能正常出现在下拉筛选中
    for (const [pId, pName] of liveProviderNames.entries()) {
      if (!pId || pId === "unknown" || pId === "other") continue;
      if (!provMap.has(pId)) {
        provMap.set(pId, { id: pId, name: pName, count: 0 });
      }
    }

    const currentVal = selectedProvider || "all";
    select.innerHTML = "";

    const optAll = document.createElement("option");
    optAll.value = "all";
    const isZh = getLocale().startsWith("zh");
    // 这里显示的是「去重后的模型数」，和「活跃模型」统计同一个口径。
    // 之前用 rawModels.length 是渠道条目数，和上面的卡片数对不上，看着像数据丢了。
    const groupCount = buildModelGroups(rawModels).length;
    const allLabel = isZh
      ? `🏢 ${t("provider_filter_all")} (${provMap.size} 厂商 / ${groupCount} 模型)`
      : `🏢 ${t("provider_filter_all")} (${provMap.size} providers / ${groupCount} models)`;
    optAll.textContent = allLabel;
    select.appendChild(optAll);

    const sorted = Array.from(provMap.values()).sort((a, b) => b.count - a.count);
    for (const prov of sorted) {
      const opt = document.createElement("option");
      opt.value = prov.id;
      opt.textContent = `${prov.name} (${prov.count})`;
      if (prov.id === currentVal) opt.selected = true;
      select.appendChild(opt);
    }

    select.onchange = () => {
      selectedProvider = select.value;
      renderList();
    };
  }

  // 「已生效计费」的口径：api-only 下只算真正走付费 API Key 的渠道；
  // 订阅渠道的 $0.00 只是免记账，不是一笔生效价格。all-equivalent 下免费模型
  // 的等值公价仍然算「有价」，与原有统计保持一致。
  function isBillingEffective(item) {
    const price = getModelPrice(item);
    if (!price) return false;
    if (globalMode === "api-only") {
      // 只记录真实 API 花费：订阅/账号渠道在 Magpie 侧已被写成 $0，
      // 页面里的自定义价也不能算成一笔生效计费，否则统计口径和账单对不上。
      if (item.providerKind !== "api") return false;
      if (price.type === "subscription-free") return false;
    }
    return true;
  }

  // 8. 统计数据刷新 (按模型分组聚合后的统计)
  function renderStats() {
    const allGroups = buildModelGroups(rawModels);
    const totalModels = allGroups.length;
    let customCount = 0;
    let pricedCount = 0;
    let unpricedCount = 0;
    let freeCount = 0;
    let enabledGroupsCount = 0;
    let enabledChannelsCount = 0;

    for (const item of rawModels) {
      if (item.enabled) enabledChannelsCount++;
    }

    for (const g of allGroups) {
      const hasWildcard = !!customPrices["*/" + g.bare];
      const hasAnyCustom = hasWildcard || g.items.some((it) => !!customPrices[it.model]);

      // 免费模型（含 -free 后缀、渠道标记 free、或公价全 0）也要计入「已生效计费」：
      // 它们的成本确实是 0，但调用量与 Token 是真实的，账单统计口径不能把它们当空气。
      // 但 api-only 下订阅渠道返回的 subscription-free 是「免记账」，不能算「已生效计费」。
      const isAnyPriced = g.items.some(isBillingEffective);
      if (isAnyPriced) {
        pricedCount++;
      } else {
        unpricedCount++;
      }

      if (g.items.some(isFreeModelItem)) {
        freeCount++;
      }

      if (hasAnyCustom) {
        customCount++;
      }

      if (g.items.some((it) => it.enabled)) {
        enabledGroupsCount++;
      }
    }

    const usageSummary = window.__MAGPIE_USAGE_SUMMARY__ || { requests: 0, totalTokens: 0 };

    if ($("stat-total")) $("stat-total").textContent = totalModels;
    if ($("stat-enabled")) $("stat-enabled").textContent = enabledGroupsCount;
    if ($("stat-enabled-sub")) $("stat-enabled-sub").textContent = `${enabledChannelsCount} 个渠道启用`;
    if ($("stat-priced")) $("stat-priced").textContent = pricedCount;
    if ($("stat-priced-sub")) {
      const pricedLabel = globalMode === "api-only" ? "tile_priced_s_api" : "tile_priced_s";
      $("stat-priced-sub").textContent = freeCount > 0
        ? `${t(pricedLabel)} · ${t("stat_free_note")} ${freeCount}`
        : t(pricedLabel);
    }
    if ($("stat-custom")) $("stat-custom").textContent = customCount;
    if ($("stat-unpriced")) $("stat-unpriced").textContent = unpricedCount;
    if ($("stat-usage")) $("stat-usage").textContent = formatNumber(usageSummary.requests);
    if ($("stat-usage-sub")) $("stat-usage-sub").textContent = `${formatTokens(usageSummary.totalTokens)} Tokens`;
    if ($("stat-usage-k")) {
      $("stat-usage-k").textContent = usagePeriod === "all" ? t("tile_usage_k") : t("tile_usage_k_30d");
    }
  }

  // 免费模型判定：渠道标记 free、名字带 -free、或公价四项全 0
  function isFreeModelItem(item) {
    if (!item) return false;
    if (item.free) return true;
    const bare = getBareModel(item.model || "");
    if (/(^|-)free($|-)/i.test(bare)) return true;
    const c = item.matched && item.matched.cost;
    if (!c) return false;
    return (Number(c.input) || 0) === 0 && (Number(c.output) || 0) === 0;
  }

  // 9. 核心列表渲染 (按模型分组 + 供应商图标 + 展开/折叠渠道价格)
  function renderList() {
    // Filter the model entries before grouping. Filtering groups after grouping
    // keeps every channel of a group, so a group with one OpenCode API model
    // would also show Trae/WorkBuddy subscription rows under the API tab.
    let kindFilter = selectedKind && selectedKind !== "all" ? selectedKind : "";
    if (filter === "api") kindFilter = "api";
    else if (filter === "login" || filter === "subscription") kindFilter = "subscription";
    const sourceModels = kindFilter
      ? rawModels.filter((it) => it.providerKind === kindFilter)
      : rawModels;
    const allGroups = buildModelGroups(sourceModels);
    let list = allGroups;

    // Filter by tab
    if (filter === "enabled") {
      if (selectedProvider && selectedProvider !== "all") {
        list = list.filter((g) => g.items.some((it) => (it.provider || "other") === selectedProvider && it.enabled));
      } else {
        list = list.filter((g) => g.items.some((it) => it.enabled));
      }
    } else if (filter === "api") {
      list = list.filter((g) => g.items.some((it) => it.providerKind === "api"));
    } else if (filter === "login" || filter === "subscription") {
      list = list.filter((g) => g.items.some((it) => it.providerKind === "subscription"));
    } else if (filter === "custom") {
      list = list.filter((g) => {
        return !!customPrices["*/" + g.bare] || g.items.some((it) => !!customPrices[it.model]);
      });
    } else if (filter === "unpriced") {
      // 与「已生效计费」统计同一口径：拿不到任何价格才算未定价，
      // 免费模型的等值公价也算「有价」，否则标签数和统计数对不上。
      list = list.filter((g) => !g.items.some((it) => !!getModelPrice(it)));
    } else if (filter === "matched") {
      list = list.filter((g) => !!g.matched || g.items.some((it) => !!it.matched));
    } else if (filter === "offpeak") {
      list = list.filter((g) => {
        return (
          g.items.some(isHourlyBilled) ||
          g.items.some((it) => {
            const p = getModelPrice(it);
            return !!(p && p.hasPeak) || isHourlyBilled(it);
          })
        );
      });
    }

    // Filter by price category (free / paid / unpriced)
    if (selectedPrice && selectedPrice !== "all") {
      list = list.filter((g) => {
        const hasPrice = g.items.some((it) => !!getModelPrice(it));
        if (selectedPrice === "unpriced") return !hasPrice;
        if (!hasPrice) return false;
        const isFreeGroup = g.items.some((it) => {
          const p = getModelPrice(it);
          if (!p) return false;
          if (p.type === "current") return /0\.0*0|free/i.test(p.text || "");
          return (Number(p.input) || 0) === 0 && (Number(p.output) || 0) === 0;
        });
        if (selectedPrice === "free") return isFreeGroup;
        if (selectedPrice === "paid") return g.items.some((it) => {
          const p = getModelPrice(it);
          if (!p) return false;
          if (p.type === "current") return !/0\.0*0|free/i.test(p.text || "");
          return (Number(p.input) || 0) > 0 || (Number(p.output) || 0) > 0;
        });
        return true;
      });
    }

    // Filter by selected provider type (kind: API vs 登录)
    if (selectedKind && selectedKind !== "all") {
      if (selectedKind === "api") {
        list = list.filter((g) => g.items.some((it) => it.providerKind === "api" && (filter !== "enabled" || it.enabled)));
      } else if (selectedKind === "subscription" || selectedKind === "login") {
        list = list.filter((g) => g.items.some((it) => it.providerKind === "subscription" && (filter !== "enabled" || it.enabled)));
      }
    }

    // Filter by selected provider
    if (selectedProvider && selectedProvider !== "all") {
      list = list.filter((g) => g.items.some((it) => (it.provider || "other") === selectedProvider));
    }

    // Filter by search query
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((g) => {
        if (g.bare.toLowerCase().includes(q)) return true;
        if (g.name && g.name.toLowerCase().includes(q)) return true;
        if (g.matched && (g.matched.provider + "/" + g.matched.model).toLowerCase().includes(q)) return true;
        return g.items.some(
          (it) =>
            it.model.toLowerCase().includes(q) ||
            (it.provider && it.provider.toLowerCase().includes(q)) ||
            (it.providerName && it.providerName.toLowerCase().includes(q))
        );
      });
    }

    // Apply sorting
    list = sortGroups(list, currentSort);

    const listContainer = $("models-list");
    listContainer.innerHTML = "";

    if (list.length === 0) {
      $("empty-hint").hidden = false;
      return;
    }
    $("empty-hint").hidden = true;

    for (const group of list) {
      const card = document.createElement("div");
      card.className = "model-card";

      const wildcardCustom = customPrices["*/" + group.bare];
      const hasChannelCustom = group.items.some((it) => !!customPrices[it.model]);
      const hasCustom = !!(wildcardCustom || hasChannelCustom);

      // Default expand state rule:
      // "默认不展开因为价格都一样除非自定义了"
      const isExpanded = userToggledGroups.has(group.bare)
        ? userToggledGroups.get(group.bare)
        : defaultExpanded;

      // Card Header
      const header = document.createElement("div");
      header.className = "card-header";

      // Left: Provider icon stack + Model title + Provider names
      const leftDiv = document.createElement("div");
      leftDiv.className = "header-left";

      // Collect unique providers offering this model
      const seenProviders = new Map();
      for (const item of group.items) {
        const pKey = item.provider || "other";
        if (!seenProviders.has(pKey)) {
          seenProviders.set(pKey, {
            name: item.providerName || pKey,
            icon: item.providerIcon || null
          });
        }
      }

      // 供应商头像堆叠 (参考 Magpie MCP / Skill 展示规范)
      const stackDiv = document.createElement("div");
      stackDiv.className = "provider-icon-stack";
      let zIdx = seenProviders.size;
      for (const [pId, pMeta] of seenProviders.entries()) {
        const iconDiv = document.createElement("div");
        iconDiv.className = "provider-squircle-icon";
        iconDiv.style.zIndex = zIdx--;
        iconDiv.title = pMeta.name;
        iconDiv.innerHTML = getProviderIconHtml(pId, pMeta.name, pMeta.icon);
        stackDiv.appendChild(iconDiv);
      }

      const titleBlock = document.createElement("div");
      titleBlock.className = "model-title-block";

      const nameRow = document.createElement("div");
      nameRow.className = "model-name-row";

      const titleSpan = document.createElement("span");
      titleSpan.className = "m-title";
      titleSpan.textContent = group.name || group.bare;

      const codeSpan = document.createElement("span");
      codeSpan.className = "m-id-code";
      codeSpan.textContent = group.bare;

      nameRow.append(titleSpan, codeSpan);

      // 峰谷角标：官方价目表里分时定价的模型族才显示，点一下就能给整个模型族开关，
      // 不用每次都进弹窗。默认按官方清单（DeepSeek 系）开启。
      const groupFamily = group.items.map(peakFamilyOf).find(Boolean);
      const groupPeakItem = groupFamily ? (group.items.find((it) => peakFamilyOf(it)?.key === groupFamily.key) || group.items[0]) : null;
      if (groupFamily && groupPeakItem && peakFamilyEnabled(groupFamily.key)) {
        const on = true;
        const groupRate = peakRateFor(groupPeakItem);
        const offPeakTag = document.createElement("button");
        offPeakTag.type = "button";
        offPeakTag.className = "badge-peak-toggle" + (on ? " is-on" : " is-off");
        offPeakTag.textContent = t("peak_family_badge", { factor: groupRate });
        offPeakTag.title = t(on ? "toast_peak_on" : "toast_peak_off", { model: groupFamily.key, factor: groupRate });
        offPeakTag.addEventListener("click", (e) => {
          e.stopPropagation();
          const next = !peakFamilyEnabled(groupFamily.key);
          setPeakFamilyEnabled(groupFamily.key, next);
          showToast(t(next ? "toast_peak_on" : "toast_peak_off", { model: groupFamily.key, factor: groupRate }));
          renderList();
          renderStats();
          persistOptions().catch(() => {});
        });
        nameRow.append(offPeakTag);
      }

      const namesDiv = document.createElement("div");
      namesDiv.className = "provider-names-text";
      namesDiv.textContent = Array.from(seenProviders.values()).map(p => p.name).join(" · ");

      titleBlock.append(nameRow, namesDiv);
      leftDiv.append(stackDiv, titleBlock);

      // Right: Price summary & Expand toggle
      const rightDiv = document.createElement("div");
      rightDiv.className = "header-right";

      // Group Usage Pill (if group has recorded calls/tokens)
      if (group.usage && group.usage.requests > 0) {
        const usagePill = document.createElement("div");
        usagePill.className = "usage-pill";
        usagePill.title = `历史调用: ${formatNumber(group.usage.requests)} 次\n输入: ${formatTokens(group.usage.inputTokens)} Tokens\n输出: ${formatTokens(group.usage.outputTokens)} Tokens\n缓存: ${formatTokens(group.usage.cacheRead)} Tokens`;
        const labelText = group.usage.totalTokens > 0
          ? `${formatTokens(group.usage.totalTokens)} (${formatNumber(group.usage.requests)}次)`
          : `${formatNumber(group.usage.requests)}次`;
        usagePill.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg><span>${labelText}</span>`;
        rightDiv.appendChild(usagePill);
      }

      const priceSummary = document.createElement("div");
      priceSummary.className = "price-summary";

      // Representative pricing
      const firstPricedItem = group.items.find((it) => !!getModelPrice(it)) || group.items[0];
      const repPrice = getModelPrice(firstPricedItem);

      function renderUnpricedBadge() {
        const unpricedSpan = document.createElement("span");
        unpricedSpan.className = "badge-tag badge-unpriced";
        unpricedSpan.textContent = t("badge_unpriced");

        const quickSetBtn = document.createElement("button");
        quickSetBtn.type = "button";
        quickSetBtn.className = "btn-quick-set";
        quickSetBtn.textContent = `+ ${t("btn_set_price")}`;
        quickSetBtn.title = `为 ${group.bare} 设定价格`;
        quickSetBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          openEditModal(firstPricedItem, "wildcard");
        });

        const wrap = document.createElement("div");
        wrap.className = "badge-unpriced-wrap";
        wrap.append(unpricedSpan, quickSetBtn);
        priceSummary.append(wrap);
      }

      if (globalMode === "api-only") {
        const apiItems = group.items.filter((it) => it.providerKind === "api");
        const subItems = group.items.filter((it) => it.providerKind === "subscription");
        const enabledApi = apiItems.filter((it) => it.enabled);
        const enabledSub = subItems.filter((it) => it.enabled);

        if (apiItems.length === 0) {
          // 全部为账号登录/订阅渠道：在真实 API 支出模式下直接为 $0.00
          const mainRate = document.createElement("span");
          mainRate.className = "main-rate rate-zero";
          mainRate.style.color = "var(--green)";
          mainRate.style.fontWeight = "600";
          mainRate.textContent = "$0.00 / 1M";

          const subCache = document.createElement("span");
          subCache.className = "sub-cache";
          if (repPrice && repPrice.originalCost) {
            subCache.innerHTML = `<span style="color: var(--green);">${escapeHtml(t("badge_sub_free", "免额外 API 费"))}</span> · <span style="text-decoration: line-through; opacity: 0.65;">${escapeHtml(t("market_price_prefix", "公价"))} $${repPrice.originalCost.input}/$${repPrice.originalCost.output}</span>`;
          } else {
            subCache.innerHTML = `<span style="color: var(--green);">${escapeHtml(t("badge_sub_free_card", "账号登录免额外 API 费"))}</span>`;
          }
          priceSummary.append(mainRate, subCache);
        } else if (subItems.length > 0) {
          // 既有按量 API 渠道，又有账号登录渠道
          const apiRep = apiItems.find((it) => !!getModelPrice(it)) || apiItems[0];
          const apiPrice = getModelPrice(apiRep);

          if (enabledApi.length === 0 && enabledSub.length > 0) {
            // 当前仅启用了免 API 费的账号登录渠道
            const mainRate = document.createElement("span");
            mainRate.className = "main-rate rate-zero";
            mainRate.style.color = "var(--green)";
            mainRate.style.fontWeight = "600";
            mainRate.textContent = "$0.00 / 1M";

            const subCache = document.createElement("span");
            subCache.className = "sub-cache";
            const apiText = apiPrice && typeof apiPrice.input === "number" ? ` · API $${apiPrice.input}/$${apiPrice.output}` : "";
            subCache.innerHTML = `<span style="color: var(--green); font-weight: 500;">${escapeHtml(t("active_sub_channels_free", "当前启用渠道免 API 费"))}</span>${apiText}`;
            priceSummary.append(mainRate, subCache);
          } else {
            // 混合启用或启用了 API 渠道
            const mainRate = document.createElement("span");
            mainRate.className = "main-rate";
            if (apiPrice && apiPrice.hasPeak) {
              mainRate.textContent = `${t("peak_tag")} $${apiPrice.peakInput}/$${apiPrice.peakOutput} (API)`;
            } else if (apiPrice && typeof apiPrice.input === "number") {
              mainRate.textContent = `$${apiPrice.input} / $${apiPrice.output} (API)`;
            } else {
              mainRate.textContent = "$0.00 / 1M";
            }

            const subCache = document.createElement("span");
            subCache.className = "sub-cache";
            subCache.innerHTML = `<span style="color: var(--green); font-weight: 500;">${escapeHtml(t("contains_free_channels", "含免 API 费账号渠道 ($0.00)"))}</span>`;
            priceSummary.append(mainRate, subCache);
          }
        } else {
          // 全部为付费 API 渠道
          if (repPrice && (repPrice.type === "custom" || repPrice.type === "matched")) {
            const mainRate = document.createElement("span");
            mainRate.className = "main-rate";
            const subCache = document.createElement("span");
            subCache.className = "sub-cache";
            if (repPrice.hasPeak) {
              mainRate.textContent = `$${repPrice.input} / $${repPrice.output}`;
              subCache.textContent = `${t("peak_tag")} $${repPrice.peakInput}/$${repPrice.peakOutput} (×${repPrice.peakRate || DEFAULT_PEAK_RATE})`;
            } else {
              mainRate.textContent = `$${repPrice.input} / $${repPrice.output}`;
              subCache.textContent = `${t("cache_label")} $${repPrice.cache_read}/$${repPrice.cache_write} · ${t("paid_api_badge", "按量 API")}`;
            }
            priceSummary.append(mainRate, subCache);
          } else if (repPrice && repPrice.type === "current") {
            const curRate = document.createElement("span");
            curRate.className = "main-rate";
            curRate.style.color = "var(--green)";
            curRate.textContent = repPrice.text;
            priceSummary.append(curRate);
          } else {
            renderUnpricedBadge();
          }
        }
      } else {
        // all-equivalent 模式（显示所有渠道等值公价）
        if (repPrice && (repPrice.type === "custom" || repPrice.type === "matched")) {
          const mainRate = document.createElement("span");
          mainRate.className = "main-rate";
          const subCache = document.createElement("span");
          subCache.className = "sub-cache";
          if (repPrice.hasPeak) {
            mainRate.textContent = `$${repPrice.input} / $${repPrice.output}`;
            subCache.textContent = `${t("peak_tag")} $${repPrice.peakInput}/$${repPrice.peakOutput} (×${repPrice.peakRate || DEFAULT_PEAK_RATE})`;
          } else {
            mainRate.textContent = `$${repPrice.input} / $${repPrice.output}`;
            subCache.textContent = `${t("cache_label")} $${repPrice.cache_read}/$${repPrice.cache_write}`;
          }
          priceSummary.append(mainRate, subCache);
        } else if (repPrice && repPrice.type === "current") {
          const curRate = document.createElement("span");
          curRate.className = "main-rate";
          curRate.style.color = "var(--green)";
          curRate.textContent = repPrice.text;
          priceSummary.append(curRate);
        } else {
          renderUnpricedBadge();
        }
      }

      // Status badge (Custom vs Consistent)
      if (hasCustom) {
        const customBadge = document.createElement("span");
        customBadge.className = "badge-tag badge-custom";
        customBadge.textContent = t("badge_has_custom");
        priceSummary.appendChild(customBadge);
      }

      // Expand toggle badge/button
      const toggleBtn = document.createElement("button");
      toggleBtn.type = "button";
      toggleBtn.className = "expand-toggle" + (hasCustom ? " is-custom" : "");
      const provCount = group.items.length;
      if (isExpanded) {
        toggleBtn.textContent = t("collapse_providers");
      } else {
        toggleBtn.textContent = t("expand_providers", { count: provCount });
      }

      rightDiv.append(priceSummary, toggleBtn);
      header.append(leftDiv, rightDiv);

      // Header click toggles expand/collapse
      header.addEventListener("click", (e) => {
        // Toggle state
        const newState = !isExpanded;
        userToggledGroups.set(group.bare, newState);
        renderList();
      });

      card.appendChild(header);

      // If expanded, render all channels under this model
      if (isExpanded) {
        const expandBody = document.createElement("div");
        expandBody.className = "card-expand-body";

        // Optional quick action bar for group-level wildcard pricing
        const topBar = document.createElement("div");
        topBar.style.cssText = "display: flex; align-items: center; justify-content: space-between; padding-bottom: 6px; border-bottom: 1px solid var(--line-2); font-size: 11px; color: var(--muted);";
        topBar.innerHTML = `<span>${escapeHtml(t("channel_title"))} (${group.items.length})</span>`;

        const btnWildcardEdit = document.createElement("button");
        btnWildcardEdit.type = "button";
        btnWildcardEdit.className = "btn btn-small";
        btnWildcardEdit.style.fontSize = "11px";
        btnWildcardEdit.style.padding = "2px 8px";
        btnWildcardEdit.textContent = wildcardCustom ? `★ ${t("scope_wildcard")}: $${wildcardCustom.input}/$${wildcardCustom.output}` : `+ ${t("scope_wildcard")} (*/${group.bare})`;
        btnWildcardEdit.addEventListener("click", (e) => {
          e.stopPropagation();
          openEditModal(group.items[0], "wildcard");
        });
        topBar.appendChild(btnWildcardEdit);
        expandBody.appendChild(topBar);

        for (const item of group.items) {
          const subrow = document.createElement("div");
          subrow.className = "provider-subrow" + (item.enabled ? "" : " is-disabled");

          const rowLeft = document.createElement("div");
          rowLeft.className = "subrow-left";

          const pIcon = document.createElement("div");
          pIcon.className = "provider-squircle-icon subrow-icon";
          pIcon.title = item.providerName || item.provider || "Channel";
          pIcon.innerHTML = getProviderIconHtml(item.provider, item.providerName, item.providerIcon);

          const provName = document.createElement("span");
          provName.className = "subrow-pname";
          provName.textContent = item.providerName || item.provider || "Channel";

          const modelIdSpan = document.createElement("span");
          modelIdSpan.className = "subrow-model-id";
          modelIdSpan.textContent = item.model;

          // Status Badge: 🟢 已启用 / ⚪ 已停用
          const statusBadge = document.createElement("span");
          statusBadge.className = "badge-status " + (item.enabled ? "status-on" : "status-off");
          statusBadge.textContent = item.enabled ? t("badge_status_enabled") : t("badge_status_disabled");

          const isSub = item.providerKind === "subscription";
          const kindBadge = document.createElement("span");
          kindBadge.style.cssText = isSub
            ? "font-size: 10px; color: var(--muted); border: 1px solid var(--line); border-radius: 3px; padding: 0 4px;"
            : "font-size: 10px; color: var(--accent); border: 1px solid var(--accent); border-radius: 3px; padding: 0 4px;";
          kindBadge.textContent = isSub ? t("badge_subscription") : t("badge_paid_api");

          rowLeft.append(pIcon, provName, modelIdSpan, statusBadge, kindBadge);

          const rowRight = document.createElement("div");
          rowRight.className = "subrow-right";

          if (item.usage && item.usage.requests > 0) {
            const subUsage = document.createElement("span");
            subUsage.className = "subrow-usage";
            subUsage.title = `历史调用: ${formatNumber(item.usage.requests)} 次\n输入: ${formatTokens(item.usage.inputTokens)} Tokens\n输出: ${formatTokens(item.usage.outputTokens)} Tokens\n缓存: ${formatTokens(item.usage.cacheRead)} Tokens`;
            const subLabel = item.usage.totalTokens > 0
              ? `${formatTokens(item.usage.totalTokens)} (${formatNumber(item.usage.requests)}次)`
              : `${formatNumber(item.usage.requests)}次`;
            subUsage.textContent = subLabel;
            rowRight.appendChild(subUsage);
          }

          const priceSpan = document.createElement("div");
          priceSpan.className = "subrow-price";

          const itemPrice = getModelPrice(item);
          if (globalMode === "api-only" && item.providerKind === "subscription" && !customPrices[item.model]) {
            const orig = item.matched?.cost;
            const origStr = orig ? `<span class="rate-del" style="font-size: 10.5px; color: var(--faint); text-decoration: line-through; margin-left: 5px;" title="${escapeHtml(t("market_price_prefix", "公价"))}">${escapeHtml(t("market_price_prefix", "公价"))} $${orig.input}/$${orig.output}</span>` : "";
            priceSpan.innerHTML = `<span class="rate-zero" style="color: var(--green); font-weight: 600;">$0.00 / 1M</span> <span style="font-size: 11px; color: var(--muted); margin-left: 2px;">(${escapeHtml(t("badge_sub_free", "免额外API费"))})</span>${origStr}`;
          } else if (itemPrice && (itemPrice.type === "custom" || itemPrice.type === "matched")) {
            const hasItemSpecificCustom = !!customPrices[item.model];
            const hasWildcardPrice = !hasItemSpecificCustom && !!customPrices["*/" + group.bare];

            let badgeHtml = "";
            if (hasItemSpecificCustom) {
              badgeHtml = `<span class="badge-tag badge-custom" style="font-size: 10px;">${escapeHtml(t("scope_specific_badge"))}</span>`;
            } else if (hasWildcardPrice) {
              badgeHtml = `<span class="badge-tag badge-custom" style="font-size: 10px;">${escapeHtml(t("scope_wildcard_badge"))}</span>`;
            }
            if (globalMode === "api-only" && item.providerKind === "api") {
              badgeHtml += ` <span style="font-size: 9.5px; color: var(--accent); border: 1px solid var(--accent); border-radius: 3px; padding: 0 3px; margin-left: 3px;">${escapeHtml(t("paid_api_badge", "按量 API"))}</span>`;
            }

            priceSpan.innerHTML = `$${itemPrice.input} / $${itemPrice.output} ${badgeHtml}`;
          } else if (itemPrice && itemPrice.type === "current") {
            priceSpan.innerHTML = `<span style="color: var(--green);">${escapeHtml(itemPrice.text)}</span>`;
          } else {
            priceSpan.innerHTML = `<span class="badge-tag badge-unpriced">${escapeHtml(t("badge_unpriced"))}</span>`;
          }

          const btnEdit = document.createElement("button");
          btnEdit.type = "button";
          btnEdit.className = "btn btn-small";
          const hasItemCustom = !!customPrices[item.model];
          btnEdit.textContent = hasItemCustom ? t("btn_edit_price") : (itemPrice ? t("btn_edit_price") : `+ ${t("btn_set_price")}`);
          btnEdit.addEventListener("click", (e) => {
            e.stopPropagation();
            openEditModal(item, "specific");
          });

          rowRight.append(priceSpan, btnEdit);

          const hasDirectCustom = !!customPrices[item.model];
          if (hasDirectCustom) {
            const btnReset = document.createElement("button");
            btnReset.type = "button";
            btnReset.className = "btn btn-small";
            btnReset.style.color = "var(--red)";
            btnReset.textContent = t("btn_reset");
            btnReset.addEventListener("click", (e) => {
              e.stopPropagation();
              resetModelPrice(item.model);
            });
            rowRight.appendChild(btnReset);
          }

          subrow.append(rowLeft, rowRight);
          expandBody.appendChild(subrow);
        }

        card.appendChild(expandBody);
      }

      listContainer.appendChild(card);
    }
  }

  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // 10. 编辑定价弹窗交互
  // 弹窗里的峰谷区：该模型的启用开关、倍率、时段列表；打开时从 modelPeaks 取。
  function refreshModalPeakUI(item) {
    if (!item) return;
    const family = peakFamilyOf(item);
    const config = peakConfigFor(item);
    editingPeakKey = family ? family.key : null;
    editingPeakWindows = config ? copyPeakWindows(config.windows) : [];
    if ($("peak-hint")) $("peak-hint").hidden = !family;
    if ($("peak-editor-model")) $("peak-editor-model").textContent = family ? "· " + family.key : "";
    const toggle = $("peak-model-toggle");
    if (toggle) toggle.checked = !!(config && config.enabled);
    const rate = $("peak-rate");
    if (rate) rate.value = String((config && config.rate) || DEFAULT_PEAK_RATE);
    if ($("peak-model-toggle-label")) $("peak-model-toggle-label").textContent = t("peak_model_toggle");
    renderEditingPeakWindows();
    const hintText = $("peak-hint-text");
    if (hintText) {
      const on = !!(config && config.enabled);
      const hintKey = !family ? "peak_hint_flat" : on ? "peak_hint_model_on" : "peak_hint_model_off";
      hintText.innerHTML = t(hintKey, { factor: (config && config.rate) || DEFAULT_PEAK_RATE });
    }
    renderPriceModeBanner();
  }

  function renderEditingPeakWindows() {
    const box = $("model-peak-windows");
    if (!box) return;
    box.innerHTML = "";
    if (!editingPeakWindows.length) {
      const p = document.createElement("p");
      p.className = "rate-empty";
      p.textContent = t("rate_empty");
      box.appendChild(p);
      return;
    }
    editingPeakWindows.forEach((w, i) => box.appendChild(modelPeakWindowRow(w, i)));
  }

  function modelPeakWindowRow(w, index) {
    const row = document.createElement("div");
    row.className = "rate-window";
    const days = document.createElement("div");
    days.className = "rate-days";
    for (let d = 0; d < 7; d++) {
      const label = document.createElement("label");
      label.className = "rate-day";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = w.days.length ? w.days.includes(d) : true;
      cb.addEventListener("change", () => {
        const set = new Set(w.days.length ? w.days : [0, 1, 2, 3, 4, 5, 6]);
        if (cb.checked) set.add(d); else set.delete(d);
        w.days = Array.from(set).sort((a, b) => a - b);
      });
      const span = document.createElement("span");
      span.textContent = RATE_WEEK[d];
      label.append(cb, span);
      days.appendChild(label);
    }
    const start = document.createElement("input");
    start.type = "text";
    start.value = w.start;
    start.placeholder = "09:00";
    start.addEventListener("input", () => { w.start = start.value.trim(); });
    const sep = document.createElement("span");
    sep.className = "rate-sep";
    sep.textContent = "—";
    const end = document.createElement("input");
    end.type = "text";
    end.value = w.end;
    end.placeholder = "18:00";
    end.addEventListener("input", () => { w.end = end.value.trim(); });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn rate-del";
    del.textContent = "×";
    del.title = t("peak_window_delete");
    del.addEventListener("click", () => {
      editingPeakWindows.splice(index, 1);
      renderEditingPeakWindows();
    });
    row.append(days, start, sep, end, del);
    return row;
  }

  function openEditModal(item, forceScope) {
    editingModel = item;
    const bare = getBareModel(item.model);

    $("modal-model-title").textContent = t("modal_title_set", { model: item.model });
    $("modal-model-sub").textContent = item.name
      ? t("modal_sub_official", { name: item.name })
      : t("modal_sub_default");
    $("scope-model-label").textContent = item.model;
    $("scope-wild-label").textContent = bare;

    if (forceScope) {
      setScope(forceScope);
    } else if (customPrices["*/" + bare] && !customPrices[item.model]) {
      setScope("wildcard");
    } else {
      setScope("specific");
    }

    const specificCustom = customPrices[item.model];
    const wildcardCustom = customPrices["*/" + bare];
    const custom = specificCustom || wildcardCustom;

    refreshModalPeakUI(item);
    applyPeakInputModeUI("offpeak");

    if (custom) {
      $("input-cost").value = custom.input;
      $("output-cost").value = custom.output;
      $("cache-read-cost").value = custom.cache_read;
      $("cache-write-cost").value = custom.cache_write;
    } else if (item.matched) {
      const c = item.matched.cost;
      $("input-cost").value = c.input;
      $("output-cost").value = c.output;
      $("cache-read-cost").value = c.cache_read;
      $("cache-write-cost").value = c.cache_write;
    } else {
      $("input-cost").value = "0";
      $("output-cost").value = "0";
      $("cache-read-cost").value = "0";
      $("cache-write-cost").value = "0";
    }

    updatePeakPreview();
    $("edit-modal").hidden = false;
    $("input-cost").focus();
  }

  function setScope(scope) {
    selectedScope = scope;
    if (scope === "wildcard") {
      $("scope-wildcard").setAttribute("aria-selected", "true");
      $("scope-specific").removeAttribute("aria-selected");
      $("scope-hint").textContent = t("scope_hint_wildcard", {
        model: getBareModel(editingModel?.model || "")
      });
    } else {
      $("scope-specific").setAttribute("aria-selected", "true");
      $("scope-wildcard").removeAttribute("aria-selected");
      $("scope-hint").textContent = t("scope_hint_specific", {
        model: editingModel?.model || ""
      });
    }
  }

  function closeEditModal() {
    $("edit-modal").hidden = true;
    editingModel = null;
  }

  async function saveModelPrice() {
    if (!editingModel) return;
    const bare = getBareModel(editingModel.model);
    const targetKey = selectedScope === "wildcard" ? "*/" + bare : editingModel.model;

    // 弹窗里可能刚改过该模型的峰谷开关/倍率/时段：保存价格时一起落盘。
    const modalPeakEnabled = $("peak-model-toggle") ? $("peak-model-toggle").checked : false;
    const modalPeakRate = editingPeakRate();
    const hourly = !!(editingPeakKey && modalPeakEnabled && editingPeakWindows.length);
    // 只有用户改过峰谷、或该模型原本就有配置时才写 modelPeaks；
    // 普通非 DeepSeek 模型保存价格时不产生一堆 enabled:false 的空配置。
    const hadPeakConfig = !!(editingPeakKey && Object.prototype.hasOwnProperty.call(modelPeaks, editingPeakKey));
    const peakTouched = hadPeakConfig || modalPeakEnabled || editingPeakWindows.length > 0 || modalPeakRate !== DEFAULT_PEAK_RATE;
    if (editingPeakKey && peakTouched) {
      modelPeaks[editingPeakKey] = {
        enabled: modalPeakEnabled,
        rate: modalPeakRate,
        windows: copyPeakWindows(editingPeakWindows)
      };
    }

    // 填的是高峰价时先换成闲时价再落盘：Magpie 的 modelPrices 存的始终是闲时价，
    // 高峰时段由渠道 rateWindows 按本模型倍率计费。
    const toStored = (v) => (hourly && peakInputMode === "peak" ? +(v / modalPeakRate).toFixed(6) : v);

    const inVal = toStored(parseFloat($("input-cost").value) || 0);
    const outVal = toStored(parseFloat($("output-cost").value) || 0);

    const priceObj = {
      input: inVal,
      output: outVal,
      cache_read: toStored(parseFloat($("cache-read-cost").value) || 0),
      cache_write: toStored(parseFloat($("cache-write-cost").value) || 0)
    };

    customPrices[targetKey] = priceObj;
    pendingRemovals = pendingRemovals.filter((key) => key !== targetKey);

    if (selectedScope === "wildcard" && customPrices[editingModel.model]) {
      delete customPrices[editingModel.model];
      if (!pendingRemovals.includes(editingModel.model)) pendingRemovals.push(editingModel.model);
    }

    const synced = await persistOptions();
    closeEditModal();
    renderStats();
    renderList();
    updatePeakStatusBar();
    // 保存后回读自检：告诉用户这份价到底进没进 Magpie 的计费表
    const report = synced ? await verifyPrices() : null;
    const verified = describeVerify(report, targetKey);
    const prefix = hourly && peakInputMode === "peak"
      ? t("toast_rate_saved_peak", { key: targetKey, stored: `$${priceObj.input}/$${priceObj.output}`, factor: modalPeakRate })
      : t("toast_rate_saved", { key: targetKey });
    showToast(verified ? prefix + " · " + verified : prefix);
  }

  async function resetModelPrice(model) {
    const bare = getBareModel(model);
    delete customPrices[model];
    delete customPrices["*/" + bare];
    if (!pendingRemovals.includes(model)) pendingRemovals.push(model);
    if (!pendingRemovals.includes("*/" + bare)) pendingRemovals.push("*/" + bare);

    await persistOptions();
    renderStats();
    renderList();
    showToast(t("toast_rate_reset", { model }));
  }

  function setGlobalMode(mode) {
    if (globalMode === mode) return;
    globalMode = mode;
    try {
      localStorage.setItem("magpie_models_price_mode", mode);
    } catch (e) {}
    renderModeUI();
    renderStats();
    renderList();
    showToast(mode === "api-only" ? t("toast_mode_api") : t("toast_mode_all"));
    persistOptions().catch((e) => console.warn("Failed to persist options:", e));
  }

  // persistOptions hands one save to magpie, which stores it as this plugin's
  // options and reloads the plugin host; the plugin applies that save once, at
  // the reload, and writes settings.json itself.
  //
  // A page in magpie's window cannot write the file: its CSP is connect-src
  // 'none', so the fetch to a local service this used to try never left the
  // frame. It has no need to either — the bridge reaches magpie.
  //
  // applyToken marks the save as new. The plugin applies a token once and skips
  // it afterwards, so a reload for another reason (magpie starting, a plugin
  // toggled) writes nothing. The token is only fresh when something changed:
  // re-saving an unchanged page must not make magpie reload the host.
  function optionsSignature(payload) {
    const keys = Object.keys(payload).sort();
    return JSON.stringify(keys.map((k) => [k, payload[k]]));
  }

  function clonePriceMap(prices) {
    return JSON.parse(JSON.stringify(prices || {}));
  }

  // Only the keys whose value differs from the prices the page last loaded or
  // saved are sent to the plugin. A key deleted in the page becomes removed.
  function diffPriceChanges(current, baseline) {
    const changes = {};
    for (const [key, value] of Object.entries(current || {})) {
      if (JSON.stringify(value) !== JSON.stringify((baseline || {})[key])) changes[key] = value;
    }
    const removed = Object.keys(baseline || {}).filter((key) => !(key in (current || {})));
    for (const key of pendingRemovals) {
      if (!removed.includes(key)) removed.push(key);
    }
    return { changes, removed };
  }

  async function persistOptions() {
    const { changes, removed } = diffPriceChanges(customPrices, savedCustomPrices);
    const payload = {
      mode: globalMode,
      // 每个模型的峰谷配置：{ enabled, rate, windows:[{days,start,end}] }
      modelPeaks,
      // Full map kept for the page state; the plugin applies priceChanges only.
      customPrices,
      priceChanges: changes,
      removedPrices: removed
    };
    try {
      localStorage.setItem("magpie_models_price_options", JSON.stringify(payload));
      localStorage.setItem("magpie_models_price_mode", globalMode);
    } catch (e) {}

    const signature = optionsSignature(payload);
    const changed = signature !== savedSignature;
    if (changed) {
      payload.applyToken = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    }

    let saved = false;
    if (globalThis.magpie && magpie.options) {
      try {
        pluginOptions = await magpie.options.set({
          ...pluginOptions,
          ...payload
        });
        saved = true;
      } catch (e) {
        console.warn("Failed to save options via magpie bridge:", e);
      }
    }

    // Magpie host postMessage 通信（窗口里没有 bridge 时的兜底）
    if (!saved) {
      try {
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({ magpie: 1, method: "options:set", params: payload }, "*");
          saved = true;
        }
      } catch (e) {}
    }

    if (saved && changed) {
      savedSignature = signature;
      savedCustomPrices = clonePriceMap(customPrices);
      pendingRemovals = [];
    }
    return saved;
  }

  // 保存后回读 settings.json 自检：页面说「已保存」不算数，Magpie 真正拿来计费的
  // 那份价格里有没有这个键、四个单价对不对，才是价格生效的判据。
  //
  // 这个自检要有本地服务才能做（GET /api/verify 读的就是 settings.json），而插件页
  // 的 CSP 是 connect-src 'none'，在窗口里连不出去。所以这里恒返回 null，调用方
  // 只提示「已提交」，不会谎称「已验证」——一句假的「已验证」比不提示更糟。
  async function verifyPrices() {
    return null;
  }

  // 把自检结果翻译成一句人话：生效 / 部分没生效（列出第一个不一致的键）
  function describeVerify(report, targetKey) {
    if (!report || !report.checked) return null;
    const bad = (report.mismatches || []).find((m) => m.key === targetKey) || (report.mismatches || [])[0];
    if (!bad) return t("toast_price_verified", { count: report.matched });
    const actual = bad.actual
      ? `$${bad.actual.input}/$${bad.actual.output}`
      : t("price_verify_missing");
    return t("toast_price_unverified", { key: bad.key, actual });
  }

  async function syncAllMatched() {
    let count = 0;
    for (const m of rawModels) {
      if (m.matched) {
        customPrices[m.model] = {
          input: m.matched.cost.input,
          output: m.matched.cost.output,
          cache_read: m.matched.cost.cache_read,
          cache_write: m.matched.cost.cache_write
        };
        count++;
      }
    }
    await persistOptions();
    renderStats();
    renderList();
    showToast(t("toast_sync_all", { count }));
  }

  // 11. 事件绑定
  $("filter-seg").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    $("filter-seg")
      .querySelectorAll("button")
      .forEach((b) => b.removeAttribute("aria-selected"));
    btn.setAttribute("aria-selected", "true");
    filter = btn.dataset.filter;

    // 标签和「渠道类型」下拉是两套独立条件，混在一起会出现筛不出东西：
    // 原来只在点 api/login 时改 selectedKind，切回「全部」时它仍停在 api，
    // 于是「全部」标签看不到订阅渠道的模型。
    const kindSelect = $("kind-filter");
    if (filter === "api") {
      selectedKind = "api";
    } else if (filter === "login" || filter === "subscription") {
      selectedKind = "subscription";
    } else {
      selectedKind = "all";
    }
    if (kindSelect) kindSelect.value = selectedKind;
    renderList();
  });

  const kindSelect = $("kind-filter");
  if (kindSelect) {
    kindSelect.addEventListener("change", (e) => {
      selectedKind = e.target.value;
      renderList();
    });
  }

  const priceSelect = $("price-filter");
  if (priceSelect) {
    priceSelect.addEventListener("change", (e) => {
      selectedPrice = e.target.value;
      renderList();
    });
  }

  const expandAllBtn = $("btn-expand-all");
  if (expandAllBtn) {
    expandAllBtn.addEventListener("click", () => {
      defaultExpanded = true;
      userToggledGroups.clear();
      renderList();
    });
  }

  const collapseAllBtn = $("btn-collapse-all");
  if (collapseAllBtn) {
    collapseAllBtn.addEventListener("click", () => {
      defaultExpanded = false;
      userToggledGroups.clear();
      renderList();
    });
  }

  $("mode-btn-all").addEventListener("click", () => setGlobalMode("all-equivalent"));
  $("mode-btn-api").addEventListener("click", () => setGlobalMode("api-only"));

  $("scope-specific").addEventListener("click", () => setScope("specific"));
  $("scope-wildcard").addEventListener("click", () => setScope("wildcard"));

  $("search-input").addEventListener("input", (e) => {
    search = e.target.value;
    renderList();
  });

  const sortSelect = $("sort-select");
  if (sortSelect) {
    sortSelect.addEventListener("change", (e) => {
      currentSort = e.target.value;
      renderList();
    });
  }

  $("modal-btn-cancel").addEventListener("click", (e) => {
    e.stopPropagation();
    closeEditModal();
  });

  $("edit-modal").addEventListener("click", (e) => {
    if (e.target === $("edit-modal")) {
      closeEditModal();
    }
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("edit-modal").hidden) {
      closeEditModal();
    }
  });

  $("modal-btn-save").addEventListener("click", saveModelPrice);

  if ($("peak-input-mode")) {
    $("peak-input-mode").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-mode]");
      if (btn) setPeakInputMode(btn.dataset.mode);
    });
  }

  // 弹窗里的「该模型参与峰谷」开关：只改弹窗状态，点“保存生效”时随价格一起落盘。
  if ($("peak-model-toggle")) {
    $("peak-model-toggle").addEventListener("change", (e) => {
      const family = editingModel ? peakFamilyOf(editingModel) : null;
      if (!family) return;
      if (e.target.checked && !editingPeakWindows.length) {
        editingPeakWindows = defaultPeakWindowsForFamily(family);
        renderEditingPeakWindows();
      }
      updatePeakPreview();
    });
  }

  if ($("peak-rate")) {
    $("peak-rate").addEventListener("input", updatePeakPreview);
  }

  if ($("peak-add-window")) {
    $("peak-add-window").addEventListener("click", () => {
      if (editingPeakWindows.length >= 8) {
        showToast(t("rate_max", { max: 8 }));
        return;
      }
      editingPeakWindows.push({ days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" });
      renderEditingPeakWindows();
      updatePeakPreview();
    });
  }

  if ($("peak-recommend")) {
    $("peak-recommend").addEventListener("click", () => {
      if (!editingModel) return;
      const family = peakFamilyOf(editingModel);
      if (!family) return;
      editingPeakWindows = defaultPeakWindowsForFamily(family);
      renderEditingPeakWindows();
      updatePeakPreview();
    });
  }

  $("btn-sync-all").addEventListener("click", syncAllMatched);

  // 自动刷新机制 (Tab 切回、窗口聚焦、30秒定时器)
  if (globalThis.magpie && typeof magpie.onVisibility === "function") {
    magpie.onVisibility((visible) => {
      if (visible) syncLiveMagpieData(false);
    });
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") syncLiveMagpieData(false);
  });
  window.addEventListener("focus", () => {
    syncLiveMagpieData(false);
  });
  setInterval(() => {
    if (document.visibilityState === "visible") syncLiveMagpieData(false);
  }, 30000);

  $("modal-btn-match").addEventListener("click", () => {
    if (editingModel && editingModel.matched) {
      // 公价就是闲时价，先切回闲时价模式再填，否则保存时会被再除一次倍率
      applyPeakInputModeUI("offpeak");
      const c = editingModel.matched.cost;
      $("input-cost").value = c.input;
      $("output-cost").value = c.output;
      $("cache-read-cost").value = c.cache_read;
      $("cache-write-cost").value = c.cache_write;
      updatePeakPreview();
    }
  });

  $("input-cost").addEventListener("input", updatePeakPreview);
  $("output-cost").addEventListener("input", updatePeakPreview);

  // 当语言切换时，触发全量 UI 重新渲染
  onLocaleChange(() => {
    updatePeakStatusBar();
    renderModeUI();
    renderProviderFilter();
    renderStats();
    renderList();
    if (editingModel && !$("edit-modal").hidden) {
      $("modal-model-title").textContent = t("modal_title_set", { model: editingModel.model });
      $("modal-model-sub").textContent = editingModel.name
        ? t("modal_sub_official", { name: editingModel.name })
        : t("modal_sub_default");
      setScope(selectedScope);
    }
  });

  // 定时更新峰谷状态胶囊 (每 30 秒)
  setInterval(updatePeakStatusBar, 30000);

  // URL Hash 状态恢复 (便于深层链接与快速测试: #sort=calls-desc&filter=enabled&expand=all)
  function handleUrlHash() {
    const hash = (location.hash || "").replace(/^#/, "");
    if (!hash) return;
    const params = new URLSearchParams(hash);
    if (params.has("sort")) {
      currentSort = params.get("sort");
      const s = $("sort-select");
      if (s) s.value = currentSort;
    }
    if (params.has("filter")) {
      filter = params.get("filter");
      $("filter-seg")?.querySelectorAll("button").forEach((b) => {
        if (b.dataset.filter === filter) b.setAttribute("aria-selected", "true");
        else b.removeAttribute("aria-selected");
      });
    }
    if (params.has("price")) {
      const pv = params.get("price");
      if (["all", "free", "paid", "unpriced"].includes(pv)) {
        selectedPrice = pv;
        const ps = $("price-filter");
        if (ps) ps.value = pv;
      }
    }
    if (params.has("expand")) {
      const exp = params.get("expand");
      if (exp === "all") {
        defaultExpanded = true;
        userToggledGroups.clear();
      } else if (exp) {
        userToggledGroups.set(exp, true);
      }
    }
  }

  window.addEventListener("hashchange", () => {
    handleUrlHash();
    renderList();
  });

  // 时段编辑器里的星期缩写（弹窗与旧版共用）
  const RATE_WEEK = ["日", "一", "二", "三", "四", "五", "六"];

  // 静态基准数据里的免费模型也要按同族付费公价计价。
  // 没有 Magpie bridge（独立 Web / 冷启动）时只有静态数据，不跑这一步的话
  // hy4flash-free 这类模型会一直显示 $0/$0。
  try {
    applyFreeEquivalentPricing();
  } catch (e) {
    console.warn("applyFreeEquivalentPricing failed:", e);
  }

  // 初始渲染
  updatePeakStatusBar();
  renderModeUI();
  renderProviderFilter();
  renderStats();
  handleUrlHash();
  renderList();

  // 初始动态同步 live providers 与 usage
  syncLiveMagpieData(false);
})();
