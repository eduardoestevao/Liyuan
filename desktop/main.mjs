/**
 * 梨园桌面版 Electron 主进程（docs/PLAN-DESKTOP.md）。
 *
 * 双根布局：
 * - 产品根（只读，随包）：server/ src/ packages/ web/dist assets/ .liyuan/extensions/ node_modules
 * - 数据根（可写，用户可见）：cards/ 配置 skills/ assets 活副本 .liyuan-* 运行目录
 * server 以子进程运行：ELECTRON_RUN_AS_NODE=1 把本进程二进制当纯 Node 用（VS Code 同款手法），
 * cwd＝数据根，产品根经 LIYUAN_PRODUCT_ROOT 告知（server/main.ts 只在三处消费）。
 *
 * dev（--dev 或未打包）：产品根＝仓库根；数据根＝仓库根（两根合一，行为与 node server/main.ts
 * 一致）。LIYUAN_DESKTOP_DATA_ROOT 可在 dev 或冒烟里显式指定数据根以测双根分离路径。
 */
import { app, BrowserWindow, dialog, Menu, shell } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dev = process.argv.includes("--dev") || !app.isPackaged;

/** 产品树根（含 server/src/packages/web-dist/assets 的那一层）；打包后＝resources/app 即 stage 原样 */
const productRoot = dev ? path.resolve(__dirname, "..") : app.getAppPath();

// ---------- 数据根 ----------

const desktopConfigFile = () => path.join(app.getPath("userData"), "desktop.json");

function readSavedDataRoot() {
	try {
		const cfg = JSON.parse(fs.readFileSync(desktopConfigFile(), "utf8"));
		return typeof cfg.dataRoot === "string" ? cfg.dataRoot : null;
	} catch {
		return null;
	}
}

function saveDataRoot(dir) {
	fs.mkdirSync(app.getPath("userData"), { recursive: true });
	fs.writeFileSync(desktopConfigFile(), `${JSON.stringify({ dataRoot: dir }, null, "\t")}\n`, "utf8");
}

async function pickDataRoot() {
	const docs = app.getPath("documents") || app.getPath("home");
	const { canceled, filePaths } = await dialog.showOpenDialog({
		title: "选择梨园数据目录",
		message: "角色卡、会话、记忆与配置都保存在这个目录里，可整体拷贝迁移。",
		defaultPath: path.join(docs, "Liyuan"),
		properties: ["openDirectory", "createDirectory", "dontAddToRecent"],
		buttonLabel: "选这里",
	});
	if (canceled || !filePaths?.[0]) return null;
	saveDataRoot(filePaths[0]);
	return filePaths[0];
}

async function resolveDataRoot() {
	if (process.env.LIYUAN_DESKTOP_DATA_ROOT) return process.env.LIYUAN_DESKTOP_DATA_ROOT;
	if (dev) return productRoot;
	const saved = readSavedDataRoot();
	if (saved && fs.existsSync(saved)) return saved;
	if (saved) {
		// 指针在、目录没了：明确告知，不静默重建（数据主权在用户）
		const choice = dialog.showMessageBoxSync({
			type: "warning",
			title: "梨园",
			message: `数据目录不存在：\n${saved}`,
			detail: "目录可能被移动或删除。重新选择已有目录可继续用原有数据；选新目录则从零开始。",
			buttons: ["重新选择…", "退出"],
			defaultId: 0,
			cancelId: 1,
		});
		return choice === 0 ? await pickDataRoot() : null;
	}
	return await pickDataRoot();
}

// ---------- 播种（PLAN-DESKTOP §四：覆盖同步＝产品持有的种子源；缺失才种＝用户持有） ----------

function copyTree(from, to) {
	fs.mkdirSync(to, { recursive: true });
	for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
		const src = path.join(from, entry.name);
		const dst = path.join(to, entry.name);
		if (entry.isDirectory()) copyTree(src, dst);
		else if (entry.isFile()) copyFileIfChanged(src, dst);
	}
}

function copyFileIfChanged(src, dst) {
	fs.mkdirSync(path.dirname(dst), { recursive: true });
	try {
		if (fs.readFileSync(src).equals(fs.readFileSync(dst))) return;
	} catch {
		/* 目标不存在 */
	}
	fs.copyFileSync(src, dst);
}

