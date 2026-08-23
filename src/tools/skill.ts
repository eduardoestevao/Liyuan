/**
 * 台上 skill 库族工具（PLAN-RP-TOOLING M-D7）。
 *
 * 管的是 `skills/<目录>/SKILL.md`——**引擎每拍现读的那一份**（写作/skill指导/ask判断
 * 那套方法论骨架就住在这里）。编辑器产物即引擎消费物，保存后下一拍装载即生效。
 *
 * ## 与 `.liyuan-skills` 的区别（别混）
 *
 * `.liyuan-skills/*.md` 是**助手自己**摸通外部服务后写的调用笔记（`skill_save` 那一套），
 * 与扮演无关、也不进台上的 skill 货架。两套同名不同物，故本族一律带 `stage_` 前缀，
 * 与 REST 的 `/api/stage-skills` 同一口径。
 *
 * ## 为什么整族只在助手面
 *
 * 台上留 `skill_read`（读方法论）就够：
 * - **写了也不当拍生效**——常驻档正文随 system 走，system 在本拍开头就装配完了；
 * - 「演到一半决定去沉淀一条方法论」正是最典型的分心。用户已有定案：
 *   给模型省时间的选项，它会为「要不要用」耗思考。
 *
 * 「台上自己沉淀方法论」不是工具问题，是**封笔后旁路**问题（与场记/压缩同族）——
 * 记着，别在每拍工具清单上解。
 */

import { errText, strArg, type ToolResult, type ToolSpec } from "./registry.ts";

/** skill 条目的结构子集（不依赖 materials.ts 全形，便于离线单测） */
export interface StageSkillLike {
	/** 存储目录名（编辑/删除按它定位） */
	dir: string;
	name: string;
	description: string;
	body: string;
}

export interface StageSkillDeps {
	/** 全部台上 skill（含正文；列举时按需截断） */
	listStageSkills?: () => StageSkillLike[];
	/**
	 * 新建或覆盖。给 dir = 编辑那一个；不给 = 新建（目录取名称，撞名会抛）。
	 * 返回实际存储目录名。
	 */
	saveStageSkill?: (input: {
		dir?: string;
		name: string;
		description: string;
		body: string;
	}) => { dir: string };
	/** 删除整个 skill 目录（含附件）；目录不存在时抛 */
	deleteStageSkill?: (dir: string) => void;
}

/**
 * 调用情境：用户问「现在有哪些 skill / 那条写作规矩写在哪」，
 * 或改一条之前先取存储目录名。
 */
export const stageSkillList: ToolSpec<StageSkillDeps> = {
	name: "stage_skill_list",
	domain: "skill",
	mode: "read",
	surfaces: ["assistant"],
	label: "列出台上 skill",
	description: () =>
		"列出剧情模型的 skill 库（方法论骨架，skills/<目录>/SKILL.md）：名称/说明/字数。" +
		"剧情模型按 description 自己决定读不读（标准按需档）。" +
		"给 name 则返回那一条的全文。",
	parameters: () => ({
		type: "object",
		properties: {
			name: { type: "string", description: "只看这一条的全文（名称或存储目录名）" },
		},
		required: [],
	}),
	async run(args, deps): Promise<ToolResult> {
		if (!deps.listStageSkills) return { text: "本环境不支持查看台上 skill。" };

		let all: StageSkillLike[];
		try {
			all = deps.listStageSkills();
		} catch (err) {
			return { text: `读取 skill 库失败：${errText(err)}` };
		}
		if (all.length === 0) return { text: "台上 skill 库是空的。", activity: "列 skill · 0 条" };

		const want = strArg(args, "name");
		if (want) {
			const hit = all.find((s) => s.name === want || s.dir === want)
				?? all.find((s) => s.name.includes(want) || s.dir.includes(want));
			if (!hit) return { text: `没有名为「${want}」的 skill（用不带参数的 stage_skill_list 看全部）。` };
			return {
				text: `「${hit.name}」（目录 ${hit.dir}）\n说明：${hit.description}\n\n${hit.body}`,
				activity: `读 skill「${hit.name}」`,
			};
		}

		const lines = all.map((s) => `- ${s.name}｜${s.body.length} 字｜目录 ${s.dir}\n  ${s.description}`);
		return {
			text: `台上 skill ${all.length} 条：\n${lines.join("\n")}`,
			activity: `列 skill · ${all.length} 条`,
		};
	},
};

