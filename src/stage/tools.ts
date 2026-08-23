/**
 * 台上检索工具（PLAN-RP-HARNESS M3，R2 工作区 = 稿纸 + 世界）。
 *
 * 对标 Claude Code 的 Read/Grep：动笔前查资料，不靠脑补。
 * 世界书族（lorebook_*）与向量库族（memory_*）已迁入统一工具层
 * （`src/tools/`，PLAN-RP-TOOLING M-D1~M-D3）；本模块只剩 world_state_get
 * 与 skill_read，外加统一层的装配与派发入口。
 *
 * 封顶 MAX_LOOKUPS 次/拍：模型输出正文即视为动笔，工具循环自然结束。
 *
 * 工具 schema 与执行分离：schema 是纯数据（引擎装配进 Context.tools），
 * 执行依赖注入（检索函数），因此本模块可离线单测。
 */

import { runUnifiedStageTool, unifiedStageTools } from "../tools/adapters/stage.ts";
import type { LoreDeps, LoreHitLike } from "../tools/lore.ts";
import type { MemoryDeps, MemoryHitLike } from "../tools/memory.ts";
import type { CardDeps } from "../tools/card.ts";
import type { WorldlineDeps } from "../tools/worldline.ts";
import type { PanelDeps } from "../tools/panels.ts";
import type { WorldState } from "../types.ts";

/** 一拍内最多允许的检索次数（超出后撤掉工具，强制动笔） */
export const MAX_LOOKUPS = 3;

/** agent 循环安全阀（PLAN-RP-AGENT-EXEC §2.3）：开放式循环的轮数上限，触阀以现稿定稿 */
// 8/09 提额：ask 接回 + 续写出口后，正常一拍可达 12+ 轮（规划/3段/3勾/修/ask/重拟/续写…）——
// 12 轮在实弹中被正常演出耗尽（安全阀吞掉了第三段与状态栏）。20 = 正常上限 × 安全余量。
export const MAX_ROUNDS = 20;

/** @liyuan/ai Tool 的结构子集（parameters 用裸 JSON Schema，避免 src/ 依赖 typebox） */
export interface StageTool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

/** 命中形（M-D1/M-D3 起由统一工具层定义，此处再导出保持既有引用不变） */
export type { LoreHitLike, MemoryHitLike };

/**
 * 台上工具执行依赖。五族（世界书 / 向量库 / 角色库 / 世界线 / 面板）由统一工具层
 * 定义，此处继承——一处增减、全链路同步。台上的可用工具按注入函数的存在性过滤。
 */
export interface StageToolDeps extends LoreDeps, MemoryDeps, CardDeps, WorldlineDeps, PanelDeps {
	/** 世界状态账本（getState 必在；formatState 用于展示） */
	getState: () => WorldState;
	formatState: (s: WorldState) => string;
	/** skill 内容解析（名称制）：skills/ 文件优先，拆层 D/E 进口包兜底；未注入＝无 skill_read 工具 */
	getSkill?: (name: string) => string | undefined;
}

const STR = { type: "string" } as const;

/**
 * 工具清单（纯数据）。language 用于把「用哪种语言查」写进描述。
 * deps 给出时按注入情况过滤统一层工具（依赖缺失的不上清单，见 adapters/stage.ts）。
 */
export function stageTools(language: string, deps?: StageToolDeps): StageTool[] {
	return [
		// 世界书族（M-D1/M-D2）与向量库族（M-D3）已迁入统一工具层：一份实现多面共用
		...unifiedStageTools(language, deps),
		{
			name: "world_state_get",
			description: "读取当前世界状态账本（时间/地点/人物好感与状态/物品归属/标记/剧情线）。拿不准既定事实时调用。",
			parameters: { type: "object", properties: {}, required: [] },
		},
	];
}

/**
 * skill 读取工具：按名读取 skill 全文。**标准 agent skill 形态**（8/23 用户定案：
 * 「回归最本初的模样，对梨园与 Claude Code 一般无二」）——列表给 `名字：描述`，模型看描述
 * 自己决定读不读，读了才把全文加载进当拍。
 *
 * ⚠ 描述**必须带上**：此前只给名字（`可读：ask判断`），模型无从判断何时该读，实测 8/19
 * 之后零调用。description 是它唯一的判断依据（frontmatter 里必填，扫描时早就解析了，
 * 只是没传过来）。
 *
 * 关键性质：工具结果**不落历史**（rebuildHistory 只留定稿正文）——内容只活在当拍，
 * 谢幕即蒸发＝按需加载、用完即走。skills 为空时不要注册本工具（不凭空点名）。
 */
