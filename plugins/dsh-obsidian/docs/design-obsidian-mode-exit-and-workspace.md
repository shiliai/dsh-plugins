# 设计方案:Obsidian 模式的一键退出 与 对话工作区一致性

- 状态:v2(已按 k3-256k 评审修订,见 §10)
- 范围:`@dsh-plugins/dsh-obsidian` 客户端(Workbench / VaultBrowser / landing 流程)
- 关联:#135(vault landing)、#137/0.8.0(Refresh + discard 死锁修复)之后的两个新缺陷
- 高保真原型:`mockup-obsidian-mode-exit-and-workspace.html`(同目录,浏览器直接打开)

---

## 1. 问题定义

### 1.1 问题一:没有一键退出 Obsidian 模式

现状(v0.8.0)的退出/恢复路径盘点:

| 路径 | 现状 | 问题 |
| --- | --- | --- |
| 右上角 chrome 的 ✕ | `position:fixed; top:7px; right:8px` 的两个 12px 图标按钮 | 与宿主 header 的「Session 日志」按钮区域重叠,视觉上像宿主 UI,几乎不被认为是"退出 Obsidian" |
| Esc 键 | 关闭工作台 | 完全不可发现 |
| 侧边栏 footer 的 NotebookTabs 按钮 | 可再次点击关闭 | 无 active 态,不知道当前"处于 Obsidian 模式中";侧边栏收起时不可见 |
| 面板 header 的「隐藏」按钮 | 把单个面板收起 | 用户把它当成"退出"来用,于是一个一个收 |
| chrome 里的 pane checkbox 菜单 | 唯一的"恢复面板"入口 | 藏在角落图标后面,极难发现 |
| 全部收起后 | `workbenchEmpty` 卡片 `position:fixed` 钉在屏幕正中 | 像一个压在对话内容上的模态框;文案是英文;唯一的恢复按钮也在卡片里 |

结论:用户的心智模型是"收起面板 = 退出",而系统的心智模型是"收起面板只是布局偏好"。两者错位,最终落在屏幕正中的"Restore all panes"卡片上。

### 1.2 问题二:对话工作区与 Vault 的归属不一致

#135 的落地规则:空白对话 Add to chat 时迁入 vault workspace(cwd = vault,生成的文件进 vault);进行中的对话留在原 workspace,只接收引用块。这条规则本身正确,但缺少任何可见性:

1. **落地后**:侧边栏的 workspace 浏览器(ui-workspace)按 workspace 分组展示 session;新注册的 vault workspace 分组默认折叠、排序靠后,视觉重心仍停留在之前的 workspace(如 dsh-plugins)。用户"打开侧边栏看到的还是 dsh-plugins",无法确认文件去了哪。
2. **落地后**:工作台内部没有任何"当前对话的工作区是什么"的指示。用户看到文件进了 vault 目录,但 UI 上没有任何地方解释这一点。
3. **未落地(进行中的对话)**:反向不一致 —— 用户在 Obsidian 模式里对话,以为文件会进 vault,实际 cwd 还是 dsh-plugins。同样没有任何提示。
4. 注册 vault workspace 时沿用目录名,在侧边栏列表里没有辨识度(和普通目录 workspace 长得一样)。

### 1.3 顺带发现(纳入本设计)

- 工作台非 active 标签的草稿缓存在 `draftCache`(组件 ref),卸载即丢 —— 退出 Obsidian 模式再进来,之前未保存的标签草稿丢失。本设计把草稿缓存上移到 store,退出不再丢字。
- `openBrowser`(`sidebar.workspaces` 槽位注册)是死代码,vault 树从未出现在侧边栏。本设计不恢复它(工作台已是唯一的 vault 表面),但会删除误导。

---

## 2. 设计目标

1. **一键退出**:任何时刻、任何状态,一个明显、带文字的按钮完成退出;Esc 保持有效;退出可撤销。
2. **消灭"全收起"死态**:收起最后一个内容面板等价于退出,不再出现屏幕中央卡片。
3. **面板可恢复性成为常驻能力**:面板开关是常驻的 segmented control,不是藏在菜单里的 checkbox。
4. **文件去向永远可见**:工作台常驻显示"当前对话的工作区",一致时安静,不一致时警告并给出迁移动作。
5. **侧边栏可解释**:落地后用户能在侧边栏找到 vault workspace(通过命名 + toast 指引),不依赖改动宿主 ui-workspace 包。

