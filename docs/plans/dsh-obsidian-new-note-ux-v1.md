# dsh-obsidian: 新建 Note 体验重设计 + mutationOrigin 健壮性修复 v1

日期:2026-09-21
状态:设计待评审
关联插件:`plugins/dsh-obsidian`
原型:`prototypes/dsh-obsidian/new-note-ux/index.html`

## 1. 背景与问题

### 1.1 Bug:新建 note 报 403「Note mutations require a same-origin browser request.」

**已复现并定位**(2026-09-21,生产 :3280):

- 所有写操作(PUT/POST/DELETE)经过 `http-api.ts` 的
  `assertConfiguredOrigin`,要求请求 `Origin` 头精确等于配置的
  `mutationOrigin`。
- 生产配置 `profiles/web/cordis.patch.yml` 中 `mutationOrigin` 的默认值仍是
  `http://127.0.0.1:3080`,而当前 GUI 实际运行在
  `http://127.0.0.1:3280`。浏览器按真实来源发送
  `Origin: http://127.0.0.1:3280`,与配置不符 → 403。
- 探测验证:同一请求带 `Origin: ...:3280` 返回 403 `ORIGIN_DENIED`,带
  `Origin: ...:3080` 则通过校验(404 NOT_FOUND,因为探测路径不存在)。

**根因**:origin 白名单是一个容易漂移的静态配置。GUI 端口变化(3080 →
3280、dev 沙箱 5280、任何反向代理)都会让写操作全部失败,且报错文案没有
指出期望值,排查困难。

**临时处置(已做)**:生产 `cordis.patch.yml` 默认值已改为
`http://127.0.0.1:3280`(备份 `cordis.patch.yml.bak-20260921-223051`),
下次外部重启生产宿主后生效。本 issue 要求代码层根治,使此类配置不再
需要手工跟随端口。

### 1.2 UX:新建 note 流程难用

现状(`VaultBrowser.tsx`):

1. 文件夹右键 →「New note here」后,输入框出现在**侧栏最顶部**(标签页
   上方),离目标文件夹很远;树可能已滚动到别处,用户感觉"跳到了导航栏
   最上面",且目标文件夹没有任何高亮,创建后找不到新文件。
2. 输入框要求填写**完整 vault 相对路径**:右键文件夹时仅预填
   `Folder/` 前缀,用户仍需自己拼路径;占位符 `Folder/Note.md` 还暗示
   必须带 `.md` 后缀(实际上 `store.createNote` 会自动补 `.md`,但 UI
   没有传达这一点)。
3. 创建成功后只有一行文本反馈「Created …」,树不会滚动/展开到新 note,
   反馈里的路径靠字符串裁剪(`text.replace(/^Created /u, '')`)回传,
   脆弱且不可本地化。

## 2. 设计目标

- G1:origin 校验不再需要手工配置即可适应 GUI 端口/主机变化,同时保留
  显式覆盖能力;报错可诊断。
- G2:新建 note 的输入发生在**目标位置原地**(in-place),目标文件夹
  有明确视觉反馈。
- G3:用户只需输入 **note 名**,不要求目录前缀,不要求 `.md` 后缀。
- G4:创建成功后新 note 在树中可见(滚动到位 + 高亮),并自动打开。

## 3. Bug 修复设计:自适应同源校验

`http-api.ts` 的 `assertConfiguredOrigin` 改为两级:

1. **默认(推荐)**:`mutationOrigin` 未配置时,校验
   `Origin` 头的 host 部分与请求自身的 `Host` 头一致
   (`new URL(origin).host === request.headers.host`)。浏览器同源
   fetch 必然满足;跨站伪造(不同源的 Origin)仍被拒绝。GUI 端口如何
   变化都不再需要改配置。
2. **显式覆盖**:配置了 `mutationOrigin`(或数组 `mutationOrigins`)
   时维持现有精确匹配语义,用于 GUI 与 API 确实不同源的部署(反代
   拆分等)。配置存在时优先级高于 Host 比较。

其它要求:

- 403 响应体带上诊断信息:收到的 Origin、期望来源(配置值或
  Host)。纯本地工具,无泄漏顾虑。
- `Origin` 缺失时维持拒绝(非浏览器客户端必须显式带 Origin)。
- 向后兼容:现有配置(含 `!!js` 表达式)原样生效;配置项改为可选,
  缺省走 Host 比较。
- 配置 schema:`mutationOrigin: string` → 可选;新增可选
  `mutationOrigins: string[]` 时两者合并为白名单。
- 测试:扩充 `tests/http-api.spec.ts` 的同源用例(无配置走 Host、
  配置覆盖、403 诊断信息)。

## 4. UX 重设计:原地创建(in-place creation)

参照 Obsidian / VSCode 资源管理器的成熟模式。

### 4.1 交互流程

**入口 A:文件夹右键 → New note here**

