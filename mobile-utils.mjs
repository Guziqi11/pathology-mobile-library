const PREFERENCE_KEY = "pathology-mobile-preferences-v1";
const EXTERNAL_RETURN_KEY = "pathology-mobile-external-return-v1";
const EXTERNAL_RETURN_MAX_AGE_MS = 30 * 60 * 1000;

export const MOBILE_PREFERENCE_KEY = PREFERENCE_KEY;
export const MOBILE_EXTERNAL_RETURN_KEY = EXTERNAL_RETURN_KEY;

export function catalogCompatibility(payload, currentVersion = 6, minimumVersion = 5) {
  const version = Number(payload?.schemaVersion);
  const structurallyUsable = Boolean(
    Number.isInteger(version)
    && payload?.tnm
    && Array.isArray(payload.tnm.schemes)
    && Array.isArray(payload.diseases)
    && Array.isArray(payload.cases),
  );
  if (!structurallyUsable || version > currentVersion || version < minimumVersion) return "incompatible";
  return version === currentVersion ? "current" : "compatible";
}

export function writeExternalReturn(storage, hash, scrollY, savedAt = Date.now()) {
  if (!storage) return false;
  const value = {
    hash: String(hash || "#/"),
    scrollY: Number.isFinite(Number(scrollY)) ? Math.max(0, Math.round(Number(scrollY))) : 0,
    savedAt: Number.isFinite(Number(savedAt)) ? Number(savedAt) : Date.now(),
  };
  try { storage.setItem(EXTERNAL_RETURN_KEY, JSON.stringify(value)); return true; }
  catch { return false; }
}

export function readExternalReturn(storage, hash, now = Date.now()) {
  try {
    const value = JSON.parse(storage?.getItem(EXTERNAL_RETURN_KEY) || "null");
    const age = Number(now) - Number(value?.savedAt);
    if (!value || value.hash !== String(hash || "#/") || !Number.isFinite(value.scrollY) || !Number.isFinite(age) || age < 0 || age > EXTERNAL_RETURN_MAX_AGE_MS) return null;
    return { hash: value.hash, scrollY: Math.max(0, Math.round(value.scrollY)), savedAt: value.savedAt };
  } catch { return null; }
}

export function clearExternalReturn(storage) {
  try { storage?.removeItem(EXTERNAL_RETURN_KEY); }
  catch { /* 存储不可用时不影响浏览。 */ }
}

