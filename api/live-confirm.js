import admin from "firebase-admin";
import { extractBearerToken } from "../lib/auth.js";

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

/**
 * Marks the current live session as real.
 *
 * The client posts this once its transcription socket is open. Only a confirmed
 * session is billable as abandoned at the next mint — without it, a mint whose
 * response was lost, or whose socket never opened, would later be charged for up
 * to the full token TTL and 429 the user for the rest of the day over zero audio.
 *
 * The body is ignored entirely; the uid comes from the verified token.
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ message: 'Use POST' });

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
    console.error("live-confirm auth error:", error.message);
    return res.status(401).json({ error: "Unauthorized", message: "Invalid or expired ID token" });
  }

  try {
    const quotaRef = db.collection("users_quota").doc(uid);

    // Transactional so a mint racing this call cannot have its brand new session
    // silently confirmed, and so the whole session object can be rewritten
    // without depending on Firestore's nested-merge behaviour.
    const confirmed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(quotaRef);
      const session = snap.exists ? snap.data().live_session : null;

      if (!session || typeof session.mintedAt !== 'number') return false;

      tx.update(quotaRef, { live_session: { ...session, confirmed: true } });
      return true;
    });

    return res.status(200).json({ confirmed });
  } catch (error) {
    console.error("live-confirm Error:", error.message);
    return res.status(500).json({ error: "Live Confirm Failed", message: error.message });
  }
}
