# 桌面版：Electron 封装与双根布局

2026-09-12 用户定案（原话大意）：「那就 electron，目标是两个文件，一个 zip 压缩包，一个 exe 安装包，mac 和 linux 的桌面版也得准备，写计划然后开始吧。」

## 一、目标产物

| 平台 | 产物 | 说明 |
|---|---|---|
| Windows | `Liyuan-<ver>-win-desktop-portable.zip` | 解压即用，免安装免 Node |
| Windows | `Liyuan-<ver>-win-desktop-setup.exe` | NSIS 安装包（per-user 安装） |
| macOS | `Liyuan-<ver>-mac-desktop-arm64.dmg` ＋ `-x64.dmg` | 未签名；发布说明写清隔离位清除法（与源码包文档同款） |
| Linux | `Liyuan-<ver>-linux-desktop.AppImage` | AppImage 单文件 |

全部免装 Node.js——运行时由 Electron 自带（Node ≥22）。

## 二、选型依据（已答用户）

不可动核心是 Node（server TS 直跑、jiti 扩展装载、vendored pi），桌面壳选谁都改变不了必须带一个 Node 运行时；Electron 本身就是那个 Node，Tauri 则要多出 Rust 壳＋Node sidecar 两条打包链。依赖表全纯 JS 零原生模块（`package.json` 运行时依赖仅 `ws`、MCP SDK、两个 `file:` 内核包），无重编译负担。前端一直在 Chromium 系浏览器测，Electron 三平台同一引擎；Tauri 是三套系统 webview。

## 三、铁律四三问

**问 1 全集**：分发面 = 4 产物 × 3 类首次环境（干净机器：无 Node、无数据、无配置／老用户升级：旧数据根＋新代码根／用户挪动数据根或便携目录）。结构性风险全集：

1. **代码根只读**：AppImage 挂载只读、mac Translocation、NSIS 可装进 Program Files——三平台都存在「产品目录写不进」的现实，而梨园的数据（cards/、库、配置、全部 `.liyuan-*` 运行目录）与产品代码交织在同一 cwd 下，`server/main.ts` 全按 `process.cwd()` 取数据。
2. **ELECTRON_RUN_AS_NODE 语义**：Electron 主进程里 `process.execPath` 是 Liyuan.exe 不是 node，直接 spawn 会弹出第二个应用窗口。现网两个位点：`src/mcp.ts:312`（vision MCP）、`src/card-authoring.ts:266`（语法检查子进程）。
3. **接线层扩展的相对引用**：`roleplay.ts` 以 `../../src/*` 引产品源码，扩展文件必须与 `src/` 同根；而 pi 的自动发现按 `cwd/.liyuan/extensions` 扫——cwd 换到数据根后两者分家。
4. **升级**：数据根里不得有产品代码副本，否则升级漂移。

**问 2 负责人**：打包交给 electron-builder（成熟工具链，不自造）；staging 排除纪律交给 `scripts/stage-desktop.mjs`（清单照抄 `pack-release.ps1`，源码包链路一行不动）；双根解析的唯一新逻辑在 `desktop/main.mjs`；server 侧改动全部走既有通道——`LIYUAN_PRODUCT_ROOT` env（三处消费）、`resourceLoaderOptions.additionalExtensionPaths`（pi 现成字段，main.ts 已在用同族 override）、`UpdateWire` 部署标志（dockerDeploy 同款）。无新增注入点，无提示词改动。

**问 3 没见过的机器**：首启无 Node（Electron 自带 ✓）、无配置（从 example 播种 ✓）、无数据（assets/cards/skills 播种 ✓）；中文用户名路径（数据根在「文档」下，Node fs 处理 Unicode，cpSync 崩溃已有 copyPathSafe 兜底）；pi 项目信任对全新数据根的行为与源码包全新解压完全一致（同一机制，无新差异面）。

## 四、形态

### 双根布局

```
产品根（只读，随包）                      数据根（可写，用户可见，默认 文档/Liyuan）
  server/  src/  packages/(src+dist)       cards/  liyuan.config.json  liyuan.agent.json
  web/dist  assets/(种子源)                assets/(SYSTEM.md、cards/、skills/…的活副本)
  .liyuan/extensions/  node_modules        skills/  assets/lorebooks/  assets/presets/
  desktop-main.mjs  package.json           .liyuan-* 运行时目录全部
```