function seedDataRoot(dataRoot) {
	if (path.resolve(dataRoot) === path.resolve(productRoot)) return; // 两根合一（dev）：仓库本身就是完整布局
	const prod = (rel) => path.join(productRoot, rel);
	const data = (rel) => path.join(dataRoot, rel);

	// 覆盖同步（只是种子源；活件在 ~/.liyuan/agent 与 skills/，播过即用户持有）
	for (const rel of ["assets/SYSTEM.md", "assets/APPEND_SYSTEM.md"]) {
		if (fs.existsSync(prod(rel))) copyFileIfChanged(prod(rel), data(rel));
	}
	if (fs.existsSync(prod("assets/skills"))) copyTree(prod("assets/skills"), data("assets/skills"));

	// 缺失才种（用户可删默认卡；配置与库播过即用户持有）
	const defaults = fs.existsSync(prod("assets/cards"))
		? fs.readdirSync(prod("assets/cards")).filter((f) => f.startsWith("default_") && f.endsWith(".json"))
		: [];
	for (const f of defaults) {
		if (!fs.existsSync(data(path.join("assets/cards", f)))) {
			copyFileIfChanged(prod(path.join("assets/cards", f)), data(path.join("assets/cards", f)));
		}
	}
	copyIfMissing(prod("liyuan.config.example.json"), data("liyuan.config.json"));
	copyIfMissing(prod("liyuan.agent.example.json"), data("liyuan.agent.json"));
	for (const rel of ["cards", "assets/lorebooks", "assets/presets"]) fs.mkdirSync(data(rel), { recursive: true });
}

function copyIfMissing(src, dst) {
	if (!fs.existsSync(src) || fs.existsSync(dst)) return;
	fs.mkdirSync(path.dirname(dst), { recursive: true });
	fs.copyFileSync(src, dst);
}

// ---------- 端口 ----------

function portInUse(port) {
	return new Promise((resolve) => {
		const srv = net.createServer();
		srv.once("error", () => resolve(true));
		srv.once("listening", () => srv.close(() => resolve(false)));
		srv.listen(port);
	});
}

function freePort() {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const port = srv.address().port;
			srv.close(() => resolve(port));
		});
	});
}

async function pickPort() {
	const preferred = Number(process.env.PORT) || 7620;
	return (await portInUse(preferred)) ? await freePort() : preferred;
}

// ---------- server 子进程 ----------

let serverProc = null;
let serverPort = 0;
let quitting = false;
let logFd = null;
let dataRootResolved = "";

const logPath = () => path.join(dataRootResolved, ".liyuan-cache", "desktop.log");

function openLog() {
	const dir = path.join(dataRootResolved, ".liyuan-cache");
	fs.mkdirSync(dir, { recursive: true });
	try {
		if (fs.statSync(logPath()).size > 5 * 1024 * 1024) fs.rmSync(logPath()); // 简单轮转
	} catch {
		/* 无旧日志 */
	}
	return fs.openSync(logPath(), "a");
}

function killServer() {
	const pid = serverProc?.pid;
	if (!pid) return;
	if (process.platform === "win32") {
		spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" }); // 带上子孙（vision MCP、bash）
	} else {
		try {
			process.kill(-pid, "SIGTERM"); // detached 建了新进程组，组杀
		} catch {
			try {
				serverProc.kill("SIGTERM");
			} catch {
				/* 已退出 */
			}
		}
	}
	serverProc = null;
}

function spawnServer(dataRoot) {
	const split = path.resolve(dataRoot) !== path.resolve(productRoot);
	const env = {
		...process.env,
		ELECTRON_RUN_AS_NODE: "1",
		PORT: String(serverPort),
		...(split ? { LIYUAN_PRODUCT_ROOT: productRoot } : {}),
		...(!dev ? { LIYUAN_DESKTOP: "1" } : {}),
	};
	const stdio = dev ? "inherit" : ["ignore", "pipe", "pipe"];
	serverProc = spawn(process.execPath, [path.join(productRoot, "server", "main.ts")], {
		cwd: dataRoot,
		env,
		stdio,
		detached: process.platform !== "win32",
	});
	if (!dev) {
		logFd = openLog();
		const write = (chunk) => {
			try {
				fs.writeSync(logFd, chunk);
			} catch {
				/* 盘满等：丢日志不杀服务 */
			}
		};
		serverProc.stdout?.on("data", write);
		serverProc.stderr?.on("data", write);
	}
	serverProc.on("exit", (code) => {
		serverProc = null;
		if (quitting) return;
		const choice = dialog.showMessageBoxSync({
			type: "error",
			title: "梨园",
			message: `服务进程意外退出（代码 ${code}）。`,
			detail: dev ? "" : `日志：${logPath()}`,
			buttons: ["重启服务", "退出"],
			defaultId: 0,
			cancelId: 1,
		});
		if (choice === 0) void restart();
		else app.quit();
	});
}