非目标(本期不做):
- 不改动宿主 `dsh-client-ui-workspace` / `dsh-client-ui-sidebar` 包(只消费其既有能力)。
- 不做"把进行中对话迁移 workspace"的通用能力(宿主不支持和 cwd 变更语义,仅对空白对话提供"新开 Vault 对话")。
- 不恢复侧边栏 vault 树(工作台已是唯一 vault 表面,避免双入口漂移)。

---

## 3. 方案总览

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ⛨ Obsidian · MyVault   │ [Vault][编辑器][预览][对话] │ 💬 对话在 Vault 工作区 ▾ │ 退出 Obsidian ✕ │  ← 工作台标题栏(常驻)
├──────────┬────────────────────────┬───────────────────────┬─────────────────┤
│ Vault    │ Note editor            │ Preview               │ 对话             │
│ (树)     │ (tabs + editor)        │                       │ (真实会话)       │
└──────────┴────────────────────────┴───────────────────────┴─────────────────┘
```

三个核心改动:

1. **工作台标题栏(WorkbenchHeader)**:取代现在漂浮的两个图标按钮。左:模式标识 + vault 名;中:面板开关 segmented control(常驻、带按下态);右:工作区 chip(问题二)+ 带文字的「退出 Obsidian」按钮(问题一)。
2. **退出语义重定义(v2)**:
   - 「退出 Obsidian」/ Esc / 再次点击 footer 按钮 → 关闭工作台;
   - 全收起的处理分路径:segmented control 全关内容面板 → 轻量恢复条(纯对话布局合法);逐个 ✕ 收到最后 → 二次确认气泡;四个面板全关 → 自动退出 + 可撤销 toast(§5.1);
   - 退出时未保存草稿全部保留(store 级缓存),重开即恢复。
3. **工作区一致性(WorkspaceChip)**:由 `ctx.workspaces` 快照推断当前会话所在 workspace,与 `store.vaultRoot` 比对,三种状态(一致 / 不一致 / 未知),不一致时提供「在 Vault 中新开对话」。

---

## 4. 工作台标题栏(WorkbenchHeader)规格

### 4.1 布局

- 位置:工作台区域顶部,占 `rect.top` 起 36px 高;下方四个面板的 `top` 下移 36px(+gap)。
- compact(<720px):标题栏折两行,第一行模式名 + 退出按钮,第二行 segmented control;chip 收进 popover。

### 4.2 区段

**左 — 模式标识**
- 图形:Obsidian glyph(沿用 NotebookTabs)+ 文本 `Obsidian · <vaultName>`;点击 = 打开 vault 选择器(等价现有 FolderCog)。
- vault 名截断显示(title 属性给完整路径)。

**中 — 面板开关 segmented control(role="toolbar", aria-pressed)**
- 四个 toggle:`Vault` `编辑器` `预览` `对话`;按下 = 可见。
- 点击切换对应面板可见性;宽度拖拽、per-pane 隐藏按钮保持不变(二者写同一份 visibility 状态,segmented control 是镜像)。
- 「对话」toggle 关闭 = 隐藏真实会话(纯笔记布局),合法;但它不算"内容面板"。

**右 — WorkspaceChip + 退出按钮**
- WorkspaceChip:见 §6。
- 退出按钮:文字「退出 Obsidian」+ ✕ 图标,primary-quiet 样式(白底描边,hover 加深);`aria-keyshortcuts="Esc"`;tooltip "退出 Obsidian 模式(Esc)"。

### 4.3 状态保持

- `visibility` 仍持久化到 localStorage(现有 key),新增约束见 §5。
- 面板宽度、标签、草稿全部跨退出保留。

---

## 5. 退出语义与状态机

### 5.1 状态机

```
        ┌────────────────────────────────────────────────────────┐
        │                    (宿主对话视图)                        │
        └───────────┬─────────────────────────────▲──────────────┘
     footer按钮/Esc/ │                             │ 撤销(8s 内)/footer按钮/再次打开
     「退出 Obsidian」│                             │
        ┌───────────▼─────────────────────────────┴──────────────┐
        │               OBSIDIAN 模式(工作台打开)                 │
        │  content panes = tree/editor/preview 中可见的集合        │
        └───────────┬────────────────────────────────────────────┘
                    │ 收起最后一个可见内容面板
                    │ (面板 ✕ 或 segmented control)
        ┌───────────▼────────────────────────────────────────────┐
        │ 自动退出:工作台关闭 + exit toast(见 5.3)               │
        └────────────────────────────────────────────────────────┘
