# AGENTS.md — 梨园项目助手须知

本文件是任何 AI 助手（Claude Code / opencode / 其他）进入本仓库的**第一读**。

## 铁律

1. **禁止直接动手改代码**，除非用户明确说「开始/动手」。
   用户会说「先同步情况」「你来告诉我」「只读」——那期间只能读、不能改。
2. **读思考记录必须先读** `docs/READING-THINKING.md`——按文件 mtime 找最新会话
   会读错位置（旧会话被 model_change 碰过 mtime 会排到前面）。必须用行级
   timestamp 核对北京时间。
3. **流程与提示词的最终形态**定义在 `docs/PLAN-ROUND-FLOW.md`——任何提示词/
   引擎改动都要回答「离这个流程近了多少」。
4. **当前阶段见 `docs/PLAN-RP-AGENT-NEXT.md`（2026-09-09 用户定案）**：回到 agent 架构、
   写卡资源编辑第一切片与主会话写卡模式已落地，接下来**根据实际体验与用户反馈调整**。
   从具体问题复现、定位归属、针对性修改并复验；剩余能力按真实需求排序，不自动扩建。
   两模式共用底层记录，写卡开放操作内容，回到扮演后封闭维护过程；预设低优先级后置，小说模式继续延期。
   `docs/PLAN-RP-AGENT-EXEC.md` 与 `docs/PRESET-SPLIT-TAXONOMY.md` 保留为历史计划与研究资料。

## 快速索引

- `docs/PLAN-RP-AGENT-NEXT.md` — 当前路线、已提交基线与下一窗口交接（优先读）
- `docs/CARD-AUTHORING-SLICE1.md` — 写卡第一切片的实际能力、验证与下一步边界
- `docs/CARD-AUTHORING-MODE.md` — 主会话写卡模式、共享记录的可见性与隔离续演验证
- `docs/PLAN-ROUND-FLOW.md` — 分轮演出流程（最终形态 + 落地记录）
- `docs/READING-THINKING.md` — 读思考记录的**正确方法**（先读这个再碰会话文件）
- `docs/DRAFT-prompt-rp-agent.md` — 「怎么演这一拍」演出指导草稿（B 版）
- `src/stage/` — 台上引擎（assemble 提示词 / engine 回合循环 / workspace 稿纸 /
  tools 工具 schema）
- 测试：`node --test test/*.test.ts`（2026-09-09 最近验证：773 项，771 通过，2 项既有失败，详见主会话写卡模式记录）
