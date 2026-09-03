import admin from "firebase-admin";

/**
 * Turn a quotaStore write plan into a Firestore update object. `increment` and
 * `delete` become FieldValue sentinels, which is what keeps concurrent writes
 * from clobbering each other.
 */
export const planToUpdate = (plan) => {
  const update = { ...plan.set };

  for (const [field, amount] of Object.entries(plan.increment || {})) {
    update[field] = admin.firestore.FieldValue.increment(amount);
  }

  for (const field of plan.delete || []) {
    update[field] = admin.firestore.FieldValue.delete();
  }

  return update;
};
