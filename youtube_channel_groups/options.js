(() => {
"use strict";
const KEY = "ytcgState", UNG = YTCG.UNG;
let state = YTCG.defaults();
let filterGroup = "", orderGroup = "";
const $ = id => document.getElementById(id);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt !== undefined) e.textContent = txt; return e; };
const uid = () => "g-" + Math.random().toString(36).slice(2, 10);
const indent = (name, depth) => "　".repeat(depth) + name;

async function save(msg) {
  state = YTCG.normalize(state);
  await chrome.storage.local.set({ [KEY]: state });
  $("status").textContent = msg || "保存しました";
}

// 階層順のグループ選択肢を作る。exclude に含まれるIDは除く。
function fillGroupSelect(select, { top, exclude, withUngrouped, labelFn }) {
  select.replaceChildren();
  if (top) { const o = el("option", "", top.label); o.value = top.value; select.append(o); }
  for (const { group, depth } of YTCG.flatTree(state.groups)) {
    if (exclude?.has(group.id)) continue;
    if (group.id === UNG && !withUngrouped) continue;
    const o = el("option", "", labelFn ? labelFn(group, depth) : indent(group.name, depth)); o.value = group.id; select.append(o);
  }
}

function renderSettings() {
  $("opt-hide-explore").checked = !!state.settings.hideExplore;
  $("opt-hide-services").checked = !!state.settings.hideServices;
  $("opt-show-live").checked = !!state.settings.showLive;
  $("opt-hide-home").checked = !!state.settings.hideHome;
  $("opt-hide-shorts").checked = !!state.settings.hideShorts;
  $("opt-hide-mypage").checked = !!state.settings.hideMyPage;
  $("opt-hide-report").checked = !!state.settings.hideReportHistory;
  $("opt-feed-promote").checked = !!state.settings.promoteOverdue;
  $("opt-feed-filter").checked = !!state.settings.showFeedFilter;
  $("opt-feed-remember").checked = !!state.settings.rememberFeedFilter;
}

function countDirect(id) { return Object.values(state.channels).filter(c => (c.groupId || UNG) === id).length; }
function countTotal(id) { const ids = YTCG.descendantIds(state.groups, id); return Object.values(state.channels).filter(c => ids.has(c.groupId || UNG)).length; }

function swapWithSibling(g, dir) {
  const sibs = YTCG.childrenOf(state.groups, g.parentId);
  const i = sibs.indexOf(g), other = sibs[i + dir];
  if (!other) return false;
  const a = state.groups.indexOf(g), b = state.groups.indexOf(other);
  [state.groups[a], state.groups[b]] = [state.groups[b], state.groups[a]];
  return true;
}

