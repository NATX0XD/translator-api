/**
 * The two-way system instruction promises the model "exactly two candidate
 * languages" and demands exactly one translation back. Sending any other number
 * of targets contradicts the prompt, and the model then either returns nothing
 * or translates into the source language — both of which surface to the user as
 * an untranslated echo. Reject the request instead.
 */
export const validateTranslateRequest = ({ twoWay, targets }) => {
  if (twoWay && (!Array.isArray(targets) || targets.length !== 2)) {
    return {
      ok: false,
      error: 'Invalid Request',
      message: 'twoWay requires exactly two entries in targets.',
    };
  }

  return { ok: true };
};