/**
 * 调用情境：用户说「把这个写法记成一条 skill」「那条 skill 改一下」。
 *
 * 建与改合成一件：给 dir 就是改，不给就是建（撞名会被拒，改判去编辑流）。
 */
export const stageSkillWrite: ToolSpec<StageSkillDeps> = {
	name: "stage_skill_write",
	domain: "skill",
	mode: "write",
	surfaces: ["assistant"],
	label: "写入台上 skill",
	description: () =>
		"新建或修改剧情模型的 skill（方法论骨架）。给 dir = 改那一条，不给 = 新建（撞名会被拒）。" +
		"description 是模型判断「何时该读这条」的唯一依据，写清触发场合。下一拍生效。",
	parameters: () => ({
		type: "object",
		properties: {
			dir: { type: "string", description: "要改的 skill 存储目录名（从 stage_skill_list 取）；不给 = 新建" },
			name: { type: "string", description: "skill 名称" },
			description: { type: "string", description: "一句话说清「什么时候该读这条」" },
			body: { type: "string", description: "正文（方法论本身，Markdown）" },
		},
		required: ["name", "description", "body"],
	}),
	async run(args, deps): Promise<ToolResult> {
		if (!deps.saveStageSkill) return { text: "本环境不支持写入台上 skill。" };

		const name = strArg(args, "name");
		const description = strArg(args, "description");
		const body = strArg(args, "body");
		if (!name) return { text: "缺少 name 参数（skill 名称）。" };
		if (!description) return { text: "缺少 description 参数（模型靠它决定何时读这条）。" };
		if (!body) return { text: "缺少 body 参数（正文）。" };

		const dir = strArg(args, "dir");

		let r: { dir: string };
		try {
			r = deps.saveStageSkill({
				...(dir ? { dir } : {}),
				name,
				description,
				body,
			});
		} catch (err) {
			return { text: `写入 skill 失败：${errText(err)}` };
		}
		return {
			text: `已${dir ? "修改" : "新建"} skill「${name}」（目录 ${r.dir}）。剧情模型下一拍装载即生效。`,
			activity: `${dir ? "改" : "建"} skill「${name}」`,
			details: { dir: r.dir },
		};
	},
};

/**
 * 调用情境：用户说「把那条 skill 删了」。
 *
 * 删的是**整个目录**（含 references/ 等附件），不可撤销。
 */
export const stageSkillDelete: ToolSpec<StageSkillDeps> = {
	name: "stage_skill_delete",
	domain: "skill",
	mode: "write",
	surfaces: ["assistant"],
	label: "删除台上 skill",
	description: () =>
		"删掉一条剧情模型的 skill（目录名从 stage_skill_list 取）。连同该目录下的附件一起删，不可撤销——" +
		"**仅在用户明确要求删除时调用**。",
	parameters: () => ({
		type: "object",
		properties: {
			dir: { type: "string", description: "skill 存储目录名（从 stage_skill_list 取）" },
		},
		required: ["dir"],
	}),
	async run(args, deps): Promise<ToolResult> {
		if (!deps.deleteStageSkill) return { text: "本环境不支持删除台上 skill。" };

		const dir = strArg(args, "dir");
		if (!dir) return { text: "缺少 dir 参数（目录名从 stage_skill_list 取）。" };

		try {
			deps.deleteStageSkill(dir);
		} catch (err) {
			return { text: `删除 skill 失败：${errText(err)}` };
		}
		return { text: `已删除 skill「${dir}」及其目录下的附件。剧情模型下一拍起不再看到它。`, activity: `删 skill「${dir}」` };
	},
};

/** 台上 skill 库族全部工具（M-D7：列 / 建改 / 删） */
export const stageSkillTools: ToolSpec<StageSkillDeps>[] = [stageSkillList, stageSkillWrite, stageSkillDelete];
