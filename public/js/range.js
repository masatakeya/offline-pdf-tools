// ページ範囲の解析と整形。ページ番号は1始まりで扱う。

export class RangeError_ extends Error {}

const normalize = (text) =>
  text
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[－−‐‑–—―ー～〜~]/g, "-")
    .replace(/[，、､]/g, ",")
    .replace(/\s+/g, "");

/**
 * 「1-3, 5, 7-9」を [{start:1,end:3},{start:5,end:5},{start:7,end:9}] に変換する。
 * 誤りがあれば RangeError_ を投げる。
 */
export function parseRanges(text, pageCount) {
  const s = normalize(text);
  if (s === "") throw new RangeError_("ページ範囲を入力してください。");
  const parts = s.split(",");
  const ranges = [];
  for (const part of parts) {
    if (part === "") throw new RangeError_("カンマの前後にページ番号がありません。");
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new RangeError_(`「${part}」は範囲として読み取れません。「1-3, 5」のように入力してください。`);
    const start = Number(m[1]);
    const end = m[2] === undefined ? start : Number(m[2]);
    if (start === 0 || end === 0) throw new RangeError_("ページ番号は1から始まります。");
    if (start > end) throw new RangeError_(`「${part}」は逆順です。「${end}-${start}」のように小さい番号から書いてください。`);
    if (end > pageCount) throw new RangeError_(`${end}ページは存在しません（このPDFは${pageCount}ページです）。`);
    ranges.push({ start, end, label: part });
  }
  // 重複の確認
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start <= sorted[i - 1].end) {
      throw new RangeError_(`「${sorted[i - 1].label}」と「${sorted[i].label}」でページが重複しています。`);
    }
  }
  return ranges;
}

/** 範囲指定を、元の順序に並べたページ番号（1始まり）の配列にする */
export function rangesToPages(ranges) {
  const set = new Set();
  for (const r of ranges) for (let p = r.start; p <= r.end; p++) set.add(p);
  return [...set].sort((a, b) => a - b);
}

/** ページ番号の配列を「1-3, 5」の形にする */
export function formatPages(pages) {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const out = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    out.push(i === j ? `${sorted[i]}` : `${sorted[i]}-${sorted[j]}`);
    i = j + 1;
  }
  return out.join(", ");
}
