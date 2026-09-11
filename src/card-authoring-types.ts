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
	/** 结构账本里的新增项：基线快照里没有，应用前一直算变更 */
	addition?: boolean;
	/** 已标记删除：应用时剔除；源文件仍在，可 restore */
	removed?: boolean;
}
export interface CardProjectStatus {
	prepared: boolean;
	directory: string;
	cardName: string;
	version: string;
	conflict: boolean;
	canUndo: boolean;
	resources: CardResource[];
	/** 结构账本概况 */
	changes: { added: number; removed: number; meta: number; cover: boolean; stale: number };
	/** 重新同步后仍需人工核对的资源 ID */
	conflicts?: string[];
}
export interface CardProjectBuild {
	hash: string;
	base: string;
	changed: string[];
	errors: Array<{ resource: string; message: string }>;
	checkedScripts: string[];
	checkedPatterns: string[];
	/** 结构账本：新增/待删的路径键、元数据覆盖的路径键、是否换封面、与基线对不上的项 */
	added: string[];
	removed: string[];
	meta: string[];
	cover: boolean;
	stale: string[];
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
	/** 该项拥有的 JSON 节点路径；remove / restore / meta 按它寻址 */
	path?: string[];
	/** 结构账本里的新增项 / 已标记删除 */
	addition?: boolean;
	removed?: boolean;
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
