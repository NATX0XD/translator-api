import { GoogleGenerativeAI } from "@google/generative-ai";
import admin from "firebase-admin";


if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
    });
    console.log("Firebase Admin Initialized");
  } catch (error) {
    console.error("Firebase Admin Init Error:", error.stack);
  }
}

const db = admin.firestore();

export default async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ message: 'Use POST' });

  const { sourceText, targets, uid } = req.body;

  if (!uid) {
    return res.status(400).json({ error: "Unauthorized: Missing User ID" });
  }

  try {



    const quotaRef = db.collection("users_quota").doc(uid);
    const quotaSnap = await quotaRef.get();


    const todayStr = new Date().toISOString().split('T')[0];

    let quotaData;

    if (!quotaSnap.exists) {

      quotaData = {
        tokens_today: 0,
        daily_limit: 10000,
        last_reset_date: todayStr
      };
      await quotaRef.set(quotaData);
    } else {
      quotaData = quotaSnap.data();


      if (quotaData.last_reset_date !== todayStr) {

        quotaData.tokens_today = 0;
        quotaData.last_reset_date = todayStr;

        await quotaRef.update({
          tokens_today: 0,
          last_reset_date: todayStr
        });
      }
    }


    if (quotaData.tokens_today >= quotaData.daily_limit) {
      return res.status(429).json({
        error: "Quota Exceeded",
        message: "You have reached your daily token limit (10,000 tokens). Please come back tomorrow."
      });
    }




    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: "gemini-3.1-flash-lite-preview",
      systemInstruction: "Expert Translator. Detect source language (English name). Translate by Formality(0-100) & Objective per target."
    });

    const generationConfig = {
      response_mime_type: "application/json",
      temperature: 0.1,
      response_schema: {
        type: "object",
        properties: {
          detected: { type: "string" },
          translations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                lang: { type: "string" },
                text: { type: "string" }
              },
              required: ["lang", "text"]
            }
          }
        },
        required: ["detected", "translations"]
      }
    };

    const userPrompt = JSON.stringify({ src: sourceText, targets });
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      generationConfig
    });

    const responseText = result.response.text();
    const parsedResponse = JSON.parse(responseText);
    const totalTokens = result.response.usageMetadata.totalTokenCount;




    await quotaRef.update({
      tokens_today: admin.firestore.FieldValue.increment(totalTokens)
    });




    return res.status(200).json({
      success: true,
      ...parsedResponse,
      usedTokens: totalTokens
    });

  } catch (error) {
    console.error("API Error:", error.message);
    return res.status(500).json({
      error: "Translation Failed",
      message: error.message
    });
  }
}