/**
 * The JSON shape the translate model must answer with.
 *
 * Two-way asks the model for the one target that is not the source language, so
 * the array is pinned to exactly one entry. Without the bound the model can
 * still return both targets, and the client reads `translations[0]` — which is
 * then a coin flip between the translation and an echo of what was just said.
 */
export const buildResponseSchema = (twoWay) => ({
  type: 'object',
  properties: {
    detected: { type: 'string' },
    translations: {
      type: 'array',
      ...(twoWay ? { minItems: 1, maxItems: 1 } : {}),
      items: {
        type: 'object',
        properties: {
          lang: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['lang', 'text'],
      },
    },
  },
  required: ['detected', 'translations'],
});
