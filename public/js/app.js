import {
  loadPdf, buildFromPages, mergeDocs, openForThumbnails, renderThumbnail, pageAspect, PdfLoadError,
} from "./pdfcore.js";
import { parseRanges, rangesToPages, formatPages, RangeError_ } from "./range.js";
import { zipSync } from "../vendor/fflate/fflate.js";
import { APP_VERSION } from "../version.js";

const LIMIT_BYTES = 200 * 1024 * 1024;
const LIMIT_PAGES = 500;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------------------------------------------------------------------------
// 共通の部品
// ---------------------------------------------------------------------------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function showMessages(panel, { errors = [], warnings = [], infos = [] } = {}) {
  const box = $(".messages", panel);
  box.replaceChildren(
    ...errors.map((t) => el("div", { class: "msg msg-error", text: t })),
    ...warnings.map((t) => el("div", { class: "msg msg-warn", text: t })),
    ...infos.map((t) => el("div", { class: "msg msg-info", text: t })),
  );
}

/** 読み込んだPDFについての注意 */
function fileWarnings(pdf) {
  const w = [];
  if (pdf.restricted) {
    w.push(`「${pdf.name}」には印刷・編集などの制限（暗号化）がかかっています。作成するPDFでは、この制限が外れます。取り扱いにご注意ください。`);
  }
  if (pdf.repaired) {
    w.push(`「${pdf.name}」は一部が壊れていたため、修復して読み込みました。できあがったPDFをよく確認してください。`);
  }
  if (pdf.size > LIMIT_BYTES) {
    w.push(`「${pdf.name}」は200MBを超えています。端末によっては、処理に時間がかかったり途中で止まったりすることがあります。`);
  }
  return w;
}

function pageLimitWarning(total) {
  return total > LIMIT_PAGES
    ? `合計${total}ページで、目安の500ページを超えています。端末によっては、処理に時間がかかったり途中で止まったりすることがあります。`
    : null;
}

function setupDropzone(zone, onFiles) {
  const input = $("input[type=file]", zone);
  input.addEventListener("change", () => {
    const files = [...input.files];
    input.value = "";
    if (files.length) onFiles(files);
  });
  zone.addEventListener("dragover", (e) => {
    if (![...e.dataTransfer.types].includes("Files")) return;
    e.preventDefault();
    zone.classList.add("dragover");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
  zone.addEventListener("drop", (e) => {
    if (![...e.dataTransfer.types].includes("Files")) return;
    e.preventDefault();
    zone.classList.remove("dragover");
    const files = [...e.dataTransfer.files];
    if (files.length) onFiles(files);
  });
}

// ページ全体へのドロップで、ブラウザがPDFを開いてしまうのを防ぐ
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

const isPdfFile = (f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);

const resultUrls = new WeakMap();

function clearResult(panel) {
  const box = $(".result", panel);
  for (const u of resultUrls.get(box) || []) URL.revokeObjectURL(u);
  resultUrls.set(box, []);
  box.className = "result";
  box.replaceChildren();
}

function showWorking(panel, text) {
  clearResult(panel);
  const box = $(".result", panel);
  box.classList.add("working");
  box.append(el("p", { text }));
}

function updateWorking(panel, text) {
  const p = $(".result.working p", panel);
  if (p) p.textContent = text;
}

/** できあがったファイルを保存できるようにする */
function showResult(panel, { name, bytes, type, note }) {
  clearResult(panel);
  const box = $(".result", panel);
  const blob = new Blob([bytes], { type });
  const url = URL.createObjectURL(blob);
  resultUrls.get(box).push(url);

  const buttons = el("div", { class: "result-buttons" },
    el("a", { class: "btn btn-primary", href: url, download: name, text: "保存する" }),
  );
  try {
    const file = new File([blob], name, { type });
    if (navigator.canShare?.({ files: [file] })) {
      buttons.append(el("button", {
        type: "button", class: "btn", text: "共有",
        onclick: () => navigator.share({ files: [file] }).catch(() => {}),
      }));
    }
  } catch { /* 共有に対応していない */ }

  box.append(
    el("p", {}, "できあがりました：", el("strong", { text: name }), `（${formatSize(blob.size)}）`),
    note ? el("p", { class: "help", text: note }) : null,
    buttons,
  );
}

function showError(panel, err) {
  clearResult(panel);
  const msg = err instanceof PdfLoadError || err instanceof RangeError_ || err instanceof UserError
    ? err.message
    : "処理中に問題が起きました。ファイルを読み込み直して、もう一度お試しください。";
  if (!(err instanceof PdfLoadError || err instanceof RangeError_ || err instanceof UserError)) console.error(err);
  showMessages(panel, { errors: [msg] });
}

class UserError extends Error {}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

/** 読み込み（共通） */
async function loadFiles(panel, files) {
  const zone = $(".dropzone", panel);
  const errors = [];
  const loaded = [];
  zone.classList.add("busy");
  const main = $(".dropzone-main", zone);
  const original = main.textContent;
  try {
    for (const f of files) {
      if (!isPdfFile(f)) {
        errors.push(`「${f.name}」はPDFではないため、読み込みませんでした。`);
        continue;
      }
      main.textContent = `読み込み中…（${f.name}）`;
      await nextFrame();
      try {
        loaded.push(await loadPdf(f));
      } catch (e) {
        if (e instanceof PdfLoadError) errors.push(e.message);
        else {
          console.error(e);
          errors.push(`「${f.name}」を読み込めませんでした。`);
        }
      }
    }
  } finally {
    main.textContent = original;
    zone.classList.remove("busy");
  }
  return { loaded, errors };
}

function fileInfo(panel, pdf) {
  const box = $(".file-info", panel);
  box.hidden = false;
  box.replaceChildren(
    el("span", { class: "name", text: pdf.name }),
    el("span", { class: "meta", text: `${pdf.pageCount}ページ・${formatSize(pdf.size)}` }),
  );
}

// ---------------------------------------------------------------------------
// タブ
// ---------------------------------------------------------------------------

function setupTabs() {
  const tabs = $$('[role="tab"]');
  const select = (tab, focus = false) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute("aria-selected", on);
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
    }
    if (focus) tab.focus();
    history.replaceState(null, "", `#${tab.id.replace("tab-", "")}`);
  };
  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (e) => {
      const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (d) select(tabs[(i + d + tabs.length) % tabs.length], true);
    });
  });
  const initial = document.getElementById(`tab-${location.hash.slice(1)}`);
  if (initial) select(initial);
}

