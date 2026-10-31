# dsh 隔离验证方案（不碰运行中的 desktop）

> 目标：在不触碰运行中的 dsh desktop 实例的前提下，用「单独的 dsh web CLI + 独立 DSH_HOME」验证
> `dsh-agent-team-model`（teammate 模型路由）是否真的把子会话的 provider/model 换掉了。
>
> 本报告的每条结论都来自实测或编译产物行号。实测环境：macOS，desktop 实例 PID 20019 正在跑
> （监听 127.0.0.1:56187 / *:3081 / 127.0.0.1:9230），全程未改 `~/.dsh/profiles/desktop/`。

---

## 0. 环境事实（node / pnpm）

| 项 | 值 | 证据 |
|---|---|---|
| 安装声明版本 | node `24.21.0`，pnpm `11.28.5` | `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/versions.json` |
| 打包 node 实际版本 | v24.21.0（ELECTRON_RUN_AS_NODE 下的 Electron 内置 node） | 实测报错栈尾 `Node.js v24.21.0` |
| 系统 node | `v25.9.0`（`/opt/homebrew/bin/node`） | `node -v` |
| 系统 pnpm | `11.21.0`（`/opt/homebrew/bin/pnpm`） | `pnpm -v` |
| 打包 pnpm | `11.28.5` | `ELECTRON_RUN_AS_NODE=1 "$APP" --expose-internals .../primary-runtime/dependencies/pnpm/bin/pnpm.mjs -v` → 11.28.5 |
| zstd（读会话日志必需） | `/opt/homebrew/bin/zstd` | `which zstd` |

**结论**：系统 node 25 / pnpm 11.21 够用（跑 `node test/smoke.mjs` 与建 profile 目录），
但**不能用系统 node 启动 dsh CLI**——见下一节。

---

## 1. CLI 入口与命令

### 1.1 `runtime/cli/` 里有什么

| 文件 | 大小 | 角色 |
|---|---|---|
| `bin/dsh` | 583 B, POSIX sh | **真正的 CLI 启动垫片** |
| `link-entry` | 52608 B, **Mach-O 可执行文件**（不是脚本） | 把命令链接到磁盘（strings: `Command entry paths must be absolute.`、`Cannot link command entry: %s`） |
| `command-manager.js` | 23005 B, ESM 脚本 | 命令安装/卸载的**私有 worker**（inspect/install/remove） |
| `command-path.ps1` | 9438 B | Windows 侧同类实现 |

`bin/dsh` 全文（`runtime/cli/bin/dsh:1-12`）关键两行：

```sh
resources=$(CDPATH= cd -- "$(dirname -- "$launcher")/../../.." && pwd -P)
ELECTRON_RUN_AS_NODE=1 exec "$resources/../MacOS/DeepSeek Harness" --expose-internals \
  "$resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js" "$@"
```

→ **CLI 的真实入口是 Electron 二进制 + `dsh-desktop-host/lib/cli.js`**，不是 `dsh/lib/bin.js`。

`command-manager.js:493-511` 证明安装目标与落地方式：

```js
// command-manager.js:494
const [operation, expected] = process.argv.slice(2);
// :505-510  darwin
destination: "/usr/local/bin/dsh",
launcher: join(resources, "runtime", "cli", "bin", "dsh"),
linkHelper: join(resources, "runtime", "cli", "link-entry")
```

本机实测：`which -a dsh` **为空**，`/usr/local/bin/dsh` **不存在** → CLI 没被装成命令，
必须按下面的完整命令调用。

`runtime/bin/node` 只是壳（`runtime/bin/node:1-3`）：

```sh
#!/bin/sh
export ELECTRON_RUN_AS_NODE=1
exec "$DSH_DESKTOP_NODE_EXECUTABLE" --expose-internals "$@"
```

→ 用它必须自己给 `DSH_DESKTOP_NODE_EXECUTABLE`，不如直接用 Electron 二进制。

### 1.2 完整命令（实测通过）

```sh
APP="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
CLI="/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js"
ELECTRON_RUN_AS_NODE=1 "$APP" --expose-internals "$CLI" --help
```

（等价写法：`DSH_DESKTOP_NODE_EXECUTABLE="$APP" runtime/bin/node "$CLI" --help`。）

