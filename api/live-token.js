import admin from "firebase-admin";
import { extractBearerToken } from "../lib/auth.js";
import { todayString } from "../lib/liveQuota.js";
import { planTokenMint, isEmptyPlan } from "../lib/quotaStore.js";
import { planToUpdate } from "../lib/firestorePlan.js";

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ message: 'Use POST' });

  // The uid comes from the verified ID token only. A body uid would let anyone
  // who finds this URL mint Gemini credentials against an arbitrary account.
  const idToken = extractBearerToken(req);
  if (!idToken) {
    return res.status(401).json({
      error: "Unauthorized",
      message: "Missing Authorization: Bearer <Firebase ID token>",
    });
  }

  let uid;
  try {
    ({ uid } = await admin.auth().verifyIdToken(idToken));
  } catch (error) {
    console.error("live-token auth error:", error.message);
    return res.status(401).json({ error: "Unauthorized", message: "Invalid or expired ID token" });
  }

  try {
    const quotaRef = db.collection("users_quota").doc(uid);
    const todayStr = todayString(new Date());
    const now = Date.now();

    // Reset, abandoned-session billing, and the quota check all read the same
    // snapshot, so a concurrent /api/translate increment cannot be lost between
    // the read and the write.
    const outcome = await db.runTransaction(async (tx) => {
      const snap = await tx.get(quotaRef);
      const result = planTokenMint({
        data: snap.exists ? snap.data() : null,
        todayStr,
        nowMs: now,
      });

      if (!snap.exists) {
        tx.set(quotaRef, planToUpdate(result.plan), { merge: true });
      } else if (!isEmptyPlan(result.plan)) {
        tx.update(quotaRef, planToUpdate(result.plan));
      }

      return result;
    });

    if (outcome.abandonedSeconds > 0) {
      console.warn(`live-token: billed ${outcome.abandonedSeconds}s for an abandoned session (uid ${uid})`);
    }

    if (outcome.remainingSeconds <= 0) {
      return res.status(429).json({
        error: "Live Quota Exceeded",
        message: `You have used your daily live translation allowance (${outcome.liveSecondsLimit} seconds). Please come back tomorrow.`,
        remainingSeconds: 0,
      });
    }

    // uses: 1 is correct — a dropped socket falls back to Web Speech rather than
    // reconnecting, so the token is only ever spent on one new session.
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
    const mintedAt = Date.now();

    // Written only after the mint succeeds: a failure above leaves no session
    // behind to be billed as abandoned.
    await quotaRef.set({
      live_session: { mintedAt, ttlSeconds: TOKEN_TTL_SECONDS },
    }, { merge: true });

    return res.status(200).json({
      token: tokenData.name,
      expiresAt: mintedAt + TOKEN_TTL_SECONDS * 1000,
      remainingSeconds: Math.min(outcome.remainingSeconds, TOKEN_TTL_SECONDS),
    });
  } catch (error) {
    console.error("live-token Error:", error.message);
    return res.status(500).json({ error: "Live Token Failed", message: error.message });
  }
}
