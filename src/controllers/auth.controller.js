const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { SalesRep } = require("../../models");

// exports.login = async (req, res) => {
//   try {
//     const { email, password } = req.body;

//     const rep = await SalesRep.findOne({ where: { email } });
//     if (!rep) {
//       return res.status(401).json({ error: "Invalid credentials" });
//     }

//     const match = await bcrypt.compare(password, rep.password);
//     if (!match) {
//       return res.status(401).json({ error: "Invalid credentials" });
//     }

//     if (!process.env.JWT_SECRET) {
//       throw new Error("JWT_SECRET is not defined");
//     }

//     const token = jwt.sign(
//       {
//         repId: rep.id,
//         whatsappAccountId: rep.whatsapp_account_id,
//         role: rep.role
//       },
//       process.env.JWT_SECRET,
//       { expiresIn: "7d" }
//     );

//     res.json({
//       token,
//       rep: {
//         id: rep.id,
//         name: rep.name,
//         email: rep.email
//       }
//     });
//   } catch (err) {
//     console.error("❌ Login error:", err);
//     res.status(500).json({ error: "Login failed" });
//   }
// };
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
      return res.status(400).json({ error: "email and password are required" });
    }

    // 1️⃣ Find rep
    const rep = await SalesRep.findOne({ where: { email } });
    if (!rep) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // 2️⃣ Verify password
    const match = await bcrypt.compare(password, rep.password);
    if (!match) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Deactivated reps cannot log in (checked after the password so this
    // doesn't reveal which emails exist).
    if (rep.status !== "active") {
      return res.status(403).json({ error: "Account is inactive. Contact admin." });
    }

    // 3️⃣ Create SHORT-LIVED TOKEN (this is your "token")
    const token = jwt.sign(
      {
        repId: rep.id,
        whatsappAccountId: rep.whatsapp_account_id,
        role: rep.role,
      },
      process.env.JWT_SECRET, // ✅ still ACCESS_SECRET
      { expiresIn: "8h" }
    );

    // 4️⃣ Create REFRESH TOKEN (cookie only)
    const refreshToken = jwt.sign(
      { repId: rep.id },
      process.env.REFRESH_SECRET,
      { expiresIn: "7d" }
    );

    // 5️⃣ Set refresh token cookie 🍪 (persists even when tab closes)
    res.cookie("refresh_token", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    // 6️⃣ Respond EXACTLY like before (token)
    res.json({
      token,
      rep: {
        id: rep.id,
        name: rep.name,
        email: rep.email,
        role: rep.role,
      },
    });
  } catch (err) {
    console.error("❌ Login error:", err);
    res.status(500).json({ error: "Login failed" });
  }
};

// Clears the httpOnly refresh_token cookie set during login.
// Options MUST match res.cookie() in login() (path/sameSite/secure/httpOnly),
// otherwise the browser will not remove the cookie.
exports.logout = async (req, res) => {
  try {
    res.clearCookie("refresh_token", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
    });
    return res.json({ success: true, message: "Logged out" });
  } catch (err) {
    console.error("❌ Logout error:", err);
    return res.status(500).json({ error: "Logout failed" });
  }
};