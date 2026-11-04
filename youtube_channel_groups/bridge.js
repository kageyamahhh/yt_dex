// MAINワールドで動く。YouTube自身が保持しているデータ(ガイド / 登録チャンネル一覧)から
// チャンネル情報を取り出し、window.postMessage でコンテンツスクリプトへ渡す。
// 認証情報・Cookieには触れず、ネットワークリクエストも行わない。
(() => {
  "use strict";
  if (window !== window.top && !/[?&]ytcg=sync(?:&|$)/.test(location.search)) return;   // 埋め込み等のフレームでは動かさない
  if (window.__ytcgBridge) return;
  window.__ytcgBridge = true;
  const FROM = "ytcg-bridge", TO = "ytcg-content";

  const text = v => {
    if (!v) return "";
    if (typeof v === "string") return v;
    if (typeof v.simpleText === "string") return v.simpleText;
    if (Array.isArray(v.runs)) return v.runs.map(r => (r && r.text) || "").join("");
    return "";
  };
  const https = u => {
    u = String(u || "");
    if (u.startsWith("//")) u = "https:" + u;      // YouTubeは "//yt3.ggpht.com/..." 形式で返すことがある
    return /^https:\/\//.test(u) ? u : "";
  };
  const thumb = t => {
    const list = ((t && t.thumbnails) || []).filter(x => x && x.url).sort((a, b) => (a.width || 0) - (b.width || 0));
    if (!list.length) return "";
    return https((list.find(x => (x.width || 0) >= 48) || list[list.length - 1]).url);
  };

  // 循環参照・深すぎる階層を避けつつ全オブジェクトを訪問する。visit が false を返すと配下に入らない。
  function walk(node, visit, seen = new WeakSet(), depth = 0) {
    if (!node || typeof node !== "object" || depth > 16 || seen.has(node)) return;
    seen.add(node);
    if (!Array.isArray(node) && visit(node) === false) return;
    for (const k in node) {
      const v = node[k];
      if (v && typeof v === "object") walk(v, visit, seen, depth + 1);
    }
  }

  // ガイド項目が「配信中」かどうか。バッジ等の表現が複数あるため、項目内を調べる。
  function isLive(g) {
    let live = false;
    walk(g, n => {
      if (n.liveBroadcasting === true || n.style === "BADGE_STYLE_TYPE_LIVE_NOW" || n.iconType === "LIVE" || n.iconType === "LIVE_BROADCAST") live = true;
      return !live;
    });
    return live;
  }

  const entryKind = d => {
    const ne = d && d.navigationEndpoint;
    if (!ne) return "";
    if (ne.reelWatchEndpoint || ne.shortsEndpoint) return "shorts";
    const url = (ne.commandMetadata && ne.commandMetadata.webCommandMetadata && ne.commandMetadata.webCommandMetadata.url) || "";
    if (/^\/shorts(?:\/|$)/.test(url)) return "shorts";
    if (/^\/reporthistory(?:\/|$)/.test(url)) return "report";
    if (url === "/" || (ne.browseEndpoint && ne.browseEndpoint.browseId === "FEwhat_to_watch")) return "home";
    return "";
  };

  const entryInfo = g => {
    const b = g && g.navigationEndpoint && g.navigationEndpoint.browseEndpoint;
    if (!b || typeof b.browseId !== "string") return null;
    return {
      id: b.browseId,
      path: b.canonicalBaseUrl || "",
      name: text(g.formattedTitle) || text(g.title) || (g.accessibility && g.accessibility.accessibilityData && g.accessibility.accessibilityData.label) || "",
      avatar: thumb(g.thumbnail),
      live: isLive(g)
    };
  };

  // YouTube公式の「探索」用トピックチャンネル(音楽・ライブ・ゲーム・ニュース・スポーツ・学び・ファッション&美容)。
  // 登録チャンネルではないため、常に除外する。
  const EXPLORE_CH = new Set(["UC-9-kyTW8ZkZNDHQJ6FgpwQ", "UC4R8DWoMoI7CAwX8_LjQHig", "UCYfdidRxbB8Qhf0Nx7ioOYw", "UCEgdi0XIXXZ-qJOFPf4JSKw", "UCtFRv9O2AHqOZjjynzrv-xg", "UCrpQ4p1Ql_hG8rKXIKM1MOQ", "UCOpNcN46UbXVtpKMrmU4Abg"]);
  const ID_RE = /^UC[\w-]{20,}$/;
  // 自分のチャンネルへの項目(「あなた」欄の「チャンネル」など)。ytcfgからIDが取れない場合の保険として表示名でも除外する。
  const OWN_NAME_RE = /^\s*(?:あなたの)?チャンネル\s*$|^\s*(?:your\s+)?channel\s*$/i;

  // ガイドから「登録チャンネル」の項目だけを集める。セクションの選び方(上から順に採用):
  //   1. 登録チャンネル専用のセクション(guideSubscriptionsSectionRenderer)、または FEchannels へのリンクを含むセクション
  //   2. 上がなければ、「マイページ」「探索」など他の用途のセクション(FE…/VL…へのリンクや探索用チャンネルを含む)を除いたセクション
  //   3. それもなければ全セクション(ただし探索用チャンネルと自分のチャンネルは除く)
  // 折りたたまれた「もっと見る」の中身もデータ上は含まれる。
  function collectGuide(data, out, ownId, diag) {
    const sections = [];
    walk(data, n => {
      if (n.guideSubscriptionsSectionRenderer) { sections.push({ node: n.guideSubscriptionsSectionRenderer, subs: true }); return false; }
      if (n.guideSectionRenderer) { sections.push({ node: n.guideSectionRenderer, subs: false }); return false; }
    });
    if (!sections.length) sections.push({ node: data, subs: false });
    const scanned = sections.map(({ node, subs }) => {
      const r = { entries: [], hasFeed: false, other: false, subs };
      walk(node, n => {
        if (!n.guideEntryRenderer) return;
        const info = entryInfo(n.guideEntryRenderer);
        if (!info) return;
        if (info.id === "FEchannels") r.hasFeed = true;
        else if (ID_RE.test(info.id)) { r.entries.push(info); if (EXPLORE_CH.has(info.id)) r.other = true; }
        else if (/^(?:FE|VL)/.test(info.id)) r.other = true;      // ホーム・履歴・プレイリスト・急上昇 など
      });
      return r;
    });
    let use = scanned.filter(r => r.subs || r.hasFeed);
    let how = "subscriptions";
    if (!use.length) { use = scanned.filter(r => !r.other); how = "non-other"; }
    if (!use.length) { use = scanned; how = "all"; }
    if (diag) diag.push({ how, sections: scanned.map(r => ({ subs: r.subs, feed: r.hasFeed, other: r.other, n: r.entries.length })) });
    for (const r of use) for (const e of r.entries) {
      if (e.id === ownId || EXPLORE_CH.has(e.id) || OWN_NAME_RE.test(e.name || "")) continue;
      const prev = out.get(e.id); out.set(e.id, { ...e, live: !!(e.live || (prev && prev.live)) });
    }
  }

  function scan() {
    try {
      const out = new Map();
      let ownId = "";
      try { ownId = (window.ytcfg && window.ytcfg.get && window.ytcfg.get("CHANNEL_ID")) || ""; } catch (_) {}

      // 1) 描画済みガイド要素のデータ(購読変更後も最新)
      const diag = [];
      document.querySelectorAll("ytd-guide-renderer").forEach(el => el.data && collectGuide(el.data, out, ownId, diag));
      // 2) 初回ロード時のガイドデータ
      if (window.ytInitialGuideData) collectGuide(window.ytInitialGuideData, out, ownId, diag);
      const guideIds = new Set(out.keys());

      // 3) /feed/channels に表示されている全登録チャンネル(検索結果などは対象外)
      let feedCount = 0; const feedIds = [];
      if (location.pathname === "/feed/channels") {
        document.querySelectorAll("ytd-channel-renderer").forEach(el => {
          if (!el.data) return;
          walk({ channelRenderer: el.data }, n => {
            const c = n.channelRenderer;
            if (!c || !c.channelId) return;
            const b = c.navigationEndpoint && c.navigationEndpoint.browseEndpoint;
            out.set(c.channelId, { id: c.channelId, path: (b && b.canonicalBaseUrl) || "", name: text(c.title), avatar: thumb(c.thumbnail) });
            feedCount++; feedIds.push(c.channelId);
          });
        });
      }

      // 元のガイド項目に印を付ける(content.js側で標準表示を隠すために使う)
      document.querySelectorAll("ytd-guide-entry-renderer").forEach(el => {
        const kind = entryKind(el.data);      // 「ホーム」「ショート」「報告履歴」の判別用(リンクのhrefが無い項目でも判別できるように)
        if (kind) { if (el.getAttribute("data-ytcg-kind") !== kind) el.setAttribute("data-ytcg-kind", kind); }
        else if (el.hasAttribute("data-ytcg-kind")) el.removeAttribute("data-ytcg-kind");
        const b = el.data && el.data.navigationEndpoint && el.data.navigationEndpoint.browseEndpoint;
        const id = b && b.browseId;
        if (id && guideIds.has(id)) { if (el.getAttribute("data-ytcg-id") !== id) el.setAttribute("data-ytcg-id", id); }
        else if (el.hasAttribute("data-ytcg-id")) el.removeAttribute("data-ytcg-id");
      });

      window.postMessage({ source: FROM, type: "channels", channels: [...out.values()], guideCount: guideIds.size, feedCount, feedIds, liveCount: [...out.values()].filter(c => c.live).length, ownId, diag: diag.slice(0, 2) }, location.origin);
    } catch (err) {
      window.postMessage({ source: FROM, type: "error", message: String((err && err.message) || err) }, location.origin);
    }
  }

  // 登録チャンネルフィードのShort(棚の中の1本ずつ)は、画面上にチャンネル名が出ない。
  // YouTube内部データにあるチャンネルのパスを data-ytcg-chpath として項目に付ける(グループの絞り込みに使う)。
  const SHORT_SEL = 'a[href*="/shorts/"], ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2, ytd-reel-item-renderer';
  function channelPathsOf(data) {
    const out = [];
    walk(data, n => {
      if (out.length) return false;
      const b = n.browseEndpoint;
      if (b && typeof b.browseId === "string" && /^UC[\w-]{20,}$/.test(b.browseId)) {
        if (b.canonicalBaseUrl && /^\/[^/]/.test(b.canonicalBaseUrl)) out.push(b.canonicalBaseUrl);
        out.push("/channel/" + b.browseId);
        return false;
      }
    });
    return out;
  }
  function stamp() {
    try {
      document.querySelectorAll("ytd-rich-item-renderer:not([data-ytcg-chpath])").forEach(el => {
        if (!el.data || !el.querySelector(SHORT_SEL)) return;
        const p = channelPathsOf(el.data);
        el.setAttribute("data-ytcg-chpath", p.length ? p.join("\n") : "-");
      });
    } catch (_) {}
  }

  window.addEventListener("message", e => {
    if (e.source !== window || !e.data || e.data.source !== TO) return;
    if (e.data.type === "scan") scan();
    else if (e.data.type === "stamp") stamp();
  });
  ["yt-navigate-finish", "yt-page-data-updated"].forEach(n => window.addEventListener(n, () => setTimeout(scan, 800)));
  setTimeout(scan, 1500);
})();
