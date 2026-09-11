/**
 * 递归复制（文件或目录树）。
 *
 * 不用 fs.cpSync：node 24.14.1 实测该 API 遇非 ASCII **目录**路径会原生崩溃
 * （0xC0000409——中文文件名无恙，目录路径里含中文必崩；backup 恢复、卡迁移
 * 的目标路径常含中文卡名）。readdirSync + copyFileSync + statSync 均已证安全。
 */
import { copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export function copyPathSafe(from: string, to: string): void {
	const st = statSync(from);
	if (st.isDirectory()) {
		mkdirSync(to, { recursive: true });
		for (const name of readdirSync(from)) {
			copyPathSafe(join(from, name), join(to, name));
		}
	} else {
		mkdirSync(dirname(to), { recursive: true });
		copyFileSync(from, to);
	}
}