function renderGroups() {
  const box = $("groups"); box.replaceChildren();
  for (const { group: g, depth } of YTCG.flatTree(state.groups)) {
    const row = el("div", "group-row"); row.style.paddingLeft = depth * 24 + "px";
    const input = el("input"); input.value = g.name; input.maxLength = 40; input.setAttribute("aria-label", "グループ名"); input.disabled = g.id === UNG;
    input.addEventListener("change", async () => {
      const v = input.value.trim();
      if (v) g.name = v; else input.value = g.name;
      await save(); renderAll();
    });
    const count = el("span", "count", countTotal(g.id) + " 件"); count.title = "下位グループを含む件数";
    row.append(input, count);
    if (g.id !== UNG) {
      const parent = el("select"); parent.setAttribute("aria-label", "親グループ");
      fillGroupSelect(parent, { top: { value: "", label: "（最上位）" }, exclude: YTCG.descendantIds(state.groups, g.id) });
      parent.value = g.parentId || "";
      parent.addEventListener("change", async () => {
        if (parent.value) g.parentId = parent.value; else delete g.parentId;
        await save("親グループを変更しました"); renderAll();
      });
      const sibs = YTCG.childrenOf(state.groups, g.parentId), i = sibs.indexOf(g);
      const up = el("button", "", "↑"); up.title = "同じ階層の中で上へ"; up.disabled = i <= 0;
      up.addEventListener("click", async () => { if (swapWithSibling(g, -1)) { await save(); renderAll(); } });
      const down = el("button", "", "↓"); down.title = "同じ階層の中で下へ"; down.disabled = i >= sibs.length - 1;
      down.addEventListener("click", async () => { if (swapWithSibling(g, 1)) { await save(); renderAll(); } });
      const del = el("button", "", "削除");
      del.addEventListener("click", async () => {
        const kids = YTCG.childrenOf(state.groups, g.id).length;
        const msg = "「" + g.name + "」を削除しますか？\n所属チャンネルは「未分類」に移動します。" + (kids ? "\n下位グループ（" + kids + "件）は一つ上の階層に移動します。" : "");
        if (!confirm(msg)) return;
        for (const c of Object.values(state.channels)) if (c.groupId === g.id) c.groupId = UNG;
        for (const x of state.groups) if (x.parentId === g.id) { if (g.parentId) x.parentId = g.parentId; else delete x.parentId; }
        state.groups = state.groups.filter(x => x.id !== g.id);
        if (filterGroup === g.id) filterGroup = "";
        await save(); renderAll();
      });
      row.append(parent, up, down, del);
    } else row.append(el("span", "count", "既定"));
    box.append(row);
  }
  fillGroupSelect($("group-parent"), { top: { value: "", label: "親グループ：なし（最上位）" } });
}

function renderFilter() {
  const sel = $("group-filter");
  fillGroupSelect(sel, { top: { value: "", label: "すべてのグループ" }, withUngrouped: true });
  if (filterGroup && !state.groups.some(g => g.id === filterGroup)) filterGroup = "";
  sel.value = filterGroup;
}

function renderChannels() {
  const box = $("channels"); box.replaceChildren();
  const q = $("search").value.trim().toLocaleLowerCase();
  const ids = filterGroup ? ($("include-sub").checked ? YTCG.descendantIds(state.groups, filterGroup) : new Set([filterGroup])) : null;
  const all = Object.values(state.channels).sort((a, b) => a.name.localeCompare(b.name, "ja"));
  const visible = all.filter(c => c.name.toLocaleLowerCase().includes(q) && (!ids || ids.has(c.groupId || UNG)));
  $("channel-count").textContent = all.length ? `表示 ${visible.length} / 全 ${all.length} 件` : "";
  if (!visible.length) {
    box.append(el("div", "empty", all.length ? "一致するチャンネルがありません。" : "まだチャンネルがありません。ChromeでYouTubeを開き、左側の「全取得」を押してください。"));
    return;
  }
  for (const c of visible) {
    const row = el("div", "channel-row");
    if (c.avatar) { const img = el("img"); img.src = c.avatar; img.alt = ""; img.referrerPolicy = "no-referrer"; row.append(img); }
    else row.append(el("div", "avatar-fallback", "●"));
    const name = el("div", "channel-name"); const a = el("a", "", c.name); a.href = c.url; a.target = "_blank"; a.rel = "noreferrer"; name.append(a);
    const select = el("select"); select.setAttribute("aria-label", c.name + "のグループ");
    fillGroupSelect(select, { withUngrouped: true, labelFn: g => YTCG.pathLabel(state.groups, g.id) });
    select.value = state.groups.some(g => g.id === c.groupId) ? c.groupId : UNG;
    select.addEventListener("change", async () => {
      c.groupId = select.value;
      await save(c.name + "を「" + YTCG.pathLabel(state.groups, c.groupId) + "」に移動しました");
      renderGroups(); renderOrder(); renderChannels();
    });
    const del = el("button", "", "削除"); del.title = "この拡張の一覧から削除（YouTubeの登録は変わりません）";
    del.addEventListener("click", async () => {
      if (!confirm("「" + c.name + "」を拡張の一覧から削除しますか？\nYouTubeの登録状態は変わりません。まだ登録中の場合は、次回の取得で再び追加されます。")) return;
      for (const k of Object.keys(state.channels)) if (state.channels[k] === c) delete state.channels[k];
      await save(c.name + "を削除しました"); renderAll();
    });
    row.append(name, select, del); box.append(row);
  }
}

