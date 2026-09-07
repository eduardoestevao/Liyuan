/** Rebuild selected vendored modules without emitting unrelated source/dist drift. */
import { createRequire } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(resolve(root, "packages/coding-agent/package.json"));
const ts = require("typescript");
const declarationsOnly = process.argv.includes("--declarations-only");
const requested = process.argv.slice(2).filter(arg => arg !== "--declarations-only");
if (!requested.length) {
	console.error("Usage: node scripts/build-runtime-modules.mjs [--declarations-only] packages/<package>/src/<module>.ts ...");
	process.exit(1);
}

const groups = new Map();
for (const path of requested) {
	const absolute = resolve(root, path);
	const parts = relative(root, absolute).split(sep);
	if (parts[0] !== "packages" || parts[2] !== "src" || !absolute.endsWith(".ts")) {
		throw new Error(`Expected a vendored package source module: ${path}`);
	}
	const packageDir = resolve(root, "packages", parts[1]);
	const files = groups.get(packageDir) ?? new Set();
	files.add(absolute);
	groups.set(packageDir, files);
}

const diagnosticHost = { getCurrentDirectory: () => root, getCanonicalFileName: path => path, getNewLine: () => "\n" };
for (const [packageDir, files] of groups) {
	const config = ts.readConfigFile(resolve(packageDir, "tsconfig.build.json"), ts.sys.readFile);
	if (config.error) throw new Error(ts.formatDiagnosticsWithColorAndContext([config.error], diagnosticHost));
	const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, packageDir);
	const program = ts.createProgram(parsed.fileNames, parsed.options);
	const sources = [...files].map(path => {
		const source = program.getSourceFile(path);
		if (!source) throw new Error(`Module is not included in the package build: ${path}`);
		return source;
	});
	// Declaration synchronization checks the selected modules. Normal JS builds
	// require the entire package to type-check before writing any output.
	const diagnostics = [...parsed.errors, ...(declarationsOnly
		? sources.flatMap(source => ts.getPreEmitDiagnostics(program, source))
		: ts.getPreEmitDiagnostics(program))];
	if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, diagnosticHost));
	for (const source of sources) {
		const result = program.emit(source, undefined, undefined, declarationsOnly);
		if (result.emitSkipped || result.diagnostics.length) throw new Error(`Emit failed: ${source.fileName}`);
		console.log(`Built ${relative(root, source.fileName)}${declarationsOnly ? " (declarations only; selected modules checked)" : ""}`);
	}
}