```

不变式(v2 修订):**工作台打开 ⇒ 至少一个可见面板(含「对话」)存在;且不允许出现"仅剩对话面板"而无任何提示的状态。** 具体拆成两条路径:

- **路径 A(显式开关)**:用户在 segmented control 里把 Vault/编辑器/预览全部关掉(对话面板仍可见)→ 这是**合法的纯对话布局**,不退出;面板区显示一条**可关闭的轻量恢复条**(inline,非模态):「已隐藏全部笔记面板 · [恢复笔记面板] ✕」;恢复条可永久关闭(记 localStorage),尊重"我就要纯对话"的用户。
- **路径 B(逐个 ✕ 整理)**:通过单面板「隐藏」按钮把最后一个内容面板收起 → 弹出**二次确认小气泡**(跟随该面板位置):「收起全部笔记面板并退出 Obsidian?[退出] [取消]」——逐个 ✕ 更像在整理布局,不直接推断为退出意图。
- **路径 C(对话面板也关掉)**:visibility 中四个面板全 false → 自动退出 + 撤销 toast(§5.3)。segmented control 关掉「对话」时若无任何内容面板可见,同样走路径 C(没有任何可见面板的工作台没有存在意义)。

### 5.2 退出时的数据保留

- `visibility`/`widths`:照旧持久化;自动退出路径不写入"全 false"(先退出,再落盘上次合法值)。
- 草稿:`draftCache` 从 Workbench 组件 ref 上移到 `VaultStore`(P1)。退出不清任何草稿;重开工作台后按路径恢复各标签草稿。
- `pendingDiscard`:沿用 0.8.0 语义 —— 卸载时 `cancelPendingDiscard()`(取消而非丢弃)。
- toast 提示"草稿已保留"仅在存在脏草稿时追加,避免噪音。

### 5.3 退出 toast(role="status",8s 自动消失)

| 场景 | 文案 | 动作 |
| --- | --- | --- |
| 手动退出,无脏草稿 | `已退出 Obsidian 模式` | 「撤销」 |
| 手动退出,有脏草稿 | `已退出 Obsidian 模式 · 未保存草稿已保留` | 「撤销」 |
| 自动退出(全收起) | `已退出 Obsidian 模式(所有面板已收起)` | 「撤销」(恢复之前的可见性并重开) |
| 退出且当前会话在 vault workspace | 追加第二行 `该对话仍在 Vault 工作区,生成的文件将继续保存到 <vaultName>` | 「查看工作区」(可选,见 §6.4) |

- 撤销(v2:非唯一恢复路径)= 恢复退出前的 visibility + 重开工作台;visibility 本就持久化,**重新打开 Obsidian 模式即可恢复面板布局**,8s 窗口内的撤销只是捷径,错过无损失。8s 后 toast 消失。
- toast 位置:底部居中,深色底白字,不遮挡 composer(与 0.8.0 feedback 样式语言一致)。
- **删除** `workbenchEmpty` 中央卡片及对应样式;`loadVisibility` 的全隐藏锁死保护保留作为兜底(持久化层防脏数据)。路径 A/B 的恢复条与确认气泡均为非模态 inline 元素(样式复用 `actionCommand`/`workbenchPaneMenu` 语言)。

### 5.4 入口状态

- 侧边栏 footer NotebookTabs 按钮在工作台打开期间呈现 active 态(高亮描边 + `aria-pressed=true`),tooltip 切换为「退出 Obsidian 模式」。
- compact 下 footer 按钮同样翻转语义。

---

## 6. WorkspaceChip(对话工作区一致性)规格

### 6.1 推断机制(v2 修订:会话 cwd 为主数据源)

```
// 一手事实:会话自身的路径(落地规则的判决依据就是 cwd)
sessionPath  = sessions.byId[sessions.current]?.path ?? undefined   // 以宿主会话快照实际暴露的字段为准
state        = sessionPath === undefined
                 ? (vaultWorkspace && vaultWorkspace.sessions.includes(sessions.current) ? 'vault' : 'unknown')
                 : samePath(sessionPath, store.vaultRoot) ? 'vault'
                 : 'other'
