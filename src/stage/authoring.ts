import { readFileSync } from "node:fs";
import { NATIVE_TOOL_ACCESS } from "../sandbox.ts";
import { cardTools, type CardDeps } from "../tools/card.ts";
import type { ToolContext } from "../tools/registry.ts";
import type { StageTool } from "./tools.ts";

export const CONVERSATION_MODE_TOOL: StageTool = {
	name: "conversation_mode", mode: "write",
	description: "切换本会话的扮演/工作模式。制作、诊断、维护角色卡、前端、脚本、代码或资源时进入 authoring，同一轮开放完整操作历史与工作工具；本次请求和操作不进入剧情。维护完成后切回 roleplay 续演。模式不另建对话或删除记录。",
	parameters: { type: "object", properties: { mode: { type: "string", enum: ["roleplay", "authoring"] } }, required: ["mode"] },
};

/** 工作模式开放的 pi 原生工具＝沙箱认得的那几个（docs/PLAN-SANDBOX.md）；一份清单两处用 */
export const AUTHORING_NATIVE_TOOLS: string[] = Object.keys(NATIVE_TOOL_ACCESS);
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
