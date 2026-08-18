# DSH Obsidian

[English](README.md) | 中文

`@dsh-plugins/dsh-obsidian` 为 DeepSeek Harness Web profile 增加 Obsidian Vault 浏览器、Markdown 编辑器，以及限定在当前 Vault 内的模型工具。插件直接操作本地目录中的文件，不要求 Obsidian 正在运行。

## 环境要求

- Node.js `^22.19.0 || >=24.0.0`
- pnpm
- DSH `0.1.0-rc.6` 和 Web profile
- DSH 进程可读取的目录；如需编辑，还必须可写

目录不强制包含 `.obsidian`，但常规 Obsidian Vault 通常会包含该目录。

## 安装

在本插件目录中执行：

```sh
pnpm install
pnpm run build
dsh plugin --profile web add "$(pwd)"
```

检查插件配置行是否存在：

```sh
dsh --profile web --dump-config
```

在输出中查找 `id: dsh-obsidian`，并确认 `config.vaultRoot` 的值。

## 快速开始

未提供覆盖配置时，`vaultRoot` 就是 DSH 启动时的当前目录。因此最简单的用法是：

```sh
cd /绝对路径/到/我的-vault
dsh web
```

从侧边栏底部打开 **Obsidian notes**。笔记浏览器会暂时替换会话浏览器，点击返回按钮即可恢复。打开笔记时，空白会话会在对话区域显示编辑器或预览；已有消息的会话会在详情面板中显示。

## 配置 `vaultRoot`

`vaultRoot` 指定 DSH 启动后的初始 Vault 目录。DSH 启动时会解析并校验该目录。

- 推荐使用绝对路径。
- 路径必须已经存在，并且必须是目录。
- DSH 进程必须具有读取权限。
- 创建、编辑、移动或删除笔记还需要写入权限。
- 相对路径以 DSH 的启动目录为基准解析。
- 普通 YAML 字符串中的 `~` 不会展开；请使用绝对路径或 `!!js` 表达式。
- 配置的根目录本身可以经符号链接解析，但 Vault 内部的符号链接不会被跟随。

### 方式一：使用启动目录

这是插件提供的默认配置：

```yaml
vaultRoot: !!js process.cwd()
```

每次从 Vault 目录启动 DSH，该目录就会成为初始 Vault。

### 方式二：持久配置固定目录

编辑 Web profile 的用户 patch：

```text
$DSH_HOME/profiles/web/cordis.patch.yml
```

`$DSH_HOME` 默认是 `~/.dsh`，因此常见文件路径为 `~/.dsh/profiles/web/cordis.patch.yml`。保持 YAML 顶层为数组，并添加：

```yaml
- id: dsh-obsidian
  config:
    vaultRoot: '/Users/alice/Documents/Obsidian/My Vault'
    mutationOrigin: 'http://127.0.0.1:3080'
    maxNoteBytes: 2097152
    searchResultLimit: 100
```

Linux 示例：

```yaml
    vaultRoot: '/home/alice/notes/my-vault'
```

Windows 示例：

```yaml
    vaultRoot: 'C:\Users\Alice\Documents\Obsidian\My Vault'
```

重要：DSH 对配置行的覆盖会替换整块 `config`，不会逐字段合并。因此覆盖时必须同时写出 `vaultRoot`、`mutationOrigin`、`maxNoteBytes` 和 `searchResultLimit` 四项。

编辑 profile patch 后重启 DSH，再检查最终生效的值：

```sh
dsh --profile web --dump-config
```

### 方式三：通过环境变量指定目录

可以在 profile patch 中读取自定义环境变量：

```yaml
- id: dsh-obsidian
  config:
    vaultRoot: !!js process.env.DSH_OBSIDIAN_VAULT ?? process.cwd()
    mutationOrigin: !!js process.env.DSH_OBSIDIAN_ORIGIN ?? 'http://127.0.0.1:3080'
    maxNoteBytes: 2097152
    searchResultLimit: 100
```

