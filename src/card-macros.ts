import type { MacroContext } from "./types.ts";

/** 卡作者的 {{char}} / {{user}} 宏；服务端和创作预览共用。 */
export function applyMacros(text: string, ctx: MacroContext): string {
	return text.replace(/\{\{\s*(char|user)\s*\}\}/gi, (_m, name: string) =>
		name.toLowerCase() === "char" ? ctx.charName : ctx.userName,
	);
}
