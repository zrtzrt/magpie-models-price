#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const matcher = require('./matcher');

const MODES = new Set(['api-only', 'all-equivalent']);
// Inputs the sync result depends on; when none changed, skip the ~3s scan.
// The folders come from matcher, which resolves them the way magpie's own
// appdir does (XDG_CONFIG_HOME / XDG_CACHE_HOME, then the home folder): building
// them here from process.env.HOME alone pointed the signature at a different
// folder than the one matcher writes, so on Windows and for an XDG user the
// scan was re-run on every tick and the prices it wrote were never read back.
const SYNC_INPUTS = [matcher.paths.cacheModels, matcher.paths.providersState];
let lastSignature = '';

function inputsSignature(mode, customPrices) {
  const files = SYNC_INPUTS.map((file) => {
    try {
      const st = fs.statSync(file);
      return st.mtimeMs + ':' + st.size;
    } catch {
      return 'missing';
    }
  });
  let prices = 'unreadable';
  try {
    prices = matcher.stableStringify(matcher.readSettings().modelPrices || {});
  } catch {}
  return matcher.stableStringify({ mode, customPrices, files, prices });
}

// Sync only what the user actually saved. A missing or unknown mode must not
// fall back to a default: the host can call us before options are available,
// and a silent 'all-equivalent' would overwrite an 'api-only' user's prices.
async function syncModeAndPrices(resolveOptions) {
  try {
    const options = await (typeof resolveOptions === 'function' ? resolveOptions() : resolveOptions);
    if (!options || typeof options !== 'object' || !MODES.has(options.mode)) return;
    const customPrices = options.customPrices || {};
    const signature = inputsSignature(options.mode, customPrices);
    if (signature === lastSignature) return;
    const { changed } = matcher.applyGlobalModeIfChanged(options.mode, customPrices);
    lastSignature = inputsSignature(options.mode, customPrices);
    if (changed) {
      console.log(`Synchronized mode [${options.mode}] and custom prices to Magpie settings.json`);
    }
  } catch (err) {
    console.error('Failed to sync mode and prices:', err.message);
  }
}

// Apply the page's rateWindows map (and the one-time DeepSeek default) to
// providers.json. The page cannot call the local HTTP service in the Magpie
// desktop window, so it saves the windows in this plugin's options and this
// loop is the writer.
async function syncRateWindows(resolveOptions) {
  try {
    const options = await (typeof resolveOptions === 'function' ? resolveOptions() : resolveOptions);
    if (!options || typeof options !== 'object') return;
    // 新格式：按模型保存的峰谷设置。Magpie 只有渠道级 rateWindows，由 matcher 汇总。
    if (options.modelPeaks && typeof options.modelPeaks === 'object') {
      const result = matcher.syncModelPeakWindows(options.modelPeaks);
      if (!result.ok) {
        console.error('Failed to sync model peak windows:', result.error);
        return;
      }
      const written = result.results.filter((x) => x.status === 'written');
      const conflicts = result.results.filter((x) => x.status === 'conflict');
      if (written.length) console.log('Synchronized model peak windows for ' + written.length + ' provider(s) to Magpie providers.json');
      if (conflicts.length) console.warn('Model peak conflicts (provider left unchanged): ' + conflicts.map((x) => x.provider).join(', '));
      return;
    }
    // 旧格式兼容：options.rateWindows 直接按渠道写。
    const map = options.rateWindows && typeof options.rateWindows === 'object' ? options.rateWindows : {};
    let written = 0;
    for (const [id, windows] of Object.entries(map)) {
      const result = matcher.setRateWindows(id, windows);
      if (result.ok && result.written) written += 1;
    }
    if (!options.rateDefaultsVersion && Object.keys(map).length === 0) {
      const result = matcher.applyDefaultRateWindows();
      if (result.ok && result.applied.length > 0) {
        const nextMap = { ...map };
        for (const item of result.applied) nextMap[item.id] = item.windows;
        matcher.writePluginOptions({ rateDefaultsVersion: 1, rateWindows: nextMap }, __dirname);
        written += result.applied.length;
      } else if (result.ok) {
        matcher.writePluginOptions({ rateDefaultsVersion: 1 }, __dirname);
      }
    }
    if (written) console.log('Synchronized rateWindows for ' + written + ' provider(s) to Magpie providers.json');
  } catch (err) {
    console.error('Failed to sync rate windows:', err.message);
  }
}

