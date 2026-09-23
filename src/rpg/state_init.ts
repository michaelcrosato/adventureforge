import { applyEffects, type Effect } from "../core/effects.js";
import { initState, type GameState } from "../core/state.js";
import {
  cloneEmbeddedLaunchOverlay,
  type EmbeddedLaunchOverlay,
} from "../core/embedded_launch_overlay_receipt.js";
import {
  projectCampaignCharacterImports,
  type CampaignCharacterImportInput,
} from "./campaign_character_import.js";
import type { RpgPack } from "./schema.js";

type InitRuntimeStateOptions = {
  seed: number;
  start: string;
  varsInit?: Record<string, number> | undefined;
  flagsInit?: string[] | undefined;
  heldItems?: string[] | undefined;
  onEnter?: Effect[] | undefined;
  campaignImport?: (CampaignCharacterImportInput & { pack: RpgPack }) | undefined;
  launchOverlay?: EmbeddedLaunchOverlay | undefined;
};

export function initRuntimeState(opts: InitRuntimeStateOptions): GameState {
  const seeded = initState({
    seed: opts.seed,
    start: opts.start,
    ...(opts.varsInit !== undefined ? { varsInit: opts.varsInit } : {}),
    ...(opts.flagsInit !== undefined ? { flagsInit: opts.flagsInit } : {}),
  });
  const base =
    opts.heldItems && opts.heldItems.length > 0
      ? { ...seeded, inventory: [...seeded.inventory, ...opts.heldItems] }
      : seeded;
  const imported = opts.campaignImport
    ? projectCampaignCharacterImports(
        opts.campaignImport.pack,
        base,
        opts.campaignImport.character,
        opts.campaignImport.imports,
      ).state
    : base;
  const overlaid =
    opts.launchOverlay === undefined
      ? imported
      : {
          ...imported,
          flags: {
            ...imported.flags,
            [opts.launchOverlay.receipt.applied_flag]: true,
          },
          embeddedLaunchOverlayReceipt: cloneEmbeddedLaunchOverlay(opts.launchOverlay).receipt,
        };
  return opts.onEnter && opts.onEnter.length > 0
    ? applyEffects(opts.onEnter, overlaid).state
    : overlaid;
}
