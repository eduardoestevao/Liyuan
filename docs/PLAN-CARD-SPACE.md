# 卡＝工作空间：布局定案（B · 两层）

> 2026-09-06 用户定案。执行主档是 `C:\Users\jsw_0\.claude\plans\rp-agent-claude-code-pi-skill-pi-claude-bubbly-spindle.md`（§3.1 起按此更新）。
> 本文只写**形状**与**已完成进度**，不动手实现——实现分刀走 git 提交。

## 一 用户定的形状（原话大意，不得改写）

- **方案 B**：卡库是新顶层 `cards/`；`assets/cards/` 退成导入暂存。
- **卡下面分两层**：最外层是卡；**每一个独立的对话是一个子项目**；**一个子项目里能包含很多会话**。
- 两种会话记录：「**能在第二个会话窗口继续聊**」＝同一个子项目里的另一个会话；「**完全新开对话**」＝新建一个子项目。
- 前端最终要按这个结构展示（卡 → 对话 → 会话），后端布局先立，前端最后跟上。

## 二 磁盘形状

```
cards/                       ← 卡库（新顶层，整棵用户私有数据）
  <卡文件夹>/
    <卡本体>.png|json
    卡.json                  ← 卡级配置（9 字段，见下）
    补充设定集.json           ← 旧 .liyuan-lore/<卡名>.json
    技能/  记忆/             ← 第二步（跨会话记忆）用
    对话/<对话id>/            ← 子项目＝一个独立的对话
      对话.json               ← 名字/建于何时
      会话/*.jsonl            ← pi 的 sessionDir
      世界状态.json  世界线.json  面板.json  向量记忆/  助手会话/
```

- 世界书库与预设库**仍全局共享**（`assets/lorebooks`、`assets/presets`）；卡级只存指针。
- 旧数据的其它归属：`.liyuan-state/worldline/artifacts` 按 sessionId、`.liyuan-memory` 按
  `<卡hash>__<sessionId>`、`.liyuan-assistant` 全局＋sameCardPath 过滤——迁移时**按卡归位、
  按会话跟子项目走**（迁移器已落，见进度）。

## 三 与 pi 的对接（全是现成机制，零新造）

| 用户要的 | pi 的机制 | 出处 |
|---|---|---|
| 同一子项目里再开一个会话 | `runtime.newSession()` 复用当前 `sessionDir` | `agent-session-runtime.ts:235` |
| 切到别的子项目 | `switchSession(会话文件)`：`SessionManager.open` 按文件父目录推导 sessionDir | `session-manager.ts:1429` |
| 新开子项目 | `SessionManager.create(cwd, <子项目>/会话/)` | `session-manager.ts:1410` |

**「当前是哪个子项目」不另存状态**：会话就住在子项目里，`sessionManager.getSessionDir()` 反推即得
（`src/cardspace.ts` `chatDirOfSessionDir`）。

## 四 卡级配置（`卡.json`，9 字段）

`lorebooks / userName / userPersona / displayName / greeting / greetingIndex / disabledLore / cardSkinOff / preset`。
`card` 留全局（「当前打开哪张卡」不是某张卡的属性）；其余 9 个全局字段照旧。

**合并语义（已定）：逐字段赢者独占，卡级盖全局。** 没写＝继承全局；写了＝对本卡切断继承。
理由：pi 那边只有 `AGENTS.md` 是真叠加、叠的是文本；`SYSTEM.md`/`APPEND_SYSTEM.md` 都是赢者独占。
配置是标量与清单，逐字段覆盖既可预测又天然给出「这张卡不继承那条全局偏好」。

## 五 迁移（一次性）

**「今天的一个会话＝一个子项目」**：今天「新建对话」建的就是一个新会话，账本/世界线/面板/向量记忆
也全按 sessionId 分家——那正是用户说的「完全新开的对话」。所以旧会话逐个变子项目最忠实，不猜谁跟谁一局。

- plan 与 apply 分开（plan 只读可先看）；全程 rename、幂等、不覆盖；
  **认不出卡的会话原地不动，绝不猜**（`src/migrate-cards.ts`）。
- 真实数据只读试排：22 张卡 / 149 个会话全认领 / 0 认不出 / id 零冲突 / 121ms。
- **何时真跑**：切 cwd（刀4）落地后、首启动时自动做；跑前做一次全量备份。

## 六 私有数据红线（cards/ 是新顶层用户数据）

| 处 | 口径 |
|---|---|
| `.gitignore` | `cards/` 整棵忽略 |
| `.dockerignore` | `cards` 排除 |
| `pack-release.ps1` `$xd` 与 zip 的 `skip_dirs` | 两处都加 `cards` |
| `apply-update.mjs` | `CODE_PATHS` 白名单式复制，本来就不碰；注释点名 |

四处一致性有自检脚本：`node _baseline0/chk-cards-excluded.mjs`。

## 七 进度（截至 2026-09-06 凌晨，全部已提交）

| 刀 | 内容 | 提交 |
|---|---|---|
| 刀1 | 目录访问收口 `DIRS`/`dir()`，代码里再无 `.liyuan-*` 字面量 | `bb2e4b7` |
| 刀2 | 布局词汇（paths.ts）+ `src/cardspace.ts`（发现/建立/元数据/卡级配置）+ 四处红线同步 | `cf6d972` |
| 刀3a | 迁移器 `src/migrate-cards.ts`（plan/apply 分离、幂等）+ 会话扫描收口 `src/session-scan.ts` | `d4ed0cb` |
| 刀3b | 子项目级数据落点接线：state/panels/worldline/memory 四族全走 `chatDataPath`，老布局自动回落 | `bf7fbc4` |

每刀验证口径：全量测试逐项对照（既有 2 个红是本地卡库形状问题，与本工作无关）+ 实起
`node server/main.ts` 探活 +（触到引擎的刀）无预设实弹一拍，拍后核对数据落点与还原现场。

## 八 剩余（刀4/刀5，未动）

- **刀4 换源头**：`server/main.ts:166` cwd 常量 → 当前卡目录；启动时跑迁移；`sessionInfos`/
  换卡/删卡改读 `cards/`；会话列表从 `SessionManager.list(cwd)` 改为按子项目列；`/api/card/switch`
  语义改为「换卡＝换卡文件夹」；新旧引用并存期（`assets/cards` 里还有文件时）的兼容读。
- **刀5 退名单**：三套卡归属口径（`sameCardPath` 7 处 / `rp-card` 自描述 / 卡hash＋卡名两套）
  收敛退役；`backup.ts` 按卡目录枚举；前端会话列表改两层展示。
- 铁律核查（每刀动手前）：全集＝所有卡与未迁移的老用户；负责人＝`cards/` 目录本身；
  没见过的卡＝进自己的文件夹，行为如常。
