/**
 * 界面小状态的 localStorage 存取（球的位置、悬浮窗的位置尺寸……）。
 *
 * 单独抽出来只为一件事：**读写一律吞异常**。隐私模式、站点数据被禁、配额满，
 * 任何一处直接 throw 都会把整块 UI 带崩，而这些状态本来就是「有则更好」的便利项。
 */

export function readUiJson<T>(key: string): T | null {
	try {
		const raw = localStorage.getItem(key);
		return raw ? (JSON.parse(raw) as T) : null;
	} catch {
		return null;
	}
}

export function writeUiJson(key: string, value: unknown): void {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		/* 存不下就不记住，功能照常可用 */
	}
}
