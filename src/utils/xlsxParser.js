/**
 * xlsxParser.js — Minimal .xlsx reader using only Node built-ins.
 *
 * .xlsx files are ZIP archives containing XML worksheets.
 * We read the ZIP, extract shared strings + sheet1, and return rows as arrays.
 * Also handles .csv files (plain text, comma or semicolon separated).
 */
const fs = require("fs");
const zlib = require("zlib");

// ── ZIP reader (minimal, handles deflate + stored entries) ───
function readZipEntries(buf) {
  const entries = [];
  // Find Central Directory via End-of-Central-Directory record
  let eocdPos = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocdPos = i; break; }
  }
  if (eocdPos < 0) throw new Error("Not a valid ZIP file");

  const cdOffset = buf.readUInt32LE(eocdPos + 16);
  const cdCount = buf.readUInt16LE(eocdPos + 10);

  let pos = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;
    const compMethod = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const uncompSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);
    const name = buf.slice(pos + 46, pos + 46 + nameLen).toString("utf8");

    // Read from local file header to get actual data offset
    const lhPos = localHeaderOffset;
    const lhNameLen = buf.readUInt16LE(lhPos + 26);
    const lhExtraLen = buf.readUInt16LE(lhPos + 28);
    const dataStart = lhPos + 30 + lhNameLen + lhExtraLen;
    const rawData = buf.slice(dataStart, dataStart + compSize);

    let data;
    if (compMethod === 0) {
      data = rawData; // stored
    } else if (compMethod === 8) {
      data = zlib.inflateRawSync(rawData); // deflate
    } else {
      data = null; // unsupported
    }

    entries.push({ name, data });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// ── XML helpers ──────────────────────────────────────────────
function getTagContent(xml, tag) {
  const results = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "g");
  let m;
  while ((m = re.exec(xml)) !== null) results.push(m[1]);
  return results;
}

function getTagContentWithAttrs(xml, tag) {
  const results = [];
  const re = new RegExp(`<${tag}([^>]*)(?:>([\\s\\S]*?)<\\/${tag}>|\\/>)`, "g");
  let m;
  while ((m = re.exec(xml)) !== null) {
    results.push({ attrs: m[1] || "", content: m[2] || "" });
  }
  return results;
}

function getAttr(attrStr, name) {
  const re = new RegExp(`${name}="([^"]*)"`, "i");
  const m = attrStr.match(re);
  return m ? m[1] : null;
}

// ── Parse .xlsx buffer → array of rows ──────────────────────
function parseXlsx(buffer) {
  const entries = readZipEntries(buffer);
  const entryMap = {};
  entries.forEach((e) => { entryMap[e.name] = e.data; });

  // Shared strings
  const sharedStrings = [];
  const ssBuf = entryMap["xl/sharedStrings.xml"];
  if (ssBuf) {
    const ssXml = ssBuf.toString("utf8");
    const siItems = getTagContent(ssXml, "si");
    siItems.forEach((si) => {
      // <si> can contain <t>text</t> or multiple <r><t>text</t></r>
      const tParts = getTagContent(si, "t");
      sharedStrings.push(tParts.join(""));
    });
  }

  // Find first sheet
  const sheetBuf =
    entryMap["xl/worksheets/sheet1.xml"] ||
    entries.find((e) => e.name.match(/xl\/worksheets\/sheet\d+\.xml/))?.data;
  if (!sheetBuf) throw new Error("No worksheet found in .xlsx file");
  const sheetXml = sheetBuf.toString("utf8");

  // Parse rows
  const rows = [];
  const rowItems = getTagContentWithAttrs(sheetXml, "row");
  for (const row of rowItems) {
    const cells = getTagContentWithAttrs(row.content, "c");
    const rowData = [];
    for (const cell of cells) {
      const type = getAttr(cell.attrs, "t");
      const ref = getAttr(cell.attrs, "r") || "";
      // Column index from ref like "A1", "B1", "AA1"
      const colStr = ref.replace(/\d+/g, "");
      let colIdx = 0;
      for (let i = 0; i < colStr.length; i++) {
        colIdx = colIdx * 26 + (colStr.charCodeAt(i) - 64);
      }
      colIdx -= 1; // 0-based

      const vParts = getTagContent(cell.content, "v");
      let value = vParts[0] || "";

      // Handle inline strings: <is><t>text</t></is>
      if (type === "inlineStr") {
        const isParts = getTagContent(cell.content, "is");
        if (isParts.length > 0) {
          const tParts = getTagContent(isParts[0], "t");
          value = tParts.join("");
        }
      } else if (type === "s" && sharedStrings[parseInt(value, 10)] !== undefined) {
        value = sharedStrings[parseInt(value, 10)];
      }

      // Pad row to reach this column
      while (rowData.length <= colIdx) rowData.push("");
      rowData[colIdx] = value;
    }
    rows.push(rowData);
  }
  return rows;
}

// ── Parse CSV string → array of rows ────────────────────────
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  // Detect separator (comma, semicolon, or tab)
  const firstLine = lines[0] || "";
  const sep =
    firstLine.includes("\t") ? "\t" :
    firstLine.includes(";") ? ";" : ",";

  return lines.map((line) => {
    const row = [];
    let inQuote = false;
    let field = "";
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuote) {
        if (ch === '"' && line[i + 1] === '"') { field += '"'; i++; }
        else if (ch === '"') { inQuote = false; }
        else { field += ch; }
      } else {
        if (ch === '"') { inQuote = true; }
        else if (ch === sep) { row.push(field.trim()); field = ""; }
        else { field += ch; }
      }
    }
    row.push(field.trim());
    return row;
  });
}

// ── Main: parse file buffer (auto-detect xlsx vs csv) ────────
function parseSpreadsheet(filePath) {
  const buf = fs.readFileSync(filePath);
  const ext = filePath.toLowerCase();

  if (ext.endsWith(".csv") || ext.endsWith(".tsv")) {
    return parseCsv(buf.toString("utf8"));
  }

  // Check for ZIP magic bytes (xlsx)
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b) {
    return parseXlsx(buf);
  }

  // Fallback: try as CSV
  return parseCsv(buf.toString("utf8"));
}

module.exports = { parseSpreadsheet, parseXlsx, parseCsv };
