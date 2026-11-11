// generate-data.js - Generates offline data and embeds 1:1 Magpie provider icon assets
const fs = require('fs');
const path = require('path');
const matcher = require('../matcher');

const HOME = process.env.HOME || process.env.USERPROFILE || '';
const PROVIDERS_STATE_PATH = path.join(HOME, '.cache/magpie/providers-state.json');
const MAGPIE_ICONS_DIR = path.join(HOME, '.config/magpie/icons');
const CAMOUFLAGE_ICONS_DIR = path.join(__dirname, '../../magpie-camouflage/page/icons');
const TARGET_ICONS_DIR = path.join(__dirname, 'icons');

if (!fs.existsSync(TARGET_ICONS_DIR)) {
  fs.mkdirSync(TARGET_ICONS_DIR, { recursive: true });
}

// 1. Copy icon files from Magpie config and camouflage to page/icons
for (const srcDir of [MAGPIE_ICONS_DIR, CAMOUFLAGE_ICONS_DIR]) {
  if (fs.existsSync(srcDir)) {
    try {
      const files = fs.readdirSync(srcDir);
      for (const f of files) {
        const sp = path.join(srcDir, f);
        const dp = path.join(TARGET_ICONS_DIR, f);
        if (fs.statSync(sp).isFile() && !fs.existsSync(dp)) {
          fs.copyFileSync(sp, dp);
        }
      }
    } catch (e) {
      console.warn('Icon copy warning:', e.message);
    }
  }
}

// 2. Extract provider icons and generate instant zero-latency Base64 Data URLs
const providerIcons = {};
const providerDataUrls = {};

if (fs.existsSync(PROVIDERS_STATE_PATH)) {
  try {
    const data = JSON.parse(fs.readFileSync(PROVIDERS_STATE_PATH, 'utf8'));
    const allProviders = [
      ...(data.providers?.providers || []),
      ...(data.providers?.presets || [])
    ];
    for (const p of allProviders) {
      if (p.id && p.icon) {
        providerIcons[p.id] = p.icon;
        if (p.icon.startsWith('file:')) {
          const fname = p.icon.slice(5);
          let sp = path.join(TARGET_ICONS_DIR, fname);
          if (!fs.existsSync(sp) && fs.existsSync(MAGPIE_ICONS_DIR)) {
            sp = path.join(MAGPIE_ICONS_DIR, fname);
          }
          if (fs.existsSync(sp)) {
            const buf = fs.readFileSync(sp);
            let mime = 'image/png';
            if (fname.endsWith('.svg')) mime = 'image/svg+xml';
            else if (fname.endsWith('.ico')) mime = 'image/x-icon';
            else if (fname.endsWith('.webp')) mime = 'image/webp';
            const dataUrl = 'data:' + mime + ';base64,' + buf.toString('base64');
            providerDataUrls[p.id] = dataUrl;
            providerDataUrls[p.icon] = dataUrl;
            providerDataUrls[fname] = dataUrl;
          }
        }
      }
    }
  } catch (err) {
    console.warn('Error reading providers state:', err.message);
  }
}

const report = matcher.scanAll();
const { totalSummary, bareUsage } = matcher.getUsageData();

const jsContent =
  ';(function(g){\n' +
  '  g.__MAGPIE_MODELS_DATA__ = ' + JSON.stringify(report, null, 2) + ';\n' +
  '  g.__MAGPIE_USAGE_SUMMARY__ = ' + JSON.stringify(totalSummary, null, 2) + ';\n' +
  '  g.__MAGPIE_BARE_USAGE__ = ' + JSON.stringify(bareUsage, null, 2) + ';\n' +
  '  g.__MAGPIE_PROVIDER_ICONS__ = ' + JSON.stringify(providerIcons, null, 2) + ';\n' +
  '  g.__MAGPIE_PROVIDER_DATA_URLS__ = ' + JSON.stringify(providerDataUrls, null, 2) + ';\n' +
  '})(typeof window !== "undefined" ? window : globalThis);\n';

fs.writeFileSync(path.join(__dirname, 'models-data.js'), jsContent, 'utf8');
console.log('models-data.js generated with', report.length, 'models,', Object.keys(providerDataUrls).length, 'icon data URLs, and usage summary:', totalSummary);
