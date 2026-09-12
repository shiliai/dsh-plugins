# dsh-reading

DeepSeek Harness 沉浸式阅读工作台：在 GUI 内阅读 EPUB / PDF（AZW3/MOBI 等 Amazon 格式经转换后阅读），右栏常驻当前会话，阅读进度本地持久化。

## 当前状态

- **M1（本版）**：插件骨架、本地书库（导入/浏览）、foliate-js EPUB 阅读器、pdf.js PDF 阅读器（文件端点支持 Range）、阅读进度持久化、三栏工作台（书库 / 阅读器 / 对话）。
- 规划：M2 OPDS 书源接入、M3 SSH `ebook-convert` 转换 + 批注、M4 Wallabag 稍后读 + Obsidian 导出。设计文档见 monorepo 的 `docs/plans/dsh-reading-v1.md`。

## 功能

- **三栏工作台**：左栏书库（稍后读 / 批注页签在后续里程碑开放），中栏阅读器，右栏为当前对话。
- **EPUB**：基于 [foliate-js](https://github.com/johnfactotum/foliate-js)，支持目录抽屉、字号调节、主题（夜间 / 白纸 / 羊皮纸）、分页 / 滚动两种翻页模式。
- **PDF**：基于 [pdf.js](https://mozilla.github.io/pdf.js/)，连续滚动 + 懒渲染。
- **进度持久化**：存于插件数据目录 `state.json`；EPUB 按 epubcfi 恢复，PDF 按页码 + 滚动比例恢复。
- **导入**：书库页「导入」按钮（支持 `.epub` / `.pdf` / `.azw3` / `.mobi` / `.azw`；Amazon 格式在 M3 转换管道落地后可阅读）。

## 配置

部署级配置放在 `$DSH_HOME/.env`（非密钥）与 `$DSH_HOME/.credentials.yaml`（密钥），模板见 monorepo 的 `docs/plans/dsh-reading-v1.env.example`。M1 只用：

| 变量 | 默认值 | 用途 |
|---|---|---|
| `DSH_READING_DATA_DIR` | `~/.dsh/reading` | 书籍与 `state.json` 目录 |

> 安全提示：foliate-js 要求通过 CSP 屏蔽书内脚本，DSH 目前不发送 CSP 头，请只打开可信来源的电子书。

## 开发

```sh
pnpm install
pnpm run check        # typecheck + 测试 + 构建
pnpm run release:check
```
