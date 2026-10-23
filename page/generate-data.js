
const fs = require('fs');
const path = require('path');
const matcher = require('../matcher');

const report = matcher.scanAll();
const jsContent = 'window.__MAGPIE_MODELS_DATA__ = ' + JSON.stringify(report, null, 2) + ';\n';

fs.writeFileSync(path.join(__dirname, 'models-data.js'), jsContent, 'utf8');
console.log('models-data.js generated with', report.length, 'models');
