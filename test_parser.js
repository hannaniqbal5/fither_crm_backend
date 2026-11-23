const { parseSpreadsheet } = require("./src/utils/xlsxParser");
const rows = parseSpreadsheet("uploads/numbers/1795449784450_FitHer_Complete_Database.xlsx");
console.log("Total rows:", rows.length);
console.log("Row 0 (headers):", JSON.stringify(rows[0]));
console.log("Row 1 (first data):", JSON.stringify(rows[1]));
console.log("Row 2:", JSON.stringify(rows[2]));