export function skillReadTool(language: string, skills: Array<{ name: string; description: string }>): StageTool {
	return {
		name: "skill_read",
		description:
			`按名读取一个 skill 的全文（${language}）。可读：\n` +
			skills.map((s) => `- ${s.name}：${s.description}`).join("\n"),
		parameters: {
			type: "object",
			properties: {
				name: { type: "string", enum: skills.map((s) => s.name), description: "要读取的 skill 名" },
			},
			required: ["name"],
		},
	};
}

/**
 * 写侧只剩 `ask`（第三步：draft 族与 world_state_update 先后撤出模型视野）。
 * 记账归封笔后的场记旁路（scribe-run.ts），台上零世界写入工具。
 */
export function writeTools(language: string): StageTool[] {
	return [
		{
			name: "ask",
			description:
				"剧情共创决策（P7 接回）：把该由用户拍板的选择交给用户。两种触发：\n" +
				"① **主动触发**（随时，含第 1 轮）：用户输入本身在求方向/递笔（「接下来去找谁」「怎么办」" +
				"「给个选项」「让我选」）——这不需要上文支撑，直接问。\n" +
				"② **开局收集**（开场第一拍）：用户这句输入引出的未定变量——取不同值这拍走向会" +
				"明显分岔（如：买下用户的人性格温和还是残暴，决定整拍怎么演）、且卡与世界书查不到——" +
				"先问用户定下来再演。一次一问，多个变量只问最关键的。" +
				"判断是**动态的**：变量不因「新」而重要——新人物的性格/身份不是全都要问，洞府里不是每件资源" +
				"都值得问；不分岔的自己顺着演，不事事上报。禁止代写用户身份的完整档案、禁止替用户定重大变量。\n" +
				`给出 2~4 个具体、可落地、彼此不同的选项（${language}），用户作答后按答案继续演。\n` +
				"用户点了停止 = 笔还给用户，本拍就此收束。\n" +
				"**选择框分流**：用户预设自带选择框格式（如 <w2g>）时，岔路与回合末选项**按预设格式写进正文**，" +
				"不要调本工具；只有预设没有选择框格式时才用 ask。",
			parameters: {
				type: "object",
				properties: {
					question: { ...STR, description: "要交给用户定夺的问题（一句话说清当前局面）" },
					options: {
						type: "array",
						description: "2~4 个具体选项（可落地、彼此不同）",
						items: { ...STR, description: "一个选项" },
					},
				},
				required: ["question", "options"],
			},
		},
	];
}

export interface ToolRunResult {
	/** 回给模型的 toolResult 文本 */
	text: string;
	/** 过程条短句（无则不出条） */
	activity?: string;
}

/**
 * 执行一次工具调用。未知工具名/参数缺失都返回可读文本（不抛，不打断本拍）。
 * language 供统一工具层装配上下文（M-D1）；省略时按中文。
 */
export async function runStageTool(
	deps: StageToolDeps,
	name: string,
	args: Record<string, unknown>,
	language = "中文",
): Promise<ToolRunResult> {
	// 统一工具层优先（PLAN-RP-TOOLING M-D1/M-D3）：世界书族与向量库族由那一份实现作答
	const unified = await runUnifiedStageTool(deps, name, args, language);
	if (unified) return { text: unified.text, ...(unified.activity ? { activity: unified.activity } : {}) };

	if (name === "skill_read") {
		const skillName = typeof args.name === "string" ? args.name.trim() : "";
		const text = skillName ? deps.getSkill?.(skillName) : undefined;
		if (!text) {
			return { text: `没有名为「${skillName}」的 skill。按已有理解直接动笔即可。` };
		}
		return {
			text: `【skill·${skillName}】\n\n${text}`,
			activity: `读 skill「${skillName}」`,
		};
	}

	if (name === "world_state_get") {
		const s = deps.getState();
		return { text: `${deps.formatState(s)}\n\nRAW:\n${JSON.stringify(s)}`, activity: "查账本" };
	}

	return { text: `未知工具 ${name}——本拍可用：lorebook_search / memory_search / world_state_get。` };
}
