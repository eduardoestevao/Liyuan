import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ModelRuntime } from "../src/core/model-runtime.ts";

describe("Liyuan model configuration across runtime upgrades", () => {
	const directories: string[] = [];
	afterEach(() => {
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});
	async function runtimeFor(api: string, models: unknown[], compat?: Record<string, unknown>) {
		const directory = mkdtempSync(join(tmpdir(), "liyuan-model-runtime-"));
		directories.push(directory);
		const modelsPath = join(directory, "models.json");
		writeFileSync(modelsPath, JSON.stringify({ providers: {
			fixture: { api, baseUrl: "https://fixture.example/v1", apiKey: "fixture-key", compat, models },
		} }));
		return ModelRuntime.create({ modelsPath, authPath: join(directory, "auth.json") });
	}

	it.each(["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai", "google-vertex"])(
		"preserves streaming=false and explicit off controls for %s", async (api) => {
			const runtime = await runtimeFor(api, [{ id: "configured", thinkingLevel: "off", maxTokens: 1234 }], { streaming: false });
			expect(runtime.getError()).toBeUndefined();
			const model = runtime.getModel("fixture", "configured")!;
			expect(model.reasoning).toBe(true);
			expect(model.compat?.streaming).toBe(false);
			expect(model.maxTokens).toBe(1234);
			expect((await runtime.getAuth(model))?.auth.apiKey).toBe("fixture-key");
		},
	);

	it("keeps per-model compat overrides and explicit reasoning=false", async () => {
		const runtime = await runtimeFor("openai-completions", [
			{ id: "default" },
			{ id: "override", thinkingLevel: "off", reasoning: false, compat: { streaming: true, maxTokensField: "max_completion_tokens" } },
		], { streaming: false });
		expect(runtime.getModel("fixture", "default")?.compat).toMatchObject({ streaming: false, maxTokensField: "max_tokens" });
		expect(runtime.getModel("fixture", "override")).toMatchObject({ reasoning: false, compat: { streaming: true, maxTokensField: "max_completion_tokens" } });
	});
});
