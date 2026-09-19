import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

export type Locale = "zh-CN" | "en";

const STORAGE_KEY = "liyuan.locale";

const EN: Record<string, string> = {
	"会话": "Sessions",
	"世界线": "Worldline",
	"连接": "Connection",
	"提示词": "Prompts",
	"扩展": "Extensions",
	"设置": "Settings",
	"关于": "About",
	"角色": "Characters",
	"世界书": "Lorebooks",
	"登场名录": "Roster",
	"资料": "Files",
	"状态栏": "Status",
	"登录失败": "Sign-in failed",
	"请输入访问密码": "Enter the access password",
	"访问密码": "Access password",
	"登录中…": "Signing in…",
	"进入": "Enter",
	"刚刚": "Just now",
	"（空会话）": "(empty session)",
	"夜深了": "Good evening",
	"早上好": "Good morning",
	"中午好": "Good afternoon",
	"下午好": "Good afternoon",
	"晚上好": "Good evening",
	"角色扮演 Agent · 开源": "Open-source role-playing agent",
	"打开角色卡": "Open character card",
	"当前角色": "Current character",
	"继续当前对话": "Continue conversation",
	"开始对话": "Start a conversation",
	"新建会话": "New session",
	"最近会话": "Recent sessions",
	"全部会话": "All sessions",
	"点击进入当前对话": "Open current conversation",
	"打开此会话": "Open this session",
	"当前": "Current",
	"外观": "Appearance",
	"界面语言": "Interface language",
	"简体中文": "Simplified Chinese",
	"英语": "English",
	"黑夜模式": "Dark mode",
	"白昼 / 黑夜立刻切换，偏好记在本机浏览器，与会话配置无关。": "Switch themes instantly. This preference is stored in this browser and is independent of session settings.",
	"已切换到黑夜模式": "Dark mode enabled",
	"已切换到白昼模式": "Light mode enabled",
	"关键词扫描深度": "Keyword scan depth",
	"被动触发回看最近几条消息": "How many recent messages passive triggers inspect",
	"每轮注入条目上限": "Maximum entries injected per turn",
	"0 = 关闭被动注入（常驻条目不受影响）": "0 = disable passive injection (always-on entries are unaffected)",
	"上下文压缩": "Context compression",
	"固定楼层压缩周期": "Scheduled compression interval",
	"agent 行为": "Agent behavior",
	"后端操控（bash / 文件等通用工具）": "Backend control (bash, files, and general tools)",
	"决策门禁（戏内选择卡）": "Decision gate (in-story choice cards)",
	"查看完整关于": "View full about page",
	"保存并重载会话": "Save and reload session",
	"已保存": "Saved",
	"已保存并重载会话": "Saved and reloaded session",
};

type I18nValue = {
	locale: Locale;
	setLocale: (locale: Locale) => void;
	t: (source: string) => string;
};

const I18nContext = createContext<I18nValue | null>(null);

function initialLocale(): Locale {
	try {
		const saved = localStorage.getItem(STORAGE_KEY);
		if (saved === "en" || saved === "zh-CN") return saved;
	} catch {
		// Storage can be unavailable in hardened/private browser contexts.
	}
	return navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
	const [locale, setLocaleState] = useState<Locale>(initialLocale);
	const setLocale = useCallback((next: Locale) => {
		setLocaleState(next);
		try {
			localStorage.setItem(STORAGE_KEY, next);
		} catch {
			// The in-memory selection still works for the current session.
		}
	}, []);
	const t = useCallback((source: string) => (locale === "en" ? EN[source] ?? source : source), [locale]);

	useEffect(() => {
		document.documentElement.lang = locale;
	}, [locale]);

	const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
	return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
	const value = useContext(I18nContext);
	if (!value) throw new Error("useI18n must be used within I18nProvider");
	return value;
}
