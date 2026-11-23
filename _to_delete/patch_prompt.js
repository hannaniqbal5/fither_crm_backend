const fs=require("fs");const p="src/ai/prompt.builder.js";let s=fs.readFileSync(p,"utf8");
function rep(a,b){ if(!s.includes(a)) throw new Error("not found: "+a.slice(0,60)); s=s.replace(a,b); }

// 1. Identity + tone/format → persona file
const start = s.indexOf("const SHARED_BASE = `You are Fiza");
const langIdx = s.indexOf("# LANGUAGE — match the user's language exactly");
const fmtStart = s.indexOf("# FORMAT\n");
const medIdx = s.indexOf("# MEDICAL GUARDRAILS");
if (start<0||langIdx<0||fmtStart<0||medIdx<0) throw new Error("anchors");
const langBlock = s.slice(langIdx, fmtStart);
s = s.slice(0,start) +
"const SHARED_BASE = `You are Fiza, a member of the FitHer team. FitHer is a women's wellness app for South Asian women, founded by Hannan and Shaista.\n\n{fiza_persona}\n\n# NEVER\nNEVER use \"aapi\" or any sister-like address.\nNEVER use religious greetings like \"Assalam-o-Alaikum\" or \"salam\".\n\n" +
langBlock + s.slice(medIdx);

s = s.replace("const SALES_MODE", "const SALES_MODE_PLACEHOLDER_GUARD = null;\nconst SALES_MODE");
s = s.replace("const SALES_MODE_PLACEHOLDER_GUARD = null;\n", "");

// 2. Social proof: only real numbers
rep("## 3. GOAL-RELATIVE SOCIAL PROOF — concrete numbers always beat vague claims\nUse SPECIFIC numbers tied to her goal:",
"## 3. GOAL-RELATIVE SOCIAL PROOF — concrete beats vague, but ONLY real numbers\nIf the FITHER KNOWLEDGE section gives a real number or story for her goal, use it. If it doesn't, talk about the program itself — never make a number up. Format examples (NOT facts, do not quote these):");
// 3. Loss aversion: no medical stats
rep("Cost of NOT acting hits 2× harder than gain of acting. Use for ghosted / will_start_later / re-engagement only — NEVER first-touch (would feel scary).",
"Cost of NOT acting hits 2× harder than gain of acting. Use for ghosted / will_start_later / re-engagement only — NEVER first-touch (would feel scary). Keep it gentle and about her own goal and time; NEVER quote medical risk figures (the lines below are tone examples only, do not repeat their numbers).");
// 4. Coach name not in knowledge
rep("\"Coach Asma ke is week ke batch mein sirf 20 women fit hoti hain", "\"Is week ke batch mein sirf 20 women fit hoti hain");
// 5. Price example started with filler empathy
rep("lines.push(\"\\\"Samajh sakti hoon ma\\u2019am. 1-month plan", "lines.push(\"\\\"Ji ma\\u2019am, 1-month plan");

// 6. Wire persona, mid-conversation flag, final check
rep("const { buildSystemPrompt", "const { FIZA_PERSONA, FIZA_FINAL_CHECK } = require(\"./fizaPersona\");\nconst { buildSystemPrompt");
fs.writeFileSync(p,s);console.log("step1 ok");
