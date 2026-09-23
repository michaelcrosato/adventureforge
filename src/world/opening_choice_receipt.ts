import type { JourneyStoryChoiceOption } from "./journey_contract.js";

export const OPENING_SELECTION_RECEIPT_WORD_LIMIT = 32 as const;

export function openingSelectionReceiptWordCount(value: string): number {
  return value.match(/\S+/g)?.length ?? 0;
}

type OpeningChoiceOptionPresentation = Readonly<{
  id: string;
  label: string;
  commitment: string;
  exactBenefit: string;
  checkFit?: string;
  immediateCost: string;
  giveUp: string;
}>;

/**
 * Build one roleplay-first opening card and its exact inspected receipt.
 * Dynamic costs remain authoritative because callers pass the same computed
 * formatter output used by the actual choice. The receipt fails closed instead
 * of truncating a negation or binding condition.
 */
export function presentOpeningChoiceOption(
  args: OpeningChoiceOptionPresentation,
): JourneyStoryChoiceOption {
  const consequence =
    `Benefit: ${args.exactBenefit} Cost: ${args.immediateCost}. ` + `Tradeoff: ${args.giveUp}`;
  const wordCount = openingSelectionReceiptWordCount(consequence);
  if (wordCount > OPENING_SELECTION_RECEIPT_WORD_LIMIT) {
    throw new Error(
      `Opening choice "${args.id}" receipt uses ${String(wordCount)} words; ` +
        `limit is ${String(OPENING_SELECTION_RECEIPT_WORD_LIMIT)}.`,
    );
  }
  return Object.freeze({
    id: args.id,
    label: args.label,
    summary: Object.freeze({
      commitment: args.commitment,
      ...(args.checkFit === undefined ? {} : { checkFit: args.checkFit }),
      immediateCost: args.immediateCost,
      tradeoff: args.giveUp,
    }),
    consequence,
  });
}
