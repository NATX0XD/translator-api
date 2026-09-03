const DEFAULT_INSTRUCTION =
  "Expert Translator. Detect source language (English name). Translate by Formality(0-100) & Objective per target.";

const TWO_WAY_INSTRUCTION =
  "Expert Translator. Detect source language (English name). `targets` lists exactly two candidate languages. " +
  "Translate the text into the one that is not the source language, and return exactly one entry in `translations`. " +
  "Apply that target's Formality(0-100) & Objective.";

export const buildSystemInstruction = (twoWay) => (twoWay ? TWO_WAY_INSTRUCTION : DEFAULT_INSTRUCTION);
