import admin from "firebase-admin";
import { extractBearerToken } from "../lib/auth.js";
import { todayString } from "../lib/liveQuota.js";
import { planUsageReport, isEmptyPlan } from "../lib/quotaStore.js";
import { planToUpdate } from "../lib/firestorePlan.js";

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

  // Verified uid only — a body uid would let anyone drain another user's bucket.
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
    console.error("live-usage auth error:", error.message);
    return res.status(401).json({ error: "Unauthorized", message: "Invalid or expired ID token" });
  }

  const { seconds } = req.body;

  try {
    const quotaRef = db.collection("users_quota").doc(uid);
    const todayStr = todayString(new Date());

    const outcome = await db.runTransaction(async (tx) => {
      const snap = await tx.get(quotaRef);
      const result = planUsageReport({
        data: snap.exists ? snap.data() : null,
        todayStr,
        nowMs: Date.now(),
        reported: seconds,
      });

      if (!snap.exists) {
        tx.set(quotaRef, planToUpdate(result.plan), { merge: true });
      } else if (!isEmptyPlan(result.plan)) {
        tx.update(quotaRef, planToUpdate(result.plan));
      }

      return result;
    });

    // A session that bills nothing is the signature of a client bug (reporting
    // under the wrong uid, firing before the mint). Never let it pass silently.
    if (Number(seconds) > 0 && outcome.billedSeconds === 0) {
      console.warn(
        `live-usage: reported ${seconds}s but billed 0 (uid ${uid}, reason ${outcome.reason})`
      );
    }

    return res.status(200).json({
      billedSeconds: outcome.billedSeconds,
      reason: outcome.reason,
      liveSecondsToday: outcome.liveSecondsToday,
      liveSecondsLimit: outcome.liveSecondsLimit,
    });
  } catch (error) {
    console.error("live-usage Error:", error.message);
    return res.status(500).json({ error: "Live Usage Failed", message: error.message });
  }
}
