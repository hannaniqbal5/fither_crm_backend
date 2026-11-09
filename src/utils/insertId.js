/**
 * insertIdOf — the new row id from `const [r] = await sequelize.query("INSERT …")`.
 *
 * Sequelize 6 + MySQL returns [newId, affectedRows] when the SQL starts with
 * "INSERT INTO" (so r is a number), but [ResultSetHeader, …] when it doesn't
 * (so r.insertId). Code that only read r.insertId got undefined. Use this.
 */
function insertIdOf(r) {
  if (typeof r === "number") return r;
  if (r && typeof r.insertId === "number") return r.insertId;
  if (Array.isArray(r)) return insertIdOf(r[0]);
  return null;
}
module.exports = { insertIdOf };
