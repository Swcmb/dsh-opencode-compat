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

## ops_* 层：read / glob / grep / bash / ls / list

`read`/`glob`/`grep` 这三个名字**本机内核是有的**（agent 创建后约 5–6 秒注册到位），
但它们注册在 **agent 自己的作用域**，profile 根插件在 global 层注册同名工具会撞：

```text
tool "read" is already registered (for a per-agent variant, register through that agent's `agent.ctx` instead)
```

所以这一层用两条腿走（`lib/ops-aliases.js`）：

1. `agent/created` 时通过 `agent.ctx.plugin(child => child.inject(['tools'], …))` 注册进
   **agent 本层**——与目标工具同层，且 `tools.restrict({ deny })` 只能遮继承来的全局名，
   遮不掉本层；
2. 再在 global 层注册一份，供没有 agent 上下文的调用兜底。

| 别名 | 委托目标 | 实际作用 |
|---|---|---|
| `read` | `ops_inspect_local_file` | 兜底：官方工具到位前的那几秒 |
| `glob` | `ops_glob` | 同上 |
| `grep` | `ops_grep` | 同上 |
| `bash` | `ops_bash` | **真实补充**：内核从不注册 `bash`（命令工具是 `ops_bash` / `pwsh`） |
| `ls` / `list` | `ops_glob` | **真实补充**：内核从不注册 `ls` |

同层重名时内核会拒绝（`tool "read" is already registered in this scope`），插件记日志跳过，
不重试、不覆盖。委托拿到真实定义后调它自己的 `execute`，DSH 的参数校验、沙箱、审批与渲染
继续生效；插件不读文件、不 spawn 进程。

> 不要用 `dsh-ops` 的 `replaceTools` 解决 `unknown tool "read"`：那是
> `tools.restrict({ deny })`，只把官方名字藏起来，不会让 `ops_*` 接管这些名字。

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