function waitHealthy(timeoutMs = 90_000) {
	const started = Date.now();
	return new Promise((resolve, reject) => {
		const ping = () => {
			if (serverProc === null) return reject(new Error("服务进程已退出（详见日志）"));
			const req = http.get({ host: "127.0.0.1", port: serverPort, path: "/healthz", timeout: 3000 }, (res) => {
				res.resume();
				if (res.statusCode === 200) resolve();
				else retry();
			});
			req.on("timeout", () => req.destroy(new Error("timeout")));
			req.on("error", retry);
		};
		const retry = () => {
			if (Date.now() - started > timeoutMs) return reject(new Error("等待服务就绪超时"));
			setTimeout(ping, 400);
		};
		ping();
	});
}

async function restart() {
	killServer();
	serverPort = await pickPort();
	spawnServer(dataRootResolved);
	await waitHealthy();
	if (win) win.loadURL(serverUrl());
}

const serverUrl = () => `http://127.0.0.1:${serverPort}/`;

// ---------- 窗口与菜单 ----------

let win = null;

const SPLASH =
	"data:text/html;charset=utf-8," +
	encodeURIComponent(
		`<!doctype html><meta charset="utf-8"><title>梨园</title>` +
			`<style>html,body{margin:0;height:100%;background:#141312;color:#c9b8a6;font:16px/1.8 system-ui,sans-serif}` +
			`main{height:100%;display:grid;place-items:center}</style>` +
			`<main><div>梨园启动中…</div></main>`,
	);

function createWindow() {
	win = new BrowserWindow({
		width: 1280,
		height: 820,
		minWidth: 940,
		minHeight: 600,
		backgroundColor: "#141312",
		title: "梨园",
	});
	win.loadURL(SPLASH);
	win.on("closed", () => {
		win = null;
	});
	// 外链一律给系统浏览器；页内导航只许自家 origin
	win.webContents.setWindowOpenHandler(({ url }) => {
		if (/^https?:/i.test(url)) void shell.openExternal(url);
		return { action: "deny" };
	});
	win.webContents.on("will-navigate", (event, url) => {
		if (!url.startsWith(`http://127.0.0.1:${serverPort}`)) {
			event.preventDefault();
			if (/^https?:/i.test(url)) void shell.openExternal(url);
		}
	});
}

function buildMenu() {
	const template = [
		{
			label: "文件",
			submenu: [
				{ label: "打开数据目录", click: () => void shell.openPath(dataRootResolved) },
				{ type: "separator" },
				{ label: "退出", role: "quit" },
			],
		},
		{
			label: "视图",
			submenu: [
				{ label: "重新载入", accelerator: "CmdOrCtrl+R", click: () => win?.webContents.reload() },
				{ label: "开发者工具", accelerator: "F12", click: () => win?.webContents.toggleDevTools() },
			],
		},
		{
			label: "帮助",
			submenu: [
				{
					label: "检查更新（GitHub Releases）",
					click: () => void shell.openExternal("https://github.com/weidu12123/Liyuan/releases/latest"),
				},
				{
					label: "关于",
					click: () =>
						void dialog.showMessageBox({
							type: "info",
							title: "梨园",
							message: `梨园 Liyuan v${app.getVersion()}`,
							detail: `数据目录：${dataRootResolved}`,
							buttons: ["好"],
						}),
				},
			],
		},
	];
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- 主流程 ----------

async function bootstrap() {
	await app.whenReady();
	const dataRoot = await resolveDataRoot();
	if (!dataRoot) {
		app.quit();
		return;
	}
	dataRootResolved = dataRoot;
	seedDataRoot(dataRoot);
	buildMenu();
	createWindow();
	try {
		serverPort = await pickPort();
		spawnServer(dataRoot);
		await waitHealthy();
		if (win) win.loadURL(serverUrl());
	} catch (err) {
		dialog.showErrorBox(
			"梨园启动失败",
			`${err instanceof Error ? err.message : String(err)}\n\n${dev ? "" : `日志：${logPath()}`}`,
		);
		app.quit();
	}
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
	app.quit();
} else {
	app.on("second-instance", () => {
		if (win) {
			if (win.isMinimized()) win.restore();
			win.focus();
		}
	});

	void bootstrap().catch((err) => {
		dialog.showErrorBox("梨园启动失败", String(err));
		app.quit();
	});

	app.on("window-all-closed", () => {
		// 桌面版窗口即服务：关窗即收摊（macOS 同此，v1 不留后台）
		quitting = true;
		killServer();
		app.quit();
	});
	app.on("before-quit", () => {
		quitting = true;
		killServer();
	});
}
