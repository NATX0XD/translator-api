import admin from "firebase-admin";
import { normalizeQuota, todayString, clampBillableSeconds } from "../lib/liveQuota.js";

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

  const { uid, seconds } = req.body;
  if (!uid) return res.status(400).json({ error: "Unauthorized: Missing User ID" });

  try {
    const quotaRef = db.collection("users_quota").doc(uid);
    const quotaSnap = await quotaRef.get();
    const todayStr = todayString(new Date());
    const quota = normalizeQuota(quotaSnap.exists ? quotaSnap.data() : null, todayStr);
    const session = (quotaSnap.exists && quotaSnap.data().live_session) || {};

    const billedSeconds = clampBillableSeconds({
      reported: seconds,
      mintedAtMs: session.mintedAt ?? null,
      nowMs: Date.now(),
      ttlSeconds: session.ttlSeconds ?? 600,
      used: quota.live_seconds_today,
      limit: quota.live_seconds_limit,
    });

    await quotaRef.set({
      tokens_today: quota.tokens_today,
      daily_limit: quota.daily_limit,
      live_seconds_today: quota.live_seconds_today + billedSeconds,
      live_seconds_limit: quota.live_seconds_limit,
      last_reset_date: quota.last_reset_date,
      live_session: admin.firestore.FieldValue.delete(),
    }, { merge: true });

    return res.status(200).json({
      billedSeconds,
      liveSecondsToday: quota.live_seconds_today + billedSeconds,
      liveSecondsLimit: quota.live_seconds_limit,
    });
  } catch (error) {
    console.error("live-usage Error:", error.message);
    return res.status(500).json({ error: "Live Usage Failed", message: error.message });
  }
}
