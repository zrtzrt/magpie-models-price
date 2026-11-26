// 首帧主题：在样式表之前跑，避免浅色系统下先闪一下深色背景。
// 必须放成独立文件：插件页的 CSP 只放行宿主自己内联/并哈希过的脚本，
// page/index.html 里的内联 <script> 会被 "Executing inline script violates" 拦掉。
// magpie 会把 <script src> 原样内联回同一位置，所以这里写在 head 里仍然先于首帧。
(function () {
  try {
    var isDark = true;
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
      isDark = false;
    }
    var theme = isDark ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  } catch (e) {}
})();
