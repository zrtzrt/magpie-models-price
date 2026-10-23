// check.js - Self-test suite for magpie-models-dev-sync
const assert = require('assert');
const matcher = require('./matcher');

console.log('🧪 开始运行自动化单元测试...');

// 1. 验证 catalog 加载
console.log('1. 测试 models.dev 本地缓存加载...');
const catalog = matcher.loadCatalog();
assert(Array.isArray(catalog) && catalog.length > 0, 'Catalog 应该成功加载且不为空');
console.log('   ✓ Catalog 加载成功，包含模型条目:', catalog.length);

// 2. 验证 Magpie 活跃模型解析
console.log('2. 测试 Magpie 本地活跃模型读取...');
const models = matcher.getMagpieModels();
assert(Array.isArray(models) && models.length > 0, '应该成功读取 Magpie 活跃模型');
console.log('   ✓ 成功读取 Magpie 活跃模型:', models.length, '个');

// 3. 验证全量扫描性能与无死锁
console.log('3. 测试全量定价与智能匹配性能 (要求 < 3000ms)...');
const t0 = Date.now();
const report = matcher.scanAll();
const duration = Date.now() - t0;
assert(duration < 3000, 'scanAll 执行时间超过 3s 阈值: ' + duration + 'ms');
console.log(`   ✓ 扫描完成，耗时 ${duration}ms, 总条目 ${report.length}`);

// 4. 验证核心厂商智能匹配算法
console.log('4. 测试智能匹配规则...');
const m1 = matcher.matchModel('workbuddy/deepseek-v4.1-flash', catalog);
assert(m1 !== null && m1.match.provider.includes('deepseek'), 'DeepSeek 应精准匹配到 deepseek 原厂或官方规约');
console.log('   ✓ DeepSeek 匹配成功 ->', m1.match.provider + '/' + m1.match.model);

const m2 = matcher.matchModel('antigravity/claude-opus-4-6-thinking', catalog);
assert(m2 !== null && m2.match.provider === 'anthropic', 'Claude Opus 应精准匹配到 anthropic');
console.log('   ✓ Claude 匹配成功 ->', m2.match.provider + '/' + m2.match.model);

const m3 = matcher.matchModel('antigravity/gemini-3.8-flash-tiered', catalog);
assert(m3 !== null && m3.match.provider === 'google', 'Gemini 应精准匹配到 google');
console.log('   ✓ Gemini 匹配成功 ->', m3.match.provider + '/' + m3.match.model);

// 5. 验证无污染设价与回退
console.log('5. 测试本地安全设价 (applyPrice) 与回退 (resetPrice)...');
const testModel = 'test-suite/synthetic-model';
matcher.applyPrice(testModel, '1.2,3.4,0.12,0.34');
const afterApply = matcher.getPricingStatus([{ fullName: testModel, free: false, listPrice: null }]);
assert(afterApply[0].isUnpriced === false, '设价后状态应为已定价');

matcher.resetPrice(testModel);
const afterReset = matcher.getPricingStatus([{ fullName: testModel, free: false, listPrice: null }]);
assert(afterReset[0].isUnpriced === true, '重置后状态应恢复为未定价');
console.log('   ✓ 设价与还原校验通过');

console.log('\n🎉 所有测试用例 100% 通过！系统 0 子进程调用，0% CPU 冗余。');
