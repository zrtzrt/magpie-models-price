
// Model Prices Controller with Master Mode Switch & Scope support
(async () => {
  const $ = (id) => document.getElementById(id);

  let toastTimer = null;
  function showToast(msg) {
    const t = $("toast");
    if (!t) return;
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.hidden = true;
    }, 2500);
  }

  // Initialize theme and options from Magpie bridge if available
  let lang = "zh";
  let pluginOptions = {};

  if (globalThis.magpie) {
    try {
      const theme = await magpie.ready;
      if (theme && theme.lang) lang = theme.lang;
      magpie.onTheme((t) => {
        document.documentElement.dataset.theme = t.dark ? "dark" : "light";
      });
      pluginOptions = (await magpie.options.get()) || {};
    } catch (e) {
      console.warn("Magpie bridge ready warning:", e);
    }
  }

  // Load models data
  const rawModels = window.__MAGPIE_MODELS_DATA__ || [];
  let customPrices = pluginOptions.customPrices || {};
  let globalMode = pluginOptions.mode || "all-equivalent"; // "all-equivalent" or "api-only"
  let filter = "all";
  let search = "";
  let editingModel = null;
  let selectedScope = "specific";

  function getBareModel(fullName) {
    return fullName.includes('/') ? fullName.split('/')[1] : fullName;
  }

  function getModelPrice(item) {
    // If in API-only mode and provider is a subscription/free account without custom override:
    // It is unpriced or 0
    if (globalMode === 'api-only' && item.providerKind === 'subscription') {
      const specificCustom = customPrices[item.model];
      if (specificCustom) {
        return {
          type: 'custom',
          scope: 'specific',
          input: specificCustom.input,
          output: specificCustom.output,
          cache_read: specificCustom.cache_read,
          cache_write: specificCustom.cache_write
        };
      }
      return null; // Not billed in API-only mode
    }

    // 1. Direct specific custom price
    const specificCustom = customPrices[item.model];
    if (specificCustom) {
      return {
        type: 'custom',
        scope: 'specific',
        input: specificCustom.input,
        output: specificCustom.output,
        cache_read: specificCustom.cache_read,
        cache_write: specificCustom.cache_write
      };
    }

    // 2. Wildcard custom price
    const bare = getBareModel(item.model);
    const wildcardCustom = customPrices['*/' + bare];
    if (wildcardCustom) {
      return {
        type: 'custom',
        scope: 'wildcard',
        input: wildcardCustom.input,
        output: wildcardCustom.output,
        cache_read: wildcardCustom.cache_read,
        cache_write: wildcardCustom.cache_write
      };
    }

    // 3. Current active price from settings/list
    if (item.currentPrice && !item.isUnpriced) {
      return {
        type: 'current',
        text: item.currentPrice
      };
    }
    return null;
  }

  function renderModeUI() {
    if (globalMode === 'api-only') {
      $("mode-btn-api").setAttribute("aria-selected", "true");
      $("mode-btn-all").removeAttribute("aria-selected");
      $("mode-desc-text").innerHTML = '【当前：<strong>只记录 API 真实花费模式</strong>】仅对真实通过付费 API Key 按量计费的渠道记账；包月会员、免费账号及额度渠道（如 Trae, WorkBuddy, Antigravity 等）计价为 $0.00，不会在托盘与用量统计中产生虚拟金额。';
    } else {
      $("mode-btn-all").setAttribute("aria-selected", "true");
      $("mode-btn-api").removeAttribute("aria-selected");
      $("mode-desc-text").innerHTML = '【当前：<strong>所有提供商等值公价模式</strong>】对所有渠道（包含 Trae、WorkBuddy、Antigravity 等包月/免费渠道）均按 models.dev 市场公价换算其消耗的等值市值。';
    }
  }

  function renderStats() {
    const total = rawModels.length;
    let customCount = 0;
    let pricedCount = 0;
    let unpricedCount = 0;

    for (const m of rawModels) {
      const p = getModelPrice(m);
      if (p) {
        pricedCount++;
        if (p.type === 'custom') customCount++;
      } else {
        unpricedCount++;
      }
    }

    $("stat-total").textContent = total;
    $("stat-priced").textContent = pricedCount;
    $("stat-custom").textContent = customCount;
    $("stat-unpriced").textContent = unpricedCount;
  }

  function renderList() {
    let list = rawModels;

    if (filter === "custom") {
      list = list.filter(m => {
        const p = getModelPrice(m);
        return p && p.type === 'custom';
      });
    } else if (filter === "unpriced") {
      list = list.filter(m => !getModelPrice(m));
    } else if (filter === "matched") {
      list = list.filter(m => !!m.matched);
    }

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(m => 
        m.model.toLowerCase().includes(q) || 
        (m.name && m.name.toLowerCase().includes(q)) ||
        (m.matched && (m.matched.provider + "/" + m.matched.model).toLowerCase().includes(q))
      );
    }

    const listContainer = $("models-list");
    listContainer.innerHTML = "";

    if (list.length === 0) {
      $("empty-hint").hidden = false;
      return;
    }
    $("empty-hint").hidden = true;

    for (const item of list) {
      const li = document.createElement("li");
      li.className = "model-item";

      // Item top: model name + actions
      const topDiv = document.createElement("div");
      topDiv.className = "item-top";

      const isSub = item.providerKind === 'subscription';
      const kindBadge = isSub 
        ? '<span style="font-size: 10px; color: var(--muted); border: 1px solid var(--line); border-radius: 3px; padding: 0 4px; margin-left: 5px;">包月/账号</span>'
        : '<span style="font-size: 10px; color: var(--accent); border: 1px solid var(--accent); border-radius: 3px; padding: 0 4px; margin-left: 5px;">付费API</span>';

      const infoDiv = document.createElement("div");
      infoDiv.className = "item-info";
      infoDiv.innerHTML = '<div class="m-name">' + escapeHtml(item.model) + kindBadge + '</div>' +
        '<div class="m-sub">' + escapeHtml(item.name || '') + '</div>';

      const actionsDiv = document.createElement("div");
      actionsDiv.className = "item-actions";

      const btnEdit = document.createElement("button");
      btnEdit.type = "button";
      btnEdit.className = "btn btn-small";
      btnEdit.textContent = "修改定价";
      btnEdit.addEventListener("click", () => openEditModal(item));
      actionsDiv.append(btnEdit);

      const current = getModelPrice(item);
      const bare = getBareModel(item.model);
      const hasCustom = !!(customPrices[item.model] || customPrices['*/' + bare]);

      if (hasCustom) {
        const btnReset = document.createElement("button");
        btnReset.type = "button";
        btnReset.className = "btn btn-small";
        btnReset.style.color = "var(--red)";
        btnReset.textContent = "重置";
        btnReset.addEventListener("click", () => resetModelPrice(item.model));
        actionsDiv.append(btnReset);
      }

      topDiv.append(infoDiv, actionsDiv);

      // Item bottom: current price tag + models.dev reference
      const bottomDiv = document.createElement("div");
      bottomDiv.className = "item-bottom";

      const priceCol = document.createElement("div");
      priceCol.className = "price-col";

      if (current && current.type === 'custom') {
        const scopeBadge = current.scope === 'wildcard' 
          ? '<span class="badge-tag badge-custom" title="通配生效于所有提供此模型的渠道及历史记录">任何渠道 (*)</span>' 
          : '<span class="badge-tag badge-custom" title="仅此特定渠道生效">专有渠道</span>';

        priceCol.innerHTML = '<span class="rate">$' + current.input + ' / $' + current.output + '</span>' +
          scopeBadge +
          '<span class="cache">缓存: $' + current.cache_read + '/$' + current.cache_write + '</span>';
      } else if (current && current.type === 'current') {
        priceCol.innerHTML = '<span class="rate" style="color: var(--green);">' + escapeHtml(current.text) + '</span>' +
          '<span class="badge-tag badge-modelsdev">已生效</span>';
      } else {
        if (globalMode === 'api-only' && isSub) {
          priceCol.innerHTML = '<span class="badge-tag" style="background: var(--card); color: var(--muted);">免记账 (包月/账号)</span>';
        } else {
          priceCol.innerHTML = '<span class="badge-tag badge-unpriced">未定价 (Unpriced)</span>';
        }
      }

      const refCol = document.createElement("div");
      refCol.className = "ref-col";
      if (item.matched) {
        const c = item.matched.cost;
        refCol.innerHTML = '<span>公价参考:</span> <span class="ref-price">$' + c.input + ' / $' + c.output + '</span>';
      } else {
        refCol.innerHTML = '<span>无公价参考</span>';
      }

      bottomDiv.append(priceCol, refCol);

      li.append(topDiv, bottomDiv);
      listContainer.append(li);
    }
  }

  function escapeHtml(str) {
    if (!str) return "";
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Edit Modal logic
  function openEditModal(item) {
    editingModel = item;
    const bare = getBareModel(item.model);

    $("modal-model-title").textContent = "设置 " + item.model + " 价格";
    $("modal-model-sub").textContent = item.name ? "官方名称: " + item.name : "配置每次请求与缓存单价";
    $("scope-model-label").textContent = item.model;
    $("scope-wild-label").textContent = bare;

    if (customPrices['*/' + bare] && !customPrices[item.model]) {
      setScope('wildcard');
    } else {
      setScope('specific');
    }

    const current = getModelPrice(item);
    if (current && current.type === 'custom') {
      $("input-cost").value = current.input;
      $("output-cost").value = current.output;
      $("cache-read-cost").value = current.cache_read;
      $("cache-write-cost").value = current.cache_write;
    } else if (item.matched) {
      $("input-cost").value = item.matched.cost.input;
      $("output-cost").value = item.matched.cost.output;
      $("cache-read-cost").value = item.matched.cost.cache_read;
      $("cache-write-cost").value = item.matched.cost.cache_write;
    } else {
      $("input-cost").value = "0";
      $("output-cost").value = "0";
      $("cache-read-cost").value = "0";
      $("cache-write-cost").value = "0";
    }

    $("edit-modal").hidden = false;
    $("input-cost").focus();
  }

  function setScope(scope) {
    selectedScope = scope;
    if (scope === 'wildcard') {
      $("scope-wildcard").setAttribute("aria-selected", "true");
      $("scope-specific").removeAttribute("aria-selected");
      $("scope-hint").textContent = "【任何供应商模式】：价格将写入 */" + getBareModel(editingModel?.model || '') + "，所有提供此模型的渠道统一以此价格核算！";
    } else {
      $("scope-specific").setAttribute("aria-selected", "true");
      $("scope-wildcard").removeAttribute("aria-selected");
      $("scope-hint").textContent = "【仅当前渠道模式】：价格仅对当前所选的 " + (editingModel?.model || '') + " 生效，其他渠道该模型不受影响。";
    }
  }

  function closeEditModal() {
    $("edit-modal").hidden = true;
    editingModel = null;
  }

  async function saveModelPrice() {
    if (!editingModel) return;
    const bare = getBareModel(editingModel.model);
    const targetKey = selectedScope === 'wildcard' ? ('*/' + bare) : editingModel.model;

    const priceObj = {
      input: parseFloat($("input-cost").value) || 0,
      output: parseFloat($("output-cost").value) || 0,
      cache_read: parseFloat($("cache-read-cost").value) || 0,
      cache_write: parseFloat($("cache-write-cost").value) || 0
    };

    customPrices[targetKey] = priceObj;

    if (selectedScope === 'wildcard' && customPrices[editingModel.model]) {
      delete customPrices[editingModel.model];
    }

    await persistOptions();
    closeEditModal();
    renderStats();
    renderList();
    showToast("已设置 " + targetKey + " 单价并生效");
  }

  async function resetModelPrice(model) {
    const bare = getBareModel(model);
    delete customPrices[model];
    delete customPrices['*/' + bare];

    await persistOptions();
    renderStats();
    renderList();
    showToast("已重置 " + model + " 定价");
  }

  async function setGlobalMode(mode) {
    globalMode = mode;
    renderModeUI();
    await persistOptions();
    renderStats();
    renderList();
    showToast(mode === 'api-only' ? "已切换为：仅计费真实付费 API" : "已切换为：显示所有渠道等值公价");
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
    showToast("已应用 " + count + " 个匹配模型公价");
  }

  // Event handlers
  $("filter-seg").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    $("filter-seg").querySelectorAll("button").forEach(b => b.removeAttribute("aria-selected"));
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
      $("input-cost").value = editingModel.matched.cost.input;
      $("output-cost").value = editingModel.matched.cost.output;
      $("cache-read-cost").value = editingModel.matched.cost.cache_read;
      $("cache-write-cost").value = editingModel.matched.cost.cache_write;
    }
  });

  renderModeUI();
  renderStats();
  renderList();
})();
