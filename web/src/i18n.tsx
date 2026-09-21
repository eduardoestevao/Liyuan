import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { translateStaticText } from "./i18n-core.ts";
import { EN } from "./i18n.en.ts";

export type Locale = "zh-CN" | "en";

const STORAGE_KEY = "liyuan.locale";

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
	return "zh-CN";
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
		const appName = locale === "en" ? "Liyuan" : "梨园";
		document.title = appName;
		for (const name of ["apple-mobile-web-app-title", "application-name"]) {
			document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.setAttribute("content", appName);
		}
		if (locale !== "en") return;
		const attributes = ["aria-label", "data-tip", "placeholder", "title"] as const;
		const textChanges = new Map<Text, { source: string; translated: string }>();
		const attributeChanges = new Map<Element, Map<string, { source: string; translated: string }>>();
		const localize = (root: Node) => {
			if (root instanceof Element && root.closest("[data-i18n-skip], .message-content, .welcome-chat-preview, script, style, code, pre")) return;
			if (root.nodeType === Node.TEXT_NODE && root.textContent) {
				const node = root as Text;
				const source = node.textContent;
				if (!source) return;
				const previous = textChanges.get(node);
				if (previous?.translated === source) return;
				const translated = translateStaticText(source, EN);
				if (translated !== source) {
					textChanges.set(node, { source, translated });
					node.textContent = translated;
				}
				return;
			}
			if (root instanceof Element) {
				for (const attribute of attributes) {
					const value = root.getAttribute(attribute);
					if (!value) continue;
					const previous = attributeChanges.get(root)?.get(attribute);
					if (previous?.translated === value) continue;
					const translated = translateStaticText(value, EN);
					if (translated !== value) {
						const changes = attributeChanges.get(root) ?? new Map();
						changes.set(attribute, { source: value, translated });
						attributeChanges.set(root, changes);
						root.setAttribute(attribute, translated);
					}
				}
			}
			for (const child of root.childNodes) localize(child);
		};
		localize(document.body);
		const observer = new MutationObserver((records) => {
			for (const record of records) {
				if (record.type === "characterData") localize(record.target);
				for (const node of record.addedNodes) localize(node);
				if (record.type === "attributes") localize(record.target);
			}
		});
		observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...attributes] });
		return () => {
			observer.disconnect();
			for (const [node, change] of textChanges) {
				if (node.textContent === change.translated) node.textContent = change.source;
			}
			for (const [element, changes] of attributeChanges) {
				for (const [attribute, change] of changes) {
					if (element.getAttribute(attribute) === change.translated) element.setAttribute(attribute, change.source);
				}
			}
		};
	}, [locale]);

	const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
	return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
	const value = useContext(I18nContext);
	if (!value) throw new Error("useI18n must be used within I18nProvider");
	return value;
}