**必须走 Electron**：系统 node v25 读不了 asar 虚拟路径，实测
`node "$CLI" --help` → `Error: Cannot find module '.../app.asar/.../cli.js'`，exit 1。

### 1.3 `dsh --help` 的真实可用参数（只跑 --help，不启动任何服务）

实测输出（exit 0，未创建任何 profile、未监听端口）：

```
Usage: dsh [--profile] <name> [options] [app-args...]
       dsh plugin --profile <name> <pnpm-args...>

Options:
  -V, --version
  --profile <name>               the profile under $DSH_HOME/profiles to boot
  --from-default-profile <name>  replace a custom profile with a fresh copy of a shipped profile template
  --patch <path>                 extra patch-list overlay applied after the profile layer (repeatable)
  --dump-config                  print the composed profile tree and exit
  --dump-config-schema           print JSON Schema for profile entries and patches without mounting
  --dump-default-config          print the profile tree without its user layer or --patch overlays and exit
```

参数真相全在 `dsh/lib/bin.js`：

- `bin.js:105` 定义上述选项；`.helpOption(false).helpCommand(false).allowUnknownOption().passThroughOptions()`
- `bin.js:106-109`：没有 `--profile` 时，只要 args 里出现 `-h/--help` 就 `program.help()` → **纯打印，不 boot**
- `bin.js:129-130`：`dsh web ...` 被展开成 `["--profile","web", ...]`（`dsh <name>` 是缩写）
- `bin.js:35-37 + 112`：**boot 路径无条件拒绝 desktop profile**
  ```js
  function rejectElectronProfile(program, profile) {
      if (profile.toLowerCase() === "desktop") program.error("error: profile \"desktop\" is managed exclusively by the Electron application");
  }
  ```
- `bin.js:117-126`：`dsh plugin` 子命令的拒绝被 `manageDesktopProfile` 门控 → **desktop-host CLI 允许 `dsh plugin --profile desktop ...`**（见风险 R1）

### 1.4 `dsh web --help`：安全，不拉服务（已实测确认）

```sh
export DSH_HOME=/tmp/dsh-verify-home
ELECTRON_RUN_AS_NODE=1 "$APP" --expose-internals "$CLI" --profile web --help
```

实测结果：**exit 0，印刷 web app 帮助，不监听端口**（56 s 观察窗内直接退出，端口对比只有 desktop 的 56187），
并在隔离 home 里自动生成 4 个文件（无 `node_modules`）：

```
/tmp/dsh-verify-home/profiles/web/{package.json,cordis.patch.yml,cordis.yml,pnpm-workspace.yaml}
```

机制上也有定论：`dsh-web-app/cordis.patch.yml:13` 原文写着
> `# `dsh --profile web --help` provides no `webStartup`, so no server binds.`

对应代码：`dsh-web-app/lib/startup.js:44-71`——`--help` 在 `parseCmdline` 里由 commander 抛出
退出（`dsh-cmdline/lib/index.js:91-103`，help 走 `exit(exitCode)`），**action（提供 `webStartup` 的那段）根本不执行**；
所有从 flag 派生配置的行都 `inject` `webStartup`，因此没有行绑定端口。

web app 的完整 flag 面（`startup.js:25`）：
`--host` / `--no-open` / `--port`（`0`=系统分配）/ `--public-url` / `--trusted-host` / `--tls-cert`+`--tls-key` / `-h,--help`。

> 提醒：`dsh --profile web`（**不带 --help**）会真的起服务并阻塞终端——本方案一律 `--port 0 --no-open` 并带看门狗。

---

## 2. DSH_HOME / profile 方案

### 2.1 DSH_HOME 机制

`dsh-home-paths/lib/index.js`：

- `:15` `const DSH_HOME_ENV = "DSH_HOME"`
- `:98-111` **优先级：显式配置 > `$DSH_HOME` > `~/.dsh`**
- `:103-104` 空白值视为未设置（不会把 home 解析成 cwd）
- `:85` `resolve(expandHomePath(...))` → **相对路径按 cwd 解析，务必用绝对路径**

一个 home 里所有用户数据都跟着走（隔离即彻底）：

