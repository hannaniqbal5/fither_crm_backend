require("dotenv").config();
const bcrypt = require("bcrypt");
const { sequelize, SalesRep } = require("../models");

const email = process.argv[2] || "ayesha@company.com";
const password = process.argv[3] || "password123";

(async () => {
  try {
    await sequelize.authenticate();
    const rep = await SalesRep.findOne({ where: { email } });
    if (!rep) { console.log("No rep found with", email); process.exit(1); }
    rep.password = await bcrypt.hash(password, 10);
    rep.status = "active";
    await rep.save();
    console.log("Password reset for", email, "(status: active)");
    process.exit(0);
  } catch (err) {
    console.error("Failed:", err.message);
    process.exit(1);
  }
})();
