// Minimal reader for old Excel (.xls, BIFF8 inside an OLE2 compound file) — enough for AMFI's monthly report.
// readXls(buffer) → [[row cells...], ...] for the first worksheet (strings and numbers only).

function cfbStream(buf, wanted) {
  const u16 = (o) => buf.readUInt16LE(o), u32 = (o) => buf.readUInt32LE(o);
  if (u32(0) !== 0xe011cfd0) throw new Error("not an OLE2 file");
  const ss = 1 << u16(0x1e);
  const sec = (n) => 512 + n * ss;
  // FAT sector list: 109 in the header, the rest in DIFAT sectors
  const fatSecs = [];
  for (let i = 0; i < 109; i++) { const s = u32(0x4c + i * 4); if (s < 0xfffffffa) fatSecs.push(s); }
  let dif = u32(0x44);
  for (let n = u32(0x48); n > 0 && dif < 0xfffffffa; n--) {
    for (let i = 0; i < ss / 4 - 1; i++) { const s = u32(sec(dif) + i * 4); if (s < 0xfffffffa) fatSecs.push(s); }
    dif = u32(sec(dif) + ss - 4);
  }
  const fat = [];
  for (const s of fatSecs) for (let i = 0; i < ss / 4; i++) fat.push(u32(sec(s) + i * 4));
  const chain = (start) => { const out = []; for (let s = start, g = 0; s < 0xfffffffa && g < 1e6; s = fat[s], g++) out.push(s); return out; };
  const read = (start, size) => Buffer.concat(chain(start).map((s) => buf.subarray(sec(s), sec(s) + ss))).subarray(0, size);
  const dir = read(u32(0x30), Infinity);
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const nl = dir.readUInt16LE(o + 0x40);
    const name = dir.subarray(o, o + Math.max(0, nl - 2)).toString("utf16le");
    if (wanted.includes(name)) {
      const size = dir.readUInt32LE(o + 0x78);
      if (size < u32(0x38)) throw new Error("workbook stream too small (mini stream not supported)");
      return read(dir.readUInt32LE(o + 0x74), size);
    }
  }
  throw new Error("no Workbook stream");
}

function rk(v) {
  let n;
  if (v & 2) n = v >> 2;
  else { const b = Buffer.alloc(8); b.writeUInt32LE((v & 0xfffffffc) >>> 0, 4); n = b.readDoubleLE(0); }
  return v & 1 ? n / 100 : n;
}

export function readXls(buf, sheetIndex = 0) {
  const w = cfbStream(Buffer.from(buf), ["Workbook", "Book"]);
  // records
  const recs = [];
  for (let o = 0; o + 4 <= w.length;) { const t = w.readUInt16LE(o), l = w.readUInt16LE(o + 2); recs.push([t, w.subarray(o + 4, o + 4 + l)]); o += 4 + l; }
  // shared strings: SST + its CONTINUE records (strings may split across them)
  const sst = [];
  const si = recs.findIndex(([t]) => t === 0x00fc);
  if (si >= 0) {
    const parts = [recs[si][1]];
    for (let k = si + 1; k < recs.length && recs[k][0] === 0x003c; k++) parts.push(recs[k][1]);
    let p = 0, o = 8;
    const total = parts[0].readUInt32LE(4);
    const need = (n) => { if (o + n > parts[p].length && o >= parts[p].length) { p++; o = 0; } };
    for (let i = 0; i < total && p < parts.length; i++) {
      need(3);
      let cch = parts[p].readUInt16LE(o), fl = parts[p][o + 2]; o += 3;
      let runs = 0, ext = 0;
      if (fl & 8) { runs = parts[p].readUInt16LE(o); o += 2; }
      if (fl & 4) { ext = parts[p].readUInt32LE(o); o += 4; }
      let s = "";
      while (cch > 0) {
        if (o >= parts[p].length) { p++; o = 0; fl = parts[p][0]; o = 1; } // continued: fresh flags byte
        const wide = fl & 1, avail = Math.floor((parts[p].length - o) / (wide ? 2 : 1)), take = Math.min(cch, avail);
        s += wide ? parts[p].subarray(o, o + take * 2).toString("utf16le") : parts[p].subarray(o, o + take).toString("latin1");
        o += take * (wide ? 2 : 1); cch -= take;
      }
      let skip = runs * 4 + ext;
      while (skip > 0) { if (o >= parts[p].length) { p++; o = 0; } const t = Math.min(skip, parts[p].length - o); o += t; skip -= t; }
      sst.push(s);
    }
  }
  // cells of the chosen worksheet (BOF #0 is the workbook globals)
  const rows = [];
  const put = (r, c, v) => { (rows[r] ||= [])[c] = v; };
  let bof = -1;
  for (const [t, d] of recs) {
    if (t === 0x0809) { bof++; continue; }
    if (bof !== sheetIndex + 1) continue;
    if (t === 0x00fd) put(d.readUInt16LE(0), d.readUInt16LE(2), sst[d.readUInt32LE(6)] ?? "");
    else if (t === 0x0203) put(d.readUInt16LE(0), d.readUInt16LE(2), d.readDoubleLE(6));
    else if (t === 0x027e) put(d.readUInt16LE(0), d.readUInt16LE(2), rk(d.readInt32LE(6)));
    else if (t === 0x00bd) {
      const r = d.readUInt16LE(0), c0 = d.readUInt16LE(2), n = (d.length - 6) / 6;
      for (let k = 0; k < n; k++) put(r, c0 + k, rk(d.readInt32LE(4 + k * 6 + 2)));
    } else if (t === 0x0006) {
      if (d.readUInt16LE(12) !== 0xffff) put(d.readUInt16LE(0), d.readUInt16LE(2), d.readDoubleLE(6));
    } else if (t === 0x0204) {
      const n = d.readUInt16LE(6), wide = d[8] & 1;
      put(d.readUInt16LE(0), d.readUInt16LE(2), wide ? d.subarray(9, 9 + n * 2).toString("utf16le") : d.subarray(9, 9 + n).toString("latin1"));
    }
  }
  return Array.from(rows, (r) => Array.from(r || [], (v) => (v === undefined ? "" : v)));
}
