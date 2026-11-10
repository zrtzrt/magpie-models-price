
const fs = require('fs');
const path = require('path');
const matcher = require('../matcher');

const report = matcher.scanAll();
const { totalSummary, bareUsage } = matcher.getUsageData();

const jsContent =
  ';(function(g){\n' +
  '  g.__MAGPIE_MODELS_DATA__ = ' + JSON.stringify(report, null, 2) + ';\n' +
  '  g.__MAGPIE_USAGE_SUMMARY__ = ' + JSON.stringify(totalSummary, null, 2) + ';\n' +
  '  g.__MAGPIE_BARE_USAGE__ = ' + JSON.stringify(bareUsage, null, 2) + ';\n' +
  '})(typeof window !== "undefined" ? window : globalThis);\n';

fs.writeFileSync(path.join(__dirname, 'models-data.js'), jsContent, 'utf8');
console.log('models-data.js generated with', report.length, 'models and usage summary:', totalSummary);
