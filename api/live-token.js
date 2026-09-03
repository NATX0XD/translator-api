import admin from "firebase-admin";
import { normalizeQuota, todayString } from "../lib/liveQuota.js";

const TOKEN_TTL_SECONDS = 600;
const SESSION_START_WINDOW_SECONDS = 60;
const LIVE_MODEL = "gemini-3.5-transcribe-live";

if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
    });
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

  const { uid } = req.body;
  if (!uid) return res.status(400).json({ error: "Unauthorized: Missing User ID" });

  try {
    const quotaRef = db.collection("users_quota").doc(uid);
    const quotaSnap = await quotaRef.get();
    const todayStr = todayString(new Date());
    const quota = normalizeQuota(quotaSnap.exists ? quotaSnap.data() : null, todayStr);

    const remainingSeconds = quota.live_seconds_limit - quota.live_seconds_today;
    if (remainingSeconds <= 0) {
      return res.status(429).json({
        error: "Live Quota Exceeded",
        message: `You have used your daily live translation allowance (${quota.live_seconds_limit} seconds). Please come back tomorrow.`,
        remainingSeconds: 0,
      });
    }

    const now = Date.now();
    const tokenResponse = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/auth_tokens",
      {
        method: "POST",
        headers: {
          "x-goog-api-key": process.env.GEMINI_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          uses: 1,
          expireTime: new Date(now + TOKEN_TTL_SECONDS * 1000).toISOString(),
          newSessionExpireTime: new Date(now + SESSION_START_WINDOW_SECONDS * 1000).toISOString(),
          liveConnectConstraints: { model: LIVE_MODEL },
        }),
      }
    );

    if (!tokenResponse.ok) {
      const detail = await tokenResponse.text();
      console.error("Ephemeral token mint failed:", tokenResponse.status, detail);
      return res.status(502).json({
        error: "Live Token Failed",
        message: `Gemini rejected the token request (${tokenResponse.status}): ${detail}`,
      });
    }

    const tokenData = await tokenResponse.json();

    await quotaRef.set({
      tokens_today: quota.tokens_today,
      daily_limit: quota.daily_limit,
      live_seconds_today: quota.live_seconds_today,
      live_seconds_limit: quota.live_seconds_limit,
      last_reset_date: quota.last_reset_date,
      live_session: { mintedAt: now, ttlSeconds: TOKEN_TTL_SECONDS },
    }, { merge: true });

    return res.status(200).json({
      token: tokenData.name,
      expiresAt: now + TOKEN_TTL_SECONDS * 1000,
      remainingSeconds: Math.min(remainingSeconds, TOKEN_TTL_SECONDS),
    });
  } catch (error) {
    console.error("live-token Error:", error.message);
    return res.status(500).json({ error: "Live Token Failed", message: error.message });
  }
}
