// Minimal .xlsx reader (zip + XML) using only Node's zlib — enough for AMFI's TER export.
// readXlsx(buffer) → [[cells...], ...] for the first worksheet (shared strings, inline strings and numbers).
import { inflateRawSync } from "node:zlib";

function unzip(buf) {
  // end-of-central-directory record: last 22+ bytes, signature 0x06054b50
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error("not a zip file");
  const n = buf.readUInt16LE(e + 10), cd = buf.readUInt32LE(e + 16);
  const files = {};
  for (let i = 0, p = cd; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad zip directory");
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nl).toString("utf8");
    files[name] = () => {
      const lnl = buf.readUInt16LE(off + 26), lxl = buf.readUInt16LE(off + 28), start = off + 30 + lnl + lxl;
      const raw = buf.subarray(start, start + csize);
      return method === 8 ? inflateRawSync(raw) : raw;
    };
    p += 46 + nl + xl + cl;
  }
  return files;
}

const unesc = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&amp;/g, "&");
const colIdx = (ref) => { let n = 0; for (const ch of ref.replace(/\d+$/, "")) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

export function readXlsx(buffer) {
  const z = unzip(Buffer.from(buffer));
  const strings = [];
  if (z["xl/sharedStrings.xml"]) {
    const xml = z["xl/sharedStrings.xml"]().toString("utf8");
    for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) strings.push(unesc([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")));
  }
  const sheet = Object.keys(z).filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort()[0];
  if (!sheet) throw new Error("no worksheet");
  const xml = z[sheet]().toString("utf8");
  const rows = [];
  for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1], body = cm[2] || "";
      const r = attrs.match(/\br="([A-Z]+\d+)"/)?.[1], t = attrs.match(/\bt="(\w+)"/)?.[1];
      const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let val = "";
      if (t === "s") val = strings[+v] ?? "";
      else if (t === "inlineStr") val = unesc((body.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1] || "");
      else if (t === "str") val = unesc(v ?? "");
      else if (v != null) val = Number.isFinite(+v) ? +v : unesc(v);
      row[r ? colIdx(r) : row.length] = val;
    }
    rows.push(Array.from(row, (x) => (x === undefined ? "" : x)));
  }
  return rows;
}
