/** 创作工程的浏览器/服务端共用数据；不依赖文件系统或运行时。 */
import type { CardFrontSnapshot } from "./cardfront.ts";

export type CardResourceKind = "field" | "greeting" | "lore" | "script" | "regex-pattern" | "regex-template";
export interface CardResource {
	id: string;
	kind: CardResourceKind;
	name: string;
	file: string;
	path: string[];
	length: number;
	hash: string;
	changed: boolean;
	/** 复制产生的新增草稿：base 快照里没有，应用前一直算变更 */
	addition?: boolean;
}
export interface CardProjectStatus {
	prepared: boolean;
	directory: string;
	cardName: string;
	version: string;
	conflict: boolean;
	canUndo: boolean;
	resources: CardResource[];
}
export interface CardProjectBuild {
	hash: string;
	base: string;
	changed: string[];
	errors: Array<{ resource: string; message: string }>;
	checkedScripts: string[];
	checkedPatterns: string[];
}
export interface CardProjectPreview {
	build: CardProjectBuild;
	front: CardFrontSnapshot;
	greetings: string[];
	variables: Record<string, unknown>;
}

/** 板块：卡按作者心智的分组。默认由 spec 结构判据给出，作者/模型可用声明覆盖。 */
export type CardSectionId =
	| "settings" | "lore-knowledge" | "lore-constant" | "rules" | "greetings"
	| "mvu" | "ui" | "prompt-regex" | "scripts" | "ejs" | "deps" | "other";
export const CARD_SECTION_LABELS: Record<CardSectionId, string> = {
	settings: "作品设置", "lore-knowledge": "世界书·知识", "lore-constant": "世界书·常驻块", rules: "创作规则",
	greetings: "开场白", mvu: "MVU 变量", ui: "界面", "prompt-regex": "文本正则", scripts: "脚本",
	ejs: "EJS", deps: "外部依赖", other: "其他",
};
export interface CardOutlineItem {
	/** 稳定键：按原始 JSON 位置派生，与资源 ID 同源 */
	key: string;
	section: CardSectionId;
	defaultSection: CardSectionId;
	/** 当前板块来自声明而非默认判据 */
	declared: boolean;
	label: string;
	/** 可编辑的资源 ID（无字符串槽位的项为空） */
	resources: string[];
	size: number;
	enabled: boolean;
	/** 只放 spec 结构事实，不放正文 */
	facts: Record<string, string | number | boolean>;
}
export interface CardOutlineSection {
	id: CardSectionId;
	label: string;
	items: CardOutlineItem[];
	size: number;
}
export interface CardOutline {
	sections: CardOutlineSection[];
	declared: number;
}
