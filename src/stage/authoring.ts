import { readFileSync } from "node:fs";
import { cardTools, type CardDeps } from "../tools/card.ts";
import type { ToolContext } from "../tools/registry.ts";
import type { StageTool } from "./tools.ts";

export const CONVERSATION_MODE_TOOL: StageTool = {
	name: "conversation_mode", mode: "write",
	description: "切换本会话的扮演/写卡模式。制作、诊断、修改角色卡、前端、脚本或配套资源时进入 authoring，同一轮随即开放完整操作历史与写卡工具；本次请求和操作不进入剧情。维护完成后切回 roleplay，本次操作结束，等用户下一条剧情输入续演。模式不会另建对话或删除记录。",
	parameters: { type: "object", properties: { mode: { type: "string", enum: ["roleplay", "authoring"] } }, required: ["mode"] },
};

export const AUTHORING_NATIVE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const available = (name: string, deps: CardDeps) => {
	if (name === "card_project") return !!deps.project;
	if (name === "card_create") return !!deps.createCard;
	if (name === "card_update") return !!deps.updateCard;
	if (name === "card_list") return !!deps.listCards;
	if (name === "card_greetings") return !!deps.greetings;
	return name === "card_read";
};
const context = (language: string): ToolContext => ({ surface: "authoring", language });
export function authoringTools(language: string, deps: CardDeps): StageTool[] {
	return cardTools.filter((s) => s.surfaces.includes("authoring") && available(s.name, deps))
		.map((s) => ({ name: s.name, mode: s.mode, description: s.description(context(language)), parameters: s.parameters(context(language)) }));
}
export async function runAuthoringTool(name: string, args: Record<string, unknown>, language: string, deps: CardDeps) {
	const spec = cardTools.find((s) => s.name === name && s.surfaces.includes("authoring") && available(s.name, deps));
	return spec?.run(args, deps, context(language));
}

export function authoringSystemPrompt(cwd: string, cardPath: string): string {
	return `${readFileSync(new URL("../../assets/AUTHORING.md", import.meta.url), "utf8").trim()}\n\n工作目录：${cwd}\n当前角色卡：${cardPath}`;
}
