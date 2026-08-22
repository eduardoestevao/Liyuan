/**
 * 用户身份（persona）族工具（PLAN-RP-TOOLING M-D7）。
 *
 * 合一前**三面皆零**——身份的增删改选全是面板 + REST（`/api/personas*`）。
 * agent 唯一能碰到的是 `config_write` 改 `userName`/`userPersona`，那改的是**投影**
 * （身份被选用时写进 config 的镜像），不是身份本身：改完下次切身份就被覆盖回去。
 * 这是 2026-08-22 工具化审计里「用户在面板全能做、agent 一个都不能」最完整的一族。
 *
 * ## 为什么整族只在助手面
 *
 * 不是权限限制，是**相关性**：身份的增删改选是开局与配置的事，一拍演出用不到——
 * 台上模型的 system 里本来就带着当前身份的名字与人设（注入侧给的），
 * 它不需要「先列一遍身份再挑一个」。真要中途换身份，是用户去右栏说一句的事。
 *
 * ## 投影这件事
 *
 * 身份被选用（或改到正在生效的那个）时，宿主要把它投影进 config 并热重载，
 * 否则改了等于没改。投影归宿主（`projectPersonaToConfig` + `softRefreshConfig` 都在
 * server/ 侧），工具只负责说清「改了什么、什么时候生效」。
 */

import { errText, strArg, type ToolResult, type ToolSpec } from "./registry.ts";

/** 身份的结构子集（不依赖 personas.ts 全形，便于离线单测） */
export interface PersonaLike {
	id: string;
	name: string;
	persona?: string;
}

export interface PersonaDeps {
	/** 全部身份 + 当前生效的那个 + 是否被锁到当前卡 */
	listPersonas?: () => { personas: PersonaLike[]; activeId: string | null; lockedForCard: string | null };
	/** 建新身份，返回新 id */
	createPersona?: (input: { name: string; persona?: string }) => { id: string };
	/** 改已有身份（只给的字段生效）；返回 false = id 不存在 */
	updatePersona?: (id: string, patch: { name?: string; persona?: string }) => boolean;
	/**
	 * 选用某身份。lockToCard=true 则锁到当前角色卡（此后开这张卡自动用它），
	 * 否则设为全局默认。返回 false = id 不存在。
	 */
	usePersona?: (id: string, lockToCard: boolean) => boolean;
	/** 删身份；返回 false = id 不存在或只剩最后一个（至少保留一个） */
	deletePersona?: (id: string) => boolean;
}

/**
 * 调用情境：用户问「我有哪些身份 / 现在用的是谁」，或增删改选之前先取 id。
 */
export const personaList: ToolSpec<PersonaDeps> = {
	name: "persona_list",
	domain: "persona",
	mode: "read",
	surfaces: ["assistant"],
	label: "列出用户身份",
	description: () =>
		"列出全部用户身份（{{user}} 是谁）并标出当前生效的那个。身份决定注入给模型的 userName 与人设。" +
		"增删改选之前先用它取 id。",
	parameters: () => ({ type: "object", properties: {}, required: [] }),
	async run(_args, deps): Promise<ToolResult> {
		if (!deps.listPersonas) return { text: "本环境不支持查看用户身份。" };

		let r: { personas: PersonaLike[]; activeId: string | null; lockedForCard: string | null };
		try {
			r = deps.listPersonas();
		} catch (err) {
			return { text: `读取身份失败：${errText(err)}` };
		}
		if (r.personas.length === 0) return { text: "还没有任何用户身份。", activity: "列身份 · 0 个" };

		const lines = r.personas.map((p) => {
			const cur = p.id === r.activeId ? "**当前**" : "";
			const lock = p.id === r.lockedForCard ? "锁定本卡" : "";
			const marks = [cur, lock].filter(Boolean).join("·");
			const body = p.persona?.trim() ? `｜${p.persona.trim().slice(0, 120)}` : "｜（无人设正文）";
			return `- [${p.id}] ${p.name}${marks ? `｜${marks}` : ""}${body}`;
		});
		return {
			text: `用户身份 ${r.personas.length} 个：\n${lines.join("\n")}`,
			activity: `列身份 · ${r.personas.length} 个`,
			details: { activeId: r.activeId },
		};
	},
};

/**
 * 调用情境：用户说「给我建个新身份」「把我的人设改成…」。
 *
 * 建与改合成一件：给 id 就是改，不给就是建。分成两件会让同一件事占两行清单，
 * 而模型分不清「该建还是该改」时本来就得先 `persona_list` 看一眼。
 */