| 数据 | 路径 | 证据 |
|---|---|---|
| profiles | `$DSH_HOME/profiles/<name>` | `dsh-app-boot/lib/index.js:507, 546-549` |
| 机器级补丁层 | `$DSH_HOME/cordis.patch.yml`（**对所有 profile 生效**） | `dsh/lib/profile-boot-C14i-8IN.js:110-117, 1127-1136` |
| 凭据 | `$DSH_HOME/.credentials.yaml` | `dsh-credentials-local/lib/index.js:13, 49, 58` |
| 会话日志 | `$DSH_HOME/sessions/<cwd-slug>/<session-id>/session.v4.jsonl.zstd` | 实测目录 |
| 设置 | `$DSH_HOME/settings.yaml` | `dsh-settings/lib/index.js:348` |
| 启动诊断 | `$DSH_HOME/logs/startup-*.log` | `dsh/lib/bin.js:178-193` |

### 2.2 dsh web 用哪个 profile

- `dsh web` == `dsh --profile web`（`bin.js:129-130`）→ 用 `$DSH_HOME/profiles/web`
- **在全新 DSH_HOME 里这个 profile 会自动按内置模板创建**：`dsh-app-boot/lib/index.js:551-557`
  ```js
  const PROFILE_TEMPLATES = {
      acp: {bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-acp-app"]},
      web: {bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]},
      headless: {...}, sdk: {...}, "sdk-minimal": {...}
  };
  ```
  自动建目录逻辑在 `loadProfile`（`:1065-1071`）：`package.json` 不存在且名字是模板名 → `initProfile`；
  **自定义名字**则报错 "profile ... does not exist; create it with 'dsh plugin --profile <name> add <package>'"（`:1069`）。
- 建 profile 时写 4 个文件（`initProfile`，`:611-627`）：`package.json`、`cordis.patch.yml`（空数组）、
  `cordis.yml`、`pnpm-workspace.yaml`（hoisted），**不会覆盖已有 package.json**（`:614`）。
- **关键：shipped bundle 不需要 pnpm install**。模块解析是"双锚点"（`:499-503`）：
  先从 dsh 安装自身解析，再从 profile 目录解析。所以 `@deepseek-ai/dsh-base`、`dsh-web-app`、
  `dsh-experimental-agent-team-profile` 这些**从 app.asar 安装里直接拿到**。实测新 home 的 web profile
  确实只有 4 个文件、没有 node_modules，却能正常 dump/boot。
- 只有**出树插件**（如 `dsh-agent-team-model`）需要 profile 里的 `node_modules` 条目。

### 2.3 参考现有 profile 的写法

`~/.dsh/profiles/web/package.json`（最接近"最小 web profile"）：
```json
{ "name": "dsh-profile-web", "private": true,
  "dependencies": { "@deepseek-ai/dsh-subagent-acp": "0.2.0-rc.2", ... },
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app",
    "@deepseek-ai/dsh-experimental-schedule-bundle", "@wingsky-1/dsh-notifier" ] } } }
```
`~/.dsh/profiles/desktop/package.json` 里本插件的依赖写法就是 `"dsh-agent-team-model": "link:/Users/mark/1/craft/dsh-agent-team-model"`，
bundles 里也列了 `"dsh-agent-team-model"`。

> 注意 `normalizeShippedProfile`（`dsh-app-boot/lib/index.js:946-955`）只会把**恰好等于**
> `INSTALLATION_OWNED_PROFILE_TUPLES` 的 bundle 列重写回模板；只有 `headless` 有这个 tuple（`:559-563`）。
> 自定义 profile 名不受影响。

### 2.4 「verify 专用 profile」目录结构与 package.json（方案，不创建）

```
$DSH_HOME/                                  # 例如 /tmp/dsh-verify
├── profiles/
│   └── verify/                             # 自定义名（不是 web/headless 等保留名）
│       ├── package.json                    # 见下
│       ├── cordis.patch.yml                # 可留空 []
│       ├── cordis.yml                       # 启动时被自动重写为空数组
│       ├── pnpm-workspace.yaml              # 首次 boot 自动生成（hoisted）
│       └── node_modules/
│           └── dsh-agent-team-model -> /tmp/dsh-verify-plugin   # 符号链接（推荐指向副本）
├── sessions/                                # 会话日志（子会话 request/header 就在这）
├── storages/
├── logs/
└── .credentials.yaml                        # 只在需要真跑 LLM 时才有
```

