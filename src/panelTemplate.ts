/**
 * 面板模板填充（纯函数，零 node 依赖——前端要直接 import，不能碰 node:fs）。
 *
 * agent 自建面板拆成两层之后：**外观**是 agent 写一次的模板（放 .rp-artifacts），
 * **数据**在 WorldState.panelData 里由场记每拍推进。这里是把两者合起来的那一步。
 */

/** 面板模板里的数据占位符：`{{路径.用点分隔}}` */
const PANEL_PLACEHOLDER_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

const escapeMarkup = (s: string): string =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** 按点分路径取值；取不到返回 undefined */
function valueAtPath(tree: Record<string, unknown>, path: string): unknown {
	let cur: unknown = tree;
	for (const seg of path.split(".")) {
		if (!cur || typeof cur !== "object") return undefined;
		cur = (cur as Record<string, unknown>)[seg];
	}
	return cur;
}

/**
 * 把面板外观里的 `{{路径}}` 换成数据树里的当前值。
 *
 * 为什么是占位符而不是让面板脚本读数据：agent 面板是 `sandbox=""` + CSP `default-src 'none'`
 * 渲染的（2026-07-10 用户定的「静态锁死」），压根跑不了脚本——MVU 卡那套 `setInterval`
 * 读变量的做法在这儿走不通，也不该为此松开沙箱。占位符还有个额外好处：值变了是 React
 * 重渲染，不需要面板自己轮询。
 *
 * **取不到的路径原样留着**（不换成空或「—」）：那是 agent 写错了路径，露出来才改得动；
 * 悄悄显示成空值等于把 bug 藏进界面。对象取不到标量也同理原样留着。
 */
export function fillPanelTemplate(
	content: string,
	tree: Record<string, unknown> | undefined,
	opts?: { escapeMarkup?: boolean },
): string {
	if (!tree || typeof tree !== "object") return content;
	return content.replace(PANEL_PLACEHOLDER_RE, (whole, rawPath: string) => {
		const v = valueAtPath(tree, rawPath.trim());
		let text: string;
		if (typeof v === "string") text = v;
		else if (typeof v === "number" || typeof v === "boolean") text = String(v);
		else if (Array.isArray(v)) text = v.filter((x) => x != null).map((x) => String(x)).join("、");
		else return whole; // undefined / null / 对象：原样留着
		return opts?.escapeMarkup ? escapeMarkup(text) : text;
	});
}
