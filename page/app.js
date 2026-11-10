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

  // Load models data and options
  const rawModels = window.__MAGPIE_MODELS_DATA__ || [];
  let pluginOptions = {};
  let customPrices = {};
  let globalMode = "all-equivalent"; // "all-equivalent" or "api-only"
  let filter = "all";
  let search = "";
  let selectedProvider = "all";
  let currentSort = "default";
  let editingModel = null;
  let selectedScope = "specific";
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

    function applyHostTheme(data) {
      if (!data) return;
      const root = document.documentElement;
      if (data.dark !== undefined) {
        root.dataset.theme = data.dark ? "dark" : "light";
      }
      const bg = data.tokens?.bg || (data.dark === false ? "#f5f5f7" : "#121214");
      root.style.backgroundColor = bg;
      if (document.body) document.body.style.backgroundColor = bg;
      if (data.tokens) {
        for (const [k, v] of Object.entries(data.tokens)) {
          if (v) root.style.setProperty("--" + k, v);
        }
      }
      if (data.lang) {
        setLocale(data.lang);
      }
    }

    callHost("hello")
      .then((res) => {
        if (res) applyHostTheme(res);
      })
      .catch(() => {});
  }

  // 2. 初始化 Magpie bridge (如果存在)
  if (globalThis.magpie) {
    try {
      const theme = await magpie.ready;
      if (theme && theme.lang) {
        setLocale(theme.lang);
      }
      if (theme && theme.dark !== undefined) {
        document.documentElement.dataset.theme = theme.dark ? "dark" : "light";
      }
      magpie.onTheme?.((tTheme) => {
        if (tTheme.dark !== undefined) {
          document.documentElement.dataset.theme = tTheme.dark ? "dark" : "light";
        }
        if (tTheme.lang) {
          setLocale(tTheme.lang);
        }
      });
      pluginOptions = (await magpie.options.get()) || {};
      customPrices = pluginOptions.customPrices || {};
      globalMode = pluginOptions.mode || "all-equivalent";
    } catch (e) {
      console.warn("Magpie bridge ready warning:", e);
    }
  }

  initMagpieHostSync();

  function getBareModel(fullName) {
    if (!fullName) return "";
    return fullName.includes("/") ? fullName.split("/").slice(1).join("/") : fullName;
  }

  // 3. 模型分组逻辑 (Group models by bare model identity)
  function buildModelGroups(models) {
    const map = new Map();
    const bareUsageMap = window.__MAGPIE_BARE_USAGE__ || {};

    for (const item of models) {
      const bare = getBareModel(item.model);
      if (!map.has(bare)) {
        const bu = bareUsageMap[bare] || {
          requests: 0,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheRead: 0,
          cacheWrite: 0
        };
        map.set(bare, {
          bare,
          name: item.name || bare,
          matched: item.matched,
          offPeakPreset: item.offPeakPreset,
          usage: { ...bu },
          items: []
        });
      }
      const g = map.get(bare);
      if ((!g.name || g.name === bare) && item.name && item.name !== item.model) {
        g.name = item.name;
      }
      if (!g.matched && item.matched) {
        g.matched = item.matched;
      }
      if (!g.offPeakPreset?.supported && item.offPeakPreset?.supported) {
        g.offPeakPreset = item.offPeakPreset;
      }
      g.items.push(item);
    }
    return Array.from(map.values());
  }

  function getGroupRepresentativeInputPrice(g) {
    for (const it of g.items) {
      const p = getModelPrice(it);
      if (p && typeof p.input === "number") return p.input;
    }
    return null;
  }

  function sortGroups(list, sortType) {
    const sorted = [...list];
    if (sortType === "default" || sortType === "usage-desc" || sortType === "tokens-desc") {
      // 默认用量降序：优先按总 Token 消耗降序，相同时按调用次数降序，最后按名称
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

  // 4. 供应商图标获取辅助函数 (基于 page/icons.js 官方资源)
  function getProviderIconHtml(providerId) {
    if (window.getIconSvg) {
      const svg = window.getIconSvg(providerId);
      if (svg) return svg;
    }
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="4"/></svg>`;
  }

  // 5. 峰谷分时时段计算 (Time-of-Use & DeepSeek Official Schedule)
  function getBeijingTime(date = new Date()) {
    const utc = date.getTime() + date.getTimezoneOffset() * 60000;
    return new Date(utc + 3600000 * 8);
  }

  function checkOffPeakStatus(date = new Date()) {
    const bj = getBeijingTime(date);
    const day = bj.getDay(); // 0 是周日, 6 是周六
    const hour = bj.getHours();
    const min = bj.getMinutes();
    const t = hour + min / 60;
    const timeStr = `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`;

    // 周末全天均为低谷闲时 (立享 5 折)
    if (day === 0 || day === 6) {
      return {
        isOffPeak: true,
        discount: 0.5,
        hour,
        min,
        day,
        timeStr,
        reason: "weekend"
      };
    }

    // 工作日：高峰为 09:00-12:00 与 14:00-18:00；其余时段为低谷闲时
    const isPeak = (t >= 9 && t < 12) || (t >= 14 && t < 18);
    return {
      isOffPeak: !isPeak,
      discount: !isPeak ? 0.5 : 1.0,
      hour,
      min,
      day,
      timeStr,
      reason: isPeak ? "workday_peak" : t >= 12 && t < 14 ? "lunch" : "night"
    };
  }

  function updatePeakStatusBar() {
    const status = checkOffPeakStatus();
    const bar = $("peak-status-bar");
    const text = $("peak-text");
    const time = $("peak-time");
    if (!bar || !text) return;

    if (status.isOffPeak) {
      bar.className = "peak-status-bar is-offpeak";
      text.textContent = t("offpeak_badge_live");
    } else {
      bar.className = "peak-status-bar is-peak";
      text.textContent = t("peak_badge_live");
    }
    if (time) {
      time.textContent = `UTC+8 ${status.timeStr}`;
    }
  }

  // 6. 定价计算 (含实时峰谷切换)
  function getModelPrice(item) {
    const currentStatus = checkOffPeakStatus();
    const isSub = item.providerKind === "subscription";

    const specificCustom = customPrices[item.model];
    const bare = getBareModel(item.model);
    const wildcardCustom = customPrices["*/" + bare];
    const custom = specificCustom || wildcardCustom;
    const scope = specificCustom ? "specific" : wildcardCustom ? "wildcard" : null;

    if (globalMode === "api-only" && isSub && !specificCustom) {
      return null;
    }

    // 自定义定价
    if (custom) {
      const hasOffPeak = !!(custom.offpeak?.enabled || item.offPeakPreset?.supported);
      const peakIn = custom.input;
      const peakOut = custom.output;
      const offIn = custom.offpeak?.input ?? +(peakIn * 0.5).toFixed(5);
      const offOut = custom.offpeak?.output ?? +(peakOut * 0.5).toFixed(5);

      const effectiveIn = hasOffPeak && currentStatus.isOffPeak ? offIn : peakIn;
      const effectiveOut = hasOffPeak && currentStatus.isOffPeak ? offOut : peakOut;

      return {
        type: "custom",
        scope,
        input: effectiveIn,
        output: effectiveOut,
        cache_read: custom.cache_read,
        cache_write: custom.cache_write,
        hasOffPeak,
        isOffPeakActive: currentStatus.isOffPeak,
        peakInput: peakIn,
        peakOutput: peakOut,
        offPeakInput: offIn,
        offPeakOutput: offOut
      };
    }

    // 官方匹配公价 (若为 DeepSeek 等模型，自动计算峰谷)
    if (item.matched && item.matched.cost) {
      const c = item.matched.cost;
      const hasOffPeak = !!item.offPeakPreset?.supported;
      const peakIn = c.input;
      const peakOut = c.output;
      const offIn = +(peakIn * 0.5).toFixed(5);
      const offOut = +(peakOut * 0.5).toFixed(5);

      const effectiveIn = hasOffPeak && currentStatus.isOffPeak ? offIn : peakIn;
      const effectiveOut = hasOffPeak && currentStatus.isOffPeak ? offOut : peakOut;

      return {
        type: "matched",
        input: effectiveIn,
        output: effectiveOut,
        cache_read: c.cache_read,
        cache_write: c.cache_write,
        hasOffPeak,
        isOffPeakActive: currentStatus.isOffPeak,
        peakInput: peakIn,
        peakOutput: peakOut,
        offPeakInput: offIn,
        offPeakOutput: offOut
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
      const provId = m.provider || "other";
      const provName = m.providerName || provId;
      if (!provMap.has(provId)) {
        provMap.set(provId, { id: provId, name: provName, count: 0 });
      }
      provMap.get(provId).count++;
    }

    const currentVal = selectedProvider || "all";
    select.innerHTML = "";

    const optAll = document.createElement("option");
    optAll.value = "all";
    optAll.textContent = `🏢 ${t("provider_filter_all")} (${rawModels.length})`;
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

  // 8. 统计数据刷新 (按模型分组聚合后的统计)
  function renderStats() {
    const allGroups = buildModelGroups(rawModels);
    const totalModels = allGroups.length;
    let customCount = 0;
    let pricedCount = 0;
    let unpricedCount = 0;
    let enabledGroupsCount = 0;
    let enabledChannelsCount = 0;

    for (const item of rawModels) {
      if (item.enabled) enabledChannelsCount++;
    }

    for (const g of allGroups) {
      const hasWildcard = !!customPrices["*/" + g.bare];
      const hasAnyCustom = hasWildcard || g.items.some((it) => !!customPrices[it.model]);

      // If any item in the group is priced
      const isAnyPriced = g.items.some((it) => !!getModelPrice(it));
      if (isAnyPriced) {
        pricedCount++;
      } else {
        unpricedCount++;
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
    if ($("stat-custom")) $("stat-custom").textContent = customCount;
    if ($("stat-unpriced")) $("stat-unpriced").textContent = unpricedCount;
    if ($("stat-usage")) $("stat-usage").textContent = formatNumber(usageSummary.requests);
    if ($("stat-usage-sub")) $("stat-usage-sub").textContent = `${formatTokens(usageSummary.totalTokens)} Tokens`;
  }

  // 9. 核心列表渲染 (按模型分组 + 供应商图标 + 展开/折叠渠道价格)
  function renderList() {
    const allGroups = buildModelGroups(rawModels);
    let list = allGroups;

    // Filter by tab
    if (filter === "enabled") {
      if (selectedProvider && selectedProvider !== "all") {
        list = list.filter((g) => g.items.some((it) => (it.provider || "other") === selectedProvider && it.enabled));
      } else {
        list = list.filter((g) => g.items.some((it) => it.enabled));
      }
    } else if (filter === "custom") {
      list = list.filter((g) => {
        return !!customPrices["*/" + g.bare] || g.items.some((it) => !!customPrices[it.model]);
      });
    } else if (filter === "unpriced") {
      list = list.filter((g) => !g.items.some((it) => !!getModelPrice(it)));
    } else if (filter === "matched") {
      list = list.filter((g) => !!g.matched || g.items.some((it) => !!it.matched));
    } else if (filter === "offpeak") {
      list = list.filter((g) => {
        const hasCustomOffPeak = !!customPrices["*/" + g.bare]?.offpeak?.enabled;
        return (
          hasCustomOffPeak ||
          !!g.offPeakPreset?.supported ||
          g.items.some((it) => {
            const p = getModelPrice(it);
            return (p && p.hasOffPeak) || (it.offPeakPreset && it.offPeakPreset.supported);
          })
        );
      });
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
        : hasCustom;

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
          seenProviders.set(pKey, item.providerName || pKey);
        }
      }

      // 供应商头像堆叠 (参考 Magpie MCP / Skill 展示规范)
      const stackDiv = document.createElement("div");
      stackDiv.className = "provider-icon-stack";
      let zIdx = seenProviders.size;
      for (const [pId, pName] of seenProviders.entries()) {
        const iconDiv = document.createElement("div");
        iconDiv.className = "provider-squircle-icon";
        iconDiv.style.zIndex = zIdx--;
        iconDiv.title = pName;
        iconDiv.innerHTML = getProviderIconHtml(pId);
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

      if (group.offPeakPreset?.supported) {
        const offPeakTag = document.createElement("span");
        offPeakTag.style.cssText = "font-size: 10px; color: var(--green); border: 1px solid rgba(48, 209, 88, 0.3); border-radius: 3px; padding: 0 4px;";
        offPeakTag.textContent = t("badge_offpeak_supported");
        nameRow.append(offPeakTag);
      }

      const namesDiv = document.createElement("div");
      namesDiv.className = "provider-names-text";
      namesDiv.textContent = Array.from(seenProviders.values()).join(" · ");

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

      if (repPrice && (repPrice.type === "custom" || repPrice.type === "matched")) {
        const mainRate = document.createElement("span");
        mainRate.className = "main-rate";

        const subCache = document.createElement("span");
        subCache.className = "sub-cache";

        if (repPrice.hasOffPeak) {
          mainRate.textContent = `${t("peak_tag")} $${repPrice.peakInput}/$${repPrice.peakOutput}`;
          subCache.className = "sub-cache rate-offpeak";
          subCache.textContent = `${t("offpeak_tag")} $${repPrice.offPeakInput}/$${repPrice.offPeakOutput} (50% OFF)`;
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
        const unpricedSpan = document.createElement("span");
        unpricedSpan.className = "badge-tag badge-unpriced";
        unpricedSpan.textContent = t("badge_unpriced");
        priceSummary.append(unpricedSpan);
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
          pIcon.innerHTML = getProviderIconHtml(item.provider);

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
          if (itemPrice && (itemPrice.type === "custom" || itemPrice.type === "matched")) {
            const hasItemSpecificCustom = !!customPrices[item.model];
            const hasWildcardPrice = !hasItemSpecificCustom && !!customPrices["*/" + group.bare];

            let badgeHtml = "";
            if (hasItemSpecificCustom) {
              badgeHtml = `<span class="badge-tag badge-custom" style="font-size: 10px;">${escapeHtml(t("scope_specific_badge"))}</span>`;
            } else if (hasWildcardPrice) {
              badgeHtml = `<span class="badge-tag badge-custom" style="font-size: 10px;">${escapeHtml(t("scope_wildcard_badge"))}</span>`;
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
          btnEdit.textContent = t("btn_edit_price");
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

    if (custom) {
      $("input-cost").value = custom.input;
      $("output-cost").value = custom.output;
      $("cache-read-cost").value = custom.cache_read;
      $("cache-write-cost").value = custom.cache_write;

      const hasOffPeak = !!(custom.offpeak?.enabled || item.offPeakPreset?.supported);
      $("offpeak-enabled").checked = hasOffPeak;
      $("offpeak-details").hidden = !hasOffPeak;
      $("offpeak-input-cost").value = custom.offpeak?.input ?? +(custom.input * 0.5).toFixed(5);
      $("offpeak-output-cost").value = custom.offpeak?.output ?? +(custom.output * 0.5).toFixed(5);
    } else if (item.matched) {
      const c = item.matched.cost;
      $("input-cost").value = c.input;
      $("output-cost").value = c.output;
      $("cache-read-cost").value = c.cache_read;
      $("cache-write-cost").value = c.cache_write;

      const hasOffPeak = !!item.offPeakPreset?.supported;
      $("offpeak-enabled").checked = hasOffPeak;
      $("offpeak-details").hidden = !hasOffPeak;
      $("offpeak-input-cost").value = +(c.input * 0.5).toFixed(5);
      $("offpeak-output-cost").value = +(c.output * 0.5).toFixed(5);
    } else {
      $("input-cost").value = "0";
      $("output-cost").value = "0";
      $("cache-read-cost").value = "0";
      $("cache-write-cost").value = "0";
      $("offpeak-enabled").checked = false;
      $("offpeak-details").hidden = true;
      $("offpeak-input-cost").value = "0";
      $("offpeak-output-cost").value = "0";
    }

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

    const inVal = parseFloat($("input-cost").value) || 0;
    const outVal = parseFloat($("output-cost").value) || 0;

    const priceObj = {
      input: inVal,
      output: outVal,
      cache_read: parseFloat($("cache-read-cost").value) || 0,
      cache_write: parseFloat($("cache-write-cost").value) || 0
    };

    if ($("offpeak-enabled").checked) {
      priceObj.offpeak = {
        enabled: true,
        rule: "deepseek",
        input: parseFloat($("offpeak-input-cost").value) || +(inVal * 0.5).toFixed(5),
        output: parseFloat($("offpeak-output-cost").value) || +(outVal * 0.5).toFixed(5)
      };
    }

    customPrices[targetKey] = priceObj;

    if (selectedScope === "wildcard" && customPrices[editingModel.model]) {
      delete customPrices[editingModel.model];
    }

    await persistOptions();
    closeEditModal();
    renderStats();
    renderList();
    showToast(t("toast_rate_saved", { key: targetKey }));
  }

  async function resetModelPrice(model) {
    const bare = getBareModel(model);
    delete customPrices[model];
    delete customPrices["*/" + bare];

    await persistOptions();
    renderStats();
    renderList();
    showToast(t("toast_rate_reset", { model }));
  }

  async function setGlobalMode(mode) {
    globalMode = mode;
    renderModeUI();
    await persistOptions();
    renderStats();
    renderList();
    showToast(mode === "api-only" ? t("toast_mode_api") : t("toast_mode_all"));
  }

  async function persistOptions() {
    if (globalThis.magpie && magpie.options) {
      try {
        pluginOptions = await magpie.options.set({
          ...pluginOptions,
          mode: globalMode,
          customPrices
        });
      } catch (e) {
        console.error("Failed to save options via magpie bridge:", e);
      }
    }
  }

  async function syncAllMatched() {
    let count = 0;
    for (const m of rawModels) {
      if (m.matched) {
        const hasOffPeak = !!m.offPeakPreset?.supported;
        const peakIn = m.matched.cost.input;
        const peakOut = m.matched.cost.output;
        const offIn = +(peakIn * 0.5).toFixed(5);
        const offOut = +(peakOut * 0.5).toFixed(5);

        customPrices[m.model] = {
          input: peakIn,
          output: peakOut,
          cache_read: m.matched.cost.cache_read,
          cache_write: m.matched.cost.cache_write,
          ...(hasOffPeak ? { offpeak: { enabled: true, rule: "deepseek", input: offIn, output: offOut } } : {})
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
    renderList();
  });

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
  $("btn-sync-all").addEventListener("click", syncAllMatched);

  $("modal-btn-match").addEventListener("click", () => {
    if (editingModel && editingModel.matched) {
      const c = editingModel.matched.cost;
      $("input-cost").value = c.input;
      $("output-cost").value = c.output;
      $("cache-read-cost").value = c.cache_read;
      $("cache-write-cost").value = c.cache_write;
      if ($("offpeak-enabled").checked) {
        $("offpeak-input-cost").value = +(c.input * 0.5).toFixed(5);
        $("offpeak-output-cost").value = +(c.output * 0.5).toFixed(5);
      }
    }
  });

  $("offpeak-enabled").addEventListener("change", (e) => {
    $("offpeak-details").hidden = !e.target.checked;
    if (e.target.checked) {
      const inVal = parseFloat($("input-cost").value) || 0;
      const outVal = parseFloat($("output-cost").value) || 0;
      if (!parseFloat($("offpeak-input-cost").value)) {
        $("offpeak-input-cost").value = +(inVal * 0.5).toFixed(5);
      }
      if (!parseFloat($("offpeak-output-cost").value)) {
        $("offpeak-output-cost").value = +(outVal * 0.5).toFixed(5);
      }
    }
  });

  $("input-cost").addEventListener("input", () => {
    if ($("offpeak-enabled").checked) {
      const inVal = parseFloat($("input-cost").value) || 0;
      $("offpeak-input-cost").value = +(inVal * 0.5).toFixed(5);
    }
  });

  $("output-cost").addEventListener("input", () => {
    if ($("offpeak-enabled").checked) {
      const outVal = parseFloat($("output-cost").value) || 0;
      $("offpeak-output-cost").value = +(outVal * 0.5).toFixed(5);
    }
  });

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
    if (params.has("expand")) {
      const exp = params.get("expand");
      if (exp === "all") {
        for (const g of buildModelGroups(rawModels)) userToggledGroups.set(g.bare, true);
      } else if (exp) {
        userToggledGroups.set(exp, true);
      }
    }
  }

  window.addEventListener("hashchange", () => {
    handleUrlHash();
    renderList();
  });

  // 初始渲染
  updatePeakStatusBar();
  renderModeUI();
  renderProviderFilter();
  renderStats();
  handleUrlHash();
  renderList();
})();
