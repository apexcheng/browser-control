---
name: saas-ui-visual-analysis
description: 对比已登录 SaaS 的组件、布局、真实字体与 PNG 差异；browser-control 是唯一浏览器入口。
---

# SaaS UI 视觉逆向：最短路径

1. 通过现有 browser-control page alias 访问参考与目标页面，确认都在可比的业务状态。若参考需要登录，保留页面并请用户人工登录，禁止假冒已完成对比。
2. 用 `browser_batch` 的 `visual_inspect`（`mode: components`，CSS selector，`name: ref-styles`，必要时 `include_platform_fonts: true`）读取字体/尺寸/颜色/边框/阴影（含 `outline-offset`、`align-self`），自动将 JSON 保存在 artifacts。布局问题才用 `mode: layout`。默认不包含文本，确有需要才用 `include_text: true`；URL 不包含查询参数和 hash，CSS 资源 URL 自动隐藏。仅分析当前组件。
3. 用同一个 `browser_batch` 的 `screenshot`（`target` 为 CSS selector、`padding_px: 4` 默认值）分别保存 PNG；元素必须**完整处于当前视口**，避免截图自动滚动或移动鼠标而丢失 hover/focus。检查 `recommended_padding_px`、`effects_may_be_clipped`、`padding_clipped`：后者只表示请求的留白被视口截断，**不代表 outline/shadow 完整**。根据建议增大 `padding_px`（最多 64）。滚动/动画页面可选 `stability_check: true`，比较连续两帧；若 `stability.stable=false`，先排除临时滚动条、动画、光标等噪声，再判定 CSS 差异。可选检查不保证绝对稳定，默认关闭以避免额外截图开销。
4. 本地运行 `node scripts/visual-compare.mjs --reference <reference.png> --target <target.png> --output <diff.png>`。可另外传 `--reference-json <a.json> --target-json <b.json>` 对比刚保存的结构化样式。components 结果提供 `componentDifferences`；layout 结果提供逐节点 `layoutDifferences`，两端 `kind` 必须一致。像素差异与 JSON 结构差异应同时查看。
5. JSON 组件按数组位置比较，布局按子节点路径比较，**不是语义自动匹配**。检查 `matchingWarnings` 和 `identity` 差异，警告出现时先确认两端元素对应关系；类名、ID 不同不一定是视觉缺陷。优先看结构化样式差异，再用 Pixelmatch 确认渲染差异。动态内容、字体环境、滚动条、视口、组件尺寸不等时不要把全部像素差异视为设计缺陷。跨 iframe、shadow DOM 不在当前自动提取范围内。证据充足立即停止。

实现：browser-control 复用 PicassoWeb 0.10.1 的 DOM 分析思想（MIT，见 `src/visual.ts`），Pixelmatch 为唯一像素差异算法；不启动 PicassoWeb MCP/Browser。
