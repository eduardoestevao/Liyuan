import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { syncCardRuntimeVariables } from "../web/src/cardRuntimeFrames.ts";
import { installParentTavernShim, registerTavernChatBridge } from "../web/src/tavernShim.ts";

function browser(t: TestContext) {
	const listeners = new Set<(event: unknown) => void>();
	const messages = { story: [] as unknown[], preview: [] as unknown[] };
	const story = { postMessage: (data: unknown) => messages.story.push(data) };
	const preview = { postMessage: (data: unknown) => messages.preview.push(data) };
	const frames = [{ contentWindow: story }];
	const globals = {
		window: { addEventListener: (_name: string, callback: (event: unknown) => void) => listeners.add(callback),
			removeEventListener: (_name: string, callback: (event: unknown) => void) => listeners.delete(callback) },
		document: { querySelectorAll: () => frames },
	};
	for (const [key, value] of Object.entries(globals)) {
		const original = Object.getOwnPropertyDescriptor(globalThis, key);
		Object.defineProperty(globalThis, key, { configurable: true, value });
		t.after(() => {
			if (original) Object.defineProperty(globalThis, key, original);
			else Reflect.deleteProperty(globalThis, key);
		});
	}
	return { messages, story, preview, frames,
		emit: (source: object | null, data: unknown) => { for (const callback of listeners) callback({ source, data, origin: "null" }); } };
}

test("剧情变量的广播和握手只投递到正式帧，卸载后不再回复", t => {
	const b = browser(t);
	const stop = syncCardRuntimeVariables({ hp: 23 });
	const expected = { liyuanVariables: { stat_data: { hp: 23 } } };
	assert.deepEqual(b.messages.story, [expected]);
	b.emit(b.preview, { liyuanVariablesReady: true });
	b.emit(null, { liyuanVariablesReady: true });
	assert.deepEqual(b.messages.preview, []);
	b.emit(b.story, { liyuanVariablesReady: true });
	assert.deepEqual(b.messages.story, [expected, expected]);
	b.frames.length = 0;
	b.emit(b.story, { liyuanVariablesReady: true });
	assert.equal(b.messages.story.length, 2);
	stop();
});

test("正式脚本的跨域消息仍能触发桥，预览和已卸载来源不能触发", t => {
	const b = browser(t);
	const sent: string[] = [];
	registerTavernChatBridge({ setInput: text => sent.push(text), sendPrompt: text => sent.push(text) });
	t.after(() => registerTavernChatBridge(null));
	installParentTavernShim();
	b.emit(b.preview, { liyuanTriggerSlash: "/send 预览|/trigger" });
	b.emit(null, { liyuanTriggerSlash: "/send 无来源|/trigger" });
	assert.deepEqual(sent, []);
	b.emit(b.story, { liyuanTriggerSlash: "/send 正式组件|/trigger" });
	assert.deepEqual(sent, ["正式组件"]);
	b.frames.length = 0;
	b.emit(b.story, { liyuanTriggerSlash: "/send 旧组件|/trigger" });
	assert.deepEqual(sent, ["正式组件"]);
});
