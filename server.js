// server.js - Web UI backend for Magpie models.dev Auto Matcher
const http = require('http');
const fs = require('fs');
const path = require('path');
const matcher = require('./matcher');

const PORT = process.env.PORT || 3456;
// Loopback only: the service writes settings.json and providers.json, and
// listening on every interface put those writes on the LAN (and on whatever a
// DNS rebinding page resolves to 127.0.0.1). The plugin page in magpie's window
// reaches the service through the host bridge, and the standalone web UI is
// served by this same server, so neither needs a reachable address.
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');

// corsOrigin answers the origins a browser page here can legitimately have: the
// service's own origin and magpie's local ones. A wildcard let any website the
// user had open POST /api/mode and rewrite their prices.
function corsOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return null;
  let host;
  try {
    host = new URL(origin).hostname;
  } catch {
    return null;
  }
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1' ? origin : null;
}

function sendJson(res, data, status = 200) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  const origin = corsOrigin(res.req);
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

function sendFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    }
  });
}

const server = http.createServer((req, res) => {
  // CORS preflight, for the local origins corsOrigin names only: a foreign
  // origin gets no allow headers, so its JSON POST is never sent.
  if (req.method === 'OPTIONS') {
    const origin = corsOrigin(req);
    const headers = origin
      ? {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          Vary: 'Origin'
        }
      : { Vary: 'Origin' };
    res.writeHead(204, headers);
    return res.end();
  }

  const parsedUrl = new URL(req.url, 'http://' + req.headers.host);
  const pathname = parsedUrl.pathname;

  // API Routes
  if (pathname === '/api/usage' && req.method === 'GET') {
    try {
      const { channelUsage, bareUsage, totalSummary } = matcher.getUsageData();
      sendJson(res, { summary: totalSummary, models: bareUsage, channels: channelUsage });
    } catch (e) {
      sendJson(res, { error: String((e && e.message) || e) }, 500);
    }
    return;
  }
  if (pathname === '/api/status' && req.method === 'GET') {
    try {
      const report = matcher.scanAll();
      const unpriced = report.filter(r => r.isUnpriced);
      const priced = report.filter(r => !r.isUnpriced);
      const matchable = unpriced.filter(r => r.matched !== null);

      sendJson(res, {
        total: report.length,
        pricedCount: priced.length,
        unpricedCount: unpriced.length,
        matchableCount: matchable.length,
        items: report
      });
    } catch (e) {
      sendJson(res, { error: e.message }, 500);
    }
    return;
  }

  if (pathname === '/api/sync' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const items = payload.items; // array of { model, priceString }
        if (!Array.isArray(items) || items.length === 0) {
          return sendJson(res, { error: 'No items provided' }, 400);
        }

        const results = [];
        for (const item of items) {
          try {
            const out = matcher.applyPrice(item.model, item.priceString);
            results.push({ model: item.model, success: true, message: out });
          } catch (err) {
            results.push({ model: item.model, success: false, error: err.message });
          }
        }
        sendJson(res, { success: true, results });
      } catch (e) {
        sendJson(res, { error: e.message }, 500);
      }
    });
    return;
  }

  // 峰谷开关（总开关 + 按模型的开关）落在插件自己的 options 里：
  // 页面在 magpie 窗口内的 localStorage 是每次打开都可能重建的沙箱，
  // 只有 plugins.json 才是插件重启后还在的地方。
  if (pathname === '/api/options' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const patch = {};
        if (payload.peakEnabled !== undefined) patch.peakEnabled = !!payload.peakEnabled;
        if (payload.peakTargets && typeof payload.peakTargets === 'object') {
          patch.peakTargets = payload.peakTargets;
        }
        let peakSync = null;
        if (payload.modelPeaks && typeof payload.modelPeaks === 'object') {
          const checked = matcher.normalizeModelPeaks(payload.modelPeaks);
          if (!checked.ok) {
            return sendJson(res, { success: false, error: checked.error }, 400);
          }
          patch.modelPeaks = checked.modelPeaks;
          peakSync = matcher.syncModelPeakWindows(checked.modelPeaks);
        }
        const ok = matcher.writePluginOptions(patch, __dirname);
        sendJson(res, { success: ok, saved: patch, peakSync });
      } catch (e) {
        sendJson(res, { error: String((e && e.message) || e) }, 500);
      }
    });
    return;
  }

  // 模型级峰谷设置：读插件 options + 各渠道当前 rateWindows，便于页面/测试核对。
  if (pathname === '/api/model-peaks' && req.method === 'GET') {
    try {
      const opts = matcher.readPluginOptions(__dirname) || {};
      sendJson(res, {
        modelPeaks: opts.modelPeaks || {},
        providers: matcher.listRateWindowTargets().providers || []
      });
    } catch (e) {
      sendJson(res, { error: String((e && e.message) || e) }, 500);
    }
    return;
  }

  // 保存后自检：插件页把价格交给这里落盘，再由这里回读 settings.json，
  // 页面据此告诉用户「价格到底生效没有」，而不是只弹一句已保存。
  if (pathname === '/api/verify' && req.method === 'GET') {
    try {
      const customPrices = matcher.readPluginOptions(__dirname)?.customPrices || {};
      sendJson(res, matcher.verifyCustomPrices(customPrices));
    } catch (e) {
      sendJson(res, { error: String((e && e.message) || e) }, 500);
    }
    return;
  }

  // 高峰时段与倍率：直接读写 Magpie providers.json 的 rateWindows。
  // Magpie 自己按这些窗口计价（叠加 PriceRate），插件只负责编辑与校验。
  if (pathname === '/api/rate-windows' && req.method === 'GET') {
    try {
      sendJson(res, matcher.listRateWindowTargets());
    } catch (e) {
      sendJson(res, { error: String((e && e.message) || e) }, 500);
    }
    return;
  }

  if (pathname === '/api/rate-windows' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const result = matcher.setRateWindows(payload.id, payload.windows);
        sendJson(res, result, result.ok ? 200 : 400);
      } catch (e) {
        sendJson(res, { error: String((e && e.message) || e) }, 500);
      }
    });
    return;
  }

  if (pathname === '/api/mode' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const mode = payload.mode || 'all-equivalent';
        const customPrices = payload.customPrices || {};
        matcher.applyGlobalMode(mode, customPrices);
        sendJson(res, { success: true, mode });
      } catch (e) {
        sendJson(res, { error: e.message }, 500);
      }
    });
    return;
  }

  if (pathname === '/api/reset' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const models = payload.models; // array of model strings
        if (!Array.isArray(models) || models.length === 0) {
          return sendJson(res, { error: 'No models provided' }, 400);
        }

        const results = [];
        for (const m of models) {
          try {
            const out = matcher.resetPrice(m);
            results.push({ model: m, success: true, message: out });
          } catch (err) {
            results.push({ model: m, success: false, error: err.message });
          }
        }
        sendJson(res, { success: true, results });
      } catch (e) {
        sendJson(res, { error: e.message }, 500);
      }
    });
    return;
  }

  // Static files
  if (pathname === '/' || pathname === '/index.html') {
    return sendFile(res, path.join(PUBLIC_DIR, 'index.html'), 'text/html; charset=utf-8');
  }

  // Only files inside public/: pathname is URL-decoded by the time it reaches
  // here, so an encoded ../ could otherwise name anything on disk.
  if (pathname.endsWith('.css') || pathname.endsWith('.js')) {
    const file = path.resolve(PUBLIC_DIR, '.' + pathname);
    if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('Forbidden');
    }
    return sendFile(res, file, pathname.endsWith('.css') ? 'text/css' : 'application/javascript');
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

function startServer(port = PORT) {
  return new Promise((resolve) => {
    server.once('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        console.log(`Magpie Price Matcher Web UI already served on port ${port}; reusing the existing instance`);
      } else {
        console.warn(`Magpie Price Matcher Web UI unavailable on port ${port}: ${err && (err.code || err.message)}`);
      }
      resolve(null);
    });
    server.listen(port, HOST, () => {
      console.log(`Magpie Price Matcher Web UI running at http://${HOST}:${port}`);
      resolve(server);
    });
  });
}

module.exports = { startServer, server };

if (require.main === module) {
  startServer();
}