export const personaWrite: ToolSpec<PersonaDeps> = {
	name: "persona_write",
	domain: "persona",
	mode: "write",
	surfaces: ["assistant"],
	label: "新建/修改用户身份",
	description: () =>
		"新建或修改用户身份（{{user}} 的名字与人设正文）。给 id = 改那一个，不给 id = 建新的。" +
		"改到的若正是当前生效的身份，会立即投影进配置并热载。",
	parameters: () => ({
		type: "object",
		properties: {
			id: { type: "string", description: "要改的身份 id（从 persona_list 取）；不给 = 新建" },
			name: { type: "string", description: "身份名（新建时必填）" },
			persona: { type: "string", description: "人设正文（第一人称或第三人称皆可，用剧情语言写）" },
		},
		required: [],
	}),
	async run(args, deps): Promise<ToolResult> {
		const id = strArg(args, "id");
		const name = strArg(args, "name");
		const persona = strArg(args, "persona");

		if (id) {
			if (!deps.updatePersona) return { text: "本环境不支持修改用户身份。" };
			if (!name && !persona) return { text: "没有要改的字段（name 或 persona 至少给一个）。" };
			let ok: boolean;
			try {
				ok = deps.updatePersona(id, { ...(name ? { name } : {}), ...(persona ? { persona } : {}) });
			} catch (err) {
				return { text: `修改身份失败：${errText(err)}` };
			}
			if (!ok) return { text: `没有 id 为 ${id} 的身份（用 persona_list 重取）。` };
			return {
				text: `已改身份 ${id}：${[name ? "名字" : "", persona ? "人设" : ""].filter(Boolean).join("与")}。若它正在生效，已即时热载。`,
				activity: "改身份",
			};
		}

		if (!deps.createPersona) return { text: "本环境不支持新建用户身份。" };
		if (!name) return { text: "缺少 name 参数（新建身份要有名字）。" };
		let r: { id: string };
		try {
			r = deps.createPersona({ name, ...(persona ? { persona } : {}) });
		} catch (err) {
			return { text: `新建身份失败：${errText(err)}` };
		}
		return {
			text: `已新建身份「${name}」（id ${r.id}）。它还没有被选用——要马上用它请调 persona_use。`,
			activity: `建身份「${name}」`,
			details: { id: r.id },
		};
	},
};

/**
 * 调用情境：用户说「换成那个身份」「这张卡以后都用这个身份」。
 *
 * `lock_to_card` 是 ST 式的「按卡记住身份」：锁上以后开这张卡自动用它，
 * 不影响别的卡；不锁就是改全局默认。
 */
export const personaUse: ToolSpec<PersonaDeps> = {
	name: "persona_use",
	domain: "persona",
	mode: "write",
	surfaces: ["assistant"],
	label: "切换用户身份",
	description: () =>
		"选用某个用户身份（id 从 persona_list 取），立即投影进配置并热载。" +
		"lock_to_card=true 则把它锁到当前角色卡（此后开这张卡自动用它），缺省是设为全局默认。" +
		"**换身份是用户级的决定**——只在用户明确要求时调用。",
	parameters: () => ({
		type: "object",
		properties: {
			id: { type: "string", description: "身份 id（从 persona_list 取）" },
			lock_to_card: { type: "boolean", description: "true = 锁到当前角色卡；缺省 = 设为全局默认" },
		},
		required: ["id"],
	}),
	async run(args, deps): Promise<ToolResult> {
		if (!deps.usePersona) return { text: "本环境不支持切换用户身份。" };

		const id = strArg(args, "id");
		if (!id) return { text: "缺少 id 参数（从 persona_list 取）。" };
		const lock = args.lock_to_card === true;

		let ok: boolean;
		try {
			ok = deps.usePersona(id, lock);
		} catch (err) {
			return { text: `切换身份失败：${errText(err)}` };
		}
		if (!ok) return { text: `没有 id 为 ${id} 的身份（用 persona_list 重取）。` };
		return {
			text: `已切换到身份 ${id}${lock ? "，并锁定到当前角色卡" : "（设为全局默认）"}。已热载生效。`,
			activity: "换身份",
		};
	},
};

/**
 * 调用情境：用户说「把那个身份删了」。
 *
 * 至少保留一个身份——删到空会让 `{{user}}` 无处可取（REST 同一条约束）。
 */
export const personaDelete: ToolSpec<PersonaDeps> = {
	name: "persona_delete",
	domain: "persona",
	mode: "write",
	surfaces: ["assistant"],
	label: "删除用户身份",
	description: () =>
		"删掉一个用户身份（id 从 persona_list 取）。**仅在用户明确要求删除时调用**，不可撤销。" +
		"至少保留一个身份——删到只剩一个时会被拒绝。",
	parameters: () => ({
		type: "object",
		properties: {
			id: { type: "string", description: "身份 id（从 persona_list 取）" },
		},
		required: ["id"],
	}),
	async run(args, deps): Promise<ToolResult> {
		if (!deps.deletePersona) return { text: "本环境不支持删除用户身份。" };

		const id = strArg(args, "id");
		if (!id) return { text: "缺少 id 参数（从 persona_list 取）。" };

		let ok: boolean;
		try {
			ok = deps.deletePersona(id);
		} catch (err) {
			return { text: `删除身份失败：${errText(err)}` };
		}
		if (!ok) return { text: `没删成：${id} 不存在，或它是最后一个身份（至少保留一个）。` };
		return { text: `已删除身份 ${id}。`, activity: "删身份" };
	},
};

/** 用户身份族全部工具（M-D7：列 / 建改 / 选用 / 删） */
export const personaTools: ToolSpec<PersonaDeps>[] = [personaList, personaWrite, personaUse, personaDelete];
