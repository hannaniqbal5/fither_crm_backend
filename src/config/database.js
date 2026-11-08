const { Sequelize } = require('sequelize');

/**
 * DB connection settings.
 *
 *   - If DB_NAME is set in the environment → use DB_HOST / DB_PORT / DB_USER /
 *     DB_PASSWORD / DB_NAME (dialect mysql, or DB_DIALECT if set).
 *   - Otherwise → fall back to src/config/config.json[DB_PROFILE || "development"].
 *
 * Deliberately NOT keyed on NODE_ENV: setting NODE_ENV=production (e.g. for
 * secure cookies) must never silently switch which database the CRM uses.
 */
function resolveDbConfig() {
  if (process.env.DB_NAME) {
    return {
      database: process.env.DB_NAME,
      username: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      host:     process.env.DB_HOST || 'localhost',
      port:     process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
      dialect:  process.env.DB_DIALECT || 'mysql',
    };
  }
  const profile = process.env.DB_PROFILE || 'development';
  const all = require('./config.json');
  if (!all[profile]) {
    throw new Error(`DB_PROFILE "${profile}" not found in src/config/config.json`);
  }
  return all[profile];
}

const config = resolveDbConfig();

const sequelize = new Sequelize(
    config.database,
    config.username,
    config.password,
    {
        host: config.host,
        port: config.port,
        dialect: config.dialect,
    }
);

module.exports = sequelize;
module.exports.resolveDbConfig = resolveDbConfig;