// 回退:workspaces 分组归属(分组快照是二手数据,仅作 rc 差异兜底)
```

- **为什么不用分组归属做主源**:§1.2 抱怨的"侧边栏不可见"正源自 workspaces 分组快照,拿它当真相是循环依赖;会话 cwd 才是"文件会写到哪"的判决依据。
- `samePath`(v2):**大小写不敏感**(macOS 默认文件系统)+ 首尾斜杠归一;popover 中原样展示双方路径便于核对。符号链接场景 v1 明确按字符串判定,文档注明;`landedWorkspaceId` 闪烁补丁删除(主源不再有闪烁问题)。
- 订阅 `ctx.sessions.list` 与 workspaces 快照失效,chip 实时重算;会话切换、切 vault 后立即更新。

### 6.2 三种状态

| 状态 | 视觉 | 文案 | 交互 |
| --- | --- | --- | --- |
| `vault` 一致 | 静态绿点 chip | `对话在 Vault 工作区` | 点击开 popover 详情 |
| `other` 不一致 | 琥珀色 ⚠ chip | `对话在 dsh-plugins 工作区` | 点击开 popover,内含迁移动作 |
| `unknown` 降级 | 灰 chip | `工作区未知` | 无 popover |

### 6.3 popover(点击 chip 展开)

```
当前对话        Fresh-from-chat
对话工作区       dsh-plugins  /Users/chris/project/dsh-plugins   ⚠ 生成的文件不会进 Vault
Vault           MyVault      /Users/chris/obsidian/MyVault

[ 在 Vault 中新开对话 ]   (空白对话时可用:直接迁移本对话)
```

- 「在 Vault 中新开对话」= 现有 landing 流程复用(`landInVaultWorkspace`),成功后 toast:`已切换到 Vault 工作区 — 生成的文件将保存到 <vaultName>`。
- 若当前对话非空白,该按钮显示为「新开 Vault 对话」(创建新的空白 vault 会话并切换),并注明当前对话将留在原工作区;若为空白,按钮文案为「迁移本对话到 Vault」。

### 6.4 侧边栏联动(v2 修订:实现常驻入口,而非仅改名)

1. **常驻锚点(评审修订 7)**:不删除 `openBrowser`,而是**实现它** —— 通过宿主已暴露的 `sidebar.workspaces` 槽位注册一个紧凑的「🗎 Obsidian · <vaultName>」入口(排在 workspace 分组之后),点击 = 打开工作台;工作台已打开时呈现 active 态。这给"文件在 vault"提供了一个**持久锚点**,不依赖 8s toast 的瞬态记忆。槽位为 `kind: 'single'`,注册前检查现有占用:ui-workspace 已注册浏览器时,本入口退化为 `sidebar.footer.action` 里的 footer 按钮(已有),即**两种宿主状态下都有常驻入口,只是位置不同**。
2. **命名辨识**:workspace 注册后做**一次性带标记改名**(store 内记 `renamedWorkspaceIds`,避免每次比对 basename 的重复写):若标题等于目录 basename,改为 `Obsidian · <basename>`;**同名 vault 追加父目录名消歧**(`Obsidian · notes (obsidian)`)。幂等,不覆盖用户自定义名。
3. **落地 toast 指引**(§6.3):文案点名 workspace 名称。
4. **退出 toast 降级为提示**(评审修订 8):不再把撤销当作唯一恢复路径 —— visibility 本就持久化,toast 文案为「已退出 Obsidian 模式 · 重新打开即可恢复面板布局」,8s 窗口内的「撤销」只是顺手捷径。
5. 不做:程序化展开宿主侧边栏分组、程序化选中侧边栏某 workspace —— 仍列为对宿主的上游诉求。

### 6.5 边界(v2 补齐)

- **无当前会话**:chip 不渲染(sessions.current === undefined 时整个右区只留退出按钮)。
- **工作台内新建会话**:归属跟随会话自身的 cwd(与 §6.1 主源一致,无需特判)。
- **Esc 作用域**:Esc 仅当工作台(或其内部浮层)持有焦点时关闭工作台,避免与宿主"停止生成/关闭弹层"快捷键冲突 —— 在 window keydown 里检查 `event.target` 是否位于 `[data-dsh-obsidian-workbench]` 或 body。
- 会话归档/切换:chip 跟随 `sessions.current` 重算。
- 用户在 popover 里切换 vault(FolderCog):vaultRoot 变更 → chip 重算;若旧会话仍在旧 vault workspace,呈现 `other` 态 + 迁移动作。
- rc.6 宿主(无 uiWorkspace/workspaces):`unknown` 态,landing 本就禁用,行为与 0.8.0 一致;§6.4 的常驻入口退化为 footer 按钮。
- `unknown` 不阻塞任何现有功能 —— chip 是纯信息层。

---

## 7. 高保真原型说明

见 `mockup-obsidian-mode-exit-and-workspace.html`,四个画板:

- **A 默认态**:新标题栏全量(模式名 / segmented control / chip=vault / 退出按钮)。
- **B 全收起 → 自动退出**:收起最后一个面板后不再出现中央卡片;对话视图 + 底部 toast(撤销)。
- **C 工作区不一致**:chip=other 态 + popover(迁移动作),对话仍在 dsh-plugins 的警示。
- **D 落地后侧边栏**:vault workspace 分组命名 `Obsidian · MyVault` + 落地 toast。

原型为静态 HTML + 内联 CSS(自包含,无外部依赖),配色沿用宿主 token(`--dsw-alias-*`、accent `#2e7d62`),仅表达布局与状态,不代表最终像素。