// ---------------------------------------------------------------------------
// 結合
// ---------------------------------------------------------------------------

function setupMerge() {
  const panel = $("#panel-merge");
  const list = $(".file-list", panel);
  const summary = $(".list-summary", panel);
  const runBtn = $(".run", panel);
  const clearBtn = $(".clear", panel);
  let items = []; // { id, pdf }
  let seq = 0;
  let dragId = null;

  const move = (from, to) => {
    if (to < 0 || to >= items.length || from === to) return;
    const [it] = items.splice(from, 1);
    items.splice(to, 0, it);
    render();
  };

  function render(focusId, focusSel) {
    list.replaceChildren(...items.map((it, i) => {
      const li = el("li", { class: "file-item", draggable: "true", "data-id": it.id },
        el("span", { class: "handle", "aria-hidden": "true", title: "ドラッグで並べ替え", text: "⋮⋮" }),
        el("span", { class: "name", text: it.pdf.name }),
        el("span", { class: "meta", text: `${it.pdf.pageCount}ページ・${formatSize(it.pdf.size)}` }),
        el("span", { class: "item-buttons" },
          el("button", {
            type: "button", class: "btn btn-icon btn-ghost up", "aria-label": `${it.pdf.name}を上へ`, title: "上へ",
            disabled: i === 0, text: "↑", onclick: () => { move(i, i - 1); refocus(it.id, ".up", ".down"); },
          }),
          el("button", {
            type: "button", class: "btn btn-icon btn-ghost down", "aria-label": `${it.pdf.name}を下へ`, title: "下へ",
            disabled: i === items.length - 1, text: "↓", onclick: () => { move(i, i + 1); refocus(it.id, ".down", ".up"); },
          }),
          el("button", {
            type: "button", class: "btn btn-icon btn-ghost remove", "aria-label": `${it.pdf.name}を外す`, title: "外す",
            text: "✕", onclick: () => { items.splice(i, 1); clearResult(panel); render(); },
          }),
        ),
      );
      li.addEventListener("dragstart", (e) => {
        dragId = it.id;
        li.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(it.id));
      });
      li.addEventListener("dragend", () => {
        dragId = null;
        li.classList.remove("dragging");
        $$(".drop-before, .drop-after", list).forEach((n) => n.classList.remove("drop-before", "drop-after"));
      });
      li.addEventListener("dragover", (e) => {
        if (dragId === null) return;
        e.preventDefault();
        e.stopPropagation();
        const rect = li.getBoundingClientRect();
        const after = e.clientY > rect.top + rect.height / 2;
        li.classList.toggle("drop-after", after);
        li.classList.toggle("drop-before", !after);
      });
      li.addEventListener("dragleave", () => li.classList.remove("drop-before", "drop-after"));
      li.addEventListener("drop", (e) => {
        if (dragId === null) return;
        e.preventDefault();
        e.stopPropagation();
        const after = li.classList.contains("drop-after");
        const from = items.findIndex((x) => x.id === dragId);
        let to = items.findIndex((x) => x.id === it.id) + (after ? 1 : 0);
        if (from < to) to--;
        move(from, to);
      });
      return li;
    }));

    const total = items.reduce((s, it) => s + it.pdf.pageCount, 0);
    summary.hidden = items.length === 0;
    summary.textContent = `${items.length}ファイル・合計${total}ページ`;
    runBtn.disabled = items.length < 2;
    clearBtn.hidden = items.length === 0;

    const warnings = items.flatMap((it) => fileWarnings(it.pdf));
    const pw = pageLimitWarning(total);
    if (pw) warnings.push(pw);
    const keepErrors = $$(".msg-error", panel).map((n) => n.textContent);
    showMessages(panel, { errors: keepErrors, warnings });
  }

  function refocus(id, sel, fallback) {
    const li = $(`[data-id="${id}"]`, list);
    if (!li) return;
    const b = $(sel, li);
    (b && !b.disabled ? b : $(fallback, li))?.focus();
  }

  setupDropzone($(".dropzone", panel), async (files) => {
    clearResult(panel);
    showMessages(panel);
    const { loaded, errors } = await loadFiles(panel, files);
    for (const pdf of loaded) items.push({ id: ++seq, pdf });
    showMessages(panel, { errors });
    render();
  });

  clearBtn.addEventListener("click", () => {
    items = [];
    clearResult(panel);
    showMessages(panel);
    render();
  });

  runBtn.addEventListener("click", async () => {
    if (items.length < 2) return;
    runBtn.disabled = true;
    showMessages(panel, { warnings: $$(".msg-warn", panel).map((n) => n.textContent) });
    showWorking(panel, "結合しています…");
    await nextFrame();
    try {
      const bytes = await mergeDocs(items.map((it) => it.pdf.doc), (i, n) => updateWorking(panel, `結合しています…（${i}/${n}）`));
      showResult(panel, { name: "merged.pdf", bytes, type: "application/pdf" });
    } catch (e) {
      showError(panel, e);
    } finally {
      runBtn.disabled = items.length < 2;
    }
  });

  render();
}

