#!/usr/bin/env node
// magpie-models-price - command line for the price page plugin.
//
// A page plugin cannot run code in magpie's plugin host (it has no server
// entry, on purpose: it is a page, not a provider). So this CLI does the two
// things a page cannot: build the model list the page draws, and apply the
// saves the page stores in its own options.
const fs = require('fs');
const os = require('os');
const path = require('path');
const matcher = require('../matcher');
const pageData = require('../page-data');
const applier = require('../apply-options');

const SELF_ROOT = path.resolve(__dirname, '..');

function configDir() {
  return matcher.paths && matcher.paths.configDir ? matcher.paths.configDir : path.join(os.homedir(), '.config', 'magpie');
}

function isPricePlugin(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return pkg && pkg.name === 'magpie-models-price' && !!(pkg.magpie && pkg.magpie.page);
  } catch {
    return false;
  }
}

function expandHome(p) {
  if (typeof p !== 'string') return '';
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function isPathSpec(spec) {
  return /^\.{0,2}[\\/]|^~[\\/]|^[A-Za-z]:[\\/]/.test(spec);
}

function dirFromSpec(spec) {
  if (!spec || typeof spec !== 'string') return '';
  if (isPathSpec(spec)) return path.resolve(expandHome(spec));
  if (spec.startsWith('github:') || spec.startsWith('git+') || spec.startsWith('http')) return '';
  // npm package name, with or without a version: scope/name@version
  const at = spec.lastIndexOf('@');
  const name = at > 0 ? spec.slice(0, at) : spec;
  return path.join(configDir(), 'plugins', 'node_modules', name);
}

// The page folder magpie actually serves. An npx run lives in npm's cache;
// writing the data there would leave the installed copy empty, so the order is:
// explicit override, the plugin entries magpie has (enabled first), the
// installed package, then this checkout.
function resolvePageDir() {
  const override = process.env.MAGPIE_MODELS_PRICE_PAGE_DIR;
  if (override && override.trim()) {
    return { pageDir: path.resolve(expandHome(override.trim())), source: 'MAGPIE_MODELS_PRICE_PAGE_DIR' };
  }
  const entries = applier.pluginEntries().slice().sort((a, b) => Number(!!a.off) - Number(!!b.off));
  for (const entry of entries) {
    const dir = dirFromSpec(entry.spec);
    if (dir && isPricePlugin(dir)) {
      return { pageDir: path.join(dir, 'page'), source: 'plugins.json: ' + entry.spec };
    }
  }
  const installed = path.join(configDir(), 'plugins', 'node_modules', 'magpie-models-price');
  if (isPricePlugin(installed) && path.resolve(installed) !== SELF_ROOT) {
    return { pageDir: path.join(installed, 'page'), source: 'Magpie 已安装的插件' };
  }
  return { pageDir: path.join(SELF_ROOT, 'page'), source: '当前插件目录' };
}

function runSync(args) {
  const target = resolvePageDir();
  const force = args.includes('--force');
  const built = pageData.writePageData(SELF_ROOT, { pageDir: target.pageDir, force });
  if (!built.ok) {
    console.error('✗ 生成页面数据失败: ' + built.error);
    process.exitCode = 1;
    return;
  }
  console.log('✓ page/models-data.js 已生成：' + built.models + ' 个模型，' + built.ms + 'ms');
  console.log('  写入: ' + built.file);
  console.log('  来源: ' + target.source);
}

function describeApply(results) {
  if (!results.length) {
    console.log('没有待应用的页面保存。');
    return;
  }
  for (const item of results) {
    const r = item.result;
    if (!r.applied) {
      console.log('跳过 ' + item.spec + ' (' + r.reason + ')');
      continue;
    }
    if (r.error) {
      console.error('✗ 应用失败 ' + item.spec + ': ' + r.error);
      process.exitCode = 1;
      continue;
    }
    console.log('✓ 已应用 ' + (r.mode || '价格保存') + '：' + r.prices + ' 项价格' + (r.peakProviders ? '，' + r.peakProviders + ' 个渠道峰谷' : ''));
    if (r.peakError) console.warn('  峰谷未写入: ' + r.peakError);
    if (r.conflicts && r.conflicts.length) console.warn('  峰谷冲突（渠道未改）: ' + r.conflicts.join(', '));
  }
}

function runApply() {
  describeApply(applier.applyPendingOptions());
}

async function runWatch(args) {
  const intervalArg = args.find((a) => a.startsWith('--interval='));
  const interval = Math.max(1, parseInt(intervalArg ? intervalArg.split('=')[1] : '3', 10) || 3) * 1000;
  console.log('👀 监听页面保存与 Magpie 配置（每 ' + interval / 1000 + ' 秒检查，Ctrl+C 退出）...');
  let lastSignature = '';
  const tick = () => {
    try {
      const results = applier.applyPendingOptions();
      if (results.length) describeApply(results);
      const target = resolvePageDir();
      const built = pageData.writePageData(SELF_ROOT, { pageDir: target.pageDir });
      if (built.ok) {
        const sig = built.file + ':' + built.models + ':' + built.generated;
        if (sig !== lastSignature) {
          lastSignature = sig;
          if (built.generated) console.log('↻ 已更新页面数据：' + built.models + ' 个模型 (' + target.source + ')');
        }
      }
    } catch (err) {
      console.error('watch 出错:', err.message);
    }
  };
  tick();
  setInterval(tick, interval);
}

function runList() {
  console.log('\n🔍 正在扫描 Magpie 活跃模型与 models.dev 数据库...\n');
  const report = matcher.scanAll();
  const unpriced = report.filter((r) => r.isUnpriced);
  const priced = report.filter((r) => !r.isUnpriced);
  const offPeak = matcher.checkOffPeakStatus();
  console.log('📊 统计概览: 总模型 ' + report.length + ' 个 | 已定价 ' + priced.length + ' 个 | 未定价 ' + unpriced.length + ' 个');
  console.log('⏰ 当前分时状态: ' + offPeak.label + (offPeak.isOffPeak ? ' (🌙 按闲时价计费)' : ' (⚡ 高峰 ×2 计费)') + '\n');
  if (!unpriced.length) {
    console.log('🎉 太棒了！当前所有模型均已有定价。');
    return;
  }
  for (const item of unpriced) {
    const target = item.model.padEnd(38);
    if (item.matched) {
      console.log(target + ' ->  ' + (item.matched.provider + '/' + item.matched.model).padEnd(34) + ' $' + item.matched.cost.input + ' / $' + item.matched.cost.output);
    } else {
      console.log(target + ' ->  [无法自动匹配，需手动指定]');
    }
  }
}

function runMode(args) {
  const targetMode = args[0];
  if (targetMode === 'api-only' || targetMode === 'api') {
    matcher.writePluginOptions({ mode: 'api-only' }, SELF_ROOT);
    const n = matcher.applyGlobalMode('api-only');
    console.log('✓ 已切换为【仅计费真实付费 API】：已配置 ' + n + ' 个条目。');
  } else if (targetMode === 'all' || targetMode === 'all-equivalent') {
    matcher.writePluginOptions({ mode: 'all-equivalent' }, SELF_ROOT);
    const n = matcher.applyGlobalMode('all-equivalent');
    console.log('✓ 已切换为【显示所有渠道等值公价】：已配置 ' + n + ' 个条目。');
  } else {
    console.log('用法: magpie-models-price mode <api-only|all>');
  }
}

function runMatchPublic(args) {
  const dry = args.includes('--dry-run');
  const report = matcher.scanAll();
  const unpriced = report.filter((r) => r.isUnpriced && r.matched);
  if (!unpriced.length) {
    console.log('当前没有需要同步的未定价模型。');
    return;
  }
  let count = 0;
  for (const item of unpriced) {
    if (dry) {
      console.log('[DRY-RUN] ' + item.model + ' -> ' + item.matched.priceString);
      count++;
    } else {
      try {
        matcher.applyPrice(item.model, item.matched.priceString);
        console.log('✓ ' + item.model + ' -> ' + item.matched.priceString);
        count++;
      } catch (err) {
        console.error('✗ ' + item.model + ': ' + err.message);
      }
    }
  }
  console.log('完成：' + count + ' / ' + unpriced.length + ' 个模型。');
}

function runDoctor() {
  const target = resolvePageDir();
  const opts = matcher.readPluginOptions(SELF_ROOT);
  console.log('magpie 配置目录: ' + configDir());
  console.log('页面目录: ' + target.pageDir + ' (' + target.source + ')');
  console.log('页面数据: ' + (fs.existsSync(path.join(target.pageDir, 'models-data.js')) ? '存在' : '不存在，运行 magpie-models-price sync'));
  console.log('插件选项: ' + (opts ? '已读取' : '无（插件可能未安装或没有保存过）'));
  const entries = applier.pluginEntries();
  console.log('plugins.json 条目: ' + (entries.length ? entries.map((e) => e.spec + (e.off ? ' [关闭]' : '')).join(', ') : '无'));
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'list';
  if (command === 'sync' || command === 'page-data') return runSync(args);
  if (command === 'apply') return runApply();
  if (command === 'watch') return runWatch(args);
  if (command === 'doctor') return runDoctor();
  if (command === 'list' || command === 'status') return runList();
  if (command === 'mode') return runMode(args.slice(1));
  if (command === 'match-public') return runMatchPublic(args.slice(1));
  if (command === 'set') {
    if (!args[1] || !args[2]) return console.log('用法: magpie-models-price set <provider/model> <in,out,cache_read,cache_write>');
    console.log('✓ ' + matcher.applyPrice(args[1], args[2]));
    return;
  }
  if (command === 'reset') {
    if (!args[1]) return console.log('用法: magpie-models-price reset <provider/model>');
    console.log('✓ ' + matcher.resetPrice(args[1]));
    return;
  }
  if (command === 'ui' || command === 'serve') {
    const { startServer } = require('../server');
    const portArg = args.find((a) => a.startsWith('--port='));
    return startServer(portArg ? parseInt(portArg.split('=')[1], 10) : 3456);
  }
  console.log('magpie-models-price — 纯页面插件的命令行工具');
  console.log('  sync [--force]      生成 page/models-data.js（安装后先跑一次）');
  console.log('  apply               应用页面保存的价格/峰谷设置');
  console.log('  watch               持续监听页面保存并刷新页面数据');
  console.log('  doctor              检查配置目录与页面数据');
  console.log('  list                列出未定价模型与可匹配价格');
  console.log('  mode <api-only|all> 切换页面统计口径');
  console.log('  match-public        把 models.dev 公价应用到未定价模型');
  console.log('  set/reset <model>   直接设置或清除模型价格');
  console.log('  ui                  打开独立网页控制台');
}

main().catch((err) => {
  console.error('执行出错:', err);
  process.exit(1);
});
