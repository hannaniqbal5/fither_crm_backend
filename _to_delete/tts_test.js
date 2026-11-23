require("dotenv").config();
const { GoogleGenAI } = require("@google/genai");
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
(async () => {
  for (const model of ["gemini-3.1-flash-tts-preview", "gemini-2.5-flash-preview-tts"]) {
    const t0 = Date.now();
    try {
      const r = await ai.models.generateContent({
        model,
        contents: [{ parts: [{ text: "Read this WhatsApp reply aloud as a warm, friendly Pakistani woman from the FitHer team. If it is in Roman Urdu, pronounce it as spoken Urdu:\n\nJi ma'am, 1 month ka plan 3,500 ka hai. Lekin 2 month wala 5,000 ka hai, yani 2,500 per month. Woh dekh lein?" }] }],
        config: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } } },
      });
      const b64 = r?.candidates?.[0]?.content?.parts?.find(p => p.inlineData)?.inlineData?.data;
      const pcm = Buffer.from(b64 || "", "base64");
      require("fs").writeFileSync(`_to_delete/tts_${model}.pcm`, pcm);
      console.log(model, "OK", (pcm.length / 48000).toFixed(1) + "s audio", Date.now() - t0 + "ms", JSON.stringify(r.usageMetadata));
    } catch (e) { console.log(model, "FAIL", String(e.message).slice(0, 200)); }
  }
})();