// ---------------------------------------------------------------------------
// 分割
// ---------------------------------------------------------------------------

const pad = (n, width) => String(n).padStart(width, "0");

function setupSplit() {
  const panel = $("#panel-split");
  const runBtn = $(".run", panel);
  const fieldset = $(".options", panel);
  const rangeInput = $("#split-range", panel);
  const everyInput = $("#split-every", panel);
  let pdf = null;

  const mode = () => $('input[name="split-mode"]:checked', panel).value;
  const syncMode = () => {
    for (const d of $$(".option-detail", panel)) d.hidden = d.dataset.for !== mode();
  };
  $$('input[name="split-mode"]', panel).forEach((r) => r.addEventListener("change", () => { syncMode(); clearResult(panel); }));
  syncMode();
  rangeInput.addEventListener("input", () => rangeInput.classList.remove("invalid"));

  setupDropzone($(".dropzone", panel), async (files) => {
    clearResult(panel);
    showMessages(panel);
    const errors = files.length > 1 ? ["分割できるのは1ファイルずつです。最初のファイルを読み込みました。"] : [];
    const { loaded, errors: e2 } = await loadFiles(panel, files.slice(0, 1));
    errors.push(...e2);
    if (loaded[0]) {
      pdf = loaded[0];
      fileInfo(panel, pdf);
      fieldset.disabled = false;
      runBtn.disabled = false;
    }
    const warnings = pdf ? fileWarnings(pdf) : [];
    const pw = pdf && pageLimitWarning(pdf.pageCount);
    if (pw) warnings.push(pw);
    showMessages(panel, { errors, warnings });
  });

  function groups() {
    const n = pdf.pageCount;
    if (mode() === "range") {
      let ranges;
      try {
        ranges = parseRanges(rangeInput.value, n);
      } catch (e) {
        rangeInput.classList.add("invalid");
        rangeInput.focus();
        throw e;
      }
      return ranges.map((r) => Array.from({ length: r.end - r.start + 1 }, (_, i) => r.start - 1 + i));
    }
    if (mode() === "each") return Array.from({ length: n }, (_, i) => [i]);
    const raw = everyInput.value.trim().replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
    const size = Number(raw);
    if (!/^\d+$/.test(raw) || size < 1) {
      everyInput.focus();
      throw new UserError("「何ページごと」には1以上の整数を入力してください。");
    }
    const out = [];
    for (let s = 0; s < n; s += size) out.push(Array.from({ length: Math.min(size, n - s) }, (_, i) => s + i));
    return out;
  }

  runBtn.addEventListener("click", async () => {
    if (!pdf) return;
    const warnings = $$(".msg-warn", panel).map((x) => x.textContent);
    showMessages(panel, { warnings });
    let gs;
    try {
      gs = groups();
    } catch (e) {
      showError(panel, e);
      showMessages(panel, { errors: [e.message], warnings });
      return;
    }
    runBtn.disabled = true;
    showWorking(panel, "分割しています…");
    await nextFrame();
    try {
      const width = Math.max(2, String(gs.length).length);
      const outputs = [];
      for (let i = 0; i < gs.length; i++) {
        updateWorking(panel, `分割しています…（${i + 1}/${gs.length}）`);
        await nextFrame();
        outputs.push({ name: `${pdf.base}_${pad(i + 1, width)}.pdf`, bytes: await buildFromPages(pdf.doc, gs[i]) });
      }
      if (outputs.length === 1) {
        showResult(panel, { ...outputs[0], type: "application/pdf" });
      } else {
        updateWorking(panel, "ZIPにまとめています…");
        await nextFrame();
        const entries = {};
        for (const o of outputs) entries[o.name] = [o.bytes, { level: 0 }];
        const zip = zipSync(entries);
        showResult(panel, {
          name: `${pdf.base}_分割.zip`, bytes: zip, type: "application/zip",
          note: `${outputs.length}個のPDF（${outputs[0].name} ～ ${outputs.at(-1).name}）が入っています。`,
        });
      }
    } catch (e) {
      showError(panel, e);
      showMessages(panel, { errors: $$(".msg-error", panel).map((x) => x.textContent), warnings });
    } finally {
      runBtn.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------------
// ページ抽出・ページ削除（共通のページ選択）
// ---------------------------------------------------------------------------

function setupPagePicker(panel) {
  const mode = panel.dataset.mode; // "extract" | "delete"
  panel.append($("#page-picker-template").content.cloneNode(true));
  const picker = $(".picker", panel);
  const rangeInput = $(".range-input", panel);
  const rangeError = $(".range-error", panel);
  const thumbs = $(".thumbs", panel);
  const count = $(".sel-count", panel);
  const runBtn = $(".run", panel);
  const inputId = `${mode}-range`;
  rangeInput.id = inputId;
  $(".field-label", panel).htmlFor = inputId;
  $(".range-help", panel).id = `${inputId}-help`;
  rangeInput.setAttribute("aria-describedby", `${inputId}-help`);
  runBtn.textContent = mode === "extract" ? "選んだページを抽出する" : "選んだページを削除する";
  $(".field-label", panel).textContent = mode === "extract" ? "抽出するページ" : "削除するページ";
  thumbs.setAttribute("aria-label", mode === "extract" ? "抽出するページを選ぶ" : "削除するページを選ぶ");

  let pdf = null;
  let viewer = null; // PDF.js のドキュメント
  let selected = new Set(); // 1始まり
  let lastClicked = null;
  let observer = null;
  let renderQueue = [];
  let rendering = false;
  let generation = 0;

  function updateSelectionView() {
    for (const b of thumbs.children) b.setAttribute("aria-pressed", selected.has(Number(b.dataset.page)));
    count.textContent = pdf ? `選択中：${selected.size} / ${pdf.pageCount}ページ` : "";
    runBtn.disabled = !pdf;
  }

  function setRangeError(msg) {
    rangeError.hidden = !msg;
    rangeError.textContent = msg || "";
    rangeInput.classList.toggle("invalid", !!msg);
  }

  function syncInputFromSelection() {
    rangeInput.value = formatPages([...selected]);
    setRangeError(null);
  }

  rangeInput.addEventListener("input", () => {
    if (!pdf) return;
    if (rangeInput.value.trim() === "") {
      selected = new Set();
      setRangeError(null);
      updateSelectionView();
      return;
    }
    try {
      selected = new Set(rangesToPages(parseRanges(rangeInput.value, pdf.pageCount)));
      setRangeError(null);
      updateSelectionView();
    } catch (e) {
      // 入力途中（「1-」など）でもあるので、選択はそのままにして誤りだけ示す
      if (e instanceof RangeError_) setRangeError(e.message);
      else throw e;
    }
  });

  $(".sel-all", panel).addEventListener("click", () => {
    selected = new Set(Array.from({ length: pdf.pageCount }, (_, i) => i + 1));
    syncInputFromSelection(); updateSelectionView();
  });
  $(".sel-none", panel).addEventListener("click", () => {
    selected = new Set();
    syncInputFromSelection(); updateSelectionView();
  });
  $(".sel-invert", panel).addEventListener("click", () => {
    const next = new Set();
    for (let p = 1; p <= pdf.pageCount; p++) if (!selected.has(p)) next.add(p);
    selected = next;
    syncInputFromSelection(); updateSelectionView();
  });

  function onThumbClick(e, page) {
    if (e.shiftKey && lastClicked !== null) {
      const [a, b] = lastClicked < page ? [lastClicked, page] : [page, lastClicked];
      const turnOn = !selected.has(page) || selected.has(lastClicked);
      for (let p = a; p <= b; p++) turnOn ? selected.add(p) : selected.delete(p);
    } else {
      selected.has(page) ? selected.delete(page) : selected.add(page);
    }
    lastClicked = page;
    syncInputFromSelection();
    updateSelectionView();
  }

  async function pump(gen) {
    if (rendering) return;
    rendering = true;
    try {
      while (renderQueue.length && gen === generation) {
        const btn = renderQueue.shift();
        if (btn.dataset.rendered) continue;
        btn.dataset.rendered = "1";
        const canvas = $("canvas", btn);
        try {
          await renderThumbnail(viewer, Number(btn.dataset.page), canvas, 140);
        } catch (err) {
          if (gen === generation) console.warn("サムネイルを描けませんでした", err);
        }
      }
    } finally {
      rendering = false;
      if (renderQueue.length && gen === generation) pump(gen);
    }
  }

  function buildThumbs() {
    observer?.disconnect();
    renderQueue = [];
    const gen = generation;
    observer = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (en.isIntersecting) {
          renderQueue.push(en.target);
          observer.unobserve(en.target);
        }
      }
      if (viewer) pump(gen);
    }, { rootMargin: "400px 0px" });

    const frag = document.createDocumentFragment();
    for (let i = 0; i < pdf.pageCount; i++) {
      const page = i + 1;
      let aspect = 1.414;
      try { aspect = pageAspect(pdf.doc, i); } catch { /* 既定値 */ }
      const btn = el("button", {
        type: "button", class: "thumb", "data-page": page, "aria-pressed": "false", "aria-label": `${page}ページ`,
        onclick: (e) => onThumbClick(e, page),
      },
        el("span", { class: "thumb-box" },
          el("span", {
            class: "thumb-frame",
            style: aspect >= 1.414
              ? `height: 100%; aspect-ratio: 1 / ${aspect.toFixed(4)}`
              : `width: 100%; aspect-ratio: 1 / ${aspect.toFixed(4)}`,
          }, el("canvas")),
        ),
        el("span", { class: "thumb-num", text: `${page}` }),
      );
      frag.append(btn);
    }
    thumbs.replaceChildren(frag);
    for (const b of thumbs.children) observer.observe(b);
  }

  setupDropzone($(".dropzone", panel), async (files) => {
    clearResult(panel);
    showMessages(panel);
    const errors = files.length > 1 ? ["読み込めるのは1ファイルずつです。最初のファイルを読み込みました。"] : [];
    const { loaded, errors: e2 } = await loadFiles(panel, files.slice(0, 1));
    errors.push(...e2);
    const warnings = [];
    if (loaded[0]) {
      generation++;
      viewer?.destroy?.();
      viewer = null;
      pdf = loaded[0];
      selected = new Set();
      lastClicked = null;
      rangeInput.value = "";
      setRangeError(null);
      fileInfo(panel, pdf);
      picker.hidden = false;
      buildThumbs();
      updateSelectionView();
      warnings.push(...fileWarnings(pdf));
      const pw = pageLimitWarning(pdf.pageCount);
      if (pw) warnings.push(pw);
      const gen = generation;
      openForThumbnails(pdf.bytes).then((v) => {
        if (gen !== generation) { v.destroy(); return; }
        viewer = v;
        pump(gen);
      }).catch((err) => {
        console.warn(err);
        if (gen === generation) {
          showMessages(panel, {
            errors: $$(".msg-error", panel).map((x) => x.textContent),
            warnings: [...$$(".msg-warn", panel).map((x) => x.textContent), "ページの画像を表示できませんでした。ページ範囲の入力で選んでください。"],
          });
        }
      });
    }
    if (pdf) {
      // 既に読み込んだファイルがあれば、その注意は残す
      if (!loaded[0]) warnings.push(...fileWarnings(pdf));
    }
    showMessages(panel, { errors, warnings });
  });

  runBtn.addEventListener("click", async () => {
    if (!pdf) return;
    const warnings = $$(".msg-warn", panel).map((x) => x.textContent);
    const fail = (msg) => {
      clearResult(panel);
      showMessages(panel, { errors: [msg], warnings });
    };
    // 入力欄に誤りがあれば止める
    if (rangeInput.value.trim() !== "") {
      try {
        selected = new Set(rangesToPages(parseRanges(rangeInput.value, pdf.pageCount)));
        updateSelectionView();
      } catch (e) {
        setRangeError(e.message);
        rangeInput.focus();
        return fail(e.message);
      }
    }
    if (selected.size === 0) {
      return fail(mode === "extract" ? "抽出するページを選んでください。" : "削除するページを選んでください。");
    }
    if (mode === "delete" && selected.size === pdf.pageCount) {
      return fail("すべてのページを削除することはできません。残すページを1ページ以上にしてください。");
    }
    const indices = [];
    for (let p = 1; p <= pdf.pageCount; p++) {
      const sel = selected.has(p);
      if ((mode === "extract" && sel) || (mode === "delete" && !sel)) indices.push(p - 1);
    }
    showMessages(panel, { warnings });
    runBtn.disabled = true;
    showWorking(panel, mode === "extract" ? "抽出しています…" : "削除しています…");
    await nextFrame();
    try {
      const bytes = await buildFromPages(pdf.doc, indices);
      const name = mode === "extract" ? `${pdf.base}_抽出.pdf` : `${pdf.base}_削除済.pdf`;
      const note = mode === "extract"
        ? `${indices.length}ページ（${formatPages(indices.map((i) => i + 1))}）を取り出しました。`
        : `${selected.size}ページを削除し、${indices.length}ページが残りました。`;
      showResult(panel, { name, bytes, type: "application/pdf", note });
    } catch (e) {
      showError(panel, e);
    } finally {
      runBtn.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------------
// PWA（オフライン対応と更新のお知らせ）
// ---------------------------------------------------------------------------

function setupServiceWorker() {
  const status = $("#offline-status");
  if (!("serviceWorker" in navigator)) {
    status.textContent = "オフライン対応：このブラウザでは使えません";
    return;
  }
  const banner = $("#update-banner");
  const button = $("#update-button");
  let userAskedUpdate = false;
  // 初回訪問（まだ制御されていない）ときは「更新があります」を出さない
  const hadController = !!navigator.serviceWorker.controller;

  const showUpdate = (worker) => {
    if (!hadController) return;
    banner.hidden = false;
    button.onclick = () => {
      userAskedUpdate = true;
      button.disabled = true;
      worker.postMessage("SKIP_WAITING");
    };
  };

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (userAskedUpdate) location.reload();
  });

  navigator.serviceWorker.register("./sw.js").then((reg) => {
    const ready = () => { status.textContent = "オフライン対応：準備完了"; };
    if (reg.active) ready();
    if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg.waiting);
    reg.addEventListener("updatefound", () => {
      const nw = reg.installing;
      nw?.addEventListener("statechange", () => {
        if (nw.state === "installed" && navigator.serviceWorker.controller) showUpdate(nw);
        if (nw.state === "activated") ready();
      });
    });
    // 開いたままの場合も、1時間ごとに新しい版を確認する
    setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
  }).catch((e) => {
    console.warn(e);
    status.textContent = "オフライン対応：準備できませんでした";
  });
}

// ---------------------------------------------------------------------------

$("#app-version").textContent = APP_VERSION;
setupTabs();
setupMerge();
setupSplit();
$$(".page-picker").forEach(setupPagePicker);
setupServiceWorker();