`$DSH_HOME/profiles/verify/package.json`：

```json
{
  "name": "dsh-profile-verify",
  "private": true,
  "dependencies": {
    "dsh-agent-team-model": "link:/tmp/dsh-verify-plugin"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@deepseek-ai/dsh-experimental-agent-team-profile",
        "dsh-agent-team-model"
      ]
    }
  }
}
```

要点：
- `dsh-base` + `dsh-web-app`：UI/服务端最小面（`PROFILE_TEMPLATES.web` 就是这个组合，`app-boot:553`）
- `@deepseek-ai/dsh-experimental-agent-team-profile`：**必须有**——插件 `inject` 了 `agentTeams`
  （`lib/index.js:41`），`apply` 里直接 `ctx.agentTeams.tryMembership(agent)`（`lib/index.js:499-505`）
- `dsh-agent-team-model` 本身是 bundle：它的 `package.json` 声明了
  `"dsh": {"bundle": {"patch": "./cordis.patch.yml"}}`，patch 里 `insert: [{id: agent-team-model, name: dsh-agent-team-model}]`
- 想跑无头任务就把 `@deepseek-ai/dsh-headless` 也加进 bundles（自定义 profile 名不会被 normalize）

---

## 3. 端到端验证序列（可执行命令）

### 3.0 准备（一次性，全部落在 /tmp，零网络）

```sh
APP="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
CLI="/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js"
export DSH_HOME=/tmp/dsh-verify
export DSH_TELEMETRY_DISABLED=1
echo "DSH_HOME=$DSH_HOME"          # 每次都先打印，防止误用 ~/.dsh

# ① 插件副本（避免编辑源码影响 desktop 已 link 的同一目录，见风险 R3）
rm -rf /tmp/dsh-verify-plugin && cp -R /Users/mark/1/craft/dsh-agent-team-model /tmp/dsh-verify-plugin

# ② 手写 verify profile
P="$DSH_HOME/profiles/verify"
mkdir -p "$P/node_modules"
cat > "$P/package.json" <<'JSON'
{ "name": "dsh-profile-verify", "private": true,
  "dependencies": { "dsh-agent-team-model": "link:/tmp/dsh-verify-plugin" },
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app",
    "@deepseek-ai/dsh-experimental-agent-team-profile", "dsh-agent-team-model" ] } } }
JSON
ln -sfn /tmp/dsh-verify-plugin "$P/node_modules/dsh-agent-team-model"
```

> 为什么用软链而不 `pnpm install`：`link:` 依赖装完就是一条 symlink；直接建 symlink 等价且**不联网**。
> profile 的 `node_modules` 里指向 profiles 树之外的链接会被识别为 "linked root"
> （`dsh-app-boot/lib/index.js:664-692` 的 `linkedProfileRoots`），是官方支持形态。

### 3.1 第 0 级：纯 node 单测（完全不启动 dsh）

```sh
cd /tmp/dsh-verify-plugin && node test/smoke.mjs
# 实测输出： smoke: all assertions passed   (exit 0)
```

用系统 node 直接跑，零 dsh、零网络、零 home，先证明插件逻辑本身没坏。

### 3.2 第 1 级：组合树（compose）——证明 link 解析成功、行都在

```sh
ELECTRON_RUN_AS_NODE=1 "$APP" --expose-internals "$CLI" --profile verify --dump-config | tail -20
```

实测（1249 行，**无任何 skipping 警告**）：

```
# == @deepseek-ai/dsh-experimental-agent-team-profile
- id: agent-team
  name: '@deepseek-ai/dsh-experimental-agent-team'
- id: tool-agent-team
  name: '@deepseek-ai/dsh-experimental-tool-agent-team'
- id: ui-agent-team
  name: '@deepseek-ai/dsh-experimental-client-ui-agent-team'
# == dsh-agent-team-model
- id: agent-team-model
  name: dsh-agent-team-model
```

`--dump-config` 只组合、不挂载、不绑端口（`bin.js:239-243` → `runDumpConfig`）。
有 bundle 解析失败时这里会打印 `skipping profile bundle ...`（`dsh-app-boot/lib/index.js:537-539`）。

