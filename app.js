import {
  catalogCompatibility,
  clearExternalReturn,
  detailHash,
  MOBILE_PREFERENCE_KEY,
  normalizePreferences,
  normalizeSearch,
  parseHomeState,
  rankSearchItems,
  readExternalReturn,
  readPreferences,
  searchSnippet,
  serializeHomeHash,
  writeExternalReturn,
  writePreferences,
} from "./mobile-utils.mjs?v=mtk8autp";

(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));
  const allowedRichTags = new Set(["P", "BR", "STRONG", "B", "EM", "I", "U", "MARK", "UL", "OL", "LI", "BLOCKQUOTE", "A", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD", "H3"]);
  function sanitizeRichHtml(value = "") {
    const template = document.createElement("template");
    template.innerHTML = String(value);
    [...template.content.querySelectorAll("*")].forEach((node) => {
      if (!allowedRichTags.has(node.tagName)) { node.replaceWith(...node.childNodes); return; }
      [...node.attributes].forEach((attribute) => { if (!(node.tagName === "A" && attribute.name === "href")) node.removeAttribute(attribute.name); });
      if (node.tagName !== "A") return;
      let href = "";
      try {
        const url = new URL(node.getAttribute("href") || "");
        if (url.protocol === "https:" && !url.username && !url.password) href = url.href;
      } catch {}
      if (!href) node.removeAttribute("href");
      else {
        node.setAttribute("href", href);
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer external");
      }
    });
    return template.innerHTML;
  }
  function richFieldHtml(source, field) {
    const rich = source?.rich?.[field];
    if (typeof rich === "string" && rich.trim()) return sanitizeRichHtml(rich);
    return `<p>${escapeHtml(source?.[field] || "").replace(/\r?\n/g, "<br>")}</p>`;
  }
  const escapeRegExp = (value = "") => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const cardLabels = { definition: "定义", clinical: "临床特点", gross: "大体特征", microscopy: "镜下特点", diagnosisFormula: "诊断公式", ihc: "IHC", molecular: "必要分子" };
  const caseLabels = { clinical: "临床特点", gross: "大体特征", microscopy: "镜下表现", differential: "鉴别诊断", ihc: "免疫组化", molecular: "分子检测" };
  const statusLabels = { applicable: "可直接查", "select-site": "需选部位", "not-applicable": "不适用", "other-system": "其他体系" };
  const EXPECTED_SCHEMA_VERSION = 6;
  const MINIMUM_SCHEMA_VERSION = 5;
  const dataVersion = "mtk8autp";
  const hasDataVersion = dataVersion[0] !== "_";
  const scrollKeyPrefix = `pathology-mobile-scroll:${dataVersion}:`;
  const storage = (() => { try { return window.localStorage; } catch { return null; } })();
  const sessionStorage = (() => { try { return window.sessionStorage; } catch { return null; } })();

  let data = { diseases: [], cases: [], tnm: { meta: {}, schemes: [], diseaseMap: {} } };
  let tab = "diseases";
  let homeState = { tab: "diseases", q: "", system: "" };
  let detailParent = "#/";
  let routeToken = 0;
  let restoringScroll = false;
  let searchTimer = null;
  let searchRequested = false;
  let searchLoading = false;
  let searchErrors = [];
  let searchScope = "all";
  let diseaseShards = {};
  let diseaseFullRequested = false;
  const detailCache = new Map();
  const searchIndexes = new Map();
  const searchIndexRequests = new Map();
  const diseaseFullItems = new Map();
  const diseaseShardRequests = new Map();
  let preferences = readPreferences(storage);
  let gallery = [];
  let galleryIndex = 0;
  let galleryScale = 1;
  let galleryTranslate = { x: 0, y: 0 };
  const galleryPointers = new Map();
  let pinchStartDistance = 0;
  let pinchStartScale = 1;
  let swipeStart = null;

  if ("scrollRestoration" in history) history.scrollRestoration = "manual";

  function assetUrl(resource) {
    return hasDataVersion ? `${resource}${resource.includes("?") ? "&" : "?"}v=${encodeURIComponent(dataVersion)}` : resource;
  }
  function freshAssetUrl(resource) {
    const versioned = assetUrl(resource);
    return `${versioned}${versioned.includes("?") ? "&" : "?"}refresh=${Date.now()}`;
  }
  function catalogState(payload) { return catalogCompatibility(payload, EXPECTED_SCHEMA_VERSION, MINIMUM_SCHEMA_VERSION); }
  async function fetchCatalog(force = false) {
    const response = await fetch(force ? freshAssetUrl("catalog.json") : assetUrl("catalog.json"), { cache: force ? "reload" : "default" });
    if (!response.ok) throw new Error(`资料目录请求失败（${response.status}）`);
    return response.json();
  }
  async function updateServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    try { await (await navigator.serviceWorker.getRegistration())?.update(); } catch {}
  }
  async function loadCatalog() {
    let payload = await fetchCatalog();
    const cachedState = catalogState(payload);
    if (cachedState === "current") return payload;
    // 旧 Service Worker、CDN 或浏览器缓存可能暂时返回上一版目录，先更新并用一次性参数重取。
    await updateServiceWorker();
    try {
      const refreshed = await fetchCatalog(true);
      if (catalogState(refreshed) !== "incompatible") return refreshed;
    } catch (error) {
      // 网络刷新失败时，仍允许使用结构兼容的上一版公开资料。
      if (cachedState !== "compatible") throw error;
    }
    if (cachedState === "compatible") return payload;
    throw new Error("公开资料格式暂不兼容，请点击“重新读取公开资料”");
  }
  async function retryLoad() {
    const button = $("#refresh-data-button");
    if (button) { button.disabled = true; button.textContent = "正在重新读取…"; }
    try {
      await updateServiceWorker();
      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(keys.filter((key) => key.startsWith("pathology-mobile-")).map((key) => caches.delete(key)));
      }
    } finally {
      location.reload();
    }
  }

  function typeKey(kind) { return kind === "disease" ? "diseases" : kind === "case" ? "cases" : "tnm"; }
  function typeLabel(kind) { return kind === "disease" ? "病种" : kind === "case" ? "病例" : "TNM"; }
  function sourceRows(type) { return type === "tnm" ? data.tnm.schemes : data[type] || []; }
  function currentQuery() { return normalizeSearch(homeState.q); }
  function indexText(item) { return (item?.fields || []).map((field) => field?.text || "").join(" "); }
  function hasPendingDiseaseShards() { return Object.keys(diseaseShards).some((system) => !diseaseShardRequests.has(system)); }

  function searchText(item, type) {
    if (type === "diseases") return normalizeSearch([item.id, item.name, item.system, item.tier, item.mastery, item.frequency].join(" "));
    if (type === "tnm") return normalizeSearch([item.id, item.title, item.system, item.site, item.histology, item.exclusions, item.ajccEdition, item.capProtocol, item.capVersion].join(" "));
    return normalizeSearch([item.publicId, item.diseaseName, item.diseaseId, item.system, item.caseType, ...(item.tags || []), item.clinical, item.gross, item.microscopy, item.differential, item.ihc, item.molecular].join(" "));
  }

  function currentRows(type = tab) {
    const query = currentQuery();
    return sourceRows(type).filter((item) => (!query || searchText(item, type).includes(query)) && (!homeState.system || item.system === homeState.system));
  }

  function syncHomeInputs() {
    $("#search").value = homeState.q;
    syncTabUi();
    syncSystemFilter();
  }

  function syncTabUi() {
    const searching = Boolean(currentQuery());
    const definitions = searching
      ? [["all", "全部"], ["diseases", "病种"], ["cases", "病例"], ["tnm", "TNM"]]
      : [["diseases", "病种库"], ["cases", "精选病例"], ["tnm", "TNM分期"]];
    $("#content-tabs").innerHTML = definitions.map(([value, label]) => `<button class="${(searching ? searchScope : tab) === value ? "active" : ""}" data-tab="${value}">${label}</button>`).join("");
    $("#content-tabs").setAttribute("aria-label", searching ? "搜索结果筛选" : "资料分类");
  }

  function syncSystemFilter() {
    const types = currentQuery() && searchScope === "all" ? ["diseases", "cases", "tnm"] : [currentQuery() ? searchScope : tab];
    const systems = [...new Set(types.flatMap((type) => sourceRows(type).map((item) => item.system)).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
    if (homeState.system && !systems.includes(homeState.system)) homeState.system = "";
    $("#system-filter").innerHTML = `<option value="">全部系统</option>${systems.map((value) => `<option value="${escapeHtml(value)}" ${value === homeState.system ? "selected" : ""}>${escapeHtml(value)}</option>`).join("")}`;
  }

  function rememberScroll(hash = location.hash) {
    if (!sessionStorage || restoringScroll || parseHomeState(hash).route !== "home") return;
    const parsed = parseHomeState(hash), keyHash = serializeHomeHash(parsed);
    try { sessionStorage.setItem(`${scrollKeyPrefix}${keyHash}`, String(Math.round(window.scrollY))); } catch { /* 存储不可用时不影响浏览。 */ }
  }

  function restoreScroll(hash, explicitValue) {
    let value = Number.isFinite(explicitValue) ? explicitValue : 0;
    if (!Number.isFinite(explicitValue) && sessionStorage) {
      const parsed = parseHomeState(hash), keyHash = parsed.route === "home" ? serializeHomeHash(parsed) : (hash || "#/");
      try { value = Number(sessionStorage.getItem(`${scrollKeyPrefix}${keyHash}`) || 0); } catch { value = 0; }
    }
    restoringScroll = true;
    requestAnimationFrame(() => {
      window.scrollTo(0, Number.isFinite(value) ? value : 0);
      requestAnimationFrame(() => { restoringScroll = false; });
    });
  }

  function rememberExternalReturn() {
    writeExternalReturn(sessionStorage, location.hash || "#/", window.scrollY);
  }

  function restoreExternalReturn() {
    const value = readExternalReturn(sessionStorage, location.hash || "#/");
    if (!value) return false;
    restoringScroll = true;
    requestAnimationFrame(() => {
      window.scrollTo(0, value.scrollY);
      requestAnimationFrame(() => {
        restoringScroll = false;
        clearExternalReturn(sessionStorage);
      });
    });
    return true;
  }

  function writeHomeUrl({ replace = true } = {}) {
    rememberScroll();
    const hash = serializeHomeHash(homeState);
    if (location.hash === hash) return hash;
    const state = { ...(history.state || {}), homeState: { ...homeState }, scrollY: window.scrollY, route: "home" };
    if (replace) history.replaceState(state, "", hash);
    else history.pushState(state, "", hash);
    return hash;
  }

  function navigateTo(hash) {
    clearExternalReturn(sessionStorage);
    const parentHash = location.hash || serializeHomeHash(homeState);
    rememberScroll(parentHash);
    history.pushState({ ...(history.state || {}), parentHash, homeState: { ...homeState }, scrollY: window.scrollY, route: "detail" }, "", hash);
    route();
  }

  function goBack() {
    clearExternalReturn(sessionStorage);
    if (history.state?.parentHash) return history.back();
    const target = detailParent && parseHomeState(detailParent).route === "home" ? detailParent : "#/";
    const parsed = parseHomeState(target);
    history.replaceState({ route: "home", homeState: { tab: parsed.tab, q: parsed.q, system: parsed.system }, scrollY: 0 }, "", target);
    route();
  }

  function setTab(nextTab, { updateUrl = true } = {}) {
    tab = ["diseases", "cases", "tnm"].includes(nextTab) ? nextTab : "diseases";
    homeState.tab = tab;
    document.querySelectorAll("[data-tab]").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
    syncSystemFilter();
    if (updateUrl) writeHomeUrl();
    renderHome();
  }

  function setSearchScope(nextScope) {
    searchScope = ["all", "diseases", "cases", "tnm"].includes(nextScope) ? nextScope : "all";
    syncTabUi();
    syncSystemFilter();
    renderHome();
  }

  function highlight(text, query) {
    const source = String(text || "");
    const needle = String(query || "").trim();
    if (!needle) return escapeHtml(source);
    const pattern = new RegExp(escapeRegExp(needle), "giu");
    let cursor = 0, html = "";
    for (const match of source.matchAll(pattern)) {
      html += escapeHtml(source.slice(cursor, match.index));
      html += `<mark>${escapeHtml(match[0])}</mark>`;
      cursor = match.index + match[0].length;
    }
    return html ? html + escapeHtml(source.slice(cursor)) : escapeHtml(source);
  }

  function itemSnippet(item, query) {
    const fields = (item.fields || []).filter((field) => field && field.text);
    const normalized = normalizeSearch(query);
    const alias = (item.aliases || []).find((value) => normalizeSearch(value).includes(normalized));
    if (alias) return `<small class="search-hit"><b>别名</b>：${highlight(alias, query)}</small>`;
    const field = fields.find((value) => normalizeSearch(value.text).includes(normalized)) || fields[0];
    if (!field) return "";
    return `<small class="search-hit"><b>${escapeHtml(field.label || "命中内容")}</b>：${highlight(searchSnippet(field.text, query, 120), query)}</small>`;
  }

  function normalizeIndexPayload(payload, type) {
    const expectedSchemaVersion = Number(data?.schemaVersion);
    if (!expectedSchemaVersion || Number(payload?.schemaVersion) !== expectedSchemaVersion) throw new Error(`${type} 搜索索引版本过旧`);
    if (Array.isArray(payload?.items)) return payload.items;
    if (payload?.index && typeof payload.index === "object") return Object.entries(payload.index).map(([id, text]) => ({ id, title: id, system: "", aliases: [], fields: [{ key: "text", label: "全文", text }] }));
    throw new Error(`${type} 搜索索引格式不正确`);
  }

  async function loadSearchIndex(type) {
    if (searchIndexes.has(type)) return searchIndexes.get(type);
    if (!searchIndexRequests.has(type)) {
      const request = fetch(assetUrl(`search/${type}.json`), { cache: "default" }).then((response) => {
        if (!response.ok) throw new Error(`搜索索引请求失败（${response.status}）`);
        return response.json();
      }).then((payload) => {
        if (type === "diseases") diseaseShards = payload?.shards && typeof payload.shards === "object" ? payload.shards : {};
        return normalizeIndexPayload(payload, type);
      });
      searchIndexRequests.set(type, request);
    }
    try {
      const index = await searchIndexRequests.get(type);
      searchIndexes.set(type, index);
      return index;
    } catch (error) {
      searchIndexRequests.delete(type);
      throw error;
    }
  }


  async function loadDiseaseFullSearch(queryAtRequest, { force = false } = {}) {
    if (!queryAtRequest || !Object.keys(diseaseShards).length) return;
    const systems = (homeState.system ? [homeState.system] : Object.keys(diseaseShards)).filter((system) => diseaseShards[system]);
    const pending = systems.filter((system) => !diseaseShardRequests.has(system));
    if (!pending.length) return;
    diseaseFullRequested = true;
    searchLoading = true;
    renderHome();
    const results = await Promise.all(pending.map(async (system) => {
      const request = fetch(assetUrl(diseaseShards[system]), { cache: "default" }).then((response) => {
        if (!response.ok) throw new Error(`病种正文索引请求失败（${response.status}）`);
        return response.json();
      }).then((payload) => normalizeIndexPayload(payload, "diseases"));
      diseaseShardRequests.set(system, request);
      try { return { system, items: await request }; }
      catch (error) { diseaseShardRequests.delete(system); return { system, error }; }
    }));
    for (const result of results) for (const item of result.items || []) diseaseFullItems.set(item.id, item);
    if (results.some((result) => result.error)) searchErrors.push("部分病种正文索引暂时不可用");
    searchLoading = false;
    if (force || currentQuery() === normalizeSearch(queryAtRequest)) renderHome();
  }

  async function loadAllSearchIndexes(queryAtRequest) {
    if (!queryAtRequest || searchLoading) return;
    searchRequested = true;
    searchLoading = true;
    searchErrors = [];
    renderHome();
    const results = await Promise.all(["diseases", "cases", "tnm"].map(async (type) => {
      try { return { type, items: await loadSearchIndex(type) }; }
      catch (error) { return { type, error }; }
    }));
    searchErrors = results.filter((result) => result.error).map((result) => `${typeLabel(result.type === "diseases" ? "disease" : result.type === "cases" ? "case" : "tnm")}搜索索引暂时不可用`);
    searchLoading = false;
    if (currentQuery() === normalizeSearch(queryAtRequest)) renderHome();
  }

  function scheduleGlobalSearch() {
    clearTimeout(searchTimer);
    if (!currentQuery()) {
      searchRequested = false;
      searchErrors = [];
      searchScope = "all";
      diseaseFullRequested = false;
      return;
    }
    searchTimer = setTimeout(() => { loadAllSearchIndexes(homeState.q); }, 180);
  }

  function renderBasicLists() {
    const rows = currentRows();
    const unit = tab === "diseases" ? "项病种" : tab === "cases" ? "例精选病例" : "个 pTNM 方案";
    $("#result-summary").textContent = `${rows.length} ${unit}`;
    $("#disease-list").classList.toggle("hidden", tab !== "diseases");
    $("#case-list").classList.toggle("hidden", tab !== "cases");
    $("#tnm-list").classList.toggle("hidden", tab !== "tnm");
    $("#global-results").classList.add("hidden");
    $("#tnm-notice").classList.toggle("hidden", tab !== "tnm");
    if (tab === "diseases") $("#disease-list").innerHTML = rows.length ? rows.map((item) => `<a class="disease-row" href="${detailHash("disease", item.id)}"><strong>${escapeHtml(item.id)}</strong><span>${escapeHtml(item.name)}</span><small class="system">${escapeHtml(item.system)}</small><span class="badge">${escapeHtml(item.tier)}级</span></a>`).join("") : `<div class="empty">没有匹配的病种。</div>`;
    if (tab === "cases") $("#case-list").innerHTML = rows.length ? rows.map((item) => {
      const image = item.coverImage || item.images?.[0]?.src, imageCount = item.imageCount ?? item.images?.length ?? 0;
      return `<a class="case-card" href="${detailHash("case", item.publicId)}"><div class="case-cover">${image ? `<img src="${escapeHtml(assetUrl(image))}" alt="${escapeHtml(item.diseaseName)}" loading="lazy" decoding="async" />` : ""}<span>${imageCount} 张图片</span></div><div class="case-card-body"><small class="meta">${escapeHtml(item.system || "未分类")} · ${escapeHtml(item.caseType || "组织学")}</small><h3>${escapeHtml(item.diseaseName)}</h3><p>${escapeHtml(item.microscopy || item.clinical || "查看病例要点")}</p><div class="tag-row">${item.slideUrl ? `<span class="slide-tag">电子切片</span>` : ""}${(item.tags || []).map((value) => `<span>${escapeHtml(value)}</span>`).join("")}</div></div></a>`;
    }).join("") : `<div class="empty">没有匹配的精选病例。</div>`;
    if (tab === "tnm") $("#tnm-list").innerHTML = rows.length ? rows.map((item) => `<a class="tnm-row" href="${detailHash("tnm", item.id)}"><span><b>${escapeHtml(item.title)}</b><small>${escapeHtml(item.site)} · ${escapeHtml(item.system)}</small></span><em>${escapeHtml(item.ajccEdition)}</em></a>`).join("") : `<div class="empty">没有匹配的 TNM 方案。</div>`;
  }

  function renderGlobalResults() {
    const query = currentQuery();
    const loaded = ["diseases", "cases", "tnm"].flatMap((type) => (searchIndexes.get(type) || []).map((item) => ({ ...item, ...(type === "diseases" ? diseaseFullItems.get(item.id) : {}), type })));
    const ranked = rankSearchItems(loaded.filter((item) => !homeState.system || item.system === homeState.system), query);
    const results = ranked.filter((item) => searchScope === "all" || item.type === searchScope);
    $("#disease-list").classList.add("hidden"); $("#case-list").classList.add("hidden"); $("#tnm-list").classList.add("hidden"); $("#tnm-notice").classList.add("hidden"); $("#global-results").classList.remove("hidden");
    const groups = [["diseases", "病种", "disease"], ["cases", "病例", "case"], ["tnm", "TNM", "tnm"]];
    $("#result-summary").textContent = `${results.length} 项结果`;
    const body = groups.map(([key, label, kind]) => {
      if (searchScope !== "all" && searchScope !== key) return "";
      const values = results.filter((item) => item.type === key);
      if (!values.length) return "";
      return `<section class="search-group"><h2>${label}<small>${values.length}</small></h2>${values.map((item) => `<a class="global-result" href="${detailHash(kind, item.id)}"><strong>${highlight(item.title || item.id, homeState.q)}</strong><small>${escapeHtml(item.system || "未分类")}</small>${itemSnippet(item, homeState.q)}</a>`).join("")}</section>`;
    }).join("");
    const fallback = searchErrors.length ? `<p class="search-warning" role="status">${escapeHtml(searchErrors.join("；"))}。已保留当前目录字段搜索。</p>` : "";
    const fullSearchAction = !searchLoading && !diseaseFullRequested && ["all", "diseases"].includes(searchScope) && hasPendingDiseaseShards()
      ? `<button class="search-full-button" data-search-full="true">继续搜索病种正文（按需加载）</button>` : "";
    $("#global-results").innerHTML = `${searchLoading ? `<p class="search-loading" role="status">正在加载搜索索引…</p>` : ""}${fallback}${body || (!searchLoading ? `<div class="empty">没有找到匹配的公开资料。</div>` : "")}${fullSearchAction}`;

    const diseaseMetadataMatches = rankSearchItems((searchIndexes.get("diseases") || []).filter((item) => !homeState.system || item.system === homeState.system), query);
    if (!searchLoading && !diseaseFullRequested && !diseaseMetadataMatches.length && hasPendingDiseaseShards()) loadDiseaseFullSearch(homeState.q);
  }

  function groupsLabel(type) { return type === "diseases" ? "病种" : type === "cases" ? "病例" : "TNM"; }

  function renderHome() {
    syncHomeInputs();
    if (currentQuery() && searchErrors.length && !searchLoading && searchIndexes.size < 3) {
      renderBasicLists();
      $("#result-summary").textContent += "（全库索引暂不可用，已使用当前目录字段搜索）";
      return;
    }
    if (currentQuery() && (searchRequested || searchLoading || searchIndexes.size)) renderGlobalResults();
    else renderBasicLists();
  }

  function sectionList(source, fields, names, prefix = "knowledge", defaults = []) {
    return fields.filter((field) => String(source?.[field] || "").trim() || String(source?.rich?.[field] || "").trim()).map((field) => `<details class="knowledge-section" id="${prefix}-${field}" ${defaults.includes(field) ? "open" : ""}><summary>${names[field]}</summary><div class="mobile-rich-content">${richFieldHtml(source, field)}</div></details>`).join("");
  }

  function medicalReviewBlock(item) {
    const review = item.medicalReview || {};
    const values = [
      review.reviewedAt && `最后医学复核：${review.reviewedAt}`,
      review.classificationEdition && `分类版本：${review.classificationEdition}`,
      review.primaryReference && `主要来源：${review.primaryReference}`,
    ].filter(Boolean);
    const body = values.length ? values : ["复核日期、主要来源与分类版本尚待补充"];
    return `<details class="medical-review${values.length ? "" : " pending"}"><summary>医学资料版本</summary><div>${body.map((value) => `<span>${escapeHtml(value)}</span>`).join("")}</div></details>`;
  }

  function detailToolbar(kind, id) {
    const key = typeKey(kind), favorite = preferences.favorites[key].includes(id);
    const foldActions = kind === "tnm" ? "" : `<div class="fold-actions"><button data-knowledge-toggle="open">全部展开</button><button data-knowledge-toggle="closed">全部收起</button></div>`;
    return `<div class="detail-toolbar"><div class="detail-actions"><button class="favorite-button" data-favorite-type="${kind}" data-favorite-id="${escapeHtml(id)}" aria-pressed="${favorite}">${favorite ? "★" : "☆"} 收藏</button><button class="share-button" data-share-detail="true">分享链接</button></div>${foldActions}</div>`;
  }

  function detailLoading(item) { return `<article class="detail-card"><div class="detail-meta">${escapeHtml(item.system || "未分类")}</div><h1>${escapeHtml(item.name || item.diseaseName || item.title)}</h1><p class="detail-loading">正在加载详细资料…</p></article>`; }
  function detailFailure(error) {
    const message = !navigator.onLine ? "当前处于离线状态，该资料尚未缓存。请联网访问一次后再试。" : (error.message || "请求失败");
    return `<article class="detail-card"><div class="empty"><h2>详细资料暂时无法读取</h2><p>${escapeHtml(message)}</p><button class="back-button" data-back-inline="true">返回</button></div></article>`;
  }

  function diseaseTnmBlock(item) {
    const mapping = data.tnm.diseaseMap?.[item.id];
    if (!mapping) return "";
    if (mapping.status === "applicable") return `<section class="tnm-jump"><h2>pTNM速查</h2><p>${escapeHtml(mapping.reason)}</p><a href="#/tnm/${encodeURIComponent(mapping.schemeId)}">查看对应TNM →</a></section>`;
    const candidates = (mapping.candidateSchemeIds || []).map((id) => data.tnm.schemes.find((value) => value.id === id)).filter(Boolean);
    return `<section class="tnm-jump ${escapeHtml(mapping.status)}"><h2>TNM适用性 · ${statusLabels[mapping.status]}</h2><p>${escapeHtml(mapping.reason)}</p>${candidates.map((value) => `<a href="#/tnm/${encodeURIComponent(value.id)}">${escapeHtml(value.title)} · ${escapeHtml(value.ajccEdition)} →</a>`).join("")}</section>`;
  }

  function showDetail() { $("#home-view").classList.add("hidden"); $("#detail-view").classList.remove("hidden"); window.scrollTo(0, 0); }
  function showHome() { $("#detail-view").classList.add("hidden"); $("#home-view").classList.remove("hidden"); renderHome(); }
  function isCurrentRoute(token, expectedHash) { return token === routeToken && location.hash === expectedHash; }

  function recordRecent(kind, id) {
    const item = { type: kind, id, viewedAt: new Date().toISOString() };
    preferences = normalizePreferences({ ...preferences, recent: [item, ...preferences.recent.filter((value) => !(value.type === kind && value.id === id))].slice(0, 20) });
    writePreferences(storage, preferences);
  }

  function toggleFavorite(kind, id) {
    const key = typeKey(kind), current = new Set(preferences.favorites[key]);
    if (current.has(id)) current.delete(id); else current.add(id);
    preferences = normalizePreferences({ ...preferences, favorites: { ...preferences.favorites, [key]: [...current] } });
    writePreferences(storage, preferences);
    const button = $$(`[data-favorite-type="${kind}"]`).find((item) => item.dataset.favoriteId === id);
    if (button) { const active = current.has(id); button.setAttribute("aria-pressed", String(active)); button.textContent = `${active ? "★" : "☆"} 收藏`; }
    renderPersonal();
  }

  function resolvePersonalItem(type, id) {
    if (type === "disease") { const item = data.diseases.find((value) => value.id === id); return item && { title: item.name, meta: item.system, hash: detailHash("disease", id) }; }
    if (type === "case") { const item = data.cases.find((value) => value.publicId === id); return item && { title: item.diseaseName, meta: item.system, hash: detailHash("case", id) }; }
    const item = data.tnm.schemes.find((value) => value.id === id); return item && { title: item.title, meta: item.system, hash: detailHash("tnm", id) };
  }

  function personalRows(kind, ids) {
    return ids.map((id) => { const item = resolvePersonalItem(kind, id); return item ? `<a class="personal-row" href="${escapeHtml(item.hash)}"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.meta || "未分类")}</small></a>` : ""; }).join("") || `<p class="personal-empty">暂无内容</p>`;
  }

  function renderPersonal() {
    const target = $("#personal-content");
    if (!target) return;
    const favorites = Object.entries(preferences.favorites).map(([key, ids]) => `<section><h3>收藏 · ${key === "diseases" ? "病种" : key === "cases" ? "病例" : "TNM"}</h3>${personalRows(key === "diseases" ? "disease" : key === "cases" ? "case" : "tnm", ids)}</section>`).join("");
    const recent = preferences.recent.map((value) => { const item = resolvePersonalItem(value.type, value.id); return item ? `<a class="personal-row" href="${escapeHtml(item.hash)}"><strong>${escapeHtml(item.title)}</strong><small>${typeLabel(value.type)} · ${escapeHtml(item.meta || "未分类")}</small></a>` : ""; }).join("") || `<p class="personal-empty">暂无最近查看</p>`;
    target.innerHTML = `${favorites}<section><h3>最近查看</h3>${recent}</section><small class="personal-note">仅保存在本机（${escapeHtml(MOBILE_PREFERENCE_KEY)}），不会上传病例信息。</small>`;
  }

  async function shareCurrent() {
    const url = new URL(location.href).href;
    try {
      if (navigator.share) await navigator.share({ title: document.title, url });
      else if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(url); showToast("链接已复制"); }
      else showToast(url);
    } catch (error) { if (error?.name !== "AbortError") showToast("分享失败，请复制地址栏链接"); }
  }

  function showToast(message) {
    const toast = $("#toast"); if (!toast) return;
    toast.textContent = message; toast.classList.add("visible"); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.remove("visible"), 2200);
  }

  async function loadDetail(kind, id) {
    const key = `${kind}:${id}`;
    if (detailCache.has(key)) return detailCache.get(key);
    const directory = kind === "disease" ? "diseases" : kind === "case" ? "cases" : "tnm";
    const request = fetch(assetUrl(`${directory}/${encodeURIComponent(id)}.json`), { cache: "default" }).then((response) => {
      if (!response.ok) throw new Error(`详细资料请求失败（${response.status}）`);
      return response.json();
    });
    detailCache.set(key, request);
    try { return await request; } catch (error) { detailCache.delete(key); throw error; }
  }

  function safeAtlasOriginalUrl(value) {
    try { const url = new URL(String(value || "").trim()); return url.protocol === "https:" && !url.username && !url.password ? url.href : ""; } catch { return ""; }
  }
  function microscopyAtlasHtml(images, diseaseName) {
    if (!images.length) return "";
    return '<section id="knowledge-microscopyImages" class="microscopy-atlas"><div class="microscopy-atlas-heading"><div><p class="eyebrow">MORPHOLOGY ATLAS</p><h2>镜下图谱</h2></div><span class="subtle">' + images.length + ' 张精选图</span></div><div class="microscopy-atlas-grid">' + images.map((image, index) => {
      const originalUrl = safeAtlasOriginalUrl(image.originalUrl), meta = [image.magnification, image.stain].filter(Boolean).join(" · ");
      const source = [image.source ? "来源：" + image.source : "", image.attribution ? "署名：" + image.attribution : ""].filter(Boolean).join(" · ");
      return '<article class="microscopy-atlas-card"><button type="button" class="microscopy-atlas-thumb" data-gallery="' + index + '" aria-label="查看' + escapeHtml(image.caption || diseaseName + "镜下图谱") + '"><img src="' + escapeHtml(assetUrl(image.src)) + '" alt="' + escapeHtml(image.caption || diseaseName + "镜下图谱") + '" loading="lazy" decoding="async" /></button><div class="microscopy-atlas-caption"><strong>' + escapeHtml(image.caption || "镜下图谱") + '</strong>' + (meta ? '<span>' + escapeHtml(meta) + '</span>' : "") + (image.keyFeatures ? '<p>' + escapeHtml(image.keyFeatures) + '</p>' : "") + (source ? '<small>' + escapeHtml(source) + '</small>' : "") + (originalUrl ? '<a href="' + escapeHtml(originalUrl) + '" target="_blank" rel="noopener noreferrer external">查看原始链接 ↗</a>' : "") + '</div></article>';
    }).join("") + '</div></section>';
  }
  async function renderDisease(id, token, expectedHash) {
    const base = data.diseases.find((value) => value.id === id); if (!base) return showHome();
    detailParent = history.state?.parentHash || serializeHomeHash(homeState); showDetail(); $("#detail").innerHTML = detailLoading(base);
    try {
      const item = { ...base, ...(await loadDetail("disease", id)) }; if (!isCurrentRoute(token, expectedHash)) return;
      recordRecent("disease", id);
      const microscopyImages = Array.isArray(item.card?.microscopyImages) ? [...item.card.microscopyImages].sort((a, b) => Number(a.order || 0) - Number(b.order || 0)) : [], atlas = microscopyAtlasHtml(microscopyImages, item.name);
      gallery = microscopyImages;
      const availableFields = Object.keys(cardLabels).filter((field) => String(item.card?.[field] || "").trim() || String(item.card?.rich?.[field] || "").trim());
      const knowledgeOrder = ["microscopy", "ihc", "molecular", "clinical", "gross", "definition"];
      const knowledgeFields = knowledgeOrder.filter((field) => availableFields.includes(field));
      const jumpLabels = knowledgeFields.map((field) => `<button type="button" data-scroll-target="knowledge-${field}">${cardLabels[field]}</button>`).join("");
      const diagnosis = item.card?.diagnosisFormula || item.card?.rich?.diagnosisFormula ? `<section class="diagnosis-priority" id="knowledge-diagnosisFormula"><h2>诊断公式</h2><div class="mobile-rich-content">${richFieldHtml(item.card, "diagnosisFormula")}</div></section>` : "";
      const knowledge = knowledgeFields.length ? `<div class="knowledge-grid">${sectionList(item.card, knowledgeFields, cardLabels, "knowledge", ["microscopy", "ihc"])}</div>` : (!diagnosis ? `<div class="empty knowledge-empty">本病种资料尚待补充。</div>` : "");
      const related = data.cases.filter((value) => value.diseaseId === id);
      $("#detail").innerHTML = `<article class="detail-card"><div class="detail-meta">${escapeHtml(item.id)} · ${escapeHtml(item.system)} · ${escapeHtml(item.tier)}级</div><h1>${escapeHtml(item.name)}</h1><div class="tag-row"><span>${escapeHtml(item.mastery)} · ${escapeHtml(item.frequency)}</span></div>${detailToolbar("disease", id)}${diagnosis}${jumpLabels ? `<nav class="detail-jump" aria-label="病种详情快速跳转">${jumpLabels}</nav>` : ""}${knowledge}${diseaseTnmBlock(item)}${medicalReviewBlock(item)}${related.length ? `<div class="related"><h2>相关精选病例</h2><div class="case-grid">${related.map((value) => `<a class="case-card" href="${detailHash("case", value.publicId)}"><div class="case-card-body"><small class="meta">精选病例</small><h3>${escapeHtml(value.diseaseName)}</h3><p>${escapeHtml(value.microscopy || value.clinical || "查看病例要点")}</p></div></a>`).join("")}</div></div>` : ""}</article>`;
       if (microscopyImages.length) {
         $("#detail .detail-jump")?.insertAdjacentHTML("beforeend", '<button type="button" data-scroll-target="knowledge-microscopyImages">镜下图谱</button>');
         const microscopySection = $("#detail #knowledge-microscopy"); if (microscopySection) microscopySection.insertAdjacentHTML("afterend", atlas); else { const related = $("#detail .related"); if (related) related.insertAdjacentHTML("beforebegin", atlas); else $("#detail .detail-card")?.insertAdjacentHTML("beforeend", atlas); }
       }
       restoreExternalReturn();
    } catch (error) { if (isCurrentRoute(token, expectedHash)) $("#detail").innerHTML = detailFailure(error); }
  }

  async function renderCase(id, token, expectedHash) {
    const base = data.cases.find((value) => value.publicId === id); if (!base) return showHome();
    detailParent = history.state?.parentHash || serializeHomeHash(homeState); gallery = []; showDetail(); $("#detail").innerHTML = detailLoading(base);
    try {
      const item = { ...base, ...(await loadDetail("case", id)) }; if (!isCurrentRoute(token, expectedHash)) return;
      recordRecent("case", id);
      const slideLink = item.slideUrl ? `<section class="slide-link-card"><div><strong>电子切片</strong><small>将在新页面打开第三方切片查看器</small></div><a href="${escapeHtml(item.slideUrl)}" target="_blank" rel="noopener noreferrer external" aria-label="打开${escapeHtml(item.diseaseName)}电子切片">打开电子切片 <span aria-hidden="true">↗</span></a></section>` : "";
      const caseKnowledge = sectionList(item, Object.keys(caseLabels), caseLabels, "case-knowledge", ["clinical", "microscopy"]);
      $("#detail").innerHTML = `<article class="detail-card"><div class="detail-meta">${escapeHtml(item.system || "未分类")} · ${escapeHtml(item.caseType || "组织学")}精选病例</div><h1>${escapeHtml(item.diseaseName)}</h1><div class="tag-row">${(item.tags || []).map((value) => `<span>${escapeHtml(value)}</span>`).join("")}</div>${detailToolbar("case", id)}${slideLink}${item.images?.length ? `<div class="gallery-grid">${item.images.map((image, index) => `<button data-gallery="${index}"><img src="${escapeHtml(assetUrl(image.src))}" alt="${escapeHtml(image.caption || item.diseaseName)}" loading="lazy" decoding="async" /></button>`).join("")}</div>` : ""}${caseKnowledge ? `<div class="knowledge-grid">${caseKnowledge}</div>` : `<div class="empty knowledge-empty">本病例文字资料尚待补充。</div>`}${item.diseaseId ? `<p><a href="#/disease/${encodeURIComponent(item.diseaseId)}">查看关联病种知识 →</a></p>` : ""}</article>`;
      gallery = item.images || [];
      restoreExternalReturn();
    } catch (error) { gallery = []; if (isCurrentRoute(token, expectedHash)) $("#detail").innerHTML = detailFailure(error); }
  }

  function tnmCategory(label, rows, open = false) { return `<details class="tnm-category" ${open ? "open" : ""}><summary><span>${label}</span><small>${rows.length} 个独立类别</small></summary>${rows.map((row) => `<article class="tnm-criterion-row${row.requiresSourceCheck ? " source-check" : ""}"><span class="tnm-criterion-dot" aria-hidden="true"></span><strong>${escapeHtml(row.code)}</strong><p>${escapeHtml(row.text)}${row.requiresSourceCheck ? `<em>需查原表</em>` : ""}</p></article>`).join("")}</details>`; }

  function tnmPdfHref(pdfUrl, page) { return Number.isInteger(page) && page > 0 ? `${pdfUrl}#page=${page}` : pdfUrl; }

  function tnmOfficialSourcesBlock(item) {
    const official = item.officialSources || {};
    const cap = official.cap || {};
    const ajcc = official.ajcc || {};
    const rows = [];
    if (cap.pdfUrl) {
      const protocolMeta = [cap.protocol, cap.version ? `v${String(cap.version).replace(/^v/i, "")}` : ""].filter(Boolean).join(" · ");
      const tnmMeta = [protocolMeta, cap.tnmPage ? `PDF 第 ${cap.tnmPage} 页` : "", cap.checkedAt ? `核验 ${cap.checkedAt}` : ""].filter(Boolean).join(" · ");
      const notesMeta = [cap.notesPage ? `PDF 第 ${cap.notesPage} 页` : "同一 CAP 协议 PDF", cap.checkedAt ? `核验 ${cap.checkedAt}` : ""].filter(Boolean).join(" · ");
      rows.push(`<a href="${escapeHtml(tnmPdfHref(cap.pdfUrl, cap.tnmPage))}" target="_blank" rel="noopener noreferrer external"><b>CAP 原始 pTNM ↗</b><small>${escapeHtml(tnmMeta)}</small></a>`);
      rows.push(`<a href="${escapeHtml(tnmPdfHref(cap.pdfUrl, cap.notesPage))}" target="_blank" rel="noopener noreferrer external"><b>CAP 分期说明 ↗</b><small>${escapeHtml(notesMeta)}</small></a>`);
    }
    const versionCheckUrl = ajcc.versionCheckUrl || item.ajccUrl;
    if (versionCheckUrl) {
      const versionMeta = [ajcc.edition || item.ajccEdition, ajcc.checkedAt ? `核验 ${ajcc.checkedAt}` : ""].filter(Boolean).join(" · ");
      rows.push(`<a href="${escapeHtml(versionCheckUrl)}" target="_blank" rel="noopener noreferrer external"><b>核验当前 AJCC 版本 ↗</b><small>${escapeHtml(versionMeta)}</small></a>`);
    }
    if (ajcc.educationUrl) rows.push(`<a href="${escapeHtml(ajcc.educationUrl)}" target="_blank" rel="noopener noreferrer external"><b>AJCC 官方讲解 ↗</b><small>${escapeHtml(ajcc.edition || item.ajccEdition)}</small></a>`);
    return `<section class="tnm-official-sources"><h2>官方原始资料</h2><div>${rows.join("")}</div></section>`;
  }

  async function renderTnm(id, token, expectedHash) {
    const base = data.tnm.schemes.find((value) => value.id === id); if (!base) { setTab("tnm"); return showHome(); }
    detailParent = history.state?.parentHash || serializeHomeHash({ ...homeState, tab: "tnm" }); showDetail(); $("#detail").innerHTML = detailLoading(base);
    try {
      const item = { ...base, ...(await loadDetail("tnm", id)) }; if (!isCurrentRoute(token, expectedHash)) return;
      recordRecent("tnm", id);
      $("#detail").innerHTML = `<article class="detail-card tnm-detail"><div class="detail-meta">${escapeHtml(item.ajccEdition)} · 复核 ${escapeHtml(item.reviewedAt)}</div><h1>${escapeHtml(item.title)}</h1><p>${escapeHtml(item.site)} · ${escapeHtml(item.histology)}</p>${detailToolbar("tnm", id)}<div class="tnm-meta"><span>CAP：${escapeHtml(item.capProtocol)}</span><span>协议版本：${escapeHtml(item.capVersion)}</span></div><p class="tnm-boundary"><b>排除/边界：</b>${escapeHtml(item.exclusions)}</p>${tnmCategory("pT · 原发肿瘤", item.categories?.pT || [], true)}${tnmCategory("pN · 区域淋巴结", item.categories?.pN || [])}${tnmCategory("pM · 远处转移", item.categories?.pM || [])}<section class="tnm-notes"><h2>病理注意点</h2><ul>${(item.pathologyNotes || []).map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul></section>${tnmOfficialSourcesBlock(item)}<p class="tnm-warning">${escapeHtml(data.tnm.meta.disclaimer)}</p></article>`;
      restoreExternalReturn();
    } catch (error) { if (isCurrentRoute(token, expectedHash)) $("#detail").innerHTML = detailFailure(error); }
  }

  function route() {
    const token = ++routeToken, expectedHash = location.hash || "#/", parsed = parseHomeState(expectedHash);
    if (parsed.route === "detail") {
      const kind = parsed.kind === "disease" ? "disease" : parsed.kind === "case" ? "case" : parsed.kind === "tnm" ? "tnm" : "";
      if (!kind) return showHome();
      detailParent = history.state?.parentHash || detailParent || "#/";
      if (kind === "disease") renderDisease(decodeURIComponent(parsed.id), token, expectedHash);
      else if (kind === "case") renderCase(decodeURIComponent(parsed.id), token, expectedHash);
      else renderTnm(decodeURIComponent(parsed.id), token, expectedHash);
      return;
    }
    homeState = { tab: parsed.tab, q: parsed.q, system: parsed.system };
    tab = homeState.tab;
    document.querySelectorAll("[data-tab]").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
    const requestedSystem = homeState.system;
    syncHomeInputs();
    if (requestedSystem !== homeState.system) writeHomeUrl();
    showHome();
    restoreScroll(expectedHash, history.state?.route === "home" ? history.state.scrollY : undefined);
    scheduleGlobalSearch();
  }

  function applyGalleryTransform() {
    const image = $("#gallery-image"); if (!image) return;
    image.style.transform = `translate(${galleryTranslate.x}px, ${galleryTranslate.y}px) scale(${galleryScale})`;
  }
  function resetGalleryTransform() { galleryScale = 1; galleryTranslate = { x: 0, y: 0 }; pinchStartDistance = 0; applyGalleryTransform(); }
  function setGalleryIndex(index) { galleryIndex = (index + gallery.length) % gallery.length; resetGalleryTransform(); renderGallery(); }
  function galleryDistance() { const points = [...galleryPointers.values()]; return points.length < 2 ? 0 : Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y); }
  function renderGallery() { const image = gallery[galleryIndex]; if (!image) return; $("#gallery-image").src = assetUrl(image.src); $("#gallery-image").alt = image.caption || "镜下图片"; $("#gallery-image").decoding = "async"; $("#gallery-caption").textContent = [image.category, image.magnification, image.stain, image.caption, image.keyFeatures, image.source, image.attribution].filter(Boolean).join(" · ") || "镜下图片"; applyGalleryTransform(); }
  function openGallery(index) { galleryIndex = index; resetGalleryTransform(); renderGallery(); $("#gallery").showModal(); }

  function updateNetworkStatus() {
    const status = $("#network-status"); if (!status) return;
    const online = navigator.onLine !== false;
    status.textContent = online ? "在线" : "离线 · 仅显示已缓存资料";
    status.classList.toggle("offline", !online);
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }).catch(() => showToast("离线缓存暂不可用"));
  }

  async function handleSearchInput() {
    const wasEmpty = !currentQuery();
    homeState.q = $("#search").value;
    if (wasEmpty && currentQuery()) searchScope = "all";
    diseaseFullRequested = false;
    writeHomeUrl();
    renderHome();
    scheduleGlobalSearch();
  }

  function handleSystemChange() {
    homeState.system = $("#system-filter").value;
    diseaseFullRequested = false;
    writeHomeUrl();
    renderHome();
  }

  async function boot() {
    $("#refresh-data-button")?.addEventListener("click", retryLoad);
    try {
      data = await loadCatalog();
    } catch (error) { $("#home-view").classList.add("hidden"); $("#error-view").classList.remove("hidden"); $("#error-message").textContent = error.message; updateNetworkStatus(); return; }
    $("#disease-count").textContent = data.diseases.length; $("#case-count").textContent = data.cases.length; $("#tnm-count").textContent = data.tnm.schemes.length;
    $("#tnm-notice").innerHTML = `<b>${escapeHtml(data.tnm.meta.classificationNotice)}</b><span>${escapeHtml(data.tnm.meta.scope)}</span>`;
    renderPersonal(); updateNetworkStatus(); registerServiceWorker();
    document.addEventListener("click", (event) => {
      const image = event.target.closest("[data-gallery]"); if (image) return openGallery(Number(image.dataset.gallery));
      const tabButton = event.target.closest("[data-tab]"); if (tabButton) return currentQuery() ? setSearchScope(tabButton.dataset.tab) : setTab(tabButton.dataset.tab);
      const fullSearch = event.target.closest("[data-search-full]"); if (fullSearch) return loadDiseaseFullSearch(homeState.q, { force: true });
      const scrollTarget = event.target.closest("[data-scroll-target]"); if (scrollTarget) { document.getElementById(scrollTarget.dataset.scrollTarget)?.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
      const favorite = event.target.closest("[data-favorite-type]"); if (favorite) return toggleFavorite(favorite.dataset.favoriteType, favorite.dataset.favoriteId);
      const share = event.target.closest("[data-share-detail]"); if (share) return shareCurrent();
      const toggle = event.target.closest("[data-knowledge-toggle]"); if (toggle) { $$("#detail details.knowledge-section").forEach((item) => { item.open = toggle.dataset.knowledgeToggle === "open"; }); return; }
      const backInline = event.target.closest("[data-back-inline]"); if (backInline) return goBack();
      const external = event.target.closest('a[target="_blank"][href]');
      if (external && event.button === 0) { rememberExternalReturn(); return; }
      const internal = event.target.closest('a[href^="#/"]');
      if (internal && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        $("#personal-dialog")?.close();
        return navigateTo(internal.getAttribute("href"));
      }
    });
    $("#search").addEventListener("input", handleSearchInput);
    $("#search-submit")?.addEventListener("click", () => { handleSearchInput(); $("#search").focus(); });
    $("#system-filter").addEventListener("change", handleSystemChange);
    $("#back-button").addEventListener("click", goBack);
    $("#personal-button")?.addEventListener("click", () => { renderPersonal(); $("#personal-dialog").showModal(); });
    $("#personal-close")?.addEventListener("click", () => $("#personal-dialog").close());
    $("#gallery-close").addEventListener("click", () => { $("#gallery").close(); resetGalleryTransform(); });
    $("#gallery-prev").addEventListener("click", () => setGalleryIndex(galleryIndex - 1));
    $("#gallery-next").addEventListener("click", () => setGalleryIndex(galleryIndex + 1));
    const stage = $("#gallery-stage");
    stage?.addEventListener("pointerdown", (event) => { stage.setPointerCapture?.(event.pointerId); galleryPointers.set(event.pointerId, { x: event.clientX, y: event.clientY }); if (galleryPointers.size === 1) swipeStart = { x: event.clientX, y: event.clientY }; if (galleryPointers.size === 2) { pinchStartDistance = galleryDistance(); pinchStartScale = galleryScale; } });
    stage?.addEventListener("pointermove", (event) => { if (!galleryPointers.has(event.pointerId)) return; galleryPointers.set(event.pointerId, { x: event.clientX, y: event.clientY }); if (galleryPointers.size >= 2 && pinchStartDistance) { galleryScale = Math.min(4, Math.max(1, pinchStartScale * galleryDistance() / pinchStartDistance)); applyGalleryTransform(); } else if (galleryScale > 1 && swipeStart) { galleryTranslate = { x: event.clientX - swipeStart.x, y: event.clientY - swipeStart.y }; applyGalleryTransform(); } });
    const pointerEnd = (event) => { const start = swipeStart; galleryPointers.delete(event.pointerId); if (galleryPointers.size < 2) pinchStartDistance = 0; if (start && galleryScale === 1 && galleryPointers.size === 0) { const dx = event.clientX - start.x, dy = event.clientY - start.y; if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.3) setGalleryIndex(galleryIndex + (dx < 0 ? 1 : -1)); } if (!galleryPointers.size) swipeStart = null; };
    stage?.addEventListener("pointerup", pointerEnd); stage?.addEventListener("pointercancel", pointerEnd);
    stage?.addEventListener("dblclick", () => { galleryScale = galleryScale === 1 ? 2 : 1; galleryTranslate = { x: 0, y: 0 }; applyGalleryTransform(); });
    window.addEventListener("hashchange", route); window.addEventListener("popstate", route); window.addEventListener("scroll", () => { if (!restoringScroll) rememberScroll(); }, { passive: true }); window.addEventListener("pageshow", restoreExternalReturn); window.addEventListener("online", updateNetworkStatus); window.addEventListener("offline", updateNetworkStatus);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") restoreExternalReturn(); });
    route();
  }

  boot();
})();
