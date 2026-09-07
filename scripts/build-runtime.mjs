/** Offline build of the vendored runtime. Publish only after every package type-checks. */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const packages = {
	telemetry: { name: "@liyuan/telemetry", deps: [] },
	ai: { name: "@liyuan/ai", deps: ["telemetry"] },
	agent: { name: "@liyuan/agent-core", deps: ["telemetry", "ai"] },
	tui: { name: "@liyuan/tui", deps: [] },
	protocol: { name: "@liyuan/protocol", deps: [] },
	client: { name: "@liyuan/client", deps: ["protocol"] },
	"coding-agent": { name: "@liyuan/agent-runtime", deps: ["ai", "agent", "tui", "client", "protocol"] },
};
const selected = new Set();
function select(name) {
	if (!Object.hasOwn(packages, name)) throw new Error(`Unknown runtime package: ${name}`);
	for (const dependency of packages[name].deps) select(dependency);
	selected.add(name);
}
for (const name of process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(packages)) select(name);

const scratchRoot = path.join(root, ".liyuan-cache", "runtime-build");
fs.mkdirSync(scratchRoot, { recursive: true });
const scratch = fs.mkdtempSync(path.join(scratchRoot, "build-"));
const formatHost = { getCanonicalFileName: file => file, getCurrentDirectory: () => root, getNewLine: () => "\n" };
const paths = {};
for (const [dir, meta] of Object.entries(packages)) {
	const dist = selected.has(dir) ? path.join(scratch, dir) : path.join(root, "packages", dir, "dist");
	paths[meta.name] = [path.join(dist, "index.d.ts")];
	paths[meta.name + "/*"] = [path.join(dist, "*.d.ts")];
}
for (const name of selected) {
	const packageRoot = path.join(root, "packages", name);
	const configPath = path.join(packageRoot, "tsconfig.build.json");
	const config = ts.readConfigFile(configPath, ts.sys.readFile);
	if (config.error) throw new Error(ts.formatDiagnostics([config.error], formatHost));
	const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, packageRoot, { paths }, configPath);
	const dist = path.join(packageRoot, "dist");
	const program = ts.createProgram(parsed.fileNames, { ...parsed.options, outDir: dist });
	const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
	if (diagnostics.length) throw new Error(ts.formatDiagnostics(diagnostics, formatHost));
	const emit = program.emit(undefined, (file, content) => {
		const relative = path.relative(dist, file);
		if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Unexpected output: ${file}`);
		const target = path.join(scratch, name, relative);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content);
	});
	if (emit.emitSkipped || emit.diagnostics.length) throw new Error(ts.formatDiagnostics(emit.diagnostics, formatHost));
	const assetDirs = name === "ai" ? ["providers/data"] : name === "coding-agent"
		? ["modes/interactive/theme", "modes/interactive/assets", "core/export-html"] : [];
	for (const relative of assetDirs) {
		const source = path.join(packageRoot, "src", relative);
		fs.cpSync(source, path.join(scratch, name, relative), {
			recursive: true,
			filter: entry => fs.statSync(entry).isDirectory() || !entry.endsWith(".ts"),
		});
	}
	console.log(`Built ${name}`);
}

// All output stays within the named package's dist directory. Never follow a
// symlink here: a developer may have linked a different checkout into packages.
for (const name of selected) {
	const packageRoot = path.join(root, "packages", name);
	const dist = path.resolve(packageRoot, "dist");
	if (fs.realpathSync(packageRoot) !== packageRoot || (fs.existsSync(dist) && fs.lstatSync(dist).isSymbolicLink())) {
		throw new Error(`Refusing to replace linked runtime output: ${dist}`);
	}
}
for (const name of selected) {
	const dist = path.resolve(root, "packages", name, "dist");
	fs.rmSync(dist, { recursive: true, force: true });
	fs.cpSync(path.join(scratch, name), dist, { recursive: true });
}
if (path.dirname(scratch) !== scratchRoot) throw new Error("Unexpected build staging directory");
fs.rmSync(scratch, { recursive: true });
console.log(`Published ${selected.size} runtime packages`);
