(() => {
"use strict";
const IN_FRAME = window !== window.top;
const SYNC_RE = /[?&]ytcg=sync(?:&|$)/;
const isSyncPage = () => location.pathname === "/feed/channels" && SYNC_RE.test(location.search);
if (IN_FRAME && !isSyncPage()) return;            // 同期用の非表示iframe以外のフレームでは何もしない
const KEY = "ytcgState", UNG = "ungrouped";
const defaults = () => ({ groups: [{ id: UNG, name: "未分類", collapsed: false }], channels: {} });
const PATH_RE = /^\/(?:@[^/?#]+|channel\/[^/?#]+|c\/[^/?#]+|user\/[^/?#]+)$/;
const ID_RE = /^UC[\w-]{20,}$/;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const make = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt !== undefined) e.textContent = txt; return e; };

let lastKinds = "", signature = "", bridgeSeen = false, syncing = false, lastLog = "", lastDiag = "", lastFeedIds = [], purgedOnce = false;
const prunedIds = new Set();   // 削除済みID。古いガイドデータからの再追加を防ぐ(ページ再読み込みまで有効)
let queue = Promise.resolve();

// ---------- 拡張機能の更新・再読み込み後に残った古いスクリプトの後始末 ----------
// 更新後も開いたままのタブでは古いスクリプトが動き続け、chrome.* の呼び出しが
// "Extension context invalidated" で失敗してエラーが積み上がる。検知したら自分で停止する。
let stopped = false, mo = null, themeMo = null, navHandler = null;
let liveFrozen = false, liveIds = new Set();      // 配信中のチャンネル: ページを開いた時点の状態を1回だけ取得する
const alive = () => { try { return !!(chrome.runtime && chrome.runtime.id); } catch { return false; } };
const isInvalidated = e => /context invalidated/i.test(String((e && e.message) || e));
function shutdown() {
  if (stopped) return; stopped = true;
  try { mo && mo.disconnect(); themeMo && themeMo.disconnect(); } catch {}
  window.removeEventListener("message", onBridgeMessage);
  window.removeEventListener("yt-navigate-finish", navHandler);
  if (!IN_FRAME) { try { toast("拡張機能が更新されました。ページを再読み込みしてください", 10000); } catch {} }
}
// イベント・監視・タイマーの入口を包み、想定外の例外を onError に集める
const guard = fn => (...args) => { try { return fn(...args); } catch (e) { onError(e); } };
function onError(e) { if (isInvalidated(e) || !alive()) shutdown(); else console.error(e); }

// ---------- 保存データ ----------
async function read() {
  return YTCG.normalize((await chrome.storage.local.get(KEY))[KEY]);
}
const cleanName = n => String(n || "").replace(/\s+/g, " ").trim().slice(0, 200);
// 遅延読み込み用の data: URI(透明1px)などを弾き、https の画像URLだけ通す
const cleanAvatar = u => { try { const x = new URL(String(u || "")); return x.protocol === "https:" ? x.href : ""; } catch { return ""; } };
const safeDecode = s => { try { return decodeURIComponent(s); } catch { return s; } };
const pathOf = href => { try { const u = new URL(href, location.origin); return u.origin === location.origin && PATH_RE.test(u.pathname) ? u.pathname : ""; } catch { return ""; } };

// items: {key, path, name, avatar}。key はチャンネルID(UC...)。旧版のURLパスキーは自動で移行する。
function merge(items) {
  queue = queue.then(async () => {
    const s = await read(); let changed = false;
    for (const c of items) {
      if (prunedIds.has(c.key)) continue;
      let old = s.channels[c.key];
      if (!old && c.path) {
        for (const k of new Set([c.path, safeDecode(c.path)])) {
          if (k !== c.key && s.channels[k]) { old = s.channels[k]; delete s.channels[k]; changed = true; break; }
        }
      }
      const name = c.name || old?.name;           // 名前が取れない時は既存の名前を残す
      if (!name) continue;
      const next = {
        key: c.key, name,
        url: location.origin + (c.path || (ID_RE.test(c.key) ? "/channel/" + c.key : c.key)),
        avatar: c.avatar || cleanAvatar(old?.avatar),
        groupId: s.groups.some(g => g.id === old?.groupId) ? old.groupId : UNG
      };
      if (JSON.stringify(old) !== JSON.stringify(next)) { s.channels[c.key] = next; changed = true; }
    }
    if (changed) await chrome.storage.local.set({ [KEY]: s });
  }).catch(onError);
  return queue;
}

// 過去の版で取り込んでしまった「登録チャンネルではないもの」(探索用の公式チャンネル、自分のチャンネル)を保存データから削除する。
function purgeNonSubscriptions(ownId) {
  const job = queue.then(async () => {
    const s = await read(); let n = 0;
    for (const [k, c] of Object.entries(s.channels)) {
      const ids = [k];
      for (const src of [k, c && c.url]) {
        const m = /\/channel\/(UC[\w-]+)/.exec(safeDecode(String(src || "")));
        if (m) ids.push(m[1]);
      }
      if (OWN_NAME_RE.test(String((c && c.name) || "")) || ids.some(id => EXPLORE_CH.has(id) || (ownId && id === ownId))) { delete s.channels[k]; prunedIds.add(k); n++; }
    }
    if (n) { await chrome.storage.local.set({ [KEY]: s }); console.info("[YTCG] 登録チャンネルではない項目を", n, "件削除しました"); }
  });
  queue = job.catch(onError);
  return job;
}

// 登録一覧(/feed/channels)に無いチャンネルを保存データから削除する。
// keepIds: 一覧のチャンネルID / keepPaths: 一覧内リンクのパス(デコード済み)。どちらかに該当すれば残す。
// 削除対象が多すぎる場合は、読み取り失敗とみなして中止する。
function prune(keepIds, keepPaths) {
  const ids = new Set(keepIds);
  const job = queue.then(async () => {
    const s = await read();
    const all = Object.entries(s.channels);
    const drop = all.filter(([k, c]) => {
      if (ids.has(k)) return false;
      let p = ""; try { p = safeDecode(new URL(c.url).pathname); } catch {}
      if (p && keepPaths.has(p)) return false;
      if (ID_RE.test(k) && keepPaths.has("/channel/" + k)) return false;
      return true;
    }).map(([k]) => k);
    if (drop.length > Math.max(5, all.length * 0.5)) return { aborted: true, removed: [] };
    for (const k of drop) { delete s.channels[k]; prunedIds.add(k); }
    if (drop.length) await chrome.storage.local.set({ [KEY]: s });
    return { aborted: false, removed: drop };
  });
  queue = job.catch(onError);
  return job;
}

// 一覧ページ内のチャンネルリンク(@handle, /channel/UC...)のパス集合。要素名に依存しない読み取り。
function feedPaths() {
  const set = new Set();
  let roots = document.querySelectorAll('ytd-browse[page-subtype="channels"]');
  if (!roots.length) roots = document.querySelectorAll("ytd-browse");
  roots.forEach(r => r.querySelectorAll("a[href]").forEach(a => {
    try {
      const u = new URL(a.getAttribute("href") || "", location.origin);
      if (u.origin !== location.origin) return;
      const m = /^\/(?:@[^/?#]+|channel\/[^/?#]+|c\/[^/?#]+|user\/[^/?#]+)/.exec(u.pathname);
      if (m) set.add(safeDecode(m[0]));
    } catch {}
  }));
  return set;
}

// ---------- bridge.js(MAINワールド)との通信 ----------
function bridgeMessageImpl(e) {
  if (stopped) return;
  const d = e.data;
  if (e.source !== window || !d || d.source !== "ytcg-bridge") return;
  if (d.type === "error") { console.warn("[YTCG] bridge error:", d.message); return; }
  if (d.type !== "channels" || !Array.isArray(d.channels)) return;
  bridgeSeen = true;
  if (Array.isArray(d.feedIds)) lastFeedIds = d.feedIds.filter(id => ID_RE.test(String(id)));
  const items = [];
  const ownId = ID_RE.test(String(d.ownId || "")) ? d.ownId : "";
  for (const c of d.channels) {
    if (!c || !ID_RE.test(String(c.id || ""))) continue;
    if (c.id === ownId || EXPLORE_CH.has(c.id) || OWN_NAME_RE.test(String(c.name || ""))) continue;      // 登録チャンネルではないもの(探索用の公式チャンネル・自分のチャンネル)
    items.push({ key: c.id, path: PATH_RE.test(c.path || "") ? c.path : "", name: cleanName(c.name), avatar: cleanAvatar(c.avatar) });
  }
  const log = `guide=${d.guideCount} feed=${d.feedCount} 受信=${items.length}`;
  if (log !== lastLog) { lastLog = log; console.info("[YTCG] 検出:", log); }
  if (items.length) merge(items);
  if (!IN_FRAME) {
    if (d.guideCount > 0 && !purgedOnce) { purgedOnce = true; purgeNonSubscriptions(ownId); }
    const dg = JSON.stringify(d.diag || []);
    if (dg !== lastDiag) { lastDiag = dg; console.info("[YTCG] ガイド構造:", dg); }
  }
  // bridge.js が「ホーム」「ショート」「報告履歴」の印を付けた(または外した)ら、表示の切り替えをやり直す
  if (!IN_FRAME) {
    const kinds = [...document.querySelectorAll("[data-ytcg-kind]")].map(e => e.getAttribute("data-ytcg-kind")).join(",");
    if (kinds !== lastKinds) { lastKinds = kinds; scheduleRender(); }
  }
  // 配信中の状態は、ページを開いた時点のものを1回だけ取得し、以後は更新しない
  if (!liveFrozen && !IN_FRAME && d.guideCount > 0) {
    liveFrozen = true;
    liveIds = new Set(d.channels.filter(c => c && c.live === true && ID_RE.test(String(c.id || ""))).map(c => c.id));
    console.info("[YTCG] 配信中:", liveIds.size, "件（ページを開いた時点）");
    scheduleRender();
  }
}
const onBridgeMessage = guard(bridgeMessageImpl);
window.addEventListener("message", onBridgeMessage);
const requestScan = () => window.postMessage({ source: "ytcg-content", type: "scan" }, location.origin);

// bridge が応答しない場合(YouTube側の構造変更など)の保険。DOMから取れる範囲だけ取る。
function domFallback() {
  if (bridgeSeen) return;
  const items = [];
  for (const a of document.querySelectorAll("ytd-guide-renderer a[href]")) {
    if (a.closest("#ytcg-sidebar")) continue;                // 自分自身のリンクは対象外
    const path = pathOf(a.getAttribute("href") || ""); if (!path) continue;
    const sec = a.closest("ytd-guide-section-renderer");
    if ((sec && sectionKind(sec)) || isExploreLink(a.getAttribute("href") || "")) continue;   // 探索欄の公式チャンネル等は除外
    const entry = a.closest("ytd-guide-entry-renderer") || a;
    const name = cleanName(entry.querySelector("yt-formatted-string")?.textContent || a.getAttribute("title") || a.getAttribute("aria-label"));
    if (OWN_NAME_RE.test(name)) continue;
    items.push({ key: path, path, name, avatar: cleanAvatar(entry.querySelector("img")?.src) });
  }
  if (items.length) { console.info("[YTCG] DOMフォールバックで", items.length, "件"); merge(items); }
}

// ---------- テーマ(ダーク/ライト) ----------
// YouTubeは <html dark> を付ける。変更されても動くよう、実際の背景色の明るさも見る。
// getComputedStyle の値は rgb() 以外(color()、oklch() など)になることがあるため、canvas に塗って sRGB で読み取る。
let colorCtx = null;
function lumaOf(css) {
  try {
    if (!colorCtx) { const cv = document.createElement("canvas"); cv.width = cv.height = 1; colorCtx = cv.getContext("2d", { willReadFrequently: true }); }
    const sentinel = "#010203";
    colorCtx.clearRect(0, 0, 1, 1);
    colorCtx.fillStyle = sentinel; colorCtx.fillStyle = css;
    if (colorCtx.fillStyle === sentinel) return null;          // 解釈できない色
    colorCtx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = colorCtx.getImageData(0, 0, 1, 1).data;
    return a < 128 ? null : 0.299 * r + 0.587 * g + 0.114 * b;  // 透明は判定に使わない
  } catch { return null; }
}
function isDark() {
  try {
    if (document.documentElement.hasAttribute("dark")) return true;
    const el = document.querySelector("ytd-app") || document.body;
    if (!el) return false;
    const luma = lumaOf(getComputedStyle(el).backgroundColor);
    return luma !== null && luma < 128;
  } catch { return false; }
}
function applyTheme() {
  const root = document.getElementById("ytcg-sidebar");
  if (root) root.dataset.ytcgTheme = isDark() ? "dark" : "light";
}

// ---------- サイドメニューの「探索」「YouTube のその他のサービス」を隠す ----------
// 表示言語に依存しないよう、見出しの文字ではなくリンク先で判定する。設定でON/OFFできる。
const SERVICE_RE = /^(?:studio\.youtube\.com|music\.youtube\.com|(?:www\.)?youtubekids\.com)$/;
const OWN_NAME_RE = /^\s*(?:あなたの)?チャンネル\s*$|^\s*(?:your\s+)?channel\s*$/i;      // 自分のチャンネル項目(IDが取れない場合の保険)
const EXPLORE_CH = new Set(["UC-9-kyTW8ZkZNDHQJ6FgpwQ", "UC4R8DWoMoI7CAwX8_LjQHig", "UCYfdidRxbB8Qhf0Nx7ioOYw", "UCEgdi0XIXXZ-qJOFPf4JSKw", "UCtFRv9O2AHqOZjjynzrv-xg", "UCrpQ4p1Ql_hG8rKXIKM1MOQ", "UCOpNcN46UbXVtpKMrmU4Abg"]);
const EXPLORE_PATH_RE = /^\/(?:feed\/(?:trending|storefront|explore|courses_destination)|gaming|podcasts|shopping|movies)(?:\/|$)/;
const EXPLORE_TITLES = new Set(["探索", "Explore"]);
function linkUrl(href) { try { return new URL(href, location.origin); } catch { return null; } }
function isServiceLink(href) {
  const u = linkUrl(href); if (!u) return false;
  if (SERVICE_RE.test(u.hostname)) return true;
  return /(^|\.)youtube\.com$/.test(u.hostname) && /^\/premium(?:\/|$)/.test(u.pathname);
}
function isExploreLink(href) {
  const u = linkUrl(href); if (!u || u.origin !== location.origin) return false;
  if (EXPLORE_PATH_RE.test(u.pathname)) return true;
  const m = /^\/channel\/([^/?#]+)/.exec(u.pathname);
  return !!m && EXPLORE_CH.has(m[1]);
}
function sectionKind(sec) {
  if (sec.querySelector("ytd-guide-entry-renderer[data-ytcg-id]")) return null;     // 登録チャンネル欄は対象外
  const links = [...sec.querySelectorAll("a[href]")].map(a => a.getAttribute("href") || "");
  if (!links.length) return null;
  if (links.every(isServiceLink)) return "services";
  const hit = links.filter(isExploreLink).length;
  const title = (sec.querySelector("#guide-section-title, h3")?.textContent || "").trim();
  if ((hit >= 2 && hit / links.length >= 0.6) || EXPLORE_TITLES.has(title)) return "explore";
  return null;
}
function hideSections(settings) {
  document.querySelectorAll("ytd-guide-section-renderer").forEach(sec => {
    if (sec.classList.contains("ytcg-original-channel-hidden")) return;
    const kind = sectionKind(sec);
    sec.classList.toggle("ytcg-hide-services", kind === "services" && settings.hideServices);
    sec.classList.toggle("ytcg-hide-explore", kind === "explore" && settings.hideExplore);
  });
  hideEntries(settings);
}

// ---------- サイドメニューの「ホーム」「ショート」「報告履歴」「マイページ」の表示切り替え ----------
// 項目は、表示文字ではなくリンク先で判定する(表示言語に依存しない)。マイページは「あなた」セクション全体。
function entryKind(href) {
  const u = linkUrl(href); if (!u || u.origin !== location.origin) return null;
  if (u.pathname === "/") return "home";
  if (/^\/shorts(?:\/|$)/.test(u.pathname)) return "shorts";
  if (/^\/reporthistory(?:\/|$)/.test(u.pathname)) return "report";
  return null;
}
const LABEL_KIND = new Map([["ホーム", "home"], ["Home", "home"], ["ショート", "shorts"], ["Shorts", "shorts"], ["報告履歴", "report"], ["Report history", "report"]]);
function entryKindByLabel(en) {
  const labels = [en.getAttribute("aria-label"), en.getAttribute("title"), en.querySelector("a")?.getAttribute("title"), en.querySelector("a")?.getAttribute("aria-label"), en.querySelector("yt-formatted-string, .title")?.textContent];
  for (const l of labels) { const k = LABEL_KIND.get(String(l || "").trim()); if (k) return k; }
  return null;
}
function hideEntries(settings) {
  const want = { home: !!settings.hideHome, shorts: !!settings.hideShorts, report: !!settings.hideReportHistory };
  document.querySelectorAll("ytd-guide-entry-renderer").forEach(en => {
    if (en.closest("#ytcg-sidebar")) return;
    // 判定の優先順: リンク先 → bridge.js が付けた印(YouTube内部データ) → 表示名(最後の手段)
    const a = en.querySelector("a[href]");
    let kind = a ? entryKind(a.getAttribute("href") || "") : null;
    if (!kind) kind = en.getAttribute("data-ytcg-kind") || entryKindByLabel(en);
    en.classList.toggle("ytcg-hide-entry", !!kind && want[kind]);
  });
  const you = findYouSection();
  document.querySelectorAll(".ytcg-hide-mypage").forEach(el => { if (el !== you || !settings.hideMyPage) el.classList.remove("ytcg-hide-mypage"); });
  if (you && settings.hideMyPage) you.classList.add("ytcg-hide-mypage");
}

// ---------- 「マイページ」(YouTube側の「あなた」セクション)の検出と配置 ----------
// 見出しの文字ではなく、履歴・プレイリスト・「後で見る」「高く評価」へのリンクで判定する。
function isYouLink(href) {
  const u = linkUrl(href); if (!u || u.origin !== location.origin) return false;
  if (/^\/feed\/(?:you|history|playlists|library)(?:\/|$)/.test(u.pathname)) return true;
  return u.pathname === "/playlist" && /^(?:WL|LL)$/.test(u.searchParams.get("list") || "");
}
function findYouSection() {
  for (const sec of document.querySelectorAll("ytd-guide-section-renderer")) {
    if (sec.closest("#ytcg-sidebar") || sec.querySelector("ytd-guide-entry-renderer[data-ytcg-id]")) continue;
    if ([...sec.querySelectorAll("a[href]")].some(a => isYouLink(a.getAttribute("href") || ""))) return sec;
  }
  return null;
}
// 拡張機能のサイドバーを「マイページ」の直前に置く。見つからなければ元の登録チャンネル欄の直前、それもなければ末尾。
function placeRoot(root, guide, section) {
  const anchor = findYouSection() || section;
  if (anchor) { if (!root.isConnected || root.nextElementSibling !== anchor) anchor.before(root); }
  else if (!root.isConnected) guide.append(root);
}

// ---------- 描画 ----------
async function render() {
  if (stopped) return;
  const guide = document.querySelector("ytd-guide-renderer #sections") || document.querySelector("ytd-guide-renderer");
  if (!guide) return;
  const s = await read();
  hideSections(s.settings);
  const list = Object.values(s.channels).filter(c => c && c.name);
  const sig = JSON.stringify([s.groups, list.map(c => [c.key, c.name, c.groupId, c.url, c.avatar]), s.settings.showLive ? [...liveIds].sort() : []]);
  let root = document.getElementById("ytcg-sidebar");
  const marked = document.querySelector("ytd-guide-entry-renderer[data-ytcg-id]");
  const section = marked?.closest("ytd-guide-section-renderer") || null;
  if (sig === signature && root?.isConnected) { applyTheme(); placeRoot(root, guide, section); if (section && list.length) section.classList.add("ytcg-original-channel-hidden"); return; }
  signature = sig;
  root?.remove();
  root = make("div", "ytcg-sidebar"); root.id = "ytcg-sidebar";

  const head = make("div", "ytcg-heading");
  const title = make("a", "ytcg-title", "登録Ch");
  title.href = "https://www.youtube.com/feed/subscriptions";
  title.title = "登録チャンネルのフィードを開く";
  head.append(title);
  const sync = make("button", "ytcg-manage", "全取得");
  sync.title = "登録チャンネルの一覧を裏で読み込み、全チャンネルの取得と登録解除分の整理を行います";
  sync.addEventListener("click", startSync);
  const manage = make("button", "ytcg-manage", "管理");
  manage.addEventListener("click", () => { try { chrome.runtime.sendMessage({ type: "open-options" }); } catch (e) { onError(e); } });
  head.append(sync, manage); root.append(head);

  const byGroup = new Map();
  for (const c of list) { const k = c.groupId; if (!byGroup.has(k)) byGroup.set(k, []); byGroup.get(k).push(c); }
  const total = g => [...YTCG.descendantIds(s.groups, g.id)].reduce((n, id) => n + (byGroup.get(id)?.length || 0), 0);
  const addChannel = (c, depth, live = false) => {
    const a = make("a", "ytcg-channel"); a.href = c.url; a.title = c.name; a.style.setProperty("--ytcg-depth", depth);
    const ph = () => make("span", "ytcg-avatar-placeholder", [...c.name][0] || "?");
    const av = cleanAvatar(c.avatar);
    if (av) {
      const img = make("img", "ytcg-avatar"); img.src = av; img.alt = ""; img.referrerPolicy = "no-referrer";
      img.addEventListener("error", () => img.replaceWith(ph()), { once: true });
      a.append(img);
    } else a.append(ph());
    a.append(make("span", "ytcg-channel-name", c.name));
    if (live) a.append(make("span", "ytcg-live-badge", "LIVE"));
    root.append(a);
  };
  const addDivider = depth => {
    const d = make("div", "ytcg-divider"); d.setAttribute("role", "separator"); d.style.setProperty("--ytcg-depth", depth); root.append(d);
  };
  const addGroup = (g, depth, guard) => {
    const btn = make("button", "ytcg-group-header"); btn.style.setProperty("--ytcg-depth", depth);
    btn.append(make("span", "ytcg-caret", g.collapsed ? "›" : "⌄"), make("span", "ytcg-group-name", g.name), make("span", "ytcg-count", String(total(g))));
    btn.addEventListener("click", async () => {
      try {
        const latest = await read(); const grp = latest.groups.find(x => x.id === g.id);
        if (grp) { grp.collapsed = !grp.collapsed; await chrome.storage.local.set({ [KEY]: latest }); }
      } catch (e) { onError(e); }
    });
    root.append(btn);
    if (g.collapsed || guard > 20) return;
    for (const child of YTCG.childrenOf(s.groups, g.id)) addGroup(child, depth + 1, guard + 1);   // 下位グループ → チャンネルの順
    // 並び順どおりに表示。仕切りはチャンネル間にのみ表示(先頭・末尾・連続は省略)
    let pending = false, any = false;
    for (const e of YTCG.effectiveOrder(s, g.id)) {
      if (YTCG.isDivider(e)) { if (any) pending = true; continue; }
      const c = s.channels[e]; if (!c || !c.name) continue;
      if (pending) { addDivider(depth + 1); pending = false; }
      addChannel(c, depth + 1); any = true;
    }
  };
  // 配信中のチャンネル: グループ(フォルダ)表示とは別に、グループ一覧の上に表示する。各チャンネルは所属グループにも通常どおり表示される。
  const liveList = s.settings.showLive ? list.filter(c => liveIds.has(c.key)).sort((a, b) => a.name.localeCompare(b.name, "ja")) : [];
  if (liveList.length) {
    const lh = make("div", "ytcg-live-heading");
    lh.append(make("span", "ytcg-live-dot"), make("span", "", "配信中"), make("span", "ytcg-count", String(liveList.length)));
    root.append(lh);
    for (const c of liveList) addChannel(c, 1, true);
    root.append(make("div", "ytcg-live-sep"));
  }
  for (const { group, depth } of YTCG.flatTree(s.groups)) {
    if (depth > 0) continue;                       // 最上位のみ起点にし、下位は再帰で描画
    addGroup(group, 0, 0);
  }
  root.append(make("div", "ytcg-note", list.length + "件 ／ 足りない場合は「全取得」を押してください"));

  applyTheme();
  placeRoot(root, guide, section);
  if (section) { if (list.length) section.classList.add("ytcg-original-channel-hidden"); }
  else {
    // 印が付けられなかった場合(フォールバック): 既知チャンネルの項目だけ個別に隠す
    const known = new Set(list.map(c => c.url));
    document.querySelectorAll("ytd-guide-entry-renderer").forEach(en => {
      const p = pathOf(en.querySelector("a[href]")?.getAttribute("href") || "");
      if (p && known.has(location.origin + p)) en.classList.add("ytcg-original-channel-hidden");
    });
  }
}

// ---------- 全登録チャンネルの取得(/feed/channels を自動スクロール) ----------
function toast(msg, ms = 0) {
  let t = document.getElementById("ytcg-toast");
  if (!t) { t = make("div"); t.id = "ytcg-toast"; document.body.append(t); }
  t.textContent = msg;
  if (ms) setTimeout(() => t.remove(), ms);
}
async function autoSync() {
  if (syncing || !isSyncPage()) return;
  syncing = true;
  const report = (text, final, extra) => {
    if (IN_FRAME) window.parent.postMessage({ source: "ytcg-frame", type: final ? "done" : "progress", text, ...extra }, location.origin);
    else toast(text, final ? 8000 : 0);
  };
  try {
    let last = -1, same = 0;
    lastFeedIds = [];
    for (let i = 0; i < 240 && same < 4; i++) {
      const n = Math.max(document.querySelectorAll("ytd-channel-renderer").length, feedPaths().size);
      if (n === 0 && i < 40) { report("一覧ページを読み込み中…"); await sleep(1000); continue; }
      same = n === last ? same + 1 : 0; last = n;
      report(`登録チャンネルを読み込み中… ${n}件`);
      window.scrollTo(0, document.documentElement.scrollHeight);
      requestScan();
      await sleep(900);
    }
    requestScan(); await sleep(800); await queue;
    const paths = feedPaths();
    const complete = same >= 4 && (lastFeedIds.length > 0 || paths.size > 0);
    let res = { aborted: false, removed: [] };
    if (complete) res = await prune(lastFeedIds, paths);
    const total = Object.keys((await read()).channels).length;
    const text = !complete ? `一覧を最後まで読み込めなかったため、削除は行いませんでした（検出 ${last}件）`
      : res.aborted ? "削除対象が多すぎるため、読み取り異常とみなして削除を中止しました"
      : `完了: 登録解除済み ${res.removed.length}件を削除（合計 ${total}件）`;
    console.info("[YTCG] 同期:", { feedIds: lastFeedIds.length, feedPaths: paths.size, complete, removed: res.removed.length, total });
    report(text, true, { removedKeys: res.removed });
    if (!IN_FRAME) history.replaceState(null, "", "/feed/channels");
  } finally { syncing = false; }
}

// 「全取得」: 現在のページを離れず、非表示iframeで一覧ページを読み込む
function startSync() {
  if (document.getElementById("ytcg-sync-frame")) return;
  const f = make("iframe"); f.id = "ytcg-sync-frame"; f.tabIndex = -1; f.setAttribute("aria-hidden", "true");
  f.style.cssText = "position:fixed;left:0;top:0;width:1280px;height:900px;border:0;opacity:0;pointer-events:none;z-index:-1";
  let timer;
  const finish = () => { clearTimeout(timer); window.removeEventListener("message", onMsg); f.remove(); };
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => {      // 30秒進捗がなければ従来方式(ページ遷移)に切り替え
    finish(); toast("バックグラウンド取得に失敗したため、一覧ページで取得します", 4000);
    setTimeout(() => location.assign("/feed/channels?ytcg=sync"), 1200);
  }, 30000); };
  const onMsg = e => {
    const d = e.data;
    if (e.source !== f.contentWindow || !d || d.source !== "ytcg-frame") return;
    arm();
    if (d.type === "progress") { toast(String(d.text || "")); return; }
    for (const k of d.removedKeys || []) if (typeof k === "string") prunedIds.add(k);
    toast(String(d.text || ""), 8000); finish();
  };
  window.addEventListener("message", onMsg);
  toast("登録チャンネルを取得中…"); arm();
  f.src = "/feed/channels?ytcg=sync&ytcgframe=1";
  document.body.append(f);
}

// ---------- スケジューリング ----------
const throttle = (fn, ms) => { let t = null; return () => { if (stopped) return; if (!t) t = setTimeout(() => { t = null; if (!stopped) { try { fn(); } catch (e) { onError(e); } } }, ms); }; };
const scheduleScan = throttle(() => { requestScan(); setTimeout(domFallback, 3000); }, 1200);
const scheduleRender = throttle(() => render().then(autoSync).catch(onError), 400);
function schedule() {
  if (stopped) return;
  if (!alive()) { shutdown(); return; }            // 拡張機能が更新された後の孤立したスクリプト
  scheduleScan(); scheduleRender();
}

if (IN_FRAME) { setTimeout(() => autoSync().catch(onError), 1500); }
else {
mo = new MutationObserver(guard(muts => {
  const own = n => (n.nodeType === 1 ? n : n.parentElement)?.closest("#ytcg-sidebar,#ytcg-toast");
  if (muts.every(m => own(m.target))) return;      // 自分自身の描画では再実行しない
  schedule();
}));
mo.observe(document.documentElement, { childList: true, subtree: true });
navHandler = guard(schedule);
window.addEventListener("yt-navigate-finish", navHandler);
themeMo = new MutationObserver(guard(() => { if (!stopped) applyTheme(); }));
themeMo.observe(document.documentElement, { attributes: true, attributeFilter: ["dark", "class", "style"] });
chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch[KEY]) scheduleRender(); });
schedule();
}
})();
