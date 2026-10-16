---
name: saas-ui-visual-analysis
description: 对比已登录 SaaS 的组件、布局、真实字体与 PNG 差异；browser-control 是唯一浏览器入口。
---

# SaaS UI 视觉逆向：最短路径

1. 通过现有 browser-control page alias 访问参考与目标页面，确认都在可比的业务状态。若参考需要登录，保留页面并请用户人工登录，禁止假冒已完成对比。
2. 用 `browser_batch` 的 `visual_inspect`（`mode: components`，CSS selector，`name: ref-styles`，必要时 `include_platform_fonts: true`）读取字体/尺寸/颜色/边框/阴影，自动将 JSON 保存在 artifacts。布局问题才用 `mode: layout`。默认不包含文本，确有需要才用 `include_text: true`；URL 不包含查询参数和 hash，CSS 资源 URL 自动隐藏。仅分析当前组件。
3. 用同一个 `browser_batch` 的 `screenshot`（`target` 为 CSS selector）分别保存 PNG；确保相同页面状态、视口缩放/DPR，并尽量对齐相同组件。
4. 本地运行 `node scripts/visual-compare.mjs --reference <reference.png> --target <target.png> --output <diff.png>`。可另外传 `--reference-json <a.json> --target-json <b.json>` 对比刚保存的结构化样式。返回 mismatchPercent / worstRegions / diffImage 和样式差异。
5. JSON 组件按数组位置比较，必须先确保两端选择器选中了对应组件；会报告增删与伪元素变化。优先看结构化样式差异，再用 Pixelmatch 确认渲染差异。动态内容、字体环境、视口、组件尺寸不等时不要把全量像素差异视为设计缺陷。跨 iframe、shadow DOM 不在当前自动提取范围内。证据充足立即停止。

实现：browser-control 复用 PicassoWeb 0.10.1 的 DOM 分析思想（MIT，见 `src/visual.ts`），Pixelmatch 为唯一像素差异算法；不启动 PicassoWeb MCP/Browser。
