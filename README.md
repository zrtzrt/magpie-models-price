# Magpie Models Price (Magpie 模型价格自动匹配与自定义调价插件)

基于 [models.dev](https://models.dev) 官方公价数据库与 Magpie 原版账单系统，自动识别未定价模型、提供原厂公价匹配、支持按特定渠道或全网通配自定义设价，并支持一键切换【只记录真实 API 支出】或【显示所有渠道等值公价】。

---

## ✨ 核心特性

- 🖥️ **Magpie 原生 Page 页面插件**：直接嵌入 Magpie 侧边栏「模型价格」标签页，100% 贴合 macOS 原生设计质感；
- ⚡ **超轻量零开销**：纯文件直读直写架构（零子进程、零死锁、零 CPU 占用）；
- 🔄 **账单无缝联动**：设价后即时同步写入 Magpie 底层 `settings.json.modelPrices`，每日用量看板、会话统计与托盘花费实时重载；
- 💳 **全局统计口径总开关**：
  - **只记录 API 真实花费**：包月、会员及免费额度渠道（如 Trae, WorkBuddy, Antigravity）免计费（$0.00），只记录掏现金的 API 支出；
  - **显示所有渠道等值公价**：所有模型换算为市场市值，清晰掌握抵扣价值；
- 🛠️ **精细化调价与通配支持**：支持「仅当前渠道」或「任何供应商 (\*/model)」通配规则，并提供「一键填充 models.dev 建议」及「重置」功能；
- 📱 **响应式窄屏自适应**：在宽屏、分屏窄屏及极窄视口下自动换行流式布局，不遮挡任何操作按钮。

---

## 🚀 安装与挂载

### 方式一：在 Magpie 客户端内通过 CLI 挂载
```bash
magpie plugin add magpie-models-price
# 或者通过 GitHub 地址直接挂载：
magpie plugin add github:zrtzrt/magpie-models-price
```

### 方式二：本地开发挂载
```bash
git clone https://github.com/zrtzrt/magpie-models-price.git
cd magpie-models-price
magpie plugin add $(pwd)
```

---

## 💻 命令行维护（可选）

除在软件侧边栏图形界面操作外，也支持作为命令行工具独立维护：

```bash
# 查看所有模型匹配与定价状态
node index.js list

# 切换统计口径为仅记录 API 真实花费
node index.js mode api-only

# 切换统计口径为显示所有渠道等值公价
node index.js mode all

# 一键将所有 models.dev 建议公价写入 Magpie
node index.js sync

# 预览拟同步的设价命令（不实际写入）
node index.js sync --dry-run

# 运行自动化单元测试
npm test
```

---

## 📄 License
MIT License © zrtzrt
