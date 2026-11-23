const fs=require("fs");const p="src/ai/prompt.builder.js";let s=fs.readFileSync(p,"utf8");
const a="# LANGUAGE — match the user's language exactly\n- English in → English out";
const b="# LANGUAGE — match the language of her LATEST message (not the earlier chat)\n- If her latest message is in English, reply fully in English even if the chat before was Roman Urdu\n- English in → English out";
const c="# MEDICAL GUARDRAILS — non-negotiable";
const d="# LOCKED PRICES (PKR) — these are confirmed; use them, don't escalate a simple price question\n- 1 month: PKR 3,500\n- 2 months: PKR 5,000 (PKR 2,500 per month)\n- 3 months: PKR 6,000 (PKR 2,000 per month)\nFollow SINGLE-ANCHOR PRICING below: first reveal = lowest plan only + one question.\n\n# MEDICAL GUARDRAILS — non-negotiable";
if(!s.includes(a)||!s.includes(c)) throw "nf"; s=s.replace(a,b).replace(c,d); fs.writeFileSync(p,s); console.log("ok");