// ---- グループ内の並び順と仕切り ----
async function setOrder(arr, msg) {
  const g = state.groups.find(x => x.id === orderGroup); if (!g) return;
  g.order = arr; await save(msg || "並び順を保存しました"); renderAll();
}
function renderOrder() {
  const sel = $("order-group"), list = $("order-list");
  fillGroupSelect(sel, { withUngrouped: true, labelFn: (g, d) => indent(g.name, d) + "（" + YTCG.effectiveOrder(state, g.id).filter(e => !YTCG.isDivider(e)).length + "）" });
  if (!state.groups.some(g => g.id === orderGroup)) orderGroup = YTCG.flatTree(state.groups)[0]?.group.id || UNG;
  sel.value = orderGroup;
  list.replaceChildren();
  const order = YTCG.effectiveOrder(state, orderGroup);
  if (!order.length) { list.append(el("div", "empty", "このグループにはチャンネルがありません。")); return; }
  let dragFrom = -1;
  order.forEach((key, i) => {
    const isDiv = YTCG.isDivider(key), c = state.channels[key];
    const row = el("div", "order-row" + (isDiv ? " is-divider" : "")); row.draggable = true;
    row.addEventListener("dragstart", e => { dragFrom = i; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(i)); row.classList.add("dragging"); });
    row.addEventListener("dragend", () => row.classList.remove("dragging"));
    row.addEventListener("dragover", e => { e.preventDefault(); row.classList.add("drop-target"); });
    row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
    row.addEventListener("drop", e => {
      e.preventDefault(); row.classList.remove("drop-target");
      if (dragFrom < 0 || dragFrom === i) return;
      const arr = [...order]; const [x] = arr.splice(dragFrom, 1); arr.splice(i, 0, x); dragFrom = -1; setOrder(arr);
    });
    row.append(el("span", "handle", "⠿"));
    if (isDiv) { const bar = el("div", "divider-bar"); bar.title = "仕切り"; row.append(bar); }
    else {
      if (c.avatar) { const img = el("img"); img.src = c.avatar; img.alt = ""; img.referrerPolicy = "no-referrer"; row.append(img); } else row.append(el("div", "avatar-fallback", "●"));
      row.append(el("div", "channel-name", c.name));
    }
    const move = dir => { const arr = [...order]; const j = i + dir; if (j < 0 || j >= arr.length) return; [arr[i], arr[j]] = [arr[j], arr[i]]; setOrder(arr); };
    const up = el("button", "", "↑"); up.disabled = i === 0; up.addEventListener("click", () => move(-1));
    const down = el("button", "", "↓"); down.disabled = i === order.length - 1; down.addEventListener("click", () => move(1));
    row.append(up, down);
    if (isDiv) {
      const del = el("button", "", "仕切りを削除"); del.addEventListener("click", () => { const arr = [...order]; arr.splice(i, 1); setOrder(arr, "仕切りを削除しました"); }); row.append(del);
    } else {
      const add = el("button", "", "下に仕切りを追加"); add.addEventListener("click", () => { const arr = [...order]; arr.splice(i + 1, 0, YTCG.newDividerId()); setOrder(arr, "仕切りを追加しました"); }); row.append(add);
    }
    list.append(row);
  });
}

function renderAll() { renderSettings(); renderGroups(); renderOrder(); renderFilter(); renderChannels(); }