然后这样启动 DSH：

```sh
export DSH_OBSIDIAN_VAULT='/绝对路径/到/我的-vault'
dsh web
```

PowerShell：

```powershell
$env:DSH_OBSIDIAN_VAULT = 'C:\Users\Alice\Documents\Obsidian\My Vault'
dsh web
```

环境变量会在 DSH 进程启动时读取。

### 方式四：使用一次性 patch

创建 `obsidian-vault.patch.yml`，写入上面的完整配置行覆盖，然后运行：

```sh
dsh --profile web --patch ./obsidian-vault.patch.yml
```

`--patch` 只对本次启动有效，并且优先级高于 profile patch。

### 从界面切换 Vault

点击 Vault 名称旁的文件夹设置按钮，浏览运行 DSH 的机器上的目录。进入目标目录后，点击 **Use this folder**。

- 笔记浏览器和全部 `obsidian_*` 模型工具会一起切换。
- 切换前必须保存或放弃当前笔记的未保存内容。
- 所选目录只在当前 DSH 进程内有效。
- 重启 DSH 后会恢复配置的 `vaultRoot`。
- 如果浏览器连接的是远程 DSH，选择器显示的是服务器目录，不是浏览器所在设备的目录。

## 配置项参考

| 配置项 | 默认值 | 说明 |
|---|---:|---|
| `vaultRoot` | `process.cwd()` | 初始 Vault 目录。 |
| `mutationOrigin` | `DSH_OBSIDIAN_ORIGIN` 或 `http://127.0.0.1:3080` | 允许创建、编辑、移动、删除笔记或选择 Vault 的准确浏览器 Origin。必须包含协议和端口，不能包含路径。 |
| `maxNoteBytes` | `2097152` | 单篇笔记允许的最大 UTF-8 字节数，必须是正安全整数。 |
| `searchResultLimit` | `100` | 单次搜索返回的最大结果数，必须是正安全整数。 |

如果通过其他 Origin 打开 DSH，请将 `mutationOrigin` 设为该准确 Origin。例如：

```yaml
    mutationOrigin: 'https://dsh.example.com'
```

不要添加末尾路径。Origin 不匹配时，读取请求仍可执行，但修改和 Vault 选择请求会以 `ORIGIN_DENIED` 拒绝。

## 笔记工作流

- 浏览嵌套的 `.md` 文件，并搜索笔记路径或内容。
- 输入 `Projects/Plan.md` 这样的 Vault 相对路径来创建笔记。
- 编辑并保存笔记，保存时会检测文件是否已被外部修改。
- 预览 Markdown、GFM 表格、任务列表、Wiki 链接、frontmatter 和本地图片。
- 从当前笔记的操作菜单中重命名、移动或永久删除笔记。
- 将当前笔记引用加入当前 DSH 聊天草稿。
- 通过定时刷新观察外部文件或模型工具造成的变化。

只有 `.md` 文件会显示为笔记。隐藏目录、`.git`、`.obsidian` 和 `node_modules` 不会出现在笔记树中。本地预览支持 PNG、JPEG、GIF、WebP 和 AVIF 图片。

## 模型工具

当前 DSH provider 会获得以下工具，它们都限定在当前选择的 Vault 中：

- `obsidian_list_notes`
- `obsidian_read_note`
- `obsidian_search_notes`
- `obsidian_write_note`
- `obsidian_move_note`
- `obsidian_delete_note`

所有笔记路径都必须是 Vault 相对的 `.md` 路径。`obsidian_list_notes` 支持 1 到 500 的 `limit` 和用于继续翻页的 `cursor`。替换笔记时必须传入 `obsidian_read_note` 返回的 `modifiedMs`。删除操作不可撤销，只应在用户明确要求时执行。

## 安全与文件系统行为

