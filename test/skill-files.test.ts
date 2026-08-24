import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { scanSkillFiles } from "../src/stage/materials.ts";

test("scanSkillFiles：无 skills 目录 → 空数组（零痕迹的前提）", () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-noskill-"));
	try {
		assert.deepEqual(scanSkillFiles(cwd), []);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