- **cwd ＝ 数据根**。server 的一切数据路径（`join(cwd, …)`）原样成立；产品根经 `LIYUAN_PRODUCT_ROOT` env 告知，只在三处消费（下表）。
- 数据根首启＝带说明的一步（2026-09-12 用户反馈「装完裸弹选择框一脸懵」后改形）：**窗口启动页先出现**，再弹「欢迎使用梨园」说明框（写明默认位置 `文档/Liyuan`、可整体拷贝迁移、以后可在文件菜单更改），**[就用默认位置] 一键开始**，换位置才进文件夹选择。指针存 Electron userData（`desktop.json`）；数据根目录消失时弹窗让用户重选，不静默重建。菜单「更改数据目录…」＝重指＋按新根重启服务（原数据不自动搬移，透明目录整体拷贝即迁移）。数据根完整透明可见（与「卡空间物理独立迁移」卖点同构）。
  - 曾考虑把选择装进 NSIS 安装向导：只覆盖 exe 用户、便携 zip 无安装环节仍会撞裸弹框，一套首启流程两种产物通吃，不做（用户同判）。
- **升级＝装新版**。产品代码全在产品根随包换新；数据根里没有产品代码（种子只在缺失时播，播过即用户持有——与 SYSTEM.md / skills 现行规则逐字一致）。

### server 子进程

- Electron 主进程 `spawn(execPath, [server/main.ts], { env: { ELECTRON_RUN_AS_NODE: "1", PORT, LIYUAN_PRODUCT_ROOT, LIYUAN_DESKTOP: "1" } })`——VS Code 同款手法，Electron 二进制当纯 Node 用。
- 前置校验：Electron 自带 Node ≥22.18 则 TS 直跑可用；实施时装包验证。备胎：经 `node_modules/jiti` CLI 包装启动（stage 脚本断言 jiti 在场）。
- stdout/stderr → `数据根/.liyuan-cache/desktop.log`（桌面版排障的命门，用户一键可取）；进程早退 → 原生错误框＋日志路径。
- 端口：默认 7620，被占则取空闲端口（**不杀占用进程**——start.bat 的 taskkill 不带进桌面版）；HOST 维持 0.0.0.0 默认（与源码包行为一致：手机可连是卖点，README 已警示勿裸暴露公网）。
- 单实例锁：二次启动聚焦已有窗口。
- `asar: false`（ELECTRON_RUN_AS_NODE 下 Electron 的 asar fs 补丁不生效，子进程读不到 asar 内文件；不冒这个险，体积代价认下）。

### 扩展装载（关键刀）

数据根的 `.liyuan/extensions` 留空，产品扩展走 pi 现成的显式路径通道：

```ts
// server/main.ts createRuntime（已有 resourceLoaderOptions 旁边加一行）
...(process.env.LIYUAN_PRODUCT_ROOT ? { additionalExtensionPaths: [join(productRoot, ".liyuan", "extensions")] } : {})
```

`roleplay.ts` 在产品根原位装载，`../../src/*` 相对引用天然成立，其自身 import 链与 node_modules 解析全部落在产品根。不复制、不改动、不生成转发桩。

### 播种规则（desktop-main.mjs，每次启动跑，幂等）

| 项 | 策略 | 依据 |
|---|---|---|
| `assets/skills/`、`assets/SYSTEM.md`、`assets/APPEND_SYSTEM.md` | **每次覆盖同步**（产品持有，harness 全权） | 只是种子源；活件在 `~/.liyuan/agent` 与 `skills/`，归用户 |
| `assets/cards/default_Qingwu.json`、两份 config、`cards/`、`assets/lorebooks/`、`assets/presets/` | 只在缺失时种 | 用户可删默认卡；库与配置播过即用户持有 |
| `skills/`（运行时技能根） | 不动——server 的 `seedBuiltinSkills` 照旧 only-if-missing | 单一主人 |

### server 侧改动（全部既有通道，无提示词）

| 位点 | 改动 |
|---|---|
| `server/main.ts` | `productRoot` 常量；`web/dist` 与 `package.json`（APP_VERSION）回落产品根；`additionalExtensionPaths`（上节）；`IS_DESKTOP` env → `UpdateWire.desktopDeploy`，`updateDownload`/`updateRestart` 在桌面态拒绝 |
| `src/mcp.ts` | vision MCP：`process.versions.electron` 时给 entry env 加 `ELECTRON_RUN_AS_NODE=1` |
| `src/card-authoring.ts` | 语法检查 spawnSync 同款处理 |
| `server/wire.ts` + `web/src/components/UpdateFlow.tsx` | `desktopDeploy` 标志：提示「桌面版请到 GitHub Releases 下载新版」，禁应用内更新（zip 自更新在桌面版没有启动脚本接盘，必成幽灵操作） |

