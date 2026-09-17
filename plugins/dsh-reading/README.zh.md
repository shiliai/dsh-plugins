# dsh-reading

DeepSeek Harness 沉浸式阅读工作台：在 GUI 内阅读 EPUB / PDF（AZW3/MOBI 等 Amazon 格式经转换后阅读），右栏常驻当前会话，阅读进度本地持久化。

## 当前状态

- **M1–M4（本版）**：本地 EPUB/PDF 书库与阅读器、阅读进度持久化、三栏工作台，以及 Wallabag 稍后读导入、列表和文章阅读。

## 功能

- **三栏工作台**：左栏书库/稍后读/批注页签，中栏阅读器，右栏为当前对话。
- **EPUB**：基于 [foliate-js](https://github.com/johnfactotum/foliate-js)，支持目录抽屉、字号调节、主题（夜间 / 白纸 / 羊皮纸）、分页 / 滚动两种翻页模式。
- **PDF**：基于 [pdf.js](https://mozilla.github.io/pdf.js/)，连续滚动 + 懒渲染。
- **进度持久化**：存于插件数据目录 `state.json`；EPUB 按 epubcfi 恢复，PDF 按页码 + 滚动比例恢复。
- **Wallabag 稍后读**：粘贴 HTTP(S) URL 收藏，获取正文后在中栏打开，并持久化文章滚动进度。

### 打开阅读先行

粘贴 URL 后不再等待 Wallabag 自身的提取：正文由本地提取管线立即打开（内置 z.ai 博客适配器——该站为纯客户端渲染，页面外壳只引用一个 MDX bundle，插件直接解析 bundle 得到正文 HTML，不执行 JavaScript），随后在后台自动写入 Wallabag 收藏，收藏失败不影响阅读。对已存在但正文为 "wallabag can't retrieve contents" 报错占位的存量条目，在打开/查看时自动用本地提取结果修复并写回 Wallabag。
- **公式渲染**：Wallabag 文章正文中的 `\(...\)` / `\[...\]` LaTeX 片段（如经自维护 graby 转换的微信公式文）用内置 MathJax SVG 输出渲染，无需联网加载字体。
- **NAS Calibre-Web OPDS**：浏览配置的 nasubuntu 书库，将选中的书下载到本地缓存后阅读。
- **导入**：书库页「导入」按钮（支持 `.epub` / `.pdf` / `.azw3` / `.mobi` / `.azw`；Amazon 格式在 M3 转换管道落地后可阅读）。

## 配置

部署级配置放在 `$DSH_HOME/.env`（非密钥）与 `$DSH_HOME/.credentials.yaml` 的 `refs:` 映射（密钥），模板见 monorepo 的 `docs/plans/dsh-reading-v1.env.example`。DSH 的“设置 → 插件 → Reading”页面会显示当前数据源地址和本地缓存策略，但不会显示凭据：

| 变量 | 默认值 | 用途 |
|---|---|---|
| `READING_DATA_DIR` | `~/.dsh/reading` | 书籍与 `state.json` 目录 |
| `READING_OPDS_0_URL` | — | OPDS/Calibre-Web 书库地址 |
| `READING_OPDS_0_USERNAME` | — | OPDS 用户名 |
| `READING_WALLABAG_URL` | — | Wallabag 地址 |
| `READING_WALLABAG_CLIENT_ID` 等 | — | OAuth 凭据（写入 credentials refs） |

> 安全提示：foliate-js 要求通过 CSP 屏蔽书内脚本，DSH 目前不发送 CSP 头，请只打开可信来源的电子书。

## 开发

```sh
pnpm install
pnpm run check        # typecheck + 测试 + 构建
pnpm run release:check
```
