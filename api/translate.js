import { GoogleGenerativeAI } from "@google/generative-ai";

export default async function handler(req, res) {
  // CORS Configuration
  res.setHeader('Access-Control-Allow-Origin', '*'); 
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method Not Allowed. Use POST.' });
  }

  const { sourceText, targetLangs, formality, objective } = req.body;

  if (!sourceText || !targetLangs || !Array.isArray(targetLangs)) {
     return res.status(400).json({ error: "Missing required fields: sourceText or targetLangs" });
  }

  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    
    const systemInstruction = `
      You are an expert Cultural Linguist and highly advanced AI Translator.
      Your task is to translate the provided text into the requested target languages.
      
      You must strictly adapt the translation based on these dynamic nuances:
      1. Formality Level: A score from 0 to 100.
         - 0-30: Highly informal, casual, slang, close friends.
         - 31-70: Standard, polite, everyday conversation.
         - 71-100: Highly formal, business, academic, respectful.
      2. Objective: The context or goal of this communication (e.g., travel, business, social).

      OUTPUT FORMAT:
      You MUST return ONLY a valid, raw JSON object. Do not wrap it in markdown code blocks like \`\`\`json.
      The structure must be:
      {
        "translations": {
          "[language_code]": {
            "text": "The translated string",
            "nuance_explanation": "Brief explanation of how the formality score and objective influenced the translation choices.",
            "cultural_tip": "Any cultural context, taboos, or tips for using this phrase in the target language."
          }
        }
      }
    `;

    const model = genAI.getGenerativeModel({ 
        model: "gemini-1.5-pro",
        systemInstruction: systemInstruction
    });

    const userPrompt = `
      Source Text: "${sourceText}"
      Target Languages: ${targetLangs.join(", ")}
      Formality Score: ${formality}/100
      Objective: ${objective}
      
      Generate the precise translations and insights in JSON format.
    `;

    const result = await model.generateContent(userPrompt);
    const responseText = result.response.text();

    // Clean JSON padding (just in case the LLM still returns markdown blocks)
    const cleanJson = responseText.replace(/```json/gi, "").replace(/```/gi, "").trim();
    
    let parsedData;
    try {
      parsedData = JSON.parse(cleanJson);
    } catch (parseErr) {
      console.error("Failed to parse Gemini output:", cleanJson);
      return res.status(500).json({ error: "Invalid JSON format returned from AI" });
    }

    return res.status(200).json({ 
      success: true, 
      data: parsedData 
    });

  } catch (error) {
    console.error("Translation API Error:", error);
    return res.status(500).json({ error: error.message || "Failed to communicate with AI Engine" });
  }
}