// sidebar.js / feed.js(YouTubeページ)と options.js(管理画面)の両方で使う共通処理。
// グループは parentId で階層化する(未指定/null = 最上位)。兄弟間の表示順は groups 配列の順。
(() => {
  "use strict";
  const UNG = "ungrouped";
  const YT = "https://www.youtube.com";
  const PATH_RE = /^\/(?:@[^/?#]+|channel\/[^/?#]+|c\/[^/?#]+|user\/[^/?#]+)$/;
  const RESERVED = new Set(["__proto__", "constructor", "prototype"]);
  const LIMITS = { groups: 500, channels: 20000, name: 40, order: 5000 };
  const DIV_RE = /^div:[\w-]{1,40}$/;
  const DEFAULT_SETTINGS = { hideExplore: true, hideServices: true, showLive: true, showFeedFilter: true, rememberFeedFilter: false, promoteOverdue: true, hideHome: false, hideShorts: false, hideMyPage: true, hideReportHistory: false };

  const isDivider = e => typeof e === "string" && DIV_RE.test(e);
  const newDividerId = () => "div:" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const byName = (a, b) => String(a.name).localeCompare(String(b.name), "ja");
  const defaults = () => ({ groups: [{ id: UNG, name: "未分類", collapsed: false }], channels: {}, settings: { ...DEFAULT_SETTINGS } });
  const cleanText = (v, max) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);
  const cleanAvatar = u => { try { const x = new URL(String(u || "")); return x.protocol === "https:" ? x.href : ""; } catch { return ""; } };

  // 兄弟(同じ親)のグループを配列順で返す。「未分類」は含めない。
  const childrenOf = (groups, parentId) => groups.filter(g => g.id !== UNG && (g.parentId || null) === (parentId || null));

  // 表示順に並べた [{group, depth}]。「未分類」は常に最後(最上位)。循環があっても無限ループしない。
  function flatTree(groups) {
    const out = [], seen = new Set();
    const walk = (parentId, depth) => {
      for (const g of childrenOf(groups, parentId)) {
        if (seen.has(g.id)) continue;
        seen.add(g.id); out.push({ group: g, depth });
        walk(g.id, depth + 1);
      }
    };
    walk(null, 0);
    const ung = groups.find(g => g.id === UNG);
    if (ung) out.push({ group: ung, depth: 0 });
    return out;
  }

  // id とその配下すべてのグループIDの集合
  function descendantIds(groups, id) {
    const set = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const g of groups) if (g.parentId && set.has(g.parentId) && !set.has(g.id)) { set.add(g.id); grew = true; }
    }
    return set;
  }

  // 「親 / 子」形式の表示名
  function pathLabel(groups, id) {
    const names = []; let cur = groups.find(g => g.id === id), guard = 0;
    while (cur && guard++ < 20) { names.unshift(cur.name); cur = cur.parentId ? groups.find(g => g.id === cur.parentId) : null; }
    return names.join(" / ");
  }

  // 保存データを矯正する: 「未分類」の存在、存在しない親・自己参照・循環の解消、設定の補完
  function normalize(s) {
    s = s && typeof s === "object" ? s : defaults();
    s.groups = Array.isArray(s.groups) ? s.groups.filter(g => g && typeof g.id === "string") : [];
    s.channels = s.channels && typeof s.channels === "object" ? s.channels : {};
    s.settings = { ...DEFAULT_SETTINGS, ...(s.settings && typeof s.settings === "object" ? s.settings : {}) };
    if (!s.groups.some(g => g.id === UNG)) s.groups.push(defaults().groups[0]);
    const ids = new Set(s.groups.map(g => g.id));
    for (const g of s.groups) {
      if (g.id === UNG || !g.parentId || g.parentId === g.id || g.parentId === UNG || !ids.has(g.parentId)) delete g.parentId;
    }
    for (const g of s.groups) {                       // グループ内の並び順: 重複・存在しない/他グループのチャンネルを除く
      if (g.order === undefined) continue;
      if (!Array.isArray(g.order)) { delete g.order; continue; }
      const seen = new Set();
      g.order = g.order.filter(e => {
        if (typeof e !== "string" || seen.has(e)) return false;
        const ok = isDivider(e) || (Object.prototype.hasOwnProperty.call(s.channels, e) && ((s.channels[e] && s.channels[e].groupId) || UNG) === g.id);
        if (ok) seen.add(e);
        return ok;
      }).slice(0, LIMITS.order);
    }
    for (const g of s.groups) {                       // 循環検出: 親をたどって自分に戻るなら最上位へ
      let cur = g, guard = 0;
      while (cur && cur.parentId && guard++ < 50) {
        if (cur.parentId === g.id) { delete g.parentId; break; }
        cur = s.groups.find(x => x.id === cur.parentId);
      }
      if (guard >= 50) delete g.parentId;
    }
    return s;
  }

  // グループ内の表示順(チャンネルのキーと仕切りID)。保存済みの order を優先し、
  // 未登録のチャンネル(新規検出・他グループから移動)は末尾に名前順で追加する。
  function effectiveOrder(state, gid) {
    const g = state.groups.find(x => x.id === gid);
    const members = Object.entries(state.channels).filter(([, c]) => c && c.name && ((c.groupId) || UNG) === gid);
    const keys = new Set(members.map(([k]) => k));
    const out = [], used = new Set();
    for (const e of (g && Array.isArray(g.order)) ? g.order : []) {
      if (used.has(e)) continue;
      if (isDivider(e) || keys.has(e)) { out.push(e); used.add(e); }
    }
    members.filter(([k]) => !used.has(k)).sort((a, b) => byName(a[1], b[1])).forEach(([k]) => out.push(k));
    return out;
  }

  // 仕切りで区切られた区間ごとに名前順で並べ替える(仕切りの位置は変えない)。dir: 1=昇順 / -1=降順
  function sortSegments(state, order, dir) {
    const out = []; let seg = [];
    const flush = () => { seg.sort((a, b) => dir * byName(state.channels[a], state.channels[b])); out.push(...seg); seg = []; };
    for (const e of order) { if (isDivider(e)) { flush(); out.push(e); } else if (state.channels[e]) seg.push(e); }
    flush();
    return out;
  }

  // ---- エクスポート / インポート ----
  function buildExport(state) {
    return JSON.stringify({ format: "ytcg-backup", version: 1, exportedAt: new Date().toISOString(), state: { groups: state.groups, channels: state.channels, settings: state.settings } }, null, 2);
  }

  const cleanOrder = o => Array.isArray(o) ? o.filter(e => typeof e === "string" && e.length <= 300 && !RESERVED.has(e)).slice(0, LIMITS.order) : null;

  // バックアップ文字列を検証・無害化して state を返す。{error} または {state, stats}
  function parseImport(text) {
    let o;
    try { o = JSON.parse(text); } catch { return { error: "JSONとして読み込めませんでした。" }; }
    if (!o || o.format !== "ytcg-backup" || !o.state || typeof o.state !== "object") return { error: "このツールのバックアップファイルではありません。" };
    if (typeof o.version !== "number" || o.version > 1) return { error: "新しい形式のバックアップです。拡張機能を更新してください。" };
    const st = o.state;
    if (!Array.isArray(st.groups) || !st.channels || typeof st.channels !== "object") return { error: "バックアップの内容が不正です。" };
    if (st.groups.length > LIMITS.groups || Object.keys(st.channels).length > LIMITS.channels) return { error: "データ量が大きすぎます。" };

    const groups = [], gids = new Set([UNG]);
    for (const g of st.groups) {
      if (!g || typeof g.id !== "string" || !/^[\w-]{1,40}$/.test(g.id) || g.id === UNG || RESERVED.has(g.id) || gids.has(g.id)) continue;
      const name = cleanText(g.name, LIMITS.name); if (!name) continue;
      gids.add(g.id);
      const ng = { id: g.id, name, collapsed: g.collapsed === true };
      if (typeof g.parentId === "string") ng.parentId = g.parentId;
      const ord = cleanOrder(g.order); if (ord) ng.order = ord;
      groups.push(ng);
    }
    const impU = st.groups.find(g => g && g.id === UNG) || {};
    const ungG = { id: UNG, name: "未分類", collapsed: impU.collapsed === true };
    const ungOrd = cleanOrder(impU.order); if (ungOrd) ungG.order = ungOrd;
    groups.push(ungG);

    const channels = {}; let skipped = 0;
    for (const [k, c] of Object.entries(st.channels)) {
      let pathname = "";
      try { const u = new URL(String(c && c.url)); if (u.origin === YT && PATH_RE.test(u.pathname)) pathname = u.pathname; } catch {}
      const name = cleanText(c && c.name, 200);
      if (!pathname || !name || typeof k !== "string" || k.length > 300 || RESERVED.has(k)) { skipped++; continue; }
      channels[k] = { key: k, name, url: YT + pathname, avatar: cleanAvatar(c.avatar), groupId: gids.has(c.groupId) ? c.groupId : UNG };
    }
    const settings = { ...DEFAULT_SETTINGS };
    if (st.settings && typeof st.settings === "object") for (const k of Object.keys(DEFAULT_SETTINGS)) if (typeof st.settings[k] === "boolean") settings[k] = st.settings[k];
    return { state: normalize({ groups, channels, settings }), stats: { groups: groups.length - 1, channels: Object.keys(channels).length, skipped } };
  }

  // 現在の状態に取り込む。mode: "replace" | "merge"(同じIDはファイル側で上書き、ファイルに無いものは残す)
  function applyImport(current, imported, mode) {
    if (mode === "replace") return normalize(imported);
    const cur = normalize(JSON.parse(JSON.stringify(current)));
    for (const g of imported.groups) {
      const i = cur.groups.findIndex(x => x.id === g.id);
      if (g.id === UNG) { const cu = cur.groups.find(x => x.id === UNG); if (g.order) cu.order = g.order; continue; }
      if (i >= 0) cur.groups[i] = g; else cur.groups.splice(cur.groups.findIndex(x => x.id === UNG), 0, g);
    }
    Object.assign(cur.channels, imported.channels);
    cur.settings = { ...cur.settings, ...imported.settings };
    return normalize(cur);
  }

  globalThis.YTCG = { isDivider, newDividerId, effectiveOrder, sortSegments, UNG, PATH_RE, DEFAULT_SETTINGS, defaults, childrenOf, flatTree, descendantIds, pathLabel, normalize, buildExport, parseImport, applyImport };
})();
