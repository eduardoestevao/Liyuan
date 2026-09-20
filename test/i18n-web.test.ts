import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import ts from "typescript";
import { EN } from "../web/src/i18n.en.ts";

const ROOT = join(import.meta.dirname, "..", "web", "src");
const HAN = /[\u3400-\u9fff\uf900-\ufaff]/u;
const CODE_LIKE = /(?:<\/?(?:script|style)|function\s*\(|=>|addEventListener\s*\(|document\.|window\.|\{\s*["'])/u;

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return entry.name === "vendor" ? [] : sourceFiles(path);
		return /\.(?:ts|tsx)$/.test(entry.name) && entry.name !== "i18n.tsx" ? [path] : [];
	});
}

function isInsideTranslation(node: ts.Node): boolean {
	for (let current: ts.Node | undefined = node; current; current = current.parent) {
		if (
			ts.isCallExpression(current) &&
			ts.isIdentifier(current.expression) &&
			current.expression.text === "t" &&
			current.arguments.some((argument) => argument === node || argument.pos <= node.pos && argument.end >= node.end)
		) return true;
		if (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current)) break;
	}
	return false;
}

test("every Chinese web-interface literal is routed through i18n", () => {
	const misses: string[] = [];
	for (const file of sourceFiles(ROOT)) {
		const source = readFileSync(file, "utf8");
		const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
		const visit = (node: ts.Node): void => {
			const text = ts.isJsxText(node)
				? node.getText(tree).trim()
				: ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
					? node.text
					: undefined;
			const catalogKey = text?.trim().replace(/\s+/gu, " ");
			const translated = catalogKey && (EN[catalogKey] || Object.entries(EN).some(([key]) => key.trim().replace(/\s+/gu, " ") === catalogKey));
			if (text && text.length <= 500 && HAN.test(text) && !CODE_LIKE.test(text) && !isInsideTranslation(node) && !translated) {
				const { line } = tree.getLineAndCharacterOfPosition(node.getStart(tree));
				misses.push(`${relative(ROOT, file)}:${line + 1}: ${JSON.stringify(text.slice(0, 100))}`);
			}
			ts.forEachChild(node, visit);
		};
		visit(tree);
	}
	if (misses.length) throw new Error(`Untranslated interface literals (${misses.length} total):\n${misses.slice(0, 80).join("\n")}`);
});

test("the initial HTML metadata is English before React loads", () => {
	const html = readFileSync(join(ROOT, "..", "index.html"), "utf8");
	for (const tag of html.matchAll(/<(?:title|meta\s+name=["'](?:apple-mobile-web-app-title|application-name)["'])[^>]*>(?:[^<]*)?/gu)) {
		if (HAN.test(tag[0])) throw new Error(`Untranslated HTML metadata: ${tag[0]}`);
	}
});

test("runtime title updates respect the active locale", () => {
	const app = readFileSync(join(ROOT, "App.tsx"), "utf8");
	if (/document\.title\s*=\s*["'][^"']*[\u3400-\u9fff]/u.test(app)) throw new Error("App.tsx assigns a Chinese-only document title");
});
