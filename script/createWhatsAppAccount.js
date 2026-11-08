require("dotenv").config();
const { sequelize, WhatsAppAccount } = require("../models");

(async () => {
  try {
    await sequelize.authenticate();

    const account = await WhatsAppAccount.create({
      phone_number: "923001234567",
      session_path: "./session/whatsapp_1", // VERY IMPORTANT
      status: "active"
    });

    console.log("✅ WhatsApp Account created successfully");
    console.log("ID:", account.id);
    console.log("Phone:", account.phone_number);
    console.log("Session Path:", account.session_path);

    process.exit(0);
  } catch (err) {
    console.error("❌ Error creating WhatsApp account:", err);
    process.exit(1);
  }
})();
