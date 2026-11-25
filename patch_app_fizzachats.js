// Patch app.js to add fizzaChats route
const fs = require('fs');
const f = process.argv[2];
let code = fs.readFileSync(f, 'utf8');

// 1. Add require after numberUploadRoutes
const reqLine = `const numberUploadRoutes = require("./routes/numberUpload.routes");`;
if (!code.includes('fizzaChats.routes')) {
  code = code.replace(
    reqLine,
    reqLine + `\nconst fizzaChatsRoutes = require("./routes/fizzaChats.routes"); // Phase 21 — Fizza Chats admin view`
  );
}

// 2. Add app.use after numberUpload route
const useLine = `app.use("/api",              numberUploadRoutes);  // Number upload & management`;
if (!code.includes('fizza-chats')) {
  code = code.replace(
    useLine,
    useLine + `\napp.use("/api/admin/fizza-chats", auth, fizzaChatsRoutes); // Phase 21 — Fizza Chats`
  );
}

// 3. Make sure auth is imported if not already available as a variable for the app.use line
// Actually, the route file itself handles auth middleware, so we just mount it plain
// Let's fix the app.use line to not require auth at mount level (route handles it)
code = code.replace(
  `app.use("/api/admin/fizza-chats", auth, fizzaChatsRoutes);`,
  `app.use("/api/admin/fizza-chats", fizzaChatsRoutes);`
);

fs.writeFileSync(f, code, 'utf8');
console.log('✅ app.js patched for fizzaChats routes');
