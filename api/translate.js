import { GoogleGenerativeAI } from "@google/generative-ai";

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ message: 'Use POST' });

  const { sourceText, targets } = req.body;

  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

    const model = genAI.getGenerativeModel({
      model: "gemini-3.1-flash-lite-preview",
      // 💡 ประหยัดที่สุด: บีบคำสั่งให้สั้น กระชับ และบังคับตอบชื่อภาษาเป็นภาษาอังกฤษ
      systemInstruction: "Expert Translator. Detect source language (English name). Translate by Formality(0-100) & Objective per target."
    });

    const generationConfig = {
      response_mime_type: "application/json",
      temperature: 0.1,
      response_schema: {
        type: "object",
        properties: {
          detected: { type: "string" }, // ย่อจาก detectedLanguage
          translations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                lang: { type: "string" }, // ย่อจาก language
                text: { type: "string" }
              },
              required: ["lang", "text"]
            }
          }
        },
        required: ["detected", "translations"]
      }
    };

    // 💡 ประหยัดที่สุด: ส่งแค่ src กับ targets
    const userPrompt = JSON.stringify({ src: sourceText, targets });

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      generationConfig
    });

    return res.status(200).json({
      success: true,
      ...JSON.parse(result.response.text())
    });

  } catch (error) {
    console.error("API Error:", error.message);
    return res.status(500).json({ error: "Translation Failed" });
  }
}