export function normalizeSearch(value = "") {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function parseHomeState(hash = "#/") {
  const value = String(hash || "#/").replace(/^#\/?/, "");
  const [pathname, query = ""] = value.split("?");
  const params = new URLSearchParams(query);
  if (pathname === "tnm") return { route: "home", tab: "tnm", q: params.get("q") || "", system: params.get("system") || "" };
  if (pathname && !pathname.startsWith("?")) return { route: "detail", kind: pathname.split("/")[0], id: pathname.split("/").slice(1).join("/") };
  const tab = ["diseases", "cases", "tnm"].includes(params.get("tab")) ? params.get("tab") : "diseases";
  return { route: "home", tab, q: params.get("q") || "", system: params.get("system") || "" };
}

export function serializeHomeHash({ tab = "diseases", q = "", system = "" } = {}) {
  const params = new URLSearchParams();
  if (tab === "tnm") {
    if (q) params.set("q", q);
    if (system) params.set("system", system);
    const query = params.toString();
    return `#/tnm${query ? `?${query}` : ""}`;
  }
  params.set("tab", tab === "cases" ? "cases" : "diseases");
  if (q) params.set("q", q);
  if (system) params.set("system", system);
  return `#/?${params.toString()}`;
}

export function detailHash(kind, id) {
  return `#/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`;
}

export function searchSnippet(text, query, maxChars = 120) {
  const source = String(text || "").replace(/\s+/gu, " ").trim();
  if (!source) return "";
  const needle = normalizeSearch(query);
  if (!needle) return source.slice(0, maxChars);
  const haystack = normalizeSearch(source);
  const index = haystack.indexOf(needle);
  if (index < 0) return source.slice(0, maxChars);
  const radius = Math.max(24, Math.floor((maxChars - needle.length) / 2));
  const start = Math.max(0, index - radius);
  const end = Math.min(source.length, index + needle.length + radius);
  return `${start > 0 ? "…" : ""}${source.slice(start, end)}${end < source.length ? "…" : ""}`;
}

// 短英文标记按完整词匹配，避免 ER 命中 HER2、PR 命中表达式中的普通片段。
function normalizedIncludes(text, query) {
  const haystack = normalizeSearch(text);
  const needle = normalizeSearch(query);
  if (!needle) return false;
  if (/^[a-z0-9 ]+$/u.test(needle)) {
    const compactNeedle = needle.replaceAll(" ", "");
    if (compactNeedle.length <= 3) return new RegExp(`(^|[^a-z0-9])${compactNeedle}(?=$|[^a-z0-9])`, "u").test(haystack);
    return haystack.replaceAll(" ", "").includes(compactNeedle);
  }
  return haystack.includes(needle);
}

export function scoreSearchItem(item, query) {
  const needle = normalizeSearch(query);
  if (!needle) return 0;
  const title = normalizeSearch(item?.title);
  const id = normalizeSearch(item?.id);
  const aliases = (item?.aliases || []).map(normalizeSearch);
  let score = 0;
  if (title === needle) score = 1000;
  else if (aliases.includes(needle)) score = 920;
  else if (id === needle) score = 860;
  else if (title.startsWith(needle)) score = 760;
  else if (aliases.some((value) => value.startsWith(needle))) score = 700;
  else if (normalizedIncludes(title, needle)) score = 640;
  else if (aliases.some((value) => normalizedIncludes(value, needle))) score = 600;

  const fieldWeights = { name: 620, ihc: 520, molecular: 480, microscopy: 440, diagnosisFormula: 420, id: 380, clinical: 260, gross: 240, definition: 220 };
  for (const field of item?.fields || []) {
    if (!normalizedIncludes(field?.text, needle)) continue;
    score = Math.max(score, fieldWeights[field.key] || 180);
  }
  return score;
}

export function rankSearchItems(items, query) {
  return (items || []).map((item, order) => ({ item, order, score: scoreSearchItem(item, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || String(a.item?.title || "").localeCompare(String(b.item?.title || ""), "zh-CN") || a.order - b.order)
    .map((entry) => entry.item);
}

export function defaultPreferences() {
  return { favorites: { diseases: [], cases: [], tnm: [] }, recent: [] };
}

export const PREFERENCES_EXPORT_FORMAT = "pathology-library-preferences";
export const PREFERENCES_EXPORT_VERSION = 1;

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** 生成收藏与最近的完整替换包，导入时不会与当前内容隐式混合。 */
export function createPreferencesExport(value, exportedAt = new Date().toISOString()) {
  return {
    format: PREFERENCES_EXPORT_FORMAT,
    version: PREFERENCES_EXPORT_VERSION,
    mode: "replace",
    exportedAt: String(exportedAt),
    preferences: normalizePreferences(value),
  };
}

/**
 * 严格校验收藏与最近导入包。旧版没有 mode/exportedAt 字段的 v1 包仍按替换语义兼容，
 * 但未知格式、版本或结构不会再被 normalizePreferences 静默转换为空内容。
 */
export function parsePreferencesExport(value) {
  let payload;
  try { payload = typeof value === "string" ? JSON.parse(value) : value; }
  catch (error) { throw new Error(`收藏与最近导入文件格式不正确：${error.message}`); }
  if (!isRecord(payload) || payload.format !== PREFERENCES_EXPORT_FORMAT || payload.version !== PREFERENCES_EXPORT_VERSION) {
    throw new Error("收藏与最近导入文件的格式或版本不受支持");
  }
  if (payload.mode !== undefined && payload.mode !== "replace") throw new Error("收藏与最近导入文件的替换模式不受支持");
  if (payload.exportedAt !== undefined && typeof payload.exportedAt !== "string") throw new Error("收藏与最近导入文件缺少有效导出时间");
  const candidate = payload.preferences;
  if (!isRecord(candidate) || !isRecord(candidate.favorites) || !Array.isArray(candidate.recent)) {
    throw new Error("收藏与最近导入文件的偏好结构不完整");
  }
  for (const key of ["diseases", "cases", "tnm"]) {
    if (!Array.isArray(candidate.favorites[key]) || candidate.favorites[key].length > 100) throw new Error(`收藏与最近导入文件的${key}收藏结构不正确`);
    if (candidate.favorites[key].some((item) => typeof item !== "string" || !item.trim())) throw new Error(`收藏与最近导入文件的${key}收藏包含无效编号`);
  }
  if (candidate.recent.length > 20 || candidate.recent.some((item) => !isRecord(item) || !["disease", "case", "tnm"].includes(item.type) || typeof item.id !== "string" || !item.id.trim() || typeof item.viewedAt !== "string")) {
    throw new Error("收藏与最近导入文件的最近记录结构不正确");
  }
  return normalizePreferences(candidate);
}

export function normalizePreferences(value) {
  const fallback = defaultPreferences();
  if (!value || typeof value !== "object") return fallback;
  const favorites = value.favorites && typeof value.favorites === "object" ? value.favorites : {};
  const list = (entry) => Array.isArray(entry) ? [...new Set(entry.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()))].slice(0, 100) : [];
  const recent = [];
  const seen = new Set();
  for (const item of Array.isArray(value.recent) ? value.recent : []) {
    if (!item || typeof item !== "object" || !["disease", "case", "tnm"].includes(item.type) || typeof item.id !== "string" || !item.id.trim()) continue;
    const id = item.id.trim(), key = `${item.type}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    recent.push({ type: item.type, id, viewedAt: typeof item.viewedAt === "string" ? item.viewedAt : "" });
    if (recent.length >= 20) break;
  }
  return { favorites: { diseases: list(favorites.diseases), cases: list(favorites.cases), tnm: list(favorites.tnm) }, recent };
}

export function readPreferences(storage) {
  try { return normalizePreferences(JSON.parse(storage?.getItem(PREFERENCE_KEY) || "null")); }
  catch { return defaultPreferences(); }
}

export function writePreferences(storage, value) {
  if (!storage) return false;
  try { storage.setItem(PREFERENCE_KEY, JSON.stringify(normalizePreferences(value))); return true; }
  catch { return false; }
}

// 公开静态站与原生端共用的资料读取协议。原生端在启动前注册工厂，浏览器端继续使用静态 JSON。
function repositoryStorage(value) {
  if (value !== undefined) return value;
  try { return globalThis.localStorage || null; } catch { return null; }
}

function repositoryFetch(value) {
  if (typeof value === "function") return value;
  if (typeof globalThis.fetch === "function") return globalThis.fetch.bind(globalThis);
  throw new Error("当前运行环境不支持公开资料读取");
}

function repositoryDirectory(kind) {
  if (kind === "disease") return "diseases";
  if (kind === "case") return "cases";
  if (kind === "tnm") return "tnm";
  throw new Error(`未知资料类型：${kind}`);
}

export function createStaticLibraryRepository({ fetchImpl, storage, dataVersion = "", baseUrl = "" } = {}) {
  const requestFetch = repositoryFetch(fetchImpl);
  const preferenceStorage = repositoryStorage(storage);
  const version = String(dataVersion || "");
  const root = String(baseUrl || "");
  const assetUrl = (resource) => {
    const value = String(resource || "");
    const relative = root && !/^(?:[a-z]+:)?\/\//iu.test(value) ? `${root.replace(/\/$/u, "")}/${value.replace(/^\//u, "")}` : value;
    return version && !/^(?:[a-z]+:)?\/\//iu.test(relative) ? `${relative}${relative.includes("?") ? "&" : "?"}v=${encodeURIComponent(version)}` : relative;
  };
  const freshAssetUrl = (resource) => {
    const value = assetUrl(resource);
    return `${value}${value.includes("?") ? "&" : "?"}refresh=${Date.now()}`;
  };
  async function requestJson(resource, { force = false } = {}) {
    const response = await requestFetch(force ? freshAssetUrl(resource) : assetUrl(resource), { cache: force ? "reload" : "default" });
    if (!response?.ok) throw new Error(`公开资料请求失败（${response?.status || "网络错误"}）`);
    return response.json();
  }
  return {
    mode: "static",
    isNative: false,
    canRegisterServiceWorker: true,
    assetUrl,
    freshAssetUrl,
    loadCatalog: (force = false) => requestJson("catalog.json", { force }),
    loadDetail: (kind, id) => requestJson(`${repositoryDirectory(kind)}/${encodeURIComponent(id)}.json`),
    loadSearchIndex: (type) => requestJson(`search/${type}.json`),
    loadDiseaseShard: (resource) => requestJson(resource),
    getShareUrl: async (currentUrl) => String(currentUrl || ""),
    readPreferences: async () => readPreferences(preferenceStorage),
    writePreferences: async (value) => writePreferences(preferenceStorage, value),
    exportPreferences: async () => createPreferencesExport(readPreferences(preferenceStorage)),
    importPreferences: async (value) => {
      const normalized = parsePreferencesExport(value);
      writePreferences(preferenceStorage, normalized);
      return normalized;
    },
    savePreferencesExport: async () => null,
    openExternal: async (url) => {
      if (typeof globalThis.open !== "function") return false;
      globalThis.open(String(url), "_blank", "noopener,noreferrer");
      return true;
    },
    share: async (payload) => {
      if (typeof globalThis.navigator?.share !== "function") return false;
      await globalThis.navigator.share(payload);
      return true;
    },
    onBackButton: () => null,
    onResume: () => null,
    clearCache: async () => {
      if (!("caches" in globalThis)) return false;
      const keys = await globalThis.caches.keys();
      await Promise.all(keys.filter((key) => key.startsWith("pathology-mobile-")).map((key) => globalThis.caches.delete(key)));
      return true;
    },
  };
}

export function createLibraryRepository(options = {}) {
  const factory = globalThis.__PATHOLOGY_NATIVE_REPOSITORY_FACTORY__;
  if (typeof factory === "function") return factory(options);
  return createStaticLibraryRepository(options);
}