- 插件直接编辑原始 Vault 文件，不会创建备份或版本历史。
- Vault 内的符号链接不会用于笔记、资源读取或修改操作，也不会显示在列表中。
- 笔记路径不能是绝对路径、不能包含空路径段，也不能用 `..` 穿越目录。
- 写入不会静默覆盖已有笔记；替换时必须提供最近一次读取到的修改时间。
- 移动操作不会覆盖已有目标文件。
- 修改和 Vault 选择 HTTP 请求必须来自配置的浏览器 Origin。

对重要笔记启用写入操作前，请使用 Obsidian Sync、Git、Time Machine 或其他方式进行备份。

## 故障排查

### DSH 启动失败

运行：

```sh
dsh --profile web --dump-config
```

确认 `vaultRoot` 是指向现有目录的非空路径。将 `~` 改为绝对路径，并检查文件系统权限。

### DSH 启动后打开了错误的 Vault

界面选择不会持久保存。请在 `~/.dsh/profiles/web/cordis.patch.yml` 中设置 `vaultRoot`，重启 DSH，并检查 `--dump-config`。同时确认是否有更晚应用的 `--patch` 再次覆盖了该值。

### 保存或选择 Vault 时返回 `ORIGIN_DENIED`

将 `mutationOrigin` 设置为浏览器地址栏所示的准确 Origin：协议、主机名和可选端口，不包含路径。修改后重启 DSH。

### 目录没有出现在选择器中

该目录可能是符号链接、DSH 进程无权访问，或者目录已不存在。选择器会刻意忽略符号链接目录项。

### 笔记没有出现在目录树中

确认文件以 `.md` 结尾，不在隐藏或排除目录中，并且不是通过符号链接访问。

### 保存时报告冲突

文件在打开后发生了变化。请先保留草稿内容，重新加载笔记，合并两边的修改后再次保存。

### 笔记超过大小限制

在完整的配置覆盖中增大 `maxNoteBytes`，重启 DSH，然后检查最终生效的配置。

## 更新与卸载

如需更新本地源码 checkout，请重新构建并添加插件：

```sh
pnpm run build
dsh plugin --profile web add "$(pwd)"
```

如需让现有安装支持从公开 GitHub 仓库检测更新，可执行一次来源迁移；
新安装也可以直接使用同一命令：

```sh
dsh plugin --profile web config set --location=project --json allowBuilds \
  '{"@dsh-plugins/dsh-obsidian@git+https://github.com/shiliai/dsh-plugins.git":true,"@dsh-plugins/dsh-obsidian@git+ssh://git@github.com/shiliai/dsh-plugins.git":true}'
dsh plugin --profile web add \
  'github:shiliai/dsh-plugins#path:/plugins/dsh-obsidian'
```

这个稳定的仓库 allowlist key 会继续授权未来 commit 的 `prepare`。如果 profile
已经信任其他 build source，请先用 `dsh plugin --profile web config get --json
allowBuilds` 读取现有配置，再合并上述 entry。

通过仓库 updater 检查并自动更新；如果当前仍为本地目录或 tarball 安装，
`update` 也会完成一次性 source 迁移：

```sh
dsh plugin --profile web dlx \
  'github:shiliai/dsh-plugins#path:/scripts/dsh-plugin-updater' \
  check @dsh-plugins/dsh-obsidian
dsh plugin --profile web dlx \
  'github:shiliai/dsh-plugins#path:/scripts/dsh-plugin-updater' \
  update @dsh-plugins/dsh-obsidian
```

更新后请重启 Web profile。

卸载命令：

```sh
dsh plugin --profile web remove @dsh-plugins/dsh-obsidian
```

重启 DSH，并确认 `dsh --profile web --dump-config` 中已不存在 `id: dsh-obsidian`。同时删除 profile patch 中不再需要的 `dsh-obsidian` 覆盖。

## 开发验证

```sh
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run pack:check
pnpm run e2e:rc6
pnpm run release:check
```

rc.6 Playwright 检查使用已安装的稳定版 Chrome，并要求工作区干净且改动已提交，以确保被测包具有不可变身份。
