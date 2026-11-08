require("dotenv").config();
const bcrypt = require("bcrypt");
const { sequelize, SalesRep } = require("../models");

(async () => {
  try {
    await sequelize.authenticate();

    const password = "password123"; // choose strong password
    const hashed = await bcrypt.hash(password, 10);

    const rep = await SalesRep.create({
      name: "Ayesha",
      email: "ayesha@company.com",
      password: hashed,
      role: "rep",
      whatsapp_account_id: 1 // must exist
    });

    console.log("✅ Sales rep created:", rep.email);
    process.exit(0);
  } catch (err) {
    console.error("❌ Error creating sales rep:", err);
    process.exit(1);
  }
})();
