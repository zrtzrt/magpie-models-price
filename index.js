#!/usr/bin/env node
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
//
// The page cannot reach a program of its own in magpie's window (a page's CSP is
// connect-src 'none'), so a save there is stored by magpie as this plugin's
// options, and magpie reloads the plugin host when those change: that reload is
// where the save is applied. The page adds a fresh applyToken to each save, and
// a token already applied is skipped, so a reload for any other reason writes
// nothing. Options with no token (a fresh install, an older version's options)
// are left alone: nothing is written that the user did not set.
function applySavedOptions(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const token = typeof opts.applyToken === 'string' ? opts.applyToken : '';
  if (!token) return { applied: false, reason: 'no save to apply' };
  if (token === readApplied().token) return { applied: false, reason: 'already applied' };

  const out = { applied: true, token, mode: '', prices: 0, peakProviders: 0, conflicts: [], error: '' };
  if (MODES.has(opts.mode)) {
    const result = matcher.applyGlobalModeIfChanged(opts.mode, opts.customPrices || {});
    out.mode = opts.mode;
    out.prices = result.count;
  }
  if (opts.modelPeaks && typeof opts.modelPeaks === 'object') {
    const result = matcher.syncModelPeakWindows(opts.modelPeaks);
    if (!result.ok) {
      out.error = result.error;
    } else {
      out.peakProviders = result.results.filter((x) => x.status === 'written').length;
      out.conflicts = result.results.filter((x) => x.status === 'conflict').map((x) => x.provider);
    }
  }
  // Recorded only when the write went through: a save that failed stays pending,
  // so the next reload tries it again instead of dropping it.
  if (!out.error) writeApplied({ token, at: new Date().toISOString(), mode: out.mode, prices: out.prices });
  return out;
}

// OpenCode / Magpie Plugin export.
//
// Loading this plugin writes nothing. magpie loads it on every start, and the
// only write it makes is the save the user made in the page, applied once at
// the reload that save caused. No timer runs, and no price the user did not set
// is written: the first-run DeepSeek peak windows this used to add to
// providers.json on its own are gone.
async function MagpieModelPricesPlugin(input, options) {
  try {
    const result = applySavedOptions(options);
    if (result.applied && !result.error) {
      console.log(
        'Applied the save from the page: ' + (result.mode ? 'mode ' + result.mode : 'no mode') +
          ', ' + result.prices + ' priced model(s)' +
          (result.peakProviders ? ', peak windows on ' + result.peakProviders + ' provider(s)' : '')
      );
    } else if (result.error) {
      console.error('Could not apply the save from the page: ' + result.error);
    }
    if (result.conflicts && result.conflicts.length) {
      console.warn('Model peak conflicts (provider left unchanged): ' + result.conflicts.join(', '));
    }
  } catch (err) {
    console.error('Failed to apply the save from the page:', err.message);
  }
  return {};
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