### 3.3 第 2 级：真 boot（挂载），**一定加 `--port 0`**

```sh
ELECTRON_RUN_AS_NODE=1 "$APP" --expose-internals "$CLI" --profile verify --port 0 --no-open &
pid=$!
sleep 8
# 实测 stdout 一行：dsh web: http://127.0.0.1:50231/?token=<token>
kill -TERM $pid
```

实测：10 秒内打印带 token 的 URL，**零 error / 零 skipping**，隔离 home 里只新增
`storages/workspace.json` + `.credentials.yaml`（后者只有 browser-session secret，**不含模型 key**）。
desktop 的 56187 全程未被触碰。

### 3.4 第 3 级：真跑一次模型路由（需要凭据）

隔离 home 没有模型凭据，所以要显式带过去（**只读源、写私有临时目录**）：

```sh
install -m 600 /Users/mark/.dsh/.credentials.yaml "$DSH_HOME/.credentials.yaml"
# 用完：shred/删除
```

（`.credentials.yaml` 内含 `OPENCODE_GO_API_KEY` / `DEEPSEEK_API_KEY` / `YFY_API_KEY` 等 refs，
**不要 cat、不要进报告、不要进 git**。）

无头跑一条会触发 `spawn_teammate_with_model` 的任务（bundles 里要加 `@deepseek-ai/dsh-headless`）：

```sh
ELECTRON_RUN_AS_NODE=1 "$APP" --expose-internals "$CLI" --profile verify --json \
  "用 spawn_teammate_with_model 创建一个 teammate（名字 t1，provider P，model M），
   让它只回一句 'route: P/M'，然后把它的回答原样贴出来。"
```

无头 CLI 的参数面：`dsh-headless/lib/startup.js:35` —— `--json`（NDJSON 运行事件）/`--session-id <id>`/`[task...]`（`-` 读 stdin）。

### 3.5 观测点：怎么证明"子会话 request/header 的 provider/model 真的变了"

会话日志：`$DSH_HOME/sessions/<cwd-slug>/<session-id>/session.v4.jsonl.zstd`
（实测：`~/.dsh/sessions/--Users-mark-1-craft-dsh-agent-team-model--/<id>/session.v4.jsonl.zstd`，
cwd 的 `/` 换成 `-`、整体包一层 `--`）。

**A. 找子会话**——子会话首行是 `session` 记录，带父指针（实测原文）：

```json
{"type":"session","version":4,"id":"f9f44330-...","cwd":"/Users/mark/1/craft/dsh-agent-team-model",
 "parentSession":"session-e31d4045-...","isSeeded":false,"origin":"subagent","delegationDepth":1,"agentPreset":"ptc"}
```

```sh
# 列出某次 run 的所有 subagent 子会话
for f in "$DSH_HOME"/sessions/*/*/session.v4.jsonl.zstd; do
  first=$(zstd -dc "$f" 2>/dev/null | head -1)
  case "$first" in
    *'"origin":"subagent"'*) echo "$f"; echo "$first" | head -c 300; echo;;
  esac
done
```

**B. 父会话的 `subagent/descriptor`**——记录本次 spawn 指定的路由（实测原文，seq 0）：

```json
{"type":"subagent/descriptor","seq":0,"time":1793390845664,
 "data":{"version":3,"mode":"continuable","provider":"spawn","label":"...",
         "agentProvider":"opencodex","agentModel":"opencode-go/deepseek-v4.1-flash",
         "agentReasoningEffort":"high"}}
```

字段 `agentProvider` / `agentModel` / `agentReasoningEffort` 就是
`spawn_teammate_with_model` 该落地的路由。

**C. 子会话的 `request/header`（决定性证据）**——实测原文：

```json
{"type":"request/header","seq":13,"time":...,
 "data":{"header":{"config":{"provider":"opencodex","model":"opencode-go/deepseek-v4.1-flash",
                             "reasoningEffort":"high"},"tools":[...]}}}
```

事件签名（编译产物 `dsh-subagent/lib/typert.host.js`，`SessionEventMap` 声明）：