// OpenCode / Magpie Plugin export
let serviceStarted = false;
async function MagpieModelPricesPlugin(input, options) {
  if (!serviceStarted) {
    serviceStarted = true;
    require('./server').startServer();
  }
  // input.magpie.options() is a provider auth plugin's options, keyed by
  // provider, not a page plugin's: the page's own options (mode, custom
  // prices) are the ones magpie keeps in plugins.json, read here each time
  // they are wanted so a change in the page reaches this running server.
  const getOpts = async () => {
    let host = null;
    try {
      const raw = typeof input?.magpie?.options === 'function' ? await input.magpie.options() : null;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) host = raw;
    } catch {}
    const saved = matcher.readPluginOptions(__dirname) || null;
    return { ...(options || {}), ...(host || {}), ...(saved || {}) };
  };
  // Keep the scan off the plugin's load path so the host finishes starting.
  setTimeout(() => { syncModeAndPrices(getOpts); syncRateWindows(getOpts); }, 0);

  // Periodically check and synchronize new models from providers-state.json to settings.json
  if (typeof setInterval === 'function') {
    const timer = setInterval(() => { syncModeAndPrices(getOpts); syncRateWindows(getOpts); }, 60000);
    timer.unref?.();
  }

  return {
    async config(cfg) {
      await syncModeAndPrices(getOpts);
    }
  };
}

module.exports = MagpieModelPricesPlugin;
module.exports.default = { id: 'models-price', server: MagpieModelPricesPlugin };
module.exports.server = MagpieModelPricesPlugin;
module.exports.MagpieModelPricesPlugin = MagpieModelPricesPlugin;

