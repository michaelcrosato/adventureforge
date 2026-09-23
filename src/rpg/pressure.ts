import { readVar, type GameState } from "../core/state.js";
import type { RpgPressureTrack } from "./schema.js";

export type RpgPressureBandView = {
  min: number;
  label: string;
  description?: string;
};

export type RpgPressureNextBandView = RpgPressureBandView;

export type RpgPressureTrackView = {
  id: string;
  title: string;
  var: string;
  value: number;
  band: RpgPressureBandView;
  next: RpgPressureNextBandView | null;
};

/**
 * Resolve one authored pressure declaration against ordinary RPG state. The
 * schema guarantees strictly ascending thresholds, so the greatest reached
 * threshold is the sole current band. Values below the authored floor use the
 * first band defensively; semantic validation rejects that state at quest start.
 */
function resolveRpgPressureTrack(track: RpgPressureTrack, state: GameState): RpgPressureTrackView {
  // readVar, not a bare index: defense in depth against an authored var name
  // that collides with an Object.prototype key (the validator already requires
  // the var to be declared, which gives it an own key).
  const value = readVar(state.vars, track.var);
  let bandIndex = 0;
  for (let index = 1; index < track.bands.length; index += 1) {
    const threshold = track.bands[index]!.min;
    if (value < threshold) break;
    bandIndex = index;
  }

  const band = track.bands[bandIndex]!;
  const next = track.bands[bandIndex + 1];
  return {
    id: track.id,
    title: track.title,
    var: track.var,
    value,
    band: {
      min: band.min,
      label: band.label,
      ...(band.description !== undefined ? { description: band.description } : {}),
    },
    next:
      next === undefined
        ? null
        : {
            min: next.min,
            label: next.label,
            ...(next.description !== undefined ? { description: next.description } : {}),
          },
  };
}

export function resolveRpgPressureTracks(
  tracks: readonly RpgPressureTrack[] | undefined,
  state: GameState,
): RpgPressureTrackView[] {
  return (tracks ?? []).map((track) => resolveRpgPressureTrack(track, state));
}