```ts
'request/header': { header: EpochHeader; reason: RequestHeaderReason; startsSeries?: true; }
'model/selection': ModelSelection
'subagent/descriptor': SubagentDescriptorData
// EpochHeader = { config: LlmCallConfig; adapterDefaults?; tools? }
// LlmCallConfig = { provider: string; model: string; reasoningEffort?: ReasoningEffortId; ... }
// RequestHeaderReason = 'initial' | 'resume' | 'change' | 'series'
// ModelSelection = { provider; model; reasoningEffort? }
```

**reason 的语义就是"变没变"的官方判据**（`dsh-agent-loop/lib/index.js:1222-1240`）：

```js
const baseline = this.session.requestHeader();
if (!this.requestHeaderLogged)  ... reason: baseline === void 0 ? "initial" : "resume"
else if (baseline === void 0 || !headerEquals(baseline, header))
       this.session.append("request/header", { header, reason: "change", ... })
else if (startsSeries) this.session.append("request/header", { header, reason: "series" })
```

→ **切换模型后，子会话的下一轮必然出现 `reason":"change"` 且 `header.config.provider/model` 变成新值**。
`series` 只表示新请求段、路由未变；`initial`/`resume` 是首次/冷恢复。

**D. `model/selection`**——插件切换时写入的持久事件：`lib/index.js:272-280`（`agent.model.select(selection)`，
退化路径才是 `agent.session.append('model/selection', selection)`）。
即：**`model/selection` = 请求变更；`request/header(reason=change)` = 变更已生效**。两条都要看到。

**E. 一条命令验证全流程**：

```sh
f=$(ls -t "$DSH_HOME"/sessions/*/*/session.v4.jsonl.zstd | head -1)
zstd -dc "$f" | node -e '
let buf="";process.stdin.on("data",d=>buf+=d).on("end",()=>{
  for (const line of buf.split("\n")) {
    if (!line.trim()) continue; let o; try{o=JSON.parse(line)}catch{continue}
    if (o.type==="request/header")
      console.log(String(o.seq).padStart(4), o.data.reason ?? "?", JSON.stringify(o.data.header.config));
    if (o.type==="model/selection") console.log(String(o.seq).padStart(4), "model/selection", JSON.stringify(o.data));
  }
});'
```

期望：先是 `initial {provider:P,model:M}`；`switch_agent_model` 之后出现 `model/selection`，
再下一轮出现 `change {...新的 P/M}`。

> 小坑：不要用 `grep -o '\{0,260\}'` 这类正则抓这两类事件——实测触发
> `grep: maximum repetition exceeds 255`。用上面的 node 解析。

---

## 4. 风险清单与规避

