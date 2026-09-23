import { z } from "zod";

export const EMBEDDED_LAUNCH_OVERLAY_RECEIPT_VERSION = 2 as const;
export const WOLF_WINTER_DISPATCH_DELAY_FLAG = "dispatch_opening_delayed" as const;
export const WOLF_WINTER_DISPATCH_ON_TIME_MAX_MINUTES = 60 as const;
const WOLF_WINTER_RPG_PACK_ID = "wolf_winter_v1";

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * A quest-local opening condition carried from a trusted overworld launch.
 *
 * This deliberately stores only a hash of the parent dispatch provenance. It
 * is not a campaign-character import and it does not assert a durable world
 * fact; it explains why this particular embedded RPG opened in this state.
 *
 * The receipt lives in GameState and therefore in every state hash, so it must
 * be a function of the launch alone. Version 1 also recorded the launching
 * surface's session handle (MCP `o-<uuid>`, "cli-journey", "ui-journey"), so the
 * same launch hashed differently per MCP run and per interface (bug_0644).
 * Version 2 drops it: `provenance_hash` already binds the receipt to the exact
 * dispatch proof it came from. Version 1 stays loadable, unchanged, so
 * already-started child saves restore to their original hashes.
 */
const receiptFields = {
  kind: z.literal("overworld_dispatch_opening"),
  world_quest_id: z.literal("wolf_winter"),
  // Dispatch-window version 1 remains loadable for already-started child
  // sessions; current parent launches write the order-neutral v2 departure receipt.
  dispatch_window_version: z.union([z.literal(1), z.literal(2)]),
  status: z.literal("delayed"),
  ledger_minutes: z
    .number()
    .int()
    .safe()
    .min(WOLF_WINTER_DISPATCH_ON_TIME_MAX_MINUTES + 1),
  provenance_hash: HashSchema,
  applied_flag: z.literal(WOLF_WINTER_DISPATCH_DELAY_FLAG),
};

export const EmbeddedLaunchOverlayReceiptSchema = z.discriminatedUnion("version", [
  z
    .object({
      version: z.literal(1),
      ...receiptFields,
      overworld_session_id: z.string().min(1),
    })
    .strict(),
  z
    .object({
      version: z.literal(EMBEDDED_LAUNCH_OVERLAY_RECEIPT_VERSION),
      ...receiptFields,
    })
    .strict(),
]);

export type EmbeddedLaunchOverlayReceipt = z.infer<typeof EmbeddedLaunchOverlayReceiptSchema>;

export type EmbeddedLaunchOverlay = Readonly<{
  receipt: EmbeddedLaunchOverlayReceipt;
}>;

export function cloneEmbeddedLaunchOverlayReceipt(
  receipt: EmbeddedLaunchOverlayReceipt,
): EmbeddedLaunchOverlayReceipt {
  return EmbeddedLaunchOverlayReceiptSchema.parse(receipt);
}

export function cloneEmbeddedLaunchOverlay(overlay: EmbeddedLaunchOverlay): EmbeddedLaunchOverlay {
  return Object.freeze({
    receipt: Object.freeze(cloneEmbeddedLaunchOverlayReceipt(overlay.receipt)),
  });
}

/** A persisted overlay must reload only through its original world-quest source. */
export function assertEmbeddedLaunchOverlayWorldQuest(
  state: { embeddedLaunchOverlayReceipt?: EmbeddedLaunchOverlayReceipt },
  worldQuestId: string | null | undefined,
): void {
  const receipt = state.embeddedLaunchOverlayReceipt;
  if (receipt !== undefined && worldQuestId !== receipt.world_quest_id) {
    throw new Error(
      `Embedded launch overlay belongs to world quest "${receipt.world_quest_id}", not ${JSON.stringify(worldQuestId)}.`,
    );
  }
}

/** The only authored pack allowed to consume the dispatch-opening flag. */
export function wolfWinterDispatchOverlayFlagForPack(packId: string): string | undefined {
  return packId === WOLF_WINTER_RPG_PACK_ID ? WOLF_WINTER_DISPATCH_DELAY_FLAG : undefined;
}
