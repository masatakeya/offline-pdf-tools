// ライブラリを public/vendor/ にコピーし、Service Worker のキャッシュ一覧とバージョンを生成する。
// 使い方: npm run build
import { cpSync, rmSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createHash } from "node:crypto";

const root = new URL("..", import.meta.url).pathname;
const nm = join(root, "node_modules");
const pub = join(root, "public");
const vendor = join(pub, "vendor");

rmSync(vendor, { recursive: true, force: true });
mkdirSync(vendor, { recursive: true });

const copy = (from, to) => {
  mkdirSync(join(vendor, to, ".."), { recursive: true });
  cpSync(join(nm, from), join(vendor, to), { recursive: true });
};

// pdf-lib
copy("pdf-lib/dist/pdf-lib.esm.min.js", "pdf-lib/pdf-lib.esm.min.js");
copy("pdf-lib/LICENSE.md", "pdf-lib/LICENSE.md");
// PDF.js（.mjs は配信時の MIME 判定を避けるため .js に改名）
copy("pdfjs-dist/build/pdf.min.mjs", "pdfjs/pdf.min.js");
copy("pdfjs-dist/build/pdf.worker.min.mjs", "pdfjs/pdf.worker.min.js");
copy("pdfjs-dist/cmaps", "pdfjs/cmaps");
copy("pdfjs-dist/standard_fonts", "pdfjs/standard_fonts");
copy("pdfjs-dist/iccs", "pdfjs/iccs");
mkdirSync(join(vendor, "pdfjs/wasm"), { recursive: true });
for (const f of readdirSync(join(nm, "pdfjs-dist/wasm"))) {
  if (f.startsWith("quickjs")) continue; // PDF内スクリプト実行用。使わない
  copy(`pdfjs-dist/wasm/${f}`, `pdfjs/wasm/${f}`);
}
copy("pdfjs-dist/LICENSE", "pdfjs/LICENSE");
// fflate（ZIP生成）
copy("fflate/esm/browser.js", "fflate/fflate.js");
copy("fflate/LICENSE", "fflate/LICENSE");
// qpdf（制限付きPDFの制限解除・壊れたPDFの修復に使う）
copy("@neslinesli93/qpdf-wasm/dist/qpdf.js", "qpdf/qpdf.js");
copy("@neslinesli93/qpdf-wasm/dist/qpdf.wasm", "qpdf/qpdf.wasm");
writeFileSync(
  join(vendor, "qpdf/LICENSE.txt"),
  "qpdf (https://github.com/qpdf/qpdf) is licensed under the Apache License 2.0.\n" +
    "WebAssembly build: @neslinesli93/qpdf-wasm (ISC License).\n"
);

// Service Worker 用のキャッシュ一覧
const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const exclude = new Set(["sw.js", "_headers"]);
const files = walk(pub)
  .map((p) => relative(pub, p).split(sep).join("/"))
  .filter((p) => !exclude.has(p) && !p.endsWith(".map") && !p.endsWith("LICENSE") && !p.endsWith(".md") && !p.endsWith(".txt"))
  .sort();

const hash = createHash("sha256");
for (const f of files) {
  if (f === "version.js") continue; // 自分自身のバージョンを含むため除外
  hash.update(f);
  hash.update(readFileSync(join(pub, f)));
}
hash.update(readFileSync(join(root, "scripts/sw.template.js")));
const version = hash.digest("hex").slice(0, 10);

const urls = ["./", ...files.filter((f) => f !== "index.html").map((f) => "./" + f)];
const swTemplate = readFileSync(join(root, "scripts/sw.template.js"), "utf8");
writeFileSync(
  join(pub, "sw.js"),
  "// npm run build で scripts/sw.template.js から自動生成。手で編集しない\n" +
    swTemplate.replace('"__VERSION__"', JSON.stringify(version)).replace('["__PRECACHE_URLS__"]', JSON.stringify(urls))
);
writeFileSync(join(pub, "version.js"), `// npm run build で自動生成\nexport const APP_VERSION = ${JSON.stringify(version)};\n`);
console.log(`version ${version}, ${urls.length} files`);