| # | 风险 | 证据 | 规避 |
|---|---|---|---|
| **R1** | **`dsh plugin --profile desktop ...` 是被允许的**，会真的往**运行中的 desktop profile** 里 pnpm install（改 package.json / pnpm-lock / node_modules） | `dsh/lib/bin.js:117-126` 的拒绝被 `manageDesktopProfile` 门控；`dsh-desktop-host/lib/cli.js:96-107` 传 `manageDesktopProfile: true` | **任何命令都只用 `--profile verify`**；把这条写进 shell 包装脚本，禁止手打 desktop |
| **R2** | 误 boot desktop profile | `bin.js:35-37 + 112` 无条件拒绝 → `dsh desktop` / `--profile desktop` 结构上不可能启动第二个 desktop 实例 | 无需额外防护；这条是"天然安全的" |
| **R3** | **插件源码目录是与 desktop 共享的**：`~/.dsh/profiles/desktop/node_modules/dsh-agent-team-model -> ../../../../1/craft/dsh-agent-team-model`（实测 lstat）；desktop 解析到的就是同一个文件，运行时带 HMR 通道（`@deepseek-ai/dsh-hmr` 是 CLI 直接依赖，`dsh/package.json`） | 实测 symlink 目标 | 隔离验证时**不要编辑仓库源码**；把源码 `cp -R` 到 `/tmp/dsh-verify-plugin` 再 `link:`。要改源码，改副本 `/tmp` 下的，最后再回写仓库 |
| **R4** | 端口冲突：desktop 已占 `127.0.0.1:56187`、`*:3081`、`127.0.0.1:9230`（另有 helper `127.0.0.1:9877`）。dsh web 的默认端口就在 3080/3081 区间（`dsh-host-webserver/lib/index.js:311` 文档示例 `http://127.0.0.1:3080`） | 实测 `lsof -nP -iTCP -sTCP:LISTEN` | **恒用 `--port 0`**（OS 分配，实测拿到 50231），并从 stdout 读 `dsh web: http://...`；`--no-open` 防抢浏览器 |
| **R5** | 忘设 `DSH_HOME` → 一切写进 `~/.dsh`（sessions/cache/storages，甚至 profile 目录），直接污染在跑的 desktop | `dsh-home-paths/lib/index.js:98-111` | 每个命令块第一行 `export DSH_HOME=/tmp/dsh-verify` 并 `echo` 出来；关键命令加 `[ -n "$DSH_HOME" ] || exit 1` 护栏。**禁止**写 `~/.dsh/cordis.patch.yml`（机器级补丁层对所有 profile 生效，会同时改 desktop 行为） |
| **R6** | `pnpm install` 影响：只要 cwd/可选 profile 正确就只动新目录；但一旦在 `~/.dsh/profiles/desktop` 下执行就会重排 lock 并可能改动 node_modules 链接 | `command-manager.js`/desktop-host 的 packageManager 用打包 pnpm 11.28.5 | 本方案**完全不需要 pnpm**（shipped bundle 双锚点解析 + 软链）；真要装也只在 `$DSH_HOME/profiles/verify` 里执行 |
| **R7** | 把凭据复制到 /tmp 造成密钥外泄 | `.credentials.yaml` 含 provider key | `install -m 600` 到私有目录，验证完立即删除；或用环境变量注入；**永不 commit / 永不打印** |
| **R8** | 前台跑 `--profile web` 阻塞终端、长期占端口 | `startup.js:44-71` 成功后进程常驻 | 一律后台 `&` + `pid=$!` + 超时 watchdog（`for i in $(seq 1 25); do kill -0 $pid || break; sleep 1; done`），超时就 `kill -9` |
| **R9** | SIGKILL 留下 `session.lock` 等残留（只在隔离 home 内） | 实测 session 目录含 `session.lock` | 无害；整个 `rm -rf /tmp/dsh-verify` 收尾即可 |

**不碰 desktop 的操作边界（自检清单）**：
- ✅ 只读 `~/.dsh/.credentials.yaml`、`~/.dsh/profiles/desktop/package.json`、`~/.dsh/sessions/*`（观测用）
- ✅ 全部写操作限定 `/tmp/dsh-verify*`
- ❌ 不写 `~/.dsh/**`（含 `cordis.patch.yml`、`profiles/desktop/**`、`sessions/**`）
- ❌ 不 `dsh plugin --profile desktop ...`、不 `kill` PID 20019、不重载 desktop

---

## 5. 实测证据速查（本报告所有实测结论）

| 实测 | 结果 |
|---|---|
| `CLI --help`（launcher） | exit 0，打印上面那套 launcher flag，**未创建任何文件、未监听** |
| `--profile web --help`（新 home） | exit 0，打印 web app 帮助，**不绑端口**，自动建 4 文件 profile、无 node_modules |
| `--profile verify --dump-config` | exit 0，1249 行，含 `agent-team`/`tool-agent-team`/`ui-agent-team`/`agent-team-model`，**零 skipping** |
| `--profile verify --port 0 --no-open` | 打印 `http://127.0.0.1:50231/?token=...`，零 error，desktop 56187 未受影响 |
| `node test/smoke.mjs`（系统 node 25） | `smoke: all assertions passed`，exit 0 |
| 系统 node 直跑 asar 内 CLI | **失败**（Cannot find module ... app.asar/...）→ 必须 Electron |
| `which -a dsh` / `/usr/local/bin/dsh` | 空 / 不存在 → CLI 未安装为命令 |

产物/临时文件：`/tmp/vfy-dsh`（从 app.asar 解出的包）、`/tmp/dsh-verify-home`、`/tmp/dsh-verify-home2`、
`/tmp/vfy-extract.js`、`/tmp/vfy-journal.jsonl`。清理：`rm -rf /tmp/vfy-* /tmp/dsh-verify*`。