// ---- イベント ----
$("group-form").addEventListener("submit", async e => {
  e.preventDefault();
  const input = $("group-name"), name = input.value.trim(), parentId = $("group-parent").value || null;
  if (!name) return;
  if (YTCG.childrenOf(state.groups, parentId).some(g => g.name.toLowerCase() === name.toLowerCase())) { $("status").textContent = "同じ階層に同じ名前のグループがすでにあります。"; return; }
  const g = { id: uid(), name, collapsed: false }; if (parentId) g.parentId = parentId;
  state.groups.splice(state.groups.findIndex(x => x.id === UNG), 0, g);
  input.value = ""; await save("グループを追加しました"); renderAll();
});
$("order-group").addEventListener("change", () => { orderGroup = $("order-group").value; renderOrder(); });
$("sort-asc").addEventListener("click", () => setOrder(YTCG.sortSegments(state, YTCG.effectiveOrder(state, orderGroup), 1), "名前順（A→Z）に並べ替えました"));
$("sort-desc").addEventListener("click", () => setOrder(YTCG.sortSegments(state, YTCG.effectiveOrder(state, orderGroup), -1), "名前順（Z→A）に並べ替えました"));
$("divider-end").addEventListener("click", () => setOrder([...YTCG.effectiveOrder(state, orderGroup), YTCG.newDividerId()], "仕切りを追加しました"));
$("search").addEventListener("input", renderChannels);
$("group-filter").addEventListener("change", () => { filterGroup = $("group-filter").value; renderChannels(); });
$("include-sub").addEventListener("change", renderChannels);
$("opt-hide-explore").addEventListener("change", async e => { state.settings.hideExplore = e.target.checked; await save("表示設定を保存しました"); });
$("opt-hide-services").addEventListener("change", async e => { state.settings.hideServices = e.target.checked; await save("表示設定を保存しました"); });
$("opt-show-live").addEventListener("change", async e => { state.settings.showLive = e.target.checked; await save("表示設定を保存しました"); });
for (const [id, key] of [["opt-hide-home", "hideHome"], ["opt-hide-shorts", "hideShorts"], ["opt-hide-mypage", "hideMyPage"], ["opt-hide-report", "hideReportHistory"], ["opt-feed-promote", "promoteOverdue"]]) {
  $(id).addEventListener("change", async e => { state.settings[key] = e.target.checked; await save("表示設定を保存しました"); });
}
$("opt-feed-filter").addEventListener("change", async e => { state.settings.showFeedFilter = e.target.checked; await save("表示設定を保存しました"); });
$("opt-feed-remember").addEventListener("change", async e => { state.settings.rememberFeedFilter = e.target.checked; await save("表示設定を保存しました"); });

$("export-btn").addEventListener("click", () => {
  const blob = new Blob([YTCG.buildExport(state)], { type: "application/json" });
  const a = el("a"); a.href = URL.createObjectURL(blob);
  const d = new Date(), p = n => String(n).padStart(2, "0");
  a.download = `ytcg-backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  $("status").textContent = "エクスポートしました（グループ " + (state.groups.length - 1) + "件・チャンネル " + Object.keys(state.channels).length + "件）";
});
$("import-btn").addEventListener("click", () => $("import-file").click());
$("import-file").addEventListener("change", async e => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  if (f.size > 20 * 1024 * 1024) { $("status").textContent = "ファイルが大きすぎます。"; return; }
  const r = YTCG.parseImport(await f.text());
  if (r.error) { $("status").textContent = "インポートできません: " + r.error; return; }
  const mode = $("import-mode").value;
  const summary = `グループ ${r.stats.groups}件・チャンネル ${r.stats.channels}件` + (r.stats.skipped ? `（読み取れない ${r.stats.skipped}件は除外）` : "");
  const msg = mode === "replace" ? `現在のデータをすべて破棄し、次の内容で置き換えます。\n${summary}\nよろしいですか？`
    : `次の内容を取り込みます。同じIDのグループ・チャンネルはファイルの内容で上書きされ、ファイルに無いものは残ります。\n${summary}\nよろしいですか？`;
  if (!confirm(msg)) { $("status").textContent = "インポートを中止しました"; return; }
  state = YTCG.applyImport(state, r.state, mode);
  await save("インポートしました: " + summary); renderAll();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[KEY]) { state = YTCG.normalize(changes[KEY].newValue); renderAll(); }
});
(async () => { state = YTCG.normalize((await chrome.storage.local.get(KEY))[KEY]); renderAll(); })();
})();
