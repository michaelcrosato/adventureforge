/** Normalize one controlled RPG command without changing its punctuation. */
export function normalizeRpgCommand(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Topic ids and aliases are author-facing identifiers. Terminal input treats
 * underscores and hyphens as spaces so `commit_lure`, `commit-lure`, and
 * `commit lure` share one controlled spelling. */
export function normalizeRpgTopicCommand(value: string): string {
  return normalizeRpgCommand(value.replace(/[_-]+/g, " "));
}

type QualifiedRpgAsk = {
  speaker: string;
  topic: string;
};

type RpgTalkCommand = {
  speaker: string;
};

/** Recognize TALK after the same id/alias punctuation normalization used by
 * dialogue topics. This prevents an authored `talk_to_<name>` topic alias from
 * stealing input that is visibly a speaker-selection command. */
export function parseRpgTalkCommand(value: string): RpgTalkCommand | null {
  const match = normalizeRpgTopicCommand(value).match(/^talk(?:\s+to)?\s+(.+)$/);
  return match ? { speaker: match[1]! } : null;
}

/** Recognize the speaker-qualified ASK form before topic aliases are resolved.
 * `ask about <topic>` remains the ordinary unqualified form. */
export function parseQualifiedRpgAskCommand(value: string): QualifiedRpgAsk | null {
  const match = normalizeRpgTopicCommand(value).match(/^ask\s+(.+?)\s+about\s+(.+)$/);
  if (!match) return null;
  return { speaker: match[1]!, topic: match[2]! };
}
