const fs=require("fs");const p="src/routes/fizaChat.routes.js";let s=fs.readFileSync(p,"utf8");
function rep(a,b){ if(!s.includes(a)) throw new Error("nf: "+a.slice(0,60)); s=s.replace(a,b); }
rep("async function appJourney(lead) {", "async function appJourney(lead, assistant) {");
rep(`  return [
    "CHANNEL: she is writing in the Fit Her APP chat`, `  return [
    assistant === "luna"
      ? "NAME: in the Fit Her mobile app you are called LUNA, the in-app assistant on the Fit Her team (same knowledge as always). If she asks your name, you're Luna."
      : "",
    "CHANNEL: she is writing in the Fit Her APP chat`);
rep("{ journeyContext: await appJourney(lead) }", "{ journeyContext: await appJourney(lead, b.assistant) }");
rep(`      return res.json({ status: "handed_off", messages: out.map(asChat) });
    }
    res.json({ status: "fiza", messages: out.map(asChat) });`,
`      return res.json({ status: "handed_off", escalate: r.escalate || null, messages: out.map(asChat) });
    }
    res.json({ status: "fiza", messages: out.map(asChat) });`);
rep("module.exports = router;", `// POST /note { app_user_id, text } — the app backend adds an assistant line to
// her chat (e.g. "I've opened ticket #12 for you"), so it stays in her history.
router.post("/note", async (req, res) => {
  try {
    const b = req.body || {};
    const text = String(b.text || "").trim().slice(0, 1000);
    if (!b.app_user_id || !text) return res.status(400).json({ error: "app_user_id and text are required" });
    const lead = await leadFor(b.app_user_id);
    if (!lead) return res.status(404).json({ error: "no_chat" });
    const m = await addMessage(lead, { from: "bot", direction: "OUT", text });
    pushToReps(req, lead, m);
    res.json({ messages: [asChat(m)] });
  } catch (err) {
    console.error("[fiza-web] note:", err);
    res.status(500).json({ error: "server_error" });
  }
});

module.exports = router;`);
fs.writeFileSync(p,s);console.log("ok");
