// server.js - Web UI backend for Magpie models.dev Auto Matcher
const http = require('http');
const fs = require('fs');
const path = require('path');
const matcher = require('./matcher');

const PORT = process.env.PORT || 3456;
const PUBLIC_DIR = path.join(__dirname, 'public');

function sendJson(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
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
  // Enable CORS for preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  const parsedUrl = new URL(req.url, 'http://' + req.headers.host);
  const pathname = parsedUrl.pathname;

  // API Routes
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

  if (pathname.endsWith('.css')) {
    return sendFile(res, path.join(PUBLIC_DIR, pathname), 'text/css');
  }

  if (pathname.endsWith('.js')) {
    return sendFile(res, path.join(PUBLIC_DIR, pathname), 'application/javascript');
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

function startServer(port = PORT) {
  return new Promise((resolve) => {
    server.listen(port, () => {
      console.log(`Magpie Price Matcher Web UI running at http://localhost:${port}`);
      resolve(server);
    });
  });
}

module.exports = { startServer, server };

if (require.main === module) {
  startServer();
}
