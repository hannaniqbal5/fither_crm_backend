const fs=require("fs");const p="src/ai/prompt.builder.js";let s=fs.readFileSync(p,"utf8");
function rep(a,b){ if(!s.includes(a)) throw new Error("not found: "+a.slice(0,70)); s=s.replace(a,b); }
const tail = fs.readFileSync("_to_delete/patch_prompt.js","utf8");
// re-run step 1-5 from first patch (minus the failing require line)
eval(tail.split("// 6. Wire persona")[0].replace(/^const fs=.*\n/,"").replace(/^function rep.*\n/m,""));
// 6. require at top
rep("const SHARED_BASE = `", "const { FIZA_PERSONA, FIZA_FINAL_CHECK } = require(\"./fizaPersona\");\n\nconst SHARED_BASE = `");
// 7. mid-conversation flag + final check + persona placeholder
rep("  const journeyContext  = opts.journeyContext || null;",
"  const journeyContext  = opts.journeyContext || null;\n  const midConversation = !!opts.midConversation;");
rep("  const full = SHARED_BASE + modeSection + journeyBlock + intentBlock + examplesBlock + voiceBlock;",
"  const convoBlock = midConversation\n    ? \"\\n# RIGHT NOW: you are MID-CONVERSATION with her (you replied recently). Do NOT greet, do NOT say 'Hello ma\\u2019am' — just continue naturally.\\n\"\n    : \"\\n# RIGHT NOW: this is the start of a new conversation (or she's back after a long gap). One short greeting is fine.\\n\";\n\n  const full = SHARED_BASE + modeSection + journeyBlock + intentBlock + examplesBlock + voiceBlock + convoBlock + FIZA_FINAL_CHECK;");
rep("    .replace(\"{retrieved_context}\"", "    .replace(\"{fiza_persona}\", FIZA_PERSONA)\n    .replace(\"{retrieved_context}\"");
fs.writeFileSync(p,s);console.log("ok");
