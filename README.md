# @ianwusb/dsh-opencode-compat

DSH 插件：把 OpenCode 系模型幻觉出的少量工具名，安全地映射到 DSH 原生工具。

## 解决什么问题

glm / glm-flash 等经 opencode2api 接入的模型，在工具 schema 很大时会按 OpenCode 的训练记忆调用：

```text
tool/call  name="shell"     args={"command":"Get-ChildItem"}
tool/call  name="todowrite" args={"todos":[...]}
tool/call  name="webfetch"  args={"url":"..."}
tool/call  name="websearch" args={"query":"..."}
```

DSH 里对应的是 `pwsh`、`todo_write`、`web_fetch`、`web_search`。本插件把这 4 个名字注册成兼容别名，参数按目标工具 schema 归一化后**委托给原生工具**。

## 映射表

| 别名 | DSH 真实工具 | 参数归一化 |
|---|---|---|
| `shell` | `pwsh` | `command`、`workdir`、`timeout`→`timeoutMs`；缺 `description` 时从 `command` 生成 |
| `todowrite` | `todo_write` | 原样（`todos`） |
| `webfetch` | `web_fetch` | 只保留 `url` |
| `websearch` | `web_search` | `query` → `queries: [query]` |

`shell` 不再自己 spawn PowerShell。它调用原生 `pwsh` 的 `execute`，因此 DSH 的命令黑名单、工作目录解析、沙箱与审批链继续生效。

## 为什么删掉了 read / write / edit / glob / grep

这些别名的名字与 DSH 原生工具相同。插件由 profile 根 `cordis.patch.yml` 加载，作用域是 global；`tools.register("read")` 会与原生 `read` 同层重名并抛：

```text
tool "read" is already registered (for a per-agent variant, register through that agent's `agent.ctx` instead)
```

旧实现把这 5 个同名别名注册失败后静默跳过，实际没有生效。继续保留只会误导使用者，因此删除。参数名修正（例如 `path` → `file_path`）由外部工具网关 `toolgate` 的 sidecar 层负责；本插件只处理工具名。

同样，旧的 `shell` 自实现 PowerShell 已删除，因为它绕过了 `pwsh` 内置策略。

## 安装

`cordis.patch.yml`：

```yaml
- insert:
    - id: opencode-compat
      name: '@ianwusb/dsh-opencode-compat'
```

```bash
dsh plugin --profile desktop add @ianwusb/dsh-opencode-compat@latest
```

## 工作原理

- 用 `ctx.inject(['tools'], scoped => scoped.tools.register(tool))` 注册 4 个别名。
- 注册前用 `tools.get(name)` / `tools.executable(name)` 捕获真实工具定义；能委托就归一化参数后调用 `execute`，不能委托就返回「请改用 X」的可读提示，而不是 `unknown tool`。
- 工具正常注册，调用仍经过 DSH 的 `tools/pre-execute`、guard、审批与 `tools/result`。
- 纯 ESM，零 npm 运行时依赖，不 import `@deepseek-ai/*` 内部包。

## 测试

```bash
node --test packages/opencode-compat/test/compat.test.mjs
```

覆盖：4 个别名映射、shell 参数归一化、`query→queries`、`url` 裁剪、委托成功/失败、无转发提示、`apply` 注册 4 个工具、确认不存在同名别名。

## 限制

1. `shell` 委托到 `pwsh`；目标环境没有 `pwsh` 时返回提示，不执行命令。
2. 不处理 `read` / `write` / `edit` / `glob` / `grep` 的参数名；这些由 `toolgate` sidecar 负责。
3. 不处理 `background` 参数；后台命令请直接使用 DSH 原生 `pwsh`。
4. 参数归一化依据当前 DSH 工具 schema；DSH 升级后需要同步检查 `lib/normalize.js`。

## 许可

MIT
