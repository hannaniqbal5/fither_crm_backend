const fs = require("fs");
const zlib = require("zlib");

const filePath = "uploads/numbers/1795449784450_FitHer_Complete_Database.xlsx";
const buf = fs.readFileSync(filePath);

// Minimal ZIP reader
function readZipEntries(buf) {
  const entries = [];
  let eocdPos = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocdPos = i; break; }
  }
  if (eocdPos < 0) throw new Error("Not a valid ZIP");
  const cdOffset = buf.readUInt32LE(eocdPos + 16);
  const cdCount = buf.readUInt16LE(eocdPos + 10);
  let pos = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;
    const compMethod = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);
    const name = buf.slice(pos + 46, pos + 46 + nameLen).toString("utf8");
    const lhPos = localHeaderOffset;
    const lhNameLen = buf.readUInt16LE(lhPos + 26);
    const lhExtraLen = buf.readUInt16LE(lhPos + 28);
    const dataStart = lhPos + 30 + lhNameLen + lhExtraLen;
    const rawData = buf.slice(dataStart, dataStart + compSize);
    let data;
    if (compMethod === 0) data = rawData;
    else if (compMethod === 8) data = zlib.inflateRawSync(rawData);
    else data = null;
    entries.push({ name, data });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

const entries = readZipEntries(buf);
console.log("ZIP entries:", entries.map(e => e.name));

// Show shared strings count
const ss = entries.find(e => e.name === "xl/sharedStrings.xml");
if (ss) {
  const xml = ss.data.toString("utf8");
  console.log("\nShared strings (first 500 chars):", xml.substring(0, 500));
} else {
  console.log("\nNo sharedStrings.xml found!");
}

// Show first part of sheet1
const sheet = entries.find(e => e.name.includes("sheet1.xml") || e.name.includes("sheet"));
if (sheet) {
  const xml = sheet.data.toString("utf8");
  console.log("\nSheet name:", sheet.name);
  console.log("Sheet XML (first 2000 chars):", xml.substring(0, 2000));
} else {
  console.log("No sheet found!");
}