---

## 8. 实施切分(评审通过后)

| 阶段 | 内容 | 包 |
| --- | --- | --- |
| P1 | WorkbenchHeader(含 segmented control、退出按钮)+ 删除 workbenchEmpty + 退出状态机(路径 A 恢复条 / 路径 B 确认气泡 / 路径 C 自动退出)+ 退出 toast | dsh-obsidian |
| P2 | WorkspaceChip(cwd 主源)+ popover + 「在 Vault 中新开对话」+ 落地/退出 toast 文案 | dsh-obsidian |
| P3 | draftCache 上移 store;workspace 一次性改名(带标记+消歧);footer 按钮 active 态;sidebar.workspaces 常驻入口(可退化) | dsh-obsidian |
| 测试 | 状态机单测(路径 A/B/C、撤销恢复、恢复条永久关闭)、chip 推断单测(cwd 主源 + 大小写/斜杠归一)、改名幂等单测、e2e:一键退出 & chip 断言 | dsh-obsidian |

版本:minor(0.9.0)。

---

## 9. 对宿主的上游诉求(记录,不阻塞)

1. 侧边栏 workspace 分组暴露"展开并选中某 workspace"的程序化能力(landing 后引导)。
2. 支持把非空白会话迁移 workspace(cwd 语义明确化)—— 可解 `other` 态的迁移按钮降级问题。

---

## 10. k3-256k 评审结论与修订记录

评审结论:**需修订**(方向成立,1 处交互硬伤 + 1 处数据源风险)。以下 8 条修订**全部采纳**,落实位置:

| # | 修订项 | 落实 |
| --- | --- | --- |
| 1 | 「仅剩对话面板」是合法状态,不能自动退出;改轻量恢复条 | §5.1 路径 A |
| 2 | WorkspaceChip 以会话 cwd 为主源,分组归属仅回退;删 landedWorkspaceId | §6.1 |
| 3 | samePath 大小写不敏感;popover 原样展示路径;symlink 明确降级 | §6.1 |
| 4 | 改名改一次性带标记迁移;同名 vault 追加父目录消歧 | §6.4-2 |
| 5 | 补齐:无会话不渲染 chip / 新会话归属跟随 cwd / Esc 限定工作台焦点 | §6.5 |
| 6 | 区分两条全收起路径:segmented 全关→恢复条;逐个 ✕→二次确认 | §5.1 路径 A/B |
| 7 | 不删 openBrowser,实现为 sidebar.workspaces 常驻「Obsidian · vault」入口(ui-workspace 占用时退化为 footer 按钮) | §6.4-1 |
| 8 | 撤销 toast 降级为提示:重新打开即恢复,8s 撤销仅是捷径 | §5.3 |

评审确认无需修改的点:一键退出 + Esc + footer 翻转的组合、常驻 segmented control(镜像既有状态)、draftCache 上移、删除 workbenchEmpty、rc.6 降级、P1–P3 切分。

**未采纳/部分采纳说明**:修订 7 的常驻入口依赖 `sidebar.workspaces` 为 `kind: 'single'` 槽位 —— 宿主 ui-workspace 已注册该槽位时本插件**不能**抢占,只能退化到 footer 按钮(§6.4-1 已写明)。真正的"分组展开/选中"仍需上游能力(§9)。
