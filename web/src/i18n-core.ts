export type TranslationCatalog = Readonly<Record<string, string>>;

const normalizedCatalogs = new WeakMap<object, ReadonlyMap<string, string>>();
const sortedCatalogs = new WeakMap<object, ReadonlyArray<readonly [string, string]>>();
const HAN = /[\u3400-\u9fff\uf900-\ufaff]/u;

function normalizedCatalog(catalog: TranslationCatalog): ReadonlyMap<string, string> {
	const cached = normalizedCatalogs.get(catalog);
	if (cached) return cached;
	const normalized = new Map(Object.entries(catalog).map(([key, value]) => [key.trim().replace(/\s+/gu, " "), value]));
	normalizedCatalogs.set(catalog, normalized);
	return normalized;
}

export function translateStaticText(source: string, catalog: TranslationCatalog): string {
	const leading = source.match(/^\s*/u)?.[0] ?? "";
	const trailing = source.match(/\s*$/u)?.[0] ?? "";
	const value = source.slice(leading.length, source.length - trailing.length);
	const translated = catalog[value] ?? normalizedCatalog(catalog).get(value.replace(/\s+/gu, " "));
	if (translated) return `${leading}${translated}${trailing}`;
	if (!HAN.test(value)) return source;
	let entries = sortedCatalogs.get(catalog);
	if (!entries) {
		entries = Object.entries(catalog).filter(([key]) => HAN.test(key)).sort(([a], [b]) => b.length - a.length);
		sortedCatalogs.set(catalog, entries);
	}
	let composed = value;
	for (const [key, replacement] of entries) {
		if (composed.includes(key)) composed = composed.split(key).join(replacement);
	}
	if (composed === value || HAN.test(composed)) return source;
	composed = composed.replaceAll("（", "(").replaceAll("）", ")").replaceAll("，", ", ").replaceAll("：", ": ").replaceAll("；", "; ");
	return `${leading}${composed}${trailing}`;
}
