import assert from "node:assert/strict";
import test from "node:test";
import { translateStaticText } from "../web/src/i18n-core.ts";

const catalog = {
	"世界线": "Worldline",
	"保存": "Save",
};

test("translates an exact interface literal and preserves surrounding whitespace", () => {
	assert.equal(translateStaticText("  世界线\n", catalog), "  Worldline\n");
});

test("does not alter user-authored text that merely contains an interface word", () => {
	assert.equal(translateStaticText("我的世界线故事", catalog), "我的世界线故事");
});

test("returns already-English and unknown text unchanged", () => {
	assert.equal(translateStaticText("Save", catalog), "Save");
	assert.equal(translateStaticText("青梧", catalog), "青梧");
});

test("matches JSX and DOM whitespace normalization", () => {
	assert.equal(translateStaticText("Backup this project and keep it safe.", { "Backup\n\tthis project and keep it safe.": "Backup safely." }), "Backup safely.");
});

test("composes translated UI fragments around dynamic numbers", () => {
	assert.equal(translateStaticText("（185 字）", { "字": "characters" }), "(185 characters)");
});

test("refuses partial composition when unknown Chinese content remains", () => {
	assert.equal(translateStaticText("当前角色 青梧", { "当前角色": "Current character" }), "当前角色 青梧");
});
