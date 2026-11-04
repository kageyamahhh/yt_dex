/*
 * yt_dex(フィード側)
 * YouTube登録チャンネルフィード(/feed/subscriptions)に種別タブ・表示切り替え・グループでの絞り込みを追加する。
 * グループのデータはサイドバー側(sidebar.js / 管理画面)が chrome.storage.local の ytcgState に保存したものを読むだけで、書き込まない。
 *
 * YouTube側の画面構造が変わって動かなくなったときは、次の2か所だけ直せば済むようにしてある。
 *   - SEL : 画面上の部品の指定(セレクタ)
 *   - RE  : 配信中・配信予定・アーカイブを見分ける文言
 * 各項目には判定結果が data-sn-type / data-sn-live / data-sn-start として付くので、
 * 開発者ツールの Elements で確認できる。
 */
(() => {
  'use strict';

  if (window.__snOrganizerLoaded) return;
  window.__snOrganizerLoaded = true;

  /* ===================== 設定 ===================== */

  const CONFIG = {
    feedPath: '/feed/subscriptions',
    storageKey: 'snViewMode',
    stateKey: 'ytcgState', // サイドバー側が保存するグループのデータ(読み取り専用)
    filterKey: 'snFilter', // 選んだグループ(「次回も引き継ぐ」設定がONのときだけ保存)
    smallScale: 0.6, // 「小」は「大」の60%
    listThumbScale: 0.4, // 「一列表示」のサムネイルは「大」のサムネイル幅の40%
    listThumbMinPx: 120,
    // 予定の開始時刻を過ぎた枠を「配信中」に移すか(false なら、YouTubeが配信中にするまで配信予定のまま)
    promoteOverdue: true,
    // 予定が先に延びたと見なす最小の幅(これより先の時刻に変わったときだけ配信予定に戻す)
    unpromoteMarginMs: 60e3,
    // 開いた直後、判定や表示が落ち着くまで一覧を出さない時間(途中経過の入れ替わりを見せないため)
    settleMs: 800,
    // タブメニューと一番上のサムネイルの間に最低限あける余白
    minGapPx: 12,
    liveScanTail: 30, // 配信中・配信予定が最後に見つかってから、さらに何件読み込んで何も無ければ探索をやめるか
    boostStep: 30, // 「さらに探す」を押したときに追加で探す件数
    shortTarget: 100, // Shortタブを開いたとき、自動で読み込むShortの本数の目安
    maxItems: 800, // 読み込みの上限(これ以上は自動では読み込まない)
    scanDelayMs: 150,
    tickMs: 1000,
  };

  const SEL = {
    browse: 'ytd-browse[page-subtype="subscriptions"]',
    grid: 'ytd-rich-grid-renderer',
    item: 'ytd-rich-item-renderer',
    section: 'ytd-rich-section-renderer',
    continuation: 'ytd-continuation-item-renderer',
    shorts:
      'a[href*="/shorts/"], ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2, ytd-reel-item-renderer, ytd-reel-shelf-renderer',
    // 投稿: 要素名のほか、投稿へのリンク(/post/...)でも判定する
    post: 'ytd-post-renderer, ytd-backstage-post-renderer, ytd-backstage-post-thread-renderer, [class*="post-renderer"], a[href*="/post/"], a[href*="/community?"]',
    videoLink: 'a[href*="/watch"], a[href*="/live/"], a[href*="/playlist"]',
    ready: 'a[href]',
    // サムネイルの候補(上から順に探す)
    thumb: [
      'yt-thumbnail-view-model',
      'ytd-thumbnail',
      'a#thumbnail',
      '.yt-lockup-view-model__content-image',
      'yt-image',
      'img',
    ],
    notifyBox: 'yt-button-view-model, ytd-toggle-button-renderer, ytd-button-renderer, button-view-model, ytd-notification-toggle-button-renderer',
    notifyBtn: 'button, [role="button"], yt-button-view-model, ytd-toggle-button-renderer, ytd-button-renderer',
    channelLink: 'a[href^="/@"], a[href^="/channel/"], a[href^="/c/"], a[href^="/user/"]',
    title: '#video-title, .yt-lockup-metadata-view-model__title, h3',
    meta: '.yt-content-metadata-view-model__metadata-text, #metadata-line span, .inline-metadata-item',
    badge:
      'badge-shape, .badge-shape-wiz__text, yt-thumbnail-badge-view-model, ytd-badge-supported-renderer, ytd-thumbnail-overlay-time-status-renderer',
    liveMark: '.badge-shape-wiz--thumbnail-live, .badge-style-type-live-now-alternate, [overlay-style="LIVE"]',
    upcomingMark: '[overlay-style="UPCOMING"]',
  };

  const RE = {
    // サムネイルのバッジ文字がこれなら配信中
    liveBadge: /^(LIVE|ライブ|PREMIERE|プレミア(公開)?(中)?)$/i,
    watching: /視聴中|watching/i,
    // 開始前を示す文言(「午前/午後」は事前に除去してから判定する)
    future: /後に|後$|に開始|開始予定|予定|Scheduled|Premieres\b|Starts?\s+in|Waiting|待機|プレミア公開/i,
    // 過去を示す文言
    past: /前|ago|済み|Streamed/i,
    startedAgo: /(開始|Started)/i,
    streamed: /ストリーミング|ライブ配信|配信済み|Streamed/i,
    // 「通知を受け取る」などのボタン(非表示にする)
    notify: /通知を受け取|通知をオン|通知オン|Notify me|リマインダー|Set reminder|Remind me/i,
  };

  const MAIN_TABS = [
    ['live', 'ライブ'],
    ['video', '動画'],
    ['short', 'Short'],
  ];
  const VIEWS = ['large', 'small', 'list'];
  const VIEW_LABEL = { large: '大', small: '小(60%)', list: '一列表示' };

  /* ===================== 状態 ===================== */

  const state = {
    main: 'live',
    sub: 'now', // 'now' = 配信中・配信予定 / 'archive' = アーカイブ
    view: 'large',
    group: '', // '' = すべて / それ以外はグループID
  };
  let ctx = null; // いま画面に取り付いている要素など

  /* ===================== 小さな道具 ===================== */

  const SVG_NS = 'http://www.w3.org/2000/svg';

  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') e.className = v;
      else e.setAttribute(k, v);
    }
    for (const kid of kids) e.append(kid);
    return e;
  }

  function svg(shapes) {
    const s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    for (const [tag, attrs] of shapes) {
      const n = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      s.append(n);
    }
    return s;
  }

  const ICONS = {
    // 2x2のグリッド(大)
    large: () =>
      svg([
        ['rect', { x: 3, y: 3, width: 8, height: 8, rx: 1 }],
        ['rect', { x: 13, y: 3, width: 8, height: 8, rx: 1 }],
        ['rect', { x: 3, y: 13, width: 8, height: 8, rx: 1 }],
        ['rect', { x: 13, y: 13, width: 8, height: 8, rx: 1 }],
      ]),
    // 3x3のグリッド(小)
    small: () => {
      const pos = [3, 9.5, 16];
      const shapes = [];
      for (const y of pos) for (const x of pos) shapes.push(['rect', { x, y, width: 5, height: 5, rx: 0.8 }]);
      return svg(shapes);
    },
    // じょうご(絞り込み)
    filter: () => svg([['path', { d: 'M4.25 5.61C6.27 8.2 10 13 10 13v6c0 .55.45 1 1 1h2c.55 0 1-.45 1-1v-6s3.72-4.8 5.74-7.39A.998.998 0 0 0 18.95 4H5.04c-.83 0-1.3.95-.79 1.61z' }]]),
    // 箇条書き(一列表示)
    list: () =>
      svg([
        ['circle', { cx: 4.5, cy: 6, r: 1.6 }],
        ['circle', { cx: 4.5, cy: 12, r: 1.6 }],
        ['circle', { cx: 4.5, cy: 18, r: 1.6 }],
        ['rect', { x: 9, y: 5, width: 12, height: 2, rx: 1 }],
        ['rect', { x: 9, y: 11, width: 12, height: 2, rx: 1 }],
        ['rect', { x: 9, y: 17, width: 12, height: 2, rx: 1 }],
      ]),
  };

  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

  /* ===================== 保存 ===================== */

  function loadView() {
    try {
      chrome.storage.local.get(CONFIG.storageKey, (r) => {
        const v = r && r[CONFIG.storageKey];
        if (VIEWS.includes(v)) {
          state.view = v;
          if (ctx) {
            applyViewAttr();
            updateUI();
            scheduleMeasure();
          }
        }
      });
    } catch (_) {
      /* 保存できなくても動作は続ける */
    }
  }

  function saveView() {
    try {
      chrome.storage.local.set({ [CONFIG.storageKey]: state.view });
    } catch (_) {
      /* ignore */
    }
  }

  /* ===================== グループ(ytcgState を読むだけ) ===================== */

  const GR = {
    ok: false, // 絞り込みに使えるグループがあるか(「未分類」以外に1つ以上)
    groups: [],
    byId: new Map(),
    pathIdx: new Map(), // チャンネルのパス → 所属グループID
    totals: new Map(), // グループID → 登録チャンネル数(下位グループを含む)
    ungId: 'ungrouped',
    settings: { showFeedFilter: true, rememberFeedFilter: false, promoteOverdue: true },
    saved: '', // 保存されていた選択(引き継ぐ設定のとき)
  };

  const safeDecode = (x) => {
    try {
      return decodeURIComponent(x);
    } catch (_) {
      return x;
    }
  };

  /* チャンネルのリンクを、比較できる形に整える(デコード・NFC・ハンドルは小文字・クエリ除去) */
  function normPath(href) {
    try {
      const u = new URL(href, location.origin);
      if (u.origin !== location.origin) return '';
      const m = /^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)/.exec(u.pathname);
      if (!m) return '';
      let p = '/' + safeDecode(m[1]).normalize('NFC');
      if (!/^\/channel\//.test(p)) p = p.toLowerCase();
      return p;
    } catch (_) {
      return '';
    }
  }

  function loadGroups(raw) {
    GR.ok = false;
    GR.groups = [];
    GR.byId = new Map();
    GR.pathIdx = new Map();
    GR.totals = new Map();
    try {
      if (typeof YTCG === 'undefined' || !raw || typeof raw !== 'object') return;
      const st = YTCG.normalize(JSON.parse(JSON.stringify(raw)));
      GR.ungId = YTCG.UNG;
      GR.groups = st.groups;
      GR.settings = { showFeedFilter: st.settings.showFeedFilter !== false, rememberFeedFilter: st.settings.rememberFeedFilter === true, promoteOverdue: st.settings.promoteOverdue !== false };
      for (const g of st.groups) GR.byId.set(g.id, g);
      const gidOf = (c) => (GR.byId.has(c.groupId) ? c.groupId : GR.ungId);
      for (const [k, c] of Object.entries(st.channels)) {
        if (!c) continue;
        const gid = gidOf(c);
        const p = normPath(c.url);
        if (p) GR.pathIdx.set(p, gid);
        if (/^UC[\w-]{20,}$/.test(k)) GR.pathIdx.set('/channel/' + k, gid);
      }
      for (const g of st.groups) {
        const ids = YTCG.descendantIds(st.groups, g.id);
        let n = 0;
        for (const c of Object.values(st.channels)) if (c && ids.has(gidOf(c))) n++;
        GR.totals.set(g.id, n);
      }
      GR.ok = st.groups.some((g) => g.id !== GR.ungId);
    } catch (_) {
      GR.ok = false;
    }
    if (state.group && !GR.byId.has(state.group)) state.group = ''; // 選んでいたグループが無くなったら「すべて」
  }

  /* 「開始時刻になったら配信中へ移す」の設定が変わったとき(または最初から OFF のとき)、移した枠をYouTubeの表示どおりに戻して判定し直す */
  let lastPromote = null;
  function syncPromote() {
    const now = GR.settings.promoteOverdue;
    const changed = lastPromote === null ? !now : lastPromote !== now;
    lastPromote = now;
    if (!changed || !ctx) return;
    for (const el of ctx.grid.querySelectorAll(`${SEL.item}[data-sn-promoted]`)) {
      delete el.dataset.snPromoted;
      delete el.dataset.snFinal;
      el.dataset.snSig = '';
    }
    scan();
  }

  function applyRemembered() {
    if (!ctx || ctx.filterTouched || state.group) return;
    if (GR.settings.rememberFeedFilter && GR.saved && GR.byId.has(GR.saved)) state.group = GR.saved;
  }

  function loadGroupData() {
    try {
      chrome.storage.local.get([CONFIG.stateKey, CONFIG.filterKey], (r) => {
        GR.saved = (r && r[CONFIG.filterKey]) || '';
        loadGroups(r && r[CONFIG.stateKey]);
        applyRemembered();
        syncPromote();
        if (ctx) render();
      });
    } catch (_) {
      /* グループが読めなくても、タブと表示切り替えは動く */
    }
  }

  const filterActive = () => GR.ok && GR.settings.showFeedFilter && !!state.group && GR.byId.has(state.group);

  /* 項目(または棚)の所属グループを調べる。'yes' 選択中のグループに入る / 'no' 入らない / 'unknown' チャンネルが分からない */
  function channelPaths(el) {
    if (el.dataset.snChSig === el.dataset.snSig && el.dataset.snCh !== undefined) return el.dataset.snCh ? el.dataset.snCh.split('\n') : [];
    const title = el.querySelector(SEL.title);
    const out = [];
    for (const a of el.querySelectorAll(SEL.channelLink)) {
      if (title && (title.contains(a) || a.contains(title))) continue;
      const p = normPath(a.getAttribute('href'));
      if (p && !out.includes(p)) out.push(p);
    }
    if (!out.length) {
      // Shortは画面上にチャンネル名が出ないので、bridge.js が付けたYouTube内部データ由来のパスを使う
      for (const p of (el.getAttribute('data-ytcg-chpath') || '').split('\n')) {
        const n = p && p !== '-' ? normPath(p) : '';
        if (n && !out.includes(n)) out.push(n);
      }
      if (out.length) return out;
    }
    if (out.length) {
      el.dataset.snCh = out.join('\n');
      el.dataset.snChSig = el.dataset.snSig || '';
    }
    return out;
  }

  /* 動画ID。同じ配信がフィードに複数回出てくることがあるため、重複を省くのに使う */
  function videoId(el) {
    if (el.dataset.snVidSig === el.dataset.snSig && el.dataset.snVid !== undefined) return el.dataset.snVid;
    let id = '';
    for (const a of el.querySelectorAll('a[href*="/watch"], a[href*="/live/"]')) {
      try {
        const u = new URL(a.getAttribute('href'), location.origin);
        id = u.searchParams.get('v') || (/^\/live\/([^/?#]+)/.exec(u.pathname) || [])[1] || '';
      } catch (_) {
        id = '';
      }
      if (id) break;
    }
    if (id) {
      el.dataset.snVid = id;
      el.dataset.snVidSig = el.dataset.snSig || '';
    }
    return id;
  }

  /* 同じ動画IDの項目が複数あるとき、残す1件を決める(配信中 > 配信予定 > その他、同じなら先に出てきた方) */
  function pickDuplicates(els) {
    const rank = (el) => (el.dataset.snLive === 'now' ? 0 : el.dataset.snLive === 'upcoming' ? 1 : 2);
    const best = new Map();
    const ids = new Map();
    els.forEach((el, i) => {
      if (!el.matches(SEL.item) || !(el.dataset.snType === 'live' || el.dataset.snType === 'video')) return;
      const id = videoId(el);
      if (!id) return;
      ids.set(el, id);
      const b = best.get(id);
      if (b === undefined || rank(el) < rank(els[b])) best.set(id, i);
    });
    const dups = new Set();
    els.forEach((el, i) => {
      const id = ids.get(el);
      if (id && best.get(id) !== i) dups.add(el);
    });
    return dups;
  }

  function groupMatch(el, ids) {
    const paths = channelPaths(el);
    if (!paths.length) return 'unknown';
    const isItem = el.matches(SEL.item) && !el.hasAttribute('data-ytcg-chpath');
    for (const p of isItem ? paths.slice(0, 1) : paths) {
      if (ids.has(GR.pathIdx.get(p) || GR.ungId)) return 'yes';
    }
    return 'no';
  }

  /* ===================== 時刻の読み取り ===================== */

  const UNIT_MS = {
    分: 60e3,
    時間: 36e5,
    日: 864e5,
    週間: 6048e5,
    minute: 60e3,
    hour: 36e5,
    day: 864e5,
    week: 6048e5,
  };

  function unitMs(u) {
    return UNIT_MS[u] || UNIT_MS[(u || '').toLowerCase()] || 0;
  }

  /** 配信予定の開始時刻(ミリ秒)を、表示文言から求める。分からなければ null */
  function parseStart(metaRaw, base) {
    const t = metaRaw.replace(/午前/g, ' AM ').replace(/午後/g, ' PM ');

    let hh = null;
    let mm = null;
    let m = t.match(/(AM|PM)?\s*(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    if (m) {
      hh = +m[2];
      mm = +m[3];
      const ap = (m[1] || m[4] || '').toUpperCase();
      if (ap === 'PM' && hh < 12) hh += 12;
      if (ap === 'AM' && hh === 12) hh = 0;
    }

    const now = new Date(base);
    // 日付つき(2026/10/27, 10/27/26, 10月27日, 明日, 今日)
    let date = null;
    if ((m = t.match(/(\d{4})[\/.\-年]\s*(\d{1,2})[\/.\-月]\s*(\d{1,2})/))) {
      date = new Date(+m[1], +m[2] - 1, +m[3]);
    } else if ((m = t.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/))) {
      const y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
      date = new Date(y, +m[1] - 1, +m[2]);
    } else if ((m = t.match(/(\d{1,2})月\s*(\d{1,2})日/))) {
      date = new Date(now.getFullYear(), +m[1] - 1, +m[2]);
      if (date.getTime() < base - 30 * 864e5) date.setFullYear(date.getFullYear() + 1);
    } else if (/明日|Tomorrow/i.test(t)) {
      date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    } else if (/今日|Today/i.test(t)) {
      date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    }
    if (date) {
      date.setHours(hh == null ? 0 : hh, mm == null ? 0 : mm, 0, 0);
      return date.getTime();
    }

    // 相対表記(16時間後に開始 / in 3 hours)
    let off = null;
    if ((m = t.match(/(\d+)\s*(分|時間|日|週間)\s*後/))) off = +m[1] * unitMs(m[2]);
    else if ((m = t.match(/in\s+(\d+)\s*(minute|hour|day|week)/i))) off = +m[1] * unitMs(m[2]);

    if (off != null) {
      const approx = base + off;
      if (hh == null) return approx;
      // 括弧内の時刻があれば、相対表記に最も近い日付でその時刻に合わせる
      const d0 = new Date(approx);
      let best = null;
      for (const dd of [-1, 0, 1]) {
        const c = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + dd, hh, mm, 0, 0).getTime();
        if (best == null || Math.abs(c - approx) < Math.abs(best - approx)) best = c;
      }
      return best;
    }

    if (hh != null) {
      // 時刻だけの表記は、日付が分からないので「次にその時刻が来る時点」とする(過去には解釈しない)
      const c = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0).getTime();
      return c < base ? c + 864e5 : c;
    }
    return null;
  }

  /** 配信中の開始時刻(「20分前に開始」など)。分からなければ null */
  function parseStartedAgo(meta, base) {
    if (!RE.startedAgo.test(meta)) return null;
    let m = meta.match(/(\d+)\s*(分|時間|日)\s*前/);
    if (m) return base - +m[1] * unitMs(m[2]);
    m = meta.match(/(\d+)\s*(minute|hour|day)s?\s+ago/i);
    if (m) return base - +m[1] * unitMs(m[2]);
    return null;
  }

  /* ===================== 種別の判定 ===================== */

  function metaText(el) {
    // チャンネル名やタイトルに「ライブ配信」「予定」などが含まれていても誤判定しないよう、
    // チャンネル名へのリンクを含む行は読まない
    const parts = [];
    for (const n of el.querySelectorAll(SEL.meta)) {
      if (n.querySelector(SEL.channelLink) || n.closest(SEL.channelLink)) continue;
      const s = norm(n.textContent);
      if (s) parts.push(s);
    }
    if (parts.length) return parts.join(' ');
    // 取れなければ、項目全体の文字からタイトルとチャンネル名を除いて使う
    let all = norm(el.textContent);
    const title = norm(el.querySelector(SEL.title)?.textContent);
    if (title) all = all.replace(title, ' ');
    for (const a of el.querySelectorAll(SEL.channelLink)) {
      const c = norm(a.textContent);
      if (c) all = all.split(c).join(' ');
    }
    return all;
  }

  function badgeTexts(el) {
    const out = [];
    for (const n of el.querySelectorAll(SEL.badge)) {
      const s = norm(n.textContent);
      if (s) out.push(s);
    }
    return out;
  }

  /** 1つの項目(動画の枠)を判定する。中身がまだ描画されていなければ null */
  function classifyItem(el) {
    if (el.querySelector(SEL.post)) return { type: 'post' };
    if (el.querySelector(SEL.shorts)) return { type: 'short' };
    if (!el.querySelector(SEL.ready)) return null;
    // 動画へのリンクが無ければ動画ではない(=投稿)。描画の途中かもしれないので、あとでもう一度確認する
    if (!el.querySelector(SEL.videoLink)) return { type: 'post', volatile: true };

    const base = Date.now();
    const metaRaw = metaText(el);
    const meta = metaRaw.replace(/午[前後]/g, ' ');
    // meta: 表示文言そのもの。同じ文言なら開始時刻を計算し直さないための目印にする
    const live = (state, start, why) => ({ type: 'live', live: state, start, meta: metaRaw, why });

    // 1) 予定マーク付き
    if (el.querySelector(SEL.upcomingMark)) {
      return live('upcoming', parseStart(metaRaw, base), 'upcoming-mark');
    }
    // 2) 配信中のバッジ
    const badges = badgeTexts(el);
    const liveBadge = !!el.querySelector(SEL.liveMark) || badges.some((t) => RE.liveBadge.test(t));
    const future = RE.future.test(meta) && !RE.past.test(meta);
    if (liveBadge && !(future && !RE.watching.test(meta))) {
      return live('now', parseStartedAgo(meta, base), 'live-badge');
    }
    // 3) 開始前の文言
    if (future) {
      return live('upcoming', parseStart(metaRaw, base), 'future-text');
    }
    // 4) 視聴中の文言(バッジが無い場合の保険)
    if (RE.watching.test(meta)) {
      return live('now', parseStartedAgo(meta, base), 'watching-text');
    }
    // 5) 配信が終わったもの
    if (RE.streamed.test(meta)) {
      return live('archive', null, 'streamed-text');
    }
    // 6) それ以外は通常の動画(判定できないものも動画として扱う)。
    //    文言がまだ描画されていない可能性があるので、文言が空のときは確定させない
    return { type: 'video', volatile: !metaRaw, why: 'default' };
  }

  /** ライブ・投稿などを束ねた「棚」(ytd-rich-section-renderer)を判定する */
  function classifySection(el) {
    if (el.querySelector(SEL.shorts)) return { type: 'short' };
    if (el.querySelector(SEL.post)) return { type: 'post' };
    // 動画のリンクがある棚は動画、リンクはあるが動画ではない棚は投稿として扱う(あとでもう一度確認する)
    if (el.querySelector(SEL.videoLink)) return { type: 'video', volatile: true };
    if (el.querySelector(SEL.ready)) return { type: 'post', volatile: true };
    return { type: 'other' };
  }

  function signature(el) {
    const a = el.querySelector('a[href]');
    return a ? a.getAttribute('href') || '' : '';
  }

  function applyInfo(el, info, sig) {
    const ds = el.dataset;
    if (!info) {
      delete ds.snType;
      delete ds.snLive;
      delete ds.snStart;
      delete ds.snFinal;
      ds.snSig = sig;
      return;
    }
    // 同じ枠を判定し直しても、結果が揺れないようにする
    if (info.live === 'upcoming') {
      const nowMs = Date.now();
      if (ds.snPromoted === '1') {
        if (ds.snMeta !== info.meta && info.start != null && info.start > nowMs + CONFIG.unpromoteMarginMs) {
          delete ds.snPromoted; // 予定が先に延びた場合だけ、配信予定に戻す
        } else {
          // 開始時刻を過ぎた枠は、YouTubeの表示が「予定」のままでも配信中に保つ
          info.live = 'now';
          if (ds.snStart) info.start = Number(ds.snStart);
        }
      } else if (ds.snMeta === info.meta && ds.snStart) {
        // 「16時間後」のような相対表記は、判定のたびに時刻がずれていくので、最初に求めた時刻を使い続ける
        info.start = Number(ds.snStart);
      }
      // 開始時刻を過ぎている枠は、最初の判定の時点で確定させる(あとから動かして行き来させない)
      if (info.live === 'upcoming' && GR.settings.promoteOverdue && info.start != null && info.start <= nowMs) {
        info.live = 'now';
        ds.snPromoted = '1';
        info.why = 'overdue';
      }
    }
    if (info.live !== 'now' && info.live !== 'upcoming') delete ds.snPromoted;

    ds.snType = info.type;
    if (info.live) ds.snLive = info.live;
    else delete ds.snLive;
    if (info.start != null) ds.snStart = String(info.start);
    else delete ds.snStart;
    if (info.meta != null) ds.snMeta = info.meta;
    else delete ds.snMeta;
    if (info.why) ds.snWhy = info.why; // 何で判定したか(開発者ツールで確認する用)
    else delete ds.snWhy;
    ds.snSig = sig;
    // 配信中・配信予定・判定の途中のものは、確定扱いにしない
    if (info.type === 'other' || info.volatile || info.live === 'now' || info.live === 'upcoming') delete ds.snFinal;
    else ds.snFinal = '1';
  }

  /* 「通知を受け取る」ボタンを隠す */
  function hideNotify(el) {
    for (const b of el.querySelectorAll(SEL.notifyBtn)) {
      const label = `${b.getAttribute('aria-label') || ''} ${norm(b.textContent)}`;
      if (label.length > 60 || !RE.notify.test(label)) continue;
      const box = b.closest(SEL.notifyBox) || b;
      if (box === el || box.contains(el.querySelector(SEL.title))) continue; // 項目全体を隠してしまわないように
      box.classList.add('sn-notify-hidden');
    }
  }

  /* 一列表示のために、サムネイル・文字・それを並べる箱に印を付ける(YouTubeのクラス名に頼らない) */
  function markLayout(el) {
    if (el.dataset.snLay === '1' && el.querySelector('.sn-lay-thumb')) return;
    const title = el.querySelector(SEL.title);
    if (!title) return;
    let thumb = null;
    for (const s of SEL.thumb) {
      const c = el.querySelector(s);
      if (c && !c.contains(title) && !title.contains(c)) {
        thumb = c;
        break;
      }
    }
    if (!thumb) return;
    let p = thumb.parentElement;
    while (p && !p.contains(title)) p = p.parentElement;
    if (!p || !el.contains(p)) return;
    let tc = thumb;
    while (tc.parentElement !== p) tc = tc.parentElement;
    let mc = title;
    while (mc.parentElement !== p) mc = mc.parentElement;
    if (tc === mc) return;
    for (const old of el.querySelectorAll('.sn-lay-row, .sn-lay-thumb, .sn-lay-meta')) {
      old.classList.remove('sn-lay-row', 'sn-lay-thumb', 'sn-lay-meta');
    }
    p.classList.add('sn-lay-row');
    tc.classList.add('sn-lay-thumb');
    mc.classList.add('sn-lay-meta');
    el.dataset.snLay = '1';
  }

  /* チャンネル名と同じ行に「◯◯人が視聴中」「に公開予定」が並んでいて、名前が長いと切れる場合に、
     チャンネル名の後ろで改行する。チャンネル名と配信の情報を両方含む一番内側の行に印を付ける */
  function markChannelLine(el) {
    if (el.querySelector('.sn-lay-chan')) return;
    const title = el.querySelector(SEL.title);
    const link = [...el.querySelectorAll(SEL.channelLink)].find((a) => !(title && (title.contains(a) || a.contains(title))));
    if (!link) return;
    const name = norm(link.textContent);
    if (!name) return;
    let child = link;
    let p = link.parentElement;
    while (p && p !== el) {
      if (title && p.contains(title)) return; // タイトルまで含む箱に来たら、同じ行には情報がない
      const rest = norm(p.textContent).split(name).join(' ').replace(/[•・·|\s]/g, '');
      if (rest) {
        p.classList.add('sn-lay-line');
        child.classList.add('sn-lay-chan');
        return;
      }
      child = p;
      p = p.parentElement;
    }
  }

  /* チャンネル名が長いとき、隣の枠に被らないよう「…」で省略する。チャンネル名のリンクと、それを包む箱に印を付ける */
  function markChanName(el) {
    if (el.querySelector('.sn-chan-link')) return;
    const title = el.querySelector(SEL.title);
    const link = [...el.querySelectorAll(SEL.channelLink)].find((a) => !(title && (title.contains(a) || a.contains(title))));
    if (!link) return;
    link.classList.add('sn-chan-link');
    let p = link.parentElement;
    while (p && p !== el && !(title && p.contains(title))) {
      p.classList.add('sn-chan-box');
      p = p.parentElement;
    }
  }

  function topLevelItems(grid) {
    const out = [];
    for (const el of grid.querySelectorAll(`${SEL.item}, ${SEL.section}`)) {
      if (el.matches(SEL.item) && el.parentElement && el.parentElement.closest(SEL.section)) continue;
      out.push(el);
    }
    return out;
  }

  function scan() {
    if (!ctx) return;
    for (const el of topLevelItems(ctx.grid)) {
      const sig = signature(el);
      if (el.dataset.snFinal === '1' && el.dataset.snSig === sig) {
        if (el.dataset.snLay !== '1' && el.matches(SEL.item)) markLayout(el);
        if (el.matches(SEL.item) && el.dataset.snType === 'live') markChannelLine(el);
        if (el.matches(SEL.item) && (el.dataset.snType === 'live' || el.dataset.snType === 'video')) markChanName(el);
        continue;
      }
      const info = el.matches(SEL.section) ? classifySection(el) : classifyItem(el);
      applyInfo(el, info, sig);
      if (info && el.matches(SEL.item)) {
        markLayout(el);
        if (info.type === 'live') hideNotify(el);
        if (info.type === 'live') markChannelLine(el);
        if (info.type === 'live' || info.type === 'video') markChanName(el);
      }
    }
  }

  /* ===================== 表示の組み立て ===================== */

  const num = (v) => (v === undefined || v === '' ? null : Number(v));

  function sortByStart(list, dir) {
    // 時刻の分かる項目を先に並べ、分からないものは元の順序で後ろに回す
    const withT = list.filter((x) => x.start != null);
    const noT = list.filter((x) => x.start == null);
    withT.sort((a, b) => (a.start - b.start) * dir || a.idx - b.idx);
    return withT.concat(noT);
  }

  /* Shortの棚(「ショート」の見出し・「すべて表示」・「もっと見る」を含む)を、Shortだけが並ぶ表示にする */
  function shelfChrome(sec, inner) {
    const key = String(inner.length);
    if (sec.dataset.snChromeN === key) return;
    sec.dataset.snChromeN = key;
    const keep = new Set();
    for (const it of inner) for (let p = it; p && p !== sec; p = p.parentElement) keep.add(p);
    const walk = (node) => {
      for (const c of node.children) {
        if (c.matches(SEL.item)) continue;
        if (keep.has(c)) walk(c);
        else c.classList.add('sn-chrome');
      }
    };
    walk(sec);
  }

  /* 「もっと見る」を自動で押して、棚の中のShortを全部出す(ボタン自体は隠す) */
  function expandShelf(sec) {
    const n = Number(sec.dataset.snExpand || 0);
    if (n >= 3) return;
    for (const b of sec.querySelectorAll('button, [role="button"], ytd-button-renderer, yt-button-shape')) {
      if (!/^\s*(もっと見る|Show more)\s*$/i.test(norm(b.textContent))) continue;
      sec.dataset.snExpand = String(n + 1);
      (b.closest('button') || b).click();
      return;
    }
  }

  /* Short棚の中身を1本ずつ絞り込む。戻り値: 表示する本数・全体の本数・チャンネル不明の本数 */
  function filterShelf(sec, ids) {
    const inner = [...sec.querySelectorAll(SEL.item)];
    let shown = 0;
    let unknown = 0;
    for (const it of inner) {
      let ok = true;
      if (ids) {
        const v = groupMatch(it, ids);
        ok = v === 'yes';
        if (v === 'unknown') unknown++;
      }
      it.classList.toggle('sn-hidden', !ok);
      if (ok) shown++;
    }
    if (state.main === 'short' && inner.length) {
      shelfChrome(sec, inner);
      expandShelf(sec);
    }
    return { shown, total: inner.length, unknown };
  }

  let stampAt = 0;
  function requestStamp() {
    const now = Date.now();
    if (now - stampAt < 400) return;
    if (!ctx.grid.querySelector('ytd-rich-item-renderer:not([data-ytcg-chpath])')) return;
    stampAt = now;
    window.postMessage({ source: 'ytcg-content', type: 'stamp' }, location.origin);
    setTimeout(() => ctx && render(), 300);
  }

  function render() {
    if (!ctx) return;
    const { grid, browse } = ctx;
    const els = topLevelItems(grid);

    const liveNow = [];
    const upcoming = [];
    let lastLiveIdx = -1;
    let visibleCount = 0;
    let excluded = 0;
    // グループでの絞り込み。自動読み込みを止める基準(lastLiveIdx)は絞り込み前の全体で数える
    const fOn = filterActive();
    const ids = fOn ? YTCG.descendantIds(GR.groups, state.group) : null;
    const dups = pickDuplicates(els);
    let shortAll = 0;
    if (state.main === 'short') requestStamp();

    els.forEach((el, idx) => {
      const ds = el.dataset;
      const type = ds.snType;
      const live = ds.snLive;
      const rec = { el, idx, start: num(ds.snStart) };

      const isDup = dups.has(el);
      let verdict = 'yes';
      let shelf = null;
      if (type === 'short' && el.matches(SEL.section)) {
        // Short棚: 1本ずつ判定し、残る本数が0なら棚ごと隠す
        shelf = filterShelf(el, fOn && state.main === 'short' ? ids : null);
        verdict = shelf.shown > 0 || shelf.total === 0 ? 'yes' : 'no';
        shortAll += shelf.total;
      } else {
        if (type === 'short') shortAll++;
        if (fOn && !isDup && type && (type === 'live' || type === state.main)) verdict = groupMatch(el, ids);
      }
      const pass = verdict === 'yes' && !isDup;

      if (type === 'live' && live === 'now') {
        if (pass) liveNow.push(rec);
        if (el.matches(SEL.item)) lastLiveIdx = idx;
      } else if (type === 'live' && live === 'upcoming') {
        if (pass) upcoming.push(rec);
        if (el.matches(SEL.item)) lastLiveIdx = idx;
      }

      let typeShow = false;
      if (type === state.main) {
        typeShow = state.main === 'live' ? (state.sub === 'now' ? live === 'now' || live === 'upcoming' : live === 'archive') : true;
      }
      if (typeShow && !isDup && verdict === 'unknown') excluded++;
      if (typeShow && shelf) excluded += shelf.unknown;
      const show = typeShow && pass;
      el.classList.toggle('sn-hidden', !show);
      if (show) visibleCount += shelf ? shelf.shown : 1;
    });
    ctx.excluded = excluded;
    ctx.shortAll = shortAll;
    if (sfActive()) {
      const r = sfRender(fOn ? ids : null);
      ctx.sfShown = r.shown;
      ctx.excluded = r.unknown;
    }

    // 並び順
    for (const el of els) el.style.removeProperty('--sn-order');
    const showDivider = state.main === 'live' && state.sub === 'now' && liveNow.length > 0 && upcoming.length > 0;
    if (state.main === 'live' && state.sub === 'now') {
      sortByStart(liveNow, -1).forEach((r, i) => r.el.style.setProperty('--sn-order', String(100 + i))); // 開始が新しい順
      sortByStart(upcoming, 1).forEach((r, i) => r.el.style.setProperty('--sn-order', String(10000 + i))); // 開始が近い順
    }

    // 仕切り線
    ensureDivider();
    ctx.divider.style.setProperty('--sn-order', '5000');
    ctx.divider.classList.toggle('sn-hidden', !showDivider);

    // 追加読み込みの要素は常に最後
    for (const c of grid.querySelectorAll(SEL.continuation)) c.style.setProperty('--sn-order', '1000000');

    ctx.counts = { now: liveNow.length, upcoming: upcoming.length };
    ctx.total = els.length;
    ctx.visibleCount = sfActive() ? ctx.sfShown : visibleCount;
    ctx.tail = lastLiveIdx < 0 ? els.length : els.length - 1 - lastLiveIdx;

    updateHold();
    updateUI();
    scheduleFix();
  }

  function ensureDivider() {
    if (!ctx.divider) ctx.divider = h('div', { class: 'sn-divider', role: 'separator' });
    const parent = getContainer();
    if (parent && ctx.divider.parentNode !== parent) parent.insertBefore(ctx.divider, parent.firstChild);
  }

  /* ===================== 追加読み込みの制御 ===================== */

  function updateHold() {
    const { browse } = ctx;
    let scanning = false;
    let hold = false;

    if (state.main === 'live' && state.sub === 'now') {
      // 配信中・配信予定は、見つかった最後の項目以降に何も無くなるまで読み込み、件数を揃える
      const needMore =
        !ctx.scanAbort && ctx.tail < CONFIG.liveScanTail + ctx.boost && ctx.total < CONFIG.maxItems + ctx.boost;
      hold = !needMore;
      scanning = needMore && !!ctx.grid.querySelector(SEL.continuation);
    } else if (sfActive()) {
      // Shortフィードの一覧を使っているときは、標準の一覧は読み込まない
      hold = true;
    } else if (state.main === 'short') {
      // Shortタブは、開いた時点で目安の本数まで自動で読み込む(絞り込み前の本数で数える)
      const needMore = !ctx.scanAbort && ctx.shortAll < CONFIG.shortTarget + ctx.boost && ctx.total < CONFIG.maxItems + ctx.boost;
      hold = !needMore;
      const hasCont = !!ctx.grid.querySelector(SEL.continuation);
      scanning = needMore && hasCont;
      ctx.shortWhy = scanning ? '' : !hasCont ? 'end' : ctx.shortAll >= CONFIG.shortTarget + ctx.boost ? 'target' : ctx.total >= CONFIG.maxItems + ctx.boost ? 'max' : 'abort';
    } else if (ctx.visibleCount === 0 && ctx.total >= CONFIG.maxItems) {
      // 該当が無いまま上限まで読み込んだら、それ以上は読み込まない
      hold = true;
    }

    ctx.held = hold;
    ctx.scanning = scanning;
    if (hold) browse.setAttribute('data-sn-hold', '');
    else browse.removeAttribute('data-sn-hold');
    // 探索中は項目を一時的に隠す。表示が数件だと追加読み込みの要素が画面の外に残り、
    // YouTubeが次を読み込まないため、読み込みの要素を画面内に引き上げる。
    // 開いた直後の落ち着くまでの間(settleMs)も、途中経過を見せないよう隠す
    const settling = Date.now() < ctx.settleUntil;
    if (scanning || settling) browse.setAttribute('data-sn-scan', '');
    else browse.removeAttribute('data-sn-scan');
  }

  /* ===================== バー(UI) ===================== */

  function buildBar() {
    const mainTabs = h('div', { class: 'sn-tabs', role: 'tablist', 'aria-label': '種別' });
    for (const [key, label] of MAIN_TABS) {
      mainTabs.append(h('button', { class: 'sn-tab', role: 'tab', type: 'button', 'data-main': key }, label));
    }

    const status = h('div', { class: 'sn-status', 'aria-live': 'polite' });
    const viewBtn = h('button', { class: 'sn-view', type: 'button' });
    const row1 = h('div', { class: 'sn-row' }, mainTabs, h('div', { class: 'sn-spacer' }), status, viewBtn);

    const nowBadge = h('span', { class: 'sn-badge', 'data-count': 'now' }, '0');
    const upBadge = h('span', { class: 'sn-badge', 'data-count': 'upcoming' }, '0');
    const subNow = h(
      'button',
      { class: 'sn-tab', role: 'tab', type: 'button', 'data-sub': 'now' },
      '配信中',
      nowBadge,
      h('span', { class: 'sn-sep' }, '・'),
      '配信予定',
      upBadge
    );
    const subArchive = h('button', { class: 'sn-tab', role: 'tab', type: 'button', 'data-sub': 'archive' }, 'アーカイブ');
    const subTabs = h('div', { class: 'sn-tabs', role: 'tablist', 'aria-label': 'ライブの種類' }, subNow, subArchive);
    const row2 = h('div', { class: 'sn-row sn-subrow' }, subTabs, h('div', { class: 'sn-spacer' }));

    // グループで絞り込む操作。「ライブ」ではサブタブの行の右端、それ以外のタブでは足した行の右端に置く(updateUI で付け替える)
    const filterBtn = h('button', { class: 'sn-filter-btn', type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false' });
    const filterMenu = h('div', { class: 'sn-menu', role: 'listbox', 'aria-label': 'グループで絞り込み', hidden: '' });
    const filter = h('div', { class: 'sn-filter' }, filterBtn, filterMenu);
    const filterRow = h('div', { class: 'sn-row sn-filterrow', hidden: '' }, h('div', { class: 'sn-spacer' }));
    const noticeText = h('span', { class: 'sn-notice-text' });
    const noticeReset = h('button', { class: 'sn-reset', type: 'button' }, 'すべてに戻す');
    const noticeRow = h('div', { class: 'sn-row sn-noticerow', hidden: '', 'aria-live': 'polite' }, noticeText, noticeReset);

    const bar = h('div', { id: 'sn-bar' }, row1, row2, filterRow, noticeRow);

    bar.addEventListener('click', (e) => {
      const t = e.target.closest('button');
      if (!t || !bar.contains(t)) return;
      if (t.dataset.main) selectMain(t.dataset.main);
      else if (t.dataset.sub) selectSub(t.dataset.sub);
      else if (t.classList.contains('sn-filter-btn')) toggleMenu();
      else if (t.classList.contains('sn-opt')) chooseGroup(t.dataset.group || '');
      else if (t.classList.contains('sn-reset')) chooseGroup('');
      else if (t.classList.contains('sn-view')) cycleView();
      else if (t.classList.contains('sn-more') && sfActive()) sfMore();
      else if (t.classList.contains('sn-more')) {
        ctx.boost += CONFIG.boostStep;
        ctx.scanAbort = false;
        ctx.stall = 0;
        render();
      }
    });

    // グループの一覧: ↑↓で移動、Escで閉じる
    filter.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !filterMenu.hidden) {
        closeMenu();
        filterBtn.focus();
        e.preventDefault();
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      if (filterMenu.hidden) {
        if (!filterBtn.disabled) toggleMenu();
        return;
      }
      const opts = [...filterMenu.querySelectorAll('.sn-opt')];
      const i = opts.indexOf(document.activeElement);
      const next = e.key === 'ArrowDown' ? opts[Math.min(opts.length - 1, i + 1)] : opts[Math.max(0, i < 0 ? 0 : i - 1)];
      if (next) next.focus();
    });

    // 矢印キーでタブを移動
    bar.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const tab = e.target.closest('.sn-tab');
      if (!tab) return;
      const tabs = [...tab.parentElement.querySelectorAll('.sn-tab')];
      const i = tabs.indexOf(tab);
      const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      next.focus();
      next.click();
      e.preventDefault();
    });

    return { bar, status, viewBtn, subRow: row2, nowBadge, upBadge, filter, filterBtn, filterMenu, filterRow, noticeRow, noticeText, noticeReset };
  }

  function updateUI() {
    if (!ctx) return;
    const { bar, status, viewBtn, subRow, nowBadge, upBadge } = ctx.ui;

    for (const t of bar.querySelectorAll('[data-main]')) {
      const sel = t.dataset.main === state.main;
      t.setAttribute('aria-selected', String(sel));
      t.tabIndex = sel ? 0 : -1;
    }
    subRow.hidden = state.main !== 'live';
    for (const t of bar.querySelectorAll('[data-sub]')) {
      const sel = t.dataset.sub === state.sub;
      t.setAttribute('aria-selected', String(sel));
      t.tabIndex = sel ? 0 : -1;
    }

    nowBadge.textContent = String(ctx.counts.now);
    upBadge.textContent = String(ctx.counts.upcoming);

    // 表示切り替えのアイコン(いまのモードの形)
    const disabled = state.main === 'post';
    if (viewBtn.dataset.mode !== state.view) {
      viewBtn.replaceChildren(ICONS[state.view]());
      viewBtn.dataset.mode = state.view;
    }
    const label = `表示: ${VIEW_LABEL[state.view]}(クリックで切り替え)`;
    viewBtn.title = disabled ? '投稿タブでは表示を切り替えられません' : label;
    viewBtn.setAttribute('aria-label', viewBtn.title);
    viewBtn.disabled = disabled;

    // 探索の状況
    status.replaceChildren();
    if (sfActive()) {
      if (SF.state === 'loading') status.append('Shortフィードを読み込み中…');
      else {
        status.append(`${ctx.visibleCount}本を表示(取得${SF.items.size}本のうち登録外${SF.other || 0}本を除外)`);
        status.append(h('button', { class: 'sn-more', type: 'button' }, 'さらに読み込む'));
      }
    } else if (state.main === 'short') {
      if (SF.state === 'fail') status.append(`Shortフィード取得失敗(${SF.log[SF.log.length - 1] || ''}) `);
      if (ctx.scanning) {
        status.append(`Shortを読み込み中… ${ctx.shortAll}本`);
      } else {
        const why = { end: 'フィードの終わりまで', target: '目安の本数まで', max: '読み込み上限まで', abort: '読み込みが止まったため' }[ctx.shortWhy] || '';
        status.append(`${ctx.shortAll}本(フィード${ctx.total}件を確認・${why})`);
        if (ctx.held) status.append(h('button', { class: 'sn-more', type: 'button' }, 'さらに読み込む'));
      }
    } else if (state.main === 'live' && state.sub === 'now') {
      if (ctx.scanning) {
        status.append(`探索中… ${ctx.total}件を確認`);
      } else if (ctx.held) {
        status.append(`${ctx.total}件を確認済み`);
        status.append(h('button', { class: 'sn-more', type: 'button' }, 'さらに探す'));
      }
    }

    updateFilterUI();
    applyViewAttr();
  }

  /* ===================== グループでの絞り込み(UI) ===================== */

  function groupLabel(id) {
    if (!id) return 'すべて';
    const g = GR.byId.get(id);
    return g ? g.name : 'すべて';
  }

  function updateFilterUI() {
    const { filter, filterBtn, filterRow, subRow, noticeRow, noticeText, noticeReset } = ctx.ui;
    const on = GR.settings.showFeedFilter;
    filter.hidden = !on;
    filterRow.hidden = !on || state.main === 'live';
    const host = state.main === 'live' ? subRow : filterRow;
    if (filter.parentNode !== host) host.append(filter);

    const active = filterActive();
    const label = active ? groupLabel(state.group) : 'すべて';
    if (filterBtn.dataset.label !== label) {
      filterBtn.dataset.label = label;
      filterBtn.replaceChildren(ICONS.filter(), h('span', { class: 'sn-filter-name' }, label), h('span', { class: 'sn-caret', 'aria-hidden': 'true' }, '▾'));
    }
    filterBtn.classList.toggle('sn-active', active);
    filterBtn.disabled = !GR.ok;
    filterBtn.title = GR.ok ? 'グループで絞り込み' : 'サイドバー(管理画面)でグループを作ると使えます';
    filterBtn.setAttribute('aria-label', `グループで絞り込み: ${label}`);
    if (!GR.ok) closeMenu();

    // 除外した件数・該当が0件のときの案内
    noticeText.replaceChildren();
    let show = false;
    // 旧「登録チャンネルページ整理くん」が有効のままだと、タブバーが二重になり表示も食い違う
    if (document.querySelectorAll('#sn-bar').length > 1) {
      noticeText.append('旧「登録チャンネルページ整理くん」も有効です。拡張機能のページで無効にするか削除してください。');
      show = true;
    }
    if (active) {
      const settling = Date.now() < ctx.settleUntil;
      const loading = !ctx.held && !!ctx.grid.querySelector(SEL.continuation);
      const empty = ctx.visibleCount === 0 && !ctx.scanning && !settling && !loading;
      if (empty) {
        noticeText.append('このグループの項目はありません。');
        show = true;
      } else if (ctx.visibleCount === 0 && !ctx.scanning && !settling) {
        noticeText.append('このグループの項目を探しています…');
        show = true;
      }
      if (ctx.excluded > 0) {
        noticeText.append(`チャンネルが判別できない項目 ${ctx.excluded}件を除外しています。`);
        show = true;
      }
    }
    noticeReset.hidden = !active;
    noticeRow.hidden = !show;
  }

  function closeMenu() {
    if (!ctx) return;
    const { filterBtn, filterMenu } = ctx.ui;
    filterMenu.hidden = true;
    filterBtn.setAttribute('aria-expanded', 'false');
  }

  function toggleMenu() {
    const { filterBtn, filterMenu } = ctx.ui;
    if (!filterMenu.hidden) {
      closeMenu();
      return;
    }
    if (!GR.ok) return;
    filterMenu.replaceChildren();
    const add = (id, label, depth, count) => {
      const sel = id === (filterActive() ? state.group : '');
      const b = h('button', { class: 'sn-opt', type: 'button', role: 'option', 'data-group': id, 'aria-selected': String(sel), tabindex: '-1' });
      b.style.paddingLeft = `${12 + depth * 16}px`;
      b.append(h('span', { class: 'sn-opt-name' }, `${sel ? '✓ ' : ''}${label}`));
      if (count != null) b.append(h('span', { class: 'sn-opt-count' }, String(count)));
      filterMenu.append(b);
    };
    add('', 'すべて', 0, null);
    for (const { group, depth } of YTCG.flatTree(GR.groups)) add(group.id, group.name, group.id === GR.ungId ? 0 : depth, GR.totals.get(group.id) || 0);
    filterMenu.hidden = false;
    filterBtn.setAttribute('aria-expanded', 'true');
    const cur = filterMenu.querySelector('[aria-selected="true"]') || filterMenu.querySelector('.sn-opt');
    if (cur) cur.focus();
  }

  function chooseGroup(id) {
    closeMenu();
    ctx.filterTouched = true;
    const next = id && GR.byId.has(id) ? id : '';
    if (next !== state.group) {
      state.group = next;
      try {
        if (GR.settings.rememberFeedFilter) chrome.storage.local.set({ [CONFIG.filterKey]: next });
      } catch (_) {
        /* ignore */
      }
      render();
      scheduleMeasure();
      window.scrollTo({ top: 0 });
    }
    ctx.ui.filterBtn.focus();
  }

  function applyViewAttr() {
    if (!ctx) return;
    // 投稿タブはYouTube標準の表示のまま
    ctx.browse.setAttribute('data-sn-view', state.main === 'post' ? 'large' : state.view);
    ctx.browse.setAttribute('data-sn-main', state.main);
    if (sfActive()) ctx.browse.setAttribute('data-sn-shortfeed', '');
    else ctx.browse.removeAttribute('data-sn-shortfeed');
  }

  /* ===================== 操作 ===================== */

  function selectMain(key) {
    if (state.main === key) return;
    state.main = key;
    if (key === 'live') state.sub = 'now';
    ctx.scanAbort = false;
    ctx.stall = 0;
    if (key === 'short') sfStart();
    render();
    scheduleMeasure();
    window.scrollTo({ top: 0 });
  }

  function selectSub(key) {
    if (state.sub === key) return;
    state.sub = key;
    ctx.scanAbort = false;
    ctx.stall = 0;
    render();
    scheduleMeasure();
    window.scrollTo({ top: 0 });
  }

  function cycleView() {
    if (state.main === 'post') return;
    state.view = VIEWS[(VIEWS.indexOf(state.view) + 1) % VIEWS.length];
    saveView();
    updateUI();
    scheduleMeasure();
  }

  /* 「小」の幅(「大」の60%)と一列表示のサムネイル幅(「大」の40%)を、「大」で表示されている1枚の幅から求める */
  let measureTimer = 0;
  function scheduleMeasure() {
    clearTimeout(measureTimer);
    measureTimer = setTimeout(measureLayout, 60);
  }

  function measureLayout() {
    if (!ctx) return;
    const { browse, grid } = ctx;
    const prev = browse.getAttribute('data-sn-view');
    browse.setAttribute('data-sn-view', 'large');
    let m = null;
    for (const it of grid.querySelectorAll(SEL.item)) {
      if (it.classList.contains('sn-hidden')) continue;
      const r = it.getBoundingClientRect();
      if (r.width > 50) {
        const cs = getComputedStyle(it);
        m = {
          w: r.width,
          ml: parseFloat(cs.marginLeft) || 0,
          mr: parseFloat(cs.marginRight) || 0,
          mb: parseFloat(cs.marginBottom) || 0,
        };
        break;
      }
    }
    browse.setAttribute('data-sn-view', prev || 'large');
    if (!m) return;
    // 余白も含めて「大」の60%にそろえる(余白が固定のままだと列数が増えにくいため)。
    // 端数で折り返さないよう、幅から0.5px引く
    const k = CONFIG.smallScale;
    const set = (n, v) => browse.style.setProperty(n, `${v.toFixed(2)}px`);
    set('--sn-small-w', m.w * k - 0.5);
    set('--sn-small-ml', m.ml * k);
    set('--sn-small-mr', m.mr * k);
    set('--sn-small-mb', m.mb * k);
    // 一列表示のサムネイル幅: 「大」のサムネイル幅(=項目の幅)の40%
    set('--sn-list-thumb', Math.max(CONFIG.listThumbMinPx, m.w * CONFIG.listThumbScale));
  }

  /* ===================== 取り付け・取り外し ===================== */

  function mount() {
    const browse = document.querySelector(`${SEL.browse}:not([hidden])`) || document.querySelector(SEL.browse);
    const grid = browse && browse.querySelector(SEL.grid);
    if (!grid || !grid.parentNode) return false;
    if (ctx && ctx.grid === grid && ctx.ui.bar.isConnected) return true;
    unmount();
    sfReset();

    const container = grid.querySelector(':scope > #contents') || grid.querySelector('#contents');
    const ui = buildBar();
    // 高さ0の目印。メニューが画面上部に固定される前の「本来の位置」を求めるために使う
    const anchor = h('div', { id: 'sn-anchor' });
    grid.parentNode.insertBefore(anchor, grid);
    grid.parentNode.insertBefore(ui.bar, grid);

    ctx = {
      browse,
      grid,
      container,
      ui,
      anchor,
      offset: 0,
      fixMode: 'bar',
      lastFix: null,
      settleUntil: Date.now() + CONFIG.settleMs,
      divider: null,
      observer: null,
      counts: { now: 0, upcoming: 0 },
      total: 0,
      tail: 0,
      visibleCount: 0,
      boost: 0,
      shortAll: 0,
      held: false,
      scanning: false,
      scanAbort: false,
      lastTotal: -1,
      stall: 0,
      excluded: 0,
      filterTouched: false,
    };

    // 画面を開いた直後は、常に「ライブ」の「配信中・配信予定」
    state.main = 'live';
    state.sub = 'now';
    lastPromote = null;
    state.group = ''; // 既定は「すべて」(引き継ぐ設定がONのときだけ、保存された選択を戻す)
    applyRemembered();

    browse.setAttribute('data-sn-active', '');
    applyViewAttr();

    let timer = 0;
    ctx.observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        scan();
        render();
      }, CONFIG.scanDelayMs);
    });
    ctx.observer.observe(grid, { childList: true, subtree: true, characterData: true });

    scan();
    render();
    scheduleMeasure();

    // 開いた直後は一覧を出さずに待ち、判定や表示が落ち着いてから最初の表示を行う
    const mine = ctx;
    setTimeout(() => {
      if (ctx !== mine) return;
      scan();
      render();
      scheduleMeasure();
    }, CONFIG.settleMs + 30);
    return true;
  }

  function unmount() {
    if (!ctx) return;
    ctx.observer && ctx.observer.disconnect();
    ctx.ui.bar.remove();
    ctx.anchor && ctx.anchor.remove();
    ctx.divider && ctx.divider.remove();
    ctx.sfBox && ctx.sfBox.remove();
    ctx.browse.removeAttribute('data-sn-shortfeed');
    ctx.browse.removeAttribute('data-sn-active');
    ctx.browse.removeAttribute('data-sn-hold');
    ctx.browse.removeAttribute('data-sn-scan');
    ctx.browse.removeAttribute('data-sn-view');
    ctx.browse.removeAttribute('data-sn-main');
    ctx.browse.style.removeProperty('--sn-small-w');
    ctx.browse.style.removeProperty('--sn-offset-bar');
    ctx.browse.style.removeProperty('--sn-offset-cont');
    ctx = null;
  }

  /* タブメニューと一番上のサムネイルが重なっていたら、重なる分だけ一覧を下げる。
     YouTube側の余白の取り方に依らず、画面の一番上にいるときの実際の位置を測って合わせる。
     下げ方は2段構え:
       1) メニューの下に余白を足す(メニューより後ろにある一覧ごと下がる)
       2) 1)で位置が変わらなければ、一覧の中身の上に余白を足す
     測り直しは描画のたび・1秒ごと・画面の一番上に戻ったときに行い、収まるまで続ける */
  let fixRaf = 0;
  function scheduleFix() {
    cancelAnimationFrame(fixRaf);
    fixRaf = requestAnimationFrame(fixOffset);
  }

  function getContainer() {
    if (ctx.container && ctx.container.isConnected) return ctx.container;
    ctx.container = ctx.grid.querySelector(':scope > #contents') || ctx.grid.querySelector('#contents');
    return ctx.container;
  }

  function setOffset(mode, px) {
    const st = ctx.browse.style;
    const v = `${Math.max(0, px).toFixed(1)}px`;
    st.setProperty('--sn-offset-bar', mode === 'bar' ? v : '0px');
    st.setProperty('--sn-offset-cont', mode === 'cont' ? v : '0px');
    ctx.fixMode = mode;
    ctx.offset = Math.max(0, px);
  }

  function fixOffset() {
    if (!ctx) return;
    const diag = (t) => { try { ctx.ui.bar.dataset.snDiag = t; ctx.ui.bar.dataset.snVer = '1.0.2'; } catch (e) {} };
    if (ctx.browse.hasAttribute('data-sn-scan')) { diag('skip: 探索中'); return; }
    // スクロール中はメニューが画面上部に固定されて動くので、一番上にいるときだけ測る
    if (window.scrollY > 2) { diag(`skip: scrollY=${Math.round(window.scrollY)}(一番上で測る)`); return; }

    let top = Infinity;
    let n = 0;
    for (const el of topLevelItems(ctx.grid)) {
      if (el.classList.contains('sn-hidden') || !el.dataset.snType) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.top < top) top = r.top;
      if (++n >= 60) break;
    }
    if (top === Infinity) { diag(`skip: 測れる項目なし(grid=${ctx.grid ? ctx.grid.tagName : 'なし'} items=${topLevelItems(ctx.grid).length})`); return; }

    const barBottom = ctx.ui.bar.getBoundingClientRect().bottom;
    const overlap = barBottom + CONFIG.minGapPx - top; // 正: 重なっている(または余白が足りない)
    diag(`bar=${Math.round(barBottom)} first=${Math.round(top)} offset=${ctx.offset.toFixed(0)} mode=${ctx.fixMode}`);
    if (Math.abs(overlap) < 1) {
      ctx.lastFix = null;
      return;
    }
    // 余白が多すぎるときは、足した分だけ戻す(足していなければ何もしない)
    if (overlap < 0 && ctx.offset <= 0) return;

    // 前回メニューの下に余白を足したのに、位置がほとんど変わっていなければ、この方法では動かせない
    if (ctx.fixMode === 'bar' && ctx.lastFix && ctx.lastFix.mode === 'bar' && ctx.lastFix.delta > 2 && Math.abs(overlap - ctx.lastFix.before) < 1) {
      // メニューの下に足した余白は効いていないので、いま測った重なり分だけを一覧の上に足す
      setOffset('cont', overlap);
      ctx.lastFix = { mode: 'cont', delta: overlap, before: overlap };
      return;
    }
    ctx.lastFix = { mode: ctx.fixMode, delta: overlap, before: overlap };
    setOffset(ctx.fixMode, ctx.offset + overlap);
  }


  /* ===================== Shortフィード(/feed/subscriptions/shorts)から読む =====================
     登録チャンネルのフィードには、Shortの棚が12本ほどしか出てこない。Shortタブを押したときだけ、
     登録チャンネルのShortフィードを読みに行き、タイトル付きの一覧にする。取れなければ従来の棚表示に戻る。 */

  const SF = { state: 'idle', items: new Map(), cards: new Map(), calls: 0, log: [], key: '', context: null, token: '', seq: '', busy: false, oembed: 0 };

  function sfReset() {
    SF.state = 'idle';
    SF.items = new Map();
    SF.cards = new Map();
    SF.calls = 0;
    SF.log = [];
    SF.key = '';
    SF.context = null;
    SF.token = '';
    SF.seq = '';
    SF.busy = false;
    SF.oembed = 0;
  }

  const sfNote = (t) => {
    SF.log.push(t);
    try {
      ctx && ctx.ui.bar.setAttribute('data-sn-sf', SF.log.join(' | '));
      console.info('[YTCG] Shortフィード:', t);
    } catch (_) {
      /* ignore */
    }
  };

  function extractJson(text, re) {
    const m = re.exec(text);
    if (!m) return null;
    const s0 = text.indexOf('{', m.index + m[0].length - 1);
    if (s0 < 0) return null;
    let d = 0;
    let str = false;
    let esc = false;
    for (let j = s0; j < text.length; j++) {
      const c = text[j];
      if (str) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') str = false;
        continue;
      }
      if (c === '"') str = true;
      else if (c === '{') d++;
      else if (c === '}' && --d === 0) {
        try {
          return JSON.parse(text.slice(s0, j + 1));
        } catch (_) {
          return null;
        }
      }
    }
    return null;
  }

  function walkObj(node, visit, seen = new WeakSet(), depth = 0) {
    if (!node || typeof node !== 'object' || depth > 40 || seen.has(node)) return;
    seen.add(node);
    if (!Array.isArray(node) && visit(node) === false) return;
    for (const k in node) {
      const v = node[k];
      if (v && typeof v === 'object') walkObj(v, visit, seen, depth + 1);
    }
  }

  const rtext = (v) => (!v ? '' : typeof v === 'string' ? v : typeof v.simpleText === 'string' ? v.simpleText : Array.isArray(v.runs) ? v.runs.map((r) => (r && r.text) || '').join('') : '');

  /* YouTubeの応答から、Shortの項目と「続き」の目印を集める。戻り値: 新しく増えた本数 */
  /* 続きの目印(base64)の中に「登録チャンネルのShortフィード」を示す文字があるか */
  function isSubToken(t) {
    try {
      const b = decodeURIComponent(String(t)).replace(/-/g, '+').replace(/_/g, '/');
      return atob(b).includes('subscriptions_shorts');
    } catch (_) {
      return false;
    }
  }

  function sfCollect(data, cont) {
    let added = 0;
    const toks = [];
    // 「続き」の応答は entries(次に再生するShortの並び)だけを使う。応答の他の欄(おすすめ等)に入っている動画は取り込まない
    const roots = data && Array.isArray(data.entries) ? data.entries : [data];
    SF.lastEntries = roots === undefined || !(data && Array.isArray(data.entries)) ? -1 : data.entries.length;
    walkObj(roots, (n) => {
      const w = n.reelWatchEndpoint;
      if (w && typeof w.videoId === 'string' && /^[\w-]{11}$/.test(w.videoId)) {
        let title = '';
        let chName = '';
        let path = '';
        let path2 = '';
        walkObj(w, (m) => {
          if (!title && m.reelTitleText) title = rtext(m.reelTitleText);
          if (!chName && m.channelTitleText) chName = rtext(m.channelTitleText);
          if (!path) {
            const b = m.channelNavigationEndpoint && m.channelNavigationEndpoint.browseEndpoint;
            if (b && typeof b.browseId === 'string') {
              path = b.canonicalBaseUrl && /^\/[^/]/.test(b.canonicalBaseUrl) ? b.canonicalBaseUrl : `/channel/${b.browseId}`;
              path2 = `/channel/${b.browseId}`;
            }
          }
        });
        const prev = SF.items.get(w.videoId);
        if (!prev) {
          SF.items.set(w.videoId, { id: w.videoId, title: title.trim(), chName: chName.trim(), path, path2, cont: !!cont });
          added++;
        } else {
          if (!prev.title && title) prev.title = title.trim();
          if (!prev.chName && chName) prev.chName = chName.trim();
          if (!prev.path && path) prev.path = path;
        }
      }
      if (w && typeof w.videoId === 'string') return false; // この動画の中にさらに入っている動画(関連など)は取り込まない
    });
    walkObj(data, (n) => {
      if (n.continuationCommand && typeof n.continuationCommand.token === 'string') toks.push(n.continuationCommand.token);
      if (typeof n.sequenceContinuation === 'string') SF.seq = n.sequenceContinuation;
    });
    if (toks.length) {
      // 登録チャンネルのShortフィード用の目印を優先する(おすすめ用を使うと登録外のShortが返ってくる)
      const pref = toks.find(isSubToken);
      SF.token = pref || toks[toks.length - 1];
      SF.tokenSub = !!pref;
      SF.tokenCount = toks.length;
    }
    return added;
  }

  /* YouTubeのページ自身が内部APIを呼ぶときと同じ、ログイン済みを示す署名ヘッダー。
     署名はこのページのCookie(SAPISID)から作り、同じ youtube.com へのリクエストにだけ付ける */
  async function sfHeaders() {
    const h0 = { 'content-type': 'application/json' };
    try {
      const cl = (SF.context && SF.context.client) || {};
      if (cl.clientVersion) {
        h0['X-Youtube-Client-Name'] = '1';
        h0['X-Youtube-Client-Version'] = String(cl.clientVersion);
      }
      if (cl.visitorData) h0['X-Goog-Visitor-Id'] = String(cl.visitorData);
      h0['X-Youtube-Bootstrap-Logged-In'] = 'true';
      h0['X-Youtube-Utc-Offset'] = String(-new Date().getTimezoneOffset());
      try {
        h0['X-Youtube-Time-Zone'] = Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch (_) {
        /* ignore */
      }
      const m = /(?:^|;\s*)(?:SAPISID|__Secure-3PAPISID)=([^;]+)/.exec(document.cookie);
      if (m) {
        const ts = Math.floor(Date.now() / 1000);
        const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(`${ts} ${m[1]} ${location.origin}`));
        const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
        h0.Authorization = `SAPISIDHASH ${ts}_${hex}`;
        h0['X-Origin'] = location.origin;
        h0['X-Goog-AuthUser'] = '0';
        SF.auth = true;
      }
    } catch (_) {
      /* 署名が作れなくても、そのまま試す */
    }
    return h0;
  }

  async function sfPost(body, ep) {
    const headers = await sfHeaders();
    const r = await fetch(`/youtubei/v1/${ep}?prettyPrint=false`, {
      method: 'POST',
      credentials: 'same-origin',
      headers,
      body: JSON.stringify(Object.assign({ context: SF.context }, body)),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  async function sfFetchMore(maxCalls, goal) {
    for (let i = 0; i < maxCalls && SF.items.size < goal && ctx; i++) {
      const body = SF.token ? { continuation: SF.token } : SF.seq ? { sequenceParams: SF.seq } : null;
      if (!body || !SF.context) {
        sfNote(`続きの目印なし(token=${!!SF.token} seq=${!!SF.seq} context=${!!SF.context})`);
        return;
      }
      const before = SF.items.size;
      const usedToken = SF.token;
      const usedSeq = SF.seq;
      try {
        // 本物のShortフィードは /youtubei/v1/browse に continuation を送って続きを取る(reel_watch_sequence は1本ずつ再生する画面用)
        const data = await sfPost(body, body.continuation ? 'browse' : 'reel/reel_watch_sequence');
        SF.calls++;
        const n = sfCollect(data, true);
        sfNote(`続き${SF.calls}回目 +${n}本(entries=${SF.lastEntries} 登録Short用の目印=${!!SF.tokenSub} 署名=${!!SF.auth})`);
        if (!n || (SF.token === usedToken && SF.seq === usedSeq)) {
          sfNote('これ以上増えない');
          return;
        }
      } catch (e) {
        sfNote(`続きの取得に失敗: ${e.message}`);
        return;
      }
      if (SF.items.size === before) return;
      sfRender();
    }
  }

  /* タイトルやチャンネルが取れなかった動画は、oEmbed(同じ youtube.com の公開API)で補う */
  async function sfFillTitles() {
    const todo = [...SF.items.values()].filter((it) => !it.title || !it.path).slice(0, 150);
    let i = 0;
    const worker = async () => {
      while (i < todo.length && ctx) {
        const it = todo[i++];
        try {
          const r = await fetch(`/oembed?url=${encodeURIComponent(`https://www.youtube.com/shorts/${it.id}`)}&format=json`, { credentials: 'same-origin' });
          if (!r.ok) continue;
          const j = await r.json();
          SF.oembed++;
          if (j.title && !it.title) it.title = String(j.title).trim();
          if (j.author_name && !it.chName) it.chName = String(j.author_name).trim();
          if (j.author_url && !it.path) {
            try {
              it.path = new URL(j.author_url, location.origin).pathname;
            } catch (_) {
              /* ignore */
            }
          }
          if (SF.oembed % 6 === 0) sfRender();
        } catch (_) {
          /* 取れなかった分は、タイトル未取得のまま */
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    sfNote(`oEmbedで補完 ${SF.oembed}本`);
    sfRender();
  }

  async function sfStart() {
    if (SF.state !== 'idle' || !ctx) return;
    SF.state = 'loading';
    applyViewAttr();
    updateUI();
    try {
      const res = await fetch('/feed/subscriptions/shorts', { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      const data = extractJson(html, /ytInitialData["']?\]?\s*=\s*\{/);
      const key = (/"INNERTUBE_API_KEY":"([^"]+)"/.exec(html) || [])[1] || '';
      const context = extractJson(html, /"INNERTUBE_CONTEXT":\s*\{/);
      SF.key = key;
      SF.context = context;
      if (!data) throw new Error('ページのデータを読めない');
      const n = sfCollect(data);
      sfNote(`最初のページ ${n}本 (key=${!!key} context=${!!context} token=${!!SF.token}(${SF.tokenCount || 0}個中 登録Short用=${!!SF.tokenSub}) seq=${!!SF.seq})`);
      if (!SF.items.size) throw new Error('Shortが見つからない');
      sfRender();
      await sfFetchMore(8, CONFIG.shortTarget);
      SF.state = 'ok';
      render();
      await sfFillTitles();
    } catch (e) {
      sfNote(`取得失敗: ${e.message}`);
      SF.state = SF.items.size ? 'ok' : 'fail';
      if (ctx) render();
    }
  }

  async function sfMore() {
    if (SF.busy || SF.state !== 'ok') return;
    SF.busy = true;
    try {
      await sfFetchMore(5, SF.items.size + 30);
      render();
      await sfFillTitles();
    } finally {
      SF.busy = false;
      if (ctx) updateUI();
    }
  }

  const sfActive = () => state.main === 'short' && (SF.state === 'loading' || SF.state === 'ok');

  function sfCard(it) {
    const a = h('a', { class: 'sn-sc', href: `/shorts/${it.id}` });
    // 公開直後のShortは縦長のサムネイルがまだ無く、YouTubeが小さな灰色の画像(幅120px)を返す。その場合は次の候補に替える
    const urls = ['oardefault', 'hq2', 'hqdefault'].map((n) => `https://i.ytimg.com/vi/${it.id}/${n}.jpg`);
    let k = 0;
    const img = h('img', { alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', src: urls[0] });
    const next = () => {
      if (++k < urls.length) img.src = urls[k];
    };
    img.addEventListener('error', next);
    img.addEventListener('load', () => {
      if (img.naturalWidth > 0 && img.naturalWidth <= 120) next();
    });
    a.append(h('div', { class: 'sn-sc-th' }, img), h('div', { class: 'sn-sc-title' }));
    const box = h('div', { class: 'sn-card' }, a, h('div', { class: 'sn-sc-chbox' }));
    return box;
  }

  /* 一覧の更新。ids があれば、そのグループのチャンネルのShortだけを表示する。戻り値: 表示本数・チャンネル不明の本数 */
  function sfRender(ids) {
    if (!ctx) return { shown: 0, unknown: 0 };
    const fOn = ids !== undefined ? !!ids : filterActive();
    const useIds = ids || (fOn ? YTCG.descendantIds(GR.groups, state.group) : null);
    let box = ctx.sfBox;
    if (!box || !box.isConnected) {
      box = h('div', { id: 'sn-shorts' });
      ctx.anchor.parentNode.insertBefore(box, ctx.grid);
      ctx.sfBox = box;
    }
    let shown = 0;
    let unknown = 0;
    let other = 0;
    for (const it of SF.items.values()) {
      let card = SF.cards.get(it.id);
      if (!card || !card.isConnected) {
        card = sfCard(it);
        SF.cards.set(it.id, card);
        box.append(card);
      }
      const t = card.querySelector('.sn-sc-title');
      const want = it.title || '(タイトル取得中)';
      if (t.textContent !== want) t.textContent = want;
      const cb = card.querySelector('.sn-sc-chbox');
      const sig = `${it.path}|${it.chName}`;
      if (cb.dataset.sig !== sig) {
        cb.dataset.sig = sig;
        cb.replaceChildren();
        if (it.path) cb.append(h('a', { class: 'sn-sc-ch', href: it.path }, it.chName || it.path));
        else if (it.chName) cb.append(h('span', { class: 'sn-sc-ch' }, it.chName));
      }
      let ok = true;
      // 「続き」で取れたものには、登録していないチャンネルのおすすめが混ざる。登録済みのチャンネル(サイドバーで取得済み)のものだけ残す
      if (it.cont) {
        const known = [it.path, it.path2].some((x) => x && GR.pathIdx.has(normPath(x)));
        if (!known) {
          card.classList.add('sn-hidden');
          other++;
          continue;
        }
      }
      if (useIds) {
        const v = groupMatch(card, useIds);
        ok = v === 'yes';
        if (v === 'unknown') unknown++;
      }
      card.classList.toggle('sn-hidden', !ok);
      if (ok) shown++;
    }
    SF.other = other;
    if (other && SF.sampleN !== other && ctx.ui) {
      SF.sampleN = other;
      const ex = [...SF.items.values()].filter((it) => it.cont && ![it.path, it.path2].some((x) => x && GR.pathIdx.has(normPath(x)))).slice(0, 6).map((it) => `${it.chName || '?'}(${it.path || '-'})`);
      try {
        ctx.ui.bar.setAttribute('data-sn-sf-other', ex.join(' / '));
      } catch (_) {
        /* ignore */
      }
    }
    return { shown, unknown };
  }

  /* ===================== 定期処理 ===================== */

  function onFeedPage() {
    return location.pathname === CONFIG.feedPath;
  }

  function tick() {
    if (!onFeedPage()) {
      unmount();
      return;
    }
    if (!mount()) return;

    // 開始時刻が来た配信予定を「配信中」へ移す
    const now = Date.now();
    let moved = false;
    for (const el of GR.settings.promoteOverdue ? ctx.grid.querySelectorAll(`${SEL.item}[data-sn-live="upcoming"][data-sn-start]`) : []) {
      if (Number(el.dataset.snStart) <= now) {
        el.dataset.snLive = 'now';
        el.dataset.snPromoted = '1'; // 判定し直しても「配信予定」に戻らないようにする
        moved = true;
      }
    }
    if (ctx.divider && getContainer() && ctx.divider.parentNode !== getContainer()) moved = true;
    if (moved) render();
    scheduleFix(); // 1秒ごとにも重なりを確かめる(画像の読み込みなどで位置が動くため)

    // 追加読み込みが止まっているときは、スクロール系のイベントで再開を促す
    if (!ctx.held && ctx.grid.querySelector(SEL.continuation)) {
      if (ctx.total === ctx.lastTotal) ctx.stall++;
      else ctx.stall = 0;
      ctx.lastTotal = ctx.total;
      if (ctx.stall === 2) {
        window.dispatchEvent(new Event('scroll'));
        window.dispatchEvent(new Event('resize'));
      }
      // それでも増えなければ探索を打ち切る(画面が空のまま続かないようにする安全装置)
      if (ctx.stall >= 5 && ctx.scanning) {
        ctx.scanAbort = true;
        ctx.stall = 0;
        render();
      }
    } else {
      ctx.stall = 0;
      ctx.lastTotal = ctx.total;
    }
  }

  /* ===================== 起動 ===================== */

  loadView();
  loadGroupData();
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[CONFIG.stateKey]) return;
      loadGroups(changes[CONFIG.stateKey].newValue); // 管理画面での変更を、開いているフィードにも反映する
      applyRemembered();
      syncPromote();
      if (ctx) render();
    });
  } catch (_) {
    /* ignore */
  }
  // 一覧の外を押したら閉じる
  document.addEventListener('click', (e) => {
    if (ctx && !ctx.ui.filterMenu.hidden && !ctx.ui.filter.contains(e.target)) closeMenu();
  });
  document.addEventListener('yt-navigate-finish', tick);
  document.addEventListener('yt-page-data-updated', tick);
  window.addEventListener('popstate', tick);
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!ctx) return;
      if (state.view !== 'large') measureLayout();
      scheduleFix();
    }, 250);
  });
  // 画面の一番上に戻ったときにも重なりを確かめる
  let scrollTimer = 0;
  window.addEventListener(
    'scroll',
    () => {
      if (!ctx || window.scrollY > 2) return;
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(scheduleFix, 120);
    },
    { passive: true }
  );
  setInterval(tick, CONFIG.tickMs);
  tick();
})();