// CLI runner when executed directly
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0] || 'list';

  async function main() {
    if (command === 'list' || command === 'status') {
      console.log('\n🔍 正在扫描 Magpie 活跃模型与 models.dev 数据库...\n');
      const report = matcher.scanAll();
      const unpriced = report.filter(r => r.isUnpriced);
      const priced = report.filter(r => !r.isUnpriced);
      const offPeak = matcher.checkOffPeakStatus();

      console.log(`📊 统计概览: 总模型 ${report.length} 个 | 已定价 ${priced.length} 个 | 未定价 ${unpriced.length} 个`);
      console.log(`⏰ 当前分时状态: ${offPeak.label} (${offPeak.isOffPeak ? '🌙 按闲时价计费' : '⚡ 高峰 ×2 计费'})\n`);

      if (unpriced.length === 0) {
        console.log('🎉 太棒了！当前所有模型均已有定价。');
        return;
      }

      console.log('---------------------------------------------------------------------------------------------------------');
      console.log('未定价 Magpie 模型                     ->  智能匹配 models.dev 模型            输入 / 输出单价 (USD/1M)');
      console.log('---------------------------------------------------------------------------------------------------------');

      for (const item of unpriced) {
        const target = item.model.padEnd(38);
        if (item.matched) {
          const mStr = (item.matched.provider + '/' + item.matched.model).padEnd(34);
          const costStr = `$${item.matched.cost.input} / $${item.matched.cost.output}`;
          console.log(`${target} ->  ${mStr} ${costStr}`);
        } else {
          console.log(`${target} ->  [无法自动匹配，需手动指定]`);
        }
      }
      console.log('---------------------------------------------------------------------------------------------------------');
      console.log('\n💡 执行命令:');
      console.log('  node index.js mode api-only   切换为仅统计 API 真实支出');
      console.log('  node index.js mode all        切换为显示所有渠道等值公价');
      console.log('  node index.js sync            一键自动应用匹配价格到 Magpie');
      console.log('  node index.js ui              启动可视化网页控制台进行精细化调整\n');
      return;
    }

    if (command === 'mode') {
      const targetMode = args[1];
      if (targetMode === 'api-only' || targetMode === 'api') {
        // keep the page's own switch in step, or the next tick would put the
        // other mode back
        matcher.writePluginOptions({ mode: 'api-only' }, __dirname);
        const n = matcher.applyGlobalMode('api-only');
        console.log(`✓ 已切换为【仅计费真实付费 API】：包月/免费渠道已全部免计费，已配置 ${n} 个条目。`);
        return;
      } else if (targetMode === 'all' || targetMode === 'all-equivalent') {
        matcher.writePluginOptions({ mode: 'all-equivalent' }, __dirname);
        const n = matcher.applyGlobalMode('all-equivalent');
        console.log(`✓ 已切换为【显示所有渠道等值公价】：所有模型按市场参考价估算，已配置 ${n} 个条目。`);
        return;
      } else {
        console.log('用法: node index.js mode <api-only|all>');
        return;
      }
    }

    if (command === 'sync') {
      const isDryRun = args.includes('--dry-run');
      console.log(`\n🚀 正在开始${isDryRun ? '【模拟】' : ''}自动同步价格到 Magpie...\n`);

      const report = matcher.scanAll();
      const unpriced = report.filter(r => r.isUnpriced && r.matched);

      if (unpriced.length === 0) {
        console.log('当前没有需要同步的未定价模型。');
        return;
      }

      let successCount = 0;
      for (const item of unpriced) {
        const priceStr = item.matched.priceString;
        if (isDryRun) {
          console.log(`[DRY-RUN] applyPrice: ${item.model} -> ${priceStr}`);
          successCount++;
        } else {
          try {
            const res = matcher.applyPrice(item.model, priceStr);
            console.log(`✓ 成功设置 ${item.model} -> ${priceStr} (${res})`);
            successCount++;
          } catch (e) {
            console.error(`✗ 设置失败 ${item.model}: ${e.message}`);
          }
        }
      }

      console.log(`\n✨ 完成！已${isDryRun ? '计划' : '成功'}设置 ${successCount} / ${unpriced.length} 个模型价格。\n`);
      return;
    }

    if (command === 'set') {
      const model = args[1];
      const priceStr = args[2];
      if (!model || !priceStr) {
        console.log('用法: node index.js set <provider/model> <in,out,cache_read,cache_write>');
        return;
      }
      try {
        const res = matcher.applyPrice(model, priceStr);
        console.log(`✓ ${res}`);
      } catch (e) {
        console.error('✗ 设置失败:', e.message);
      }
      return;
    }

    if (command === 'reset') {
      console.log('\n🔄 正在重置模型价格...\n');
      const targetModel = args.find(a => !a.startsWith('-') && a !== 'reset');
      if (!targetModel) {
        console.log('请指定要重置的模型名，例如: node index.js reset workbuddy/deepseek-v4.1-flash');
        return;
      }
      try {
        const res = matcher.resetPrice(targetModel);
        console.log(`✓ ${res}`);
      } catch (e) {
        console.error(`✗ 重置失败: ${e.message}`);
      }
      return;
    }

    if (command === 'ui' || command === 'serve') {
      const { startServer } = require('./server');
      const portArg = args.find(a => a.startsWith('--port='));
      const port = portArg ? parseInt(portArg.split('=')[1]) : 3456;
      await startServer(port);
      return;
    }

    console.log('未知命令: ' + command);
    console.log('支持的命令: list, mode, sync, set, reset, ui');
  }

  main().catch(err => {
    console.error('执行出错:', err);
    process.exit(1);
  });
}