1. 目标文件夹自动展开(若已折叠),树滚动到使目标文件夹可见。
2. 目标文件夹行获得「创建目标」高亮(强调色浅底 + 左侧 2px 竖条),
   持续到提交或取消。
3. 输入行作为该文件夹的**第一个子行**原地插入,缩进与兄弟节点对齐,
   带新建文件图标。
4. 输入框只承载 **note 名**;框内右侧有不可选中的 `.md` 后缀徽章,
   明确传达"自动补后缀"。占位符:`Note name`。
5. 提交:Enter 或 ✓;取消:Esc、✕ 或失焦(blur 时若有合法非空内容
   则提交,与 Obsidian 一致;非法/为空则取消,不产生文件)。
6. 成功后:树刷新,新 note 行滚动进入视口并闪烁高亮一次
   (~1.2s),随后按现有行为在编辑器打开并进入 edit 模式。
7. 失败(重名、非法字符、服务端错误):错误文案显示在输入行正下方,
   输入行保持打开供修正,不丢内容。

**入口 B:顶栏「+」新建**

- 输入行作为**树根第一行**插入(不再出现在标签页之上),其余行为与
  入口 A 一致;无目标文件夹高亮。

**命名规则**

- 只输入名称,自动补 `.md`(已有逻辑,UI 透传)。
- 允许输入 `子目录/名称` 在当前文件夹下再嵌套一层(服务端
  `writeNote` 已递归建目录);超过一层嵌套仍允许,但设计上不主动
  宣传。
- 内联校验(即时,不提交):空名、含 `\` / `:` 等非法字符、与现有
  兄弟节点重名(忽略大小写)→ 输入行下方红字提示并禁用 ✓。
- 非法路径字符集沿用服务端校验,前端先做最常见的几项。

### 4.2 状态与组件改动

- `VaultBrowser`:`newPath: string | null` 替换为
  `creation: { parentDir: string } | null`(parentDir 为 '' 表示根)。
- `TreeNode` 新增渲染分支:当 `node.path === creation.parentDir` 且展开
  时,在子列表首位渲染 `NewNoteRow`(受控输入组件)。
- 新增 `path → row element` 的 ref 注册表,用于
  `scrollIntoView({ block: 'nearest' })`;高亮用 CSS animation,结束后
  移除类。
- `store.createNote(parentDir, name)` 签名调整:拼接
  `parentDir/name`,归一化 `.md`;返回 `{ path }` 或抛出结构化错误,
  不再返回字符串供 UI 裁剪。
- 反馈条:成功反馈携带 `path` 字段(对象而非字符串编码),点击跳转
  逻辑不变;创建成功的主要反馈改为树内高亮,文本反馈作为冗余保留。
- 可访问性:输入行 `role="treeitem"` 占位、`aria-label="New note name"`,
  Esc/Enter 行为在 `aria-describedby` 说明;闪烁高亮遵循
  `prefers-reduced-motion`(降级为静态高亮)。

### 4.3 视觉规格(对齐现有样式语言)

- 输入行:高度与树行一致(28px),背景 `--bg-input`,1px 强调色描边,
  圆角 6px;图标 `FilePlus2` 14px。
- `.md` 徽章:12px 等宽,`--fg-muted`,右边距 8px。
- 目标文件夹高亮:强调色 8% 透明度底 + 2px 左竖条;新 note 闪烁:
  背景从强调色 20% 渐隐到透明,1.2s ease-out。
- 错误提示:12px `--fg-error`,缩进对齐输入行文本起点。

高保真可交互原型见 `prototypes/dsh-obsidian/new-note-ux/index.html`
(纯 HTML/CSS/JS,覆盖入口 A/B、校验错误、成功闪烁四个状态)。

## 5. 范围与不做的事

- 包含:origin 校验根治 + 新建 note 原地创建全流程 + 树滚动/高亮。
- 不包含:文件夹重命名/删除的原地化(可复用同一 `NewNoteRow` 模式,
  另开 issue);拖拽移动;模板选择(创建时选模板,后续迭代)。

## 6. 验收标准

1. `mutationOrigin` 缺省时,GUI 在任意端口(3280/5280/反代)上的新建/
   重命名/删除/移动均成功;跨源 Origin 仍 403,且响应含诊断信息。
2. 右键文件夹新建:文件夹自动展开并高亮,输入行出现在其下方第一位;
   只输入 `周报` 回车即创建 `<文件夹>/周报.md`。
3. 创建后新 note 行在视口内可见并闪烁一次,编辑器打开该 note。
4. 重名/非法字符在输入行下方即时提示,不产生请求。
5. Esc 与 ✕ 取消后树状态完全还原(展开状态保留是允许的)。
6. `pnpm release:check`(dsh-obsidian)与扩充后的 `http-api.spec.ts`
   全绿。
