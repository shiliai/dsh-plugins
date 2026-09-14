# dsh 插件架构解构（静态站点）

一个无构建依赖的多页静态站点，从本仓库的 5 个插件出发，解构 DeepSeek
Harness（dsh）的设计思想与架构：启动链路、宿主服务面、安装/更新契约、
各插件的集成方式，以及接口与设计模式速查。

纯 HTML + 一个共享 CSS，无 JavaScript、无构建步骤；编辑即发布。

## 本地阅读

```sh
cd docs/architecture-site
python3 -m http.server 8437
# 打开 http://127.0.0.1:8437/
```

（任意静态服务器均可；直接双击 index.html 用 file:// 打开也基本可用。）

## 页面地图

| 页面 | 内容 |
| --- | --- |
| `index.html` | 总览：设计思想十条、全景架构图、5 插件与环境事实 |
| `cordis.html` | Cordis 插件容器：五个核心思想、Fiber 生命周期、事件模式 |
| `boot.html` | `dsh --profile web` 启动八步、补丁层叠加、patch YAML 语法速查 |
| `services.html` | 宿主服务面：tools / agents / sessions / webServer / skills 契约 |
| `integration.html` | bundle/profile 双清单、安装与更新契约、5 插件对比总表、四种集成模式 |
| `patterns.html` | 关键 TS 接口契约（源码摘录）与 16 个设计模式目录 |
| `plugins/plugin-*.html` | wecom / remote / reading / obsidian / file-attachment 逐插件详解 |
| `walkthrough.html` | 从零写一个 dsh 插件的七步路径与发布前检查清单 |

## 维护说明

- 站内结论对照的宿主源码快照是 `deepseek-harness@8534614a1`
  （`codex/issue-57-routed-user-questions` 分支，基线 tag `dsh-v0.1.2-rc.1`，
  与本机安装 `0.1.2-rc.1-local-issue57` 对应）。宿主演进后需要人工修订。
- 与 `tools/dsh-explainer`（单页交互讲解器）互不影响：本目录是纯静态
  长文档站，不包含可执行代码。
- 页眉导航在每页各有一份静态拷贝；新增页面时记得同步所有页的 `<nav>`
  与首页 `index.html` 的导读卡片。