### 打包链

```
scripts/stage-desktop.mjs（Node，三平台同构）
  ├─ 排除清单照抄 pack-release.ps1（cards/、私人配置、dev 脚手架、docs/PLAN-*、测试…）
  ├─ stage：server/ src/ packages/ web/dist/ assets/ .liyuan/extensions/ package.json+lock
  ├─ stage 内 npm ci --omit=dev（自包含 node_modules；断言 jiti 在场）
  ├─ 产物检查：roleplay.ts / vision-server.mjs / 双 catalog 在场；cards/、私人文件、dev scratch 不在场
  └─ 写 desktop/app/package.json（name/version/main ← 根 package.json）

desktop/（独立 npm 包，electron/electron-builder 为 devDeps，root 的 package.json 不动——
        源码包用户 npm install 不得拉 Electron）
  ├─ main.mjs（双场景：dev＝repo 根双根合一；packaged＝产品根+数据根）
  ├─ electron-builder.yml：asar:false；win zip+nsis；mac dmg×2 arch；linux AppImage
  └─ buildResources/（图标 ← assets/brand/logo.png 派生）
```

- 两份排除清单（pack-release.ps1 与 stage-desktop.mjs）有意成对：合并需动久经实弹的发布链，风险大于收益；泄漏侧由产物检查兜底，缺件侧由启动失败兜底。两文件头部交叉引用，改一处必须看另一处。
- CI：`.github/workflows/desktop.yml`，matrix（windows→win 双产物；macos→双 arch dmg；ubuntu→AppImage），workflow_dispatch 触发，产物传 artifacts；随发布手工挂 release（沿用现有发版流程）。ubuntu 顺带 AppImage `--appimage-extract-and-run` 冒烟探活。
- 中国网络：Electron 二进制下载走 npmmirror 镜像（`ELECTRON_MIRROR`，脚本与文档注明）。

## 五、已知代价（认下，不当 bug 查）

1. **不签名**：无证书。Win exe 触 SmartScreen 警示、mac dmg 带隔离位（发布说明写清除法，源码包已有同款文档）。签名是后续独立事项（花钱＋主体认证，与代码无关）。
2. **体积**：安装包 ~100MB、装完 ~300MB——Electron 本身即代价，选型时已答用户。
3. 便携 zip 与源码包同属「解压即用」，但数据默认落「文档/Liyuan」而非程序目录——数据迁移习惯与源码包不同，README 桌面段（发版时补）写明。
4. mac 只能 CI 产包＋真机人工验（本机无 Apple 硬件）；AppImage 冒烟进 CI，真机体感待用户。
5. 桌面版首启多一个「选数据目录」对话框——一次性成本，换数据主权可见。

## 六、不做什么

- 不做托盘、后台常驻、开机自启。
- 不做安装包级自动更新（electron-updater）——v1 手动下载；后续要加再立项。
- 不做 deb/snap/rpm（AppImage 全覆盖；格式需求出现再加）。
- 不做数据根迁移工具（数据根是透明目录，用户手工拷贝即迁移，与卖点一致）。
- 不动 `pack-release.ps1` 与源码包链路。
- 不给模型任何提示词（桌面化对 agent 完全不可见）。

## 七、改动清单

| 文件 | 改动 |
|---|---|
| `desktop/main.mjs` | 新：单实例锁、数据根选择/持久化/失效重选、播种、扩展覆盖同步、子进程托管＋日志、健康探测→开窗、中文菜单、外链转系统浏览器 |
| `desktop/package.json` ＋ `electron-builder.yml` ＋ `buildResources/` | 新：独立包与打包配置 |
| `scripts/stage-desktop.mjs` | 新：staging＋npm ci＋断言＋产物检查 |
| `.github/workflows/desktop.yml` | 新：三平台 matrix 构建＋Linux 冒烟 |
| `server/main.ts` | productRoot 回落（distDir、APP_VERSION）、additionalExtensionPaths、IS_DESKTOP 更新分支 |
| `src/mcp.ts` / `src/card-authoring.ts` | ELECTRON_RUN_AS_NODE 修补 |
| `server/wire.ts` / `web/src/components/UpdateFlow.tsx` | desktopDeploy 标志与文案 |
| `package.json`（root） | 仅加 desktop scripts 转发，deps 不动 |
| `.gitignore` | `desktop/app/`、`desktop/dist/`、`desktop/node_modules/` |

