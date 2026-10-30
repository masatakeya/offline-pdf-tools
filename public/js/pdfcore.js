// PDFの読み込みと生成。処理はすべてブラウザ内で行う。
import { PDFDocument, EncryptedPDFError } from "../vendor/pdf-lib/pdf-lib.esm.min.js";

const vendorUrl = (path) => new URL(`../vendor/${path}`, import.meta.url).href;

export class PdfLoadError extends Error {}

/** 拡張子を除いたファイル名 */
export const baseName = (name) => name.replace(/\.pdf$/i, "") || "document";

// ---- qpdf（制限付きPDFの制限解除と、壊れたPDFの修復に使う。必要なときだけ読み込む） ----
let qpdfFactoryPromise = null;
function loadQpdfFactory() {
  if (!qpdfFactoryPromise) {
    qpdfFactoryPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = vendorUrl("qpdf/qpdf.js");
      s.onload = () => {
        const factory = window.Module;
        if (typeof factory === "function") resolve(factory);
        else reject(new Error("qpdf の読み込みに失敗しました"));
      };
      s.onerror = () => reject(new Error("qpdf の読み込みに失敗しました"));
      document.head.appendChild(s);
    }).catch((e) => {
      qpdfFactoryPromise = null;
      throw e;
    });
  }
  return qpdfFactoryPromise;
}

/** qpdf で書き直す。args は入出力以外の引数（例: ["--decrypt"]）。output=false なら出力ファイルを指定しない */
async function runQpdf(bytes, args, output = true) {
  const factory = await loadQpdfFactory();
  const messages = [];
  const mod = await factory({
    locateFile: () => vendorUrl("qpdf/qpdf.wasm"),
    noInitialRun: true,
    print: (t) => messages.push(t),
    printErr: (t) => messages.push(t),
  });
  mod.FS.writeFile("/in.pdf", bytes);
  let code;
  try {
    code = mod.callMain(output ? [...args, "/in.pdf", "/out.pdf"] : [...args, "/in.pdf"]);
  } catch (e) {
    code = typeof e?.status === "number" ? e.status : 2;
  }
  let out = null;
  try {
    out = mod.FS.readFile("/out.pdf");
  } catch {
    out = null;
  }
  // 0: 成功、3: 警告ありで成功
  return { code, ok: (code === 0 || code === 3) && !!out && out.length > 0, out, log: messages.join("\n") };
}

/**
 * PDFファイルを読み込む。
 * 戻り値: { name, base, size, bytes, doc, pageCount, restricted, repaired }
 * bytes は pdf-lib で扱える（暗号化を解いた）データ。
 */
export async function loadPdf(file) {
  const original = new Uint8Array(await file.arrayBuffer());
  const info = { name: file.name, base: baseName(file.name), size: file.size, restricted: false, repaired: false };

  if (!looksLikePdf(original)) throw new PdfLoadError(`「${file.name}」はPDFではないようです。`);

  try {
    const doc = await PDFDocument.load(original, { updateMetadata: false });
    return finish(info, original, doc);
  } catch (e) {
    // pdf-lib の例外クラスは instanceof で判定できないことがあるため、メッセージも見る
    if (e instanceof EncryptedPDFError || /is encrypted/i.test(String(e?.message))) {
      return loadEncrypted(info, original);
    }
    return loadRepaired(info, original, e);
  }
}

function looksLikePdf(bytes) {
  // 先頭1024バイト以内に %PDF- があるか
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  return head.includes("%PDF-");
}

async function loadEncrypted(info, original) {
  let r;
  try {
    r = await runQpdf(original, ["--decrypt"]);
  } catch {
    throw new PdfLoadError(`「${info.name}」は暗号化されていますが、解除用の部品を読み込めませんでした。`);
  }
  if (!r.ok) {
    // 空のパスワードで開けなかった＝パスワードが必要、とみなす。
    // ただし --requires-password が 3（暗号化はあるがパスワード不要）を返したら、別の理由による失敗
    let needsPassword = true;
    try {
      needsPassword = (await runQpdf(original, ["--requires-password"], false)).code !== 3;
    } catch { /* 判定できなければパスワード付きとして扱う */ }
    if (needsPassword) {
      throw new PdfLoadError(`「${info.name}」はパスワード付きのPDFのため、このツールでは扱えません。`);
    }
    throw new PdfLoadError(`「${info.name}」は暗号化されており、読み込めませんでした。`);
  }
  const doc = await PDFDocument.load(r.out, { updateMetadata: false });
  info.restricted = true;
  return finish(info, r.out, doc);
}

async function loadRepaired(info, original, firstError) {
  let r;
  try {
    r = await runQpdf(original, []);
  } catch {
    r = { ok: false };
  }
  if (r.ok) {
    try {
      const doc = await PDFDocument.load(r.out, { updateMetadata: false });
      info.repaired = true;
      return finish(info, r.out, doc);
    } catch {
      /* 下でエラーにする */
    }
  }
  console.error(firstError);
  throw new PdfLoadError(`「${info.name}」を読み込めませんでした。ファイルが壊れている可能性があります。`);
}

function finish(info, bytes, doc) {
  const pageCount = doc.getPageCount();
  if (pageCount === 0) throw new PdfLoadError(`「${info.name}」にはページがありません。`);
  return { ...info, bytes, doc, pageCount };
}

/** 指定したページ（0始まり、並び順どおり）で新しいPDFを作る */
export async function buildFromPages(srcDoc, indices) {
  const out = await PDFDocument.create({ updateMetadata: false });
  const pages = await out.copyPages(srcDoc, indices);
  for (const p of pages) out.addPage(p);
  return out.save();
}

/** 複数のPDFをファイル単位でつなぐ */
export async function mergeDocs(docs, onProgress) {
  const out = await PDFDocument.create({ updateMetadata: false });
  for (let i = 0; i < docs.length; i++) {
    const src = docs[i];
    const pages = await out.copyPages(src, src.getPageIndices());
    for (const p of pages) out.addPage(p);
    onProgress?.(i + 1, docs.length);
  }
  return out.save();
}

// ---- サムネイル（PDF.js。必要なときだけ読み込む） ----
let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import("../vendor/pdfjs/pdf.min.js").then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = vendorUrl("pdfjs/pdf.worker.min.js");
      return lib;
    });
  }
  return pdfjsPromise;
}

/** サムネイル描画用に PDF.js で開く。bytes はコピーして渡す */
export async function openForThumbnails(bytes) {
  const lib = await loadPdfjs();
  const task = lib.getDocument({
    data: bytes.slice(),
    cMapUrl: vendorUrl("pdfjs/cmaps/"),
    cMapPacked: true,
    standardFontDataUrl: vendorUrl("pdfjs/standard_fonts/"),
    wasmUrl: vendorUrl("pdfjs/wasm/"),
    iccUrl: vendorUrl("pdfjs/iccs/"),
    isEvalSupported: false,
    enableXfa: false,
  });
  return task.promise;
}

export async function renderThumbnail(pdf, pageNumber, canvas, cssWidth) {
  const page = await pdf.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const viewport = page.getViewport({ scale: (cssWidth * ratio) / base.width });
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  await page.render({ canvas, viewport }).promise;
  page.cleanup();
}

/** サムネイル枠の縦横比を決めるためのページサイズ（回転を考慮） */
export function pageAspect(doc, index) {
  const page = doc.getPage(index);
  const { width, height } = page.getSize();
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  return rot === 90 || rot === 270 ? width / height : height / width;
}