## 八、验收（交付判据＝动作链完整）

1. **dev**：`npm run desktop:dev` 在 repo 根起 Electron 窗口，行为与 `node server/main.ts`＋浏览器一致。
2. **本地 win 构建**：stage → electron-builder 出 zip＋exe 两件。
3. **便携版实弹**：解压到干净目录 → 双击 → 选数据目录 → 窗口打开 → `/healthz` 200 → 青梧在卡库 → WS hello 正常 → 扩展已装载（RP 面板有数据）→ 数据全落数据根、**产品目录零写入**（前后文件清单比对）。
4. **安装版实弹**：本机装一次，同上抽查。
5. CI：三平台产物出齐；ubuntu 冒烟过。
6. 全量测试照旧跑（server 改动极小，4 项既有实卡红照旧）。

## 九、状态

- 2026-09-12：立项，本文定稿，选型已答用户（Electron）。实施开始。
- 2026-09-12（实施）：
  - server 侧五刀完成（productRoot 三处消费、additionalExtensionPaths、IS_DESKTOP、vision/语法检查的 ELECTRON_RUN_AS_NODE、UpdateFlow 桌面分支）；前端 typecheck＋构建过。
  - desktop/（main.mjs、package.json、electron-builder.yml、icon 1024×1024）、scripts/stage-desktop.mjs、.github/workflows/desktop.yml 落地。
  - **Electron 44.3.0 自带 Node 24.20.0，`ELECTRON_RUN_AS_NODE` 下 TS 直跑实测通过——jiti 备胎不需要。**
  - **实施期发现①**：pi 的 `additionalExtensionPaths` 只认单个扩展文件；传目录会被当「包根」（找其下 `extensions/` 子目录）而装载失败。main.ts 改为照 stage 同一规则枚举 `.liyuan/extensions/*.ts` 传文件列表。
  - **实施期发现②**：electron-builder 需 `directories.app: app` 显式指定应用目录，stage 在 `npm ci` 之后给 app/package.json 补 `main`/`author`（npm ci 之后改，之前改会与 lock 冲突）。
  - dev 双根分离实弹（env 指定数据根）全链通过：扩展装载（RP_DEBUG session_start 日志＋`/rp` 命令回应）、青梧开场白注入、数据根播种形状与设计逐字一致、单实例锁实测生效。
  - 中国网络构建需双镜像：`ELECTRON_MIRROR`＋`ELECTRON_BUILDER_BINARIES_MIRROR`（npmmirror），否则 NSIS/winCodeSign 下载超时。
- 2026-09-12（验收）：**win 双产物实弹通过**。
  - 产物：`Liyuan-1.5.4-win-desktop-portable.zip` 185MB、`Liyuan-1.5.4-win-desktop-setup.exe` 139MB（未签名，SmartScreen 会警示——已知代价§五.1）。
  - 便携包冒烟（干净数据根）：healthz 200 → hello 带青梧开场白与 state → 数据根播种齐（配置/SYSTEM.md/技能/desktop.log 含启动记录）→ **全树零写入**（`find -newer` 基准比对，产品目录无任何运行时痕迹）。
  - 安装包：静默 `/S` 装机（注意 git-bash 会把 `/S` 当路径吞掉，须 `MSYS_NO_PATHCONV=1`）→ 文件完整 → 装机形态起服 healthz 200＋开场白 ✓。安装去向与 per-user/per-machine 取决于运行上下文与 UAC（交互安装默认 per-user）。
  - 全量测试：仅 4 项既有实卡红（cardfront-pipeline / html-interface / mvu×2），与改动无关；前端 typecheck＋构建过。
  - CI（desktop.yml）已写未跑：三平台 matrix＋ubuntu AppImage 冒烟，首跑待发布窗口。mac/linux 产物待 CI 出包后用户真机验证。
- 2026-09-12（用户实启反馈收刀）：首启改形——窗口先开（上下文在场）＋「欢迎使用梨园」说明框（默认位置一键开始）＋菜单补「更改数据目录…」（重指＋按新根重启）。安装器内嵌选择经用户同判不做（便携 zip 无安装环节，覆盖不全）。win 双产物重出。
