/**
 * Spectate feed formatting — turn the compact MCP tool result an LLM consumes
 * into a human-readable play-by-play a person can watch scroll by. The engine's
 * story output IS in the tool result (the `["n", text]` narration events carry
 * die rolls, prose beats, and NPC dialogue in full); this surfaces it as plain
 * lines instead of a wall of JSON. Pure and defensive: any parse issue falls
 * back to a trimmed raw dump so the feed never breaks. Room descriptions are
 * whatever the caller requested (a blind agent plays with compact_observation,
 * so those repeat lines are truncated by the engine before we see them — the
 * per-turn narration is the full content and is shown untrimmed).
 */
function spectateTrim(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)} … (+${text.length - max} chars)`;
}

type Json = Record<string, unknown>;

function asRecord(v: unknown): Json {
  return v && typeof v === "object" ? (v as Json) : {};
}

function sceneTitleOf(ctx: Json): string | undefined {
  const here = ctx.here;
  return Array.isArray(here) && typeof here[1] === "string" ? here[1] : undefined;
}

type TravelRoadScene = {
  id: string;
  risk: string;
  title: string;
  summary: string;
};

/** Decode either the default compact travel tuple or the unchanged full result. */
function travelRoadSceneOf(value: unknown): TravelRoadScene | undefined {
  if (Array.isArray(value)) {
    return typeof value[6] === "string" &&
      typeof value[7] === "string" &&
      typeof value[8] === "string" &&
      typeof value[9] === "string"
      ? { id: value[6], risk: value[7], title: value[8], summary: value[9] }
      : undefined;
  }
  const event = asRecord(asRecord(value).roadEvent);
  return typeof event.id === "string" &&
    typeof event.risk === "string" &&
    typeof event.title === "string" &&
    typeof event.summary === "string"
    ? { id: event.id, risk: event.risk, title: event.title, summary: event.summary }
    : undefined;
}

/** Render narration/rejection/ending events; report whether the scene moved. */
function renderEvents(events: unknown[], out: string[]): boolean {
  let moved = false;
  for (const ev of events) {
    if (!Array.isArray(ev)) continue;
    const tag = ev[0];
    if (tag === "n" && typeof ev[1] === "string") out.push(`   ${ev[1]}`);
    else if (tag === "r" && typeof ev[1] === "string") out.push(`   ✗ ${ev[1]}`);
    else if (tag === "m") moved = true;
    else if (tag === "e" && typeof ev[1] === "string") out.push(`   ✦ ending: ${ev[1]}`);
  }
  return moved;
}

/**
 * One readable feed entry. `now` is injected for deterministic tests.
 * Returns a trailing-newline-terminated block.
 */
export function formatSpectateEntry(
  name: string,
  args: unknown,
  body: string,
  isError: boolean,
  now: Date,
): string {
  const ts = now.toISOString().slice(11, 19); // HH:MM:SS — feed is same-day scrollback
  const a = asRecord(args);
  const out: string[] = [];
  const head = (s: string): void => void out.push(`\n── ${ts}  ${s}`);

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    payload = undefined;
  }
  if (isError || payload === undefined) {
    head(`${name}${isError ? "  ✗ ERROR" : ""}`);
    out.push(`   ${spectateTrim(body || "(no body)", 600)}`);
    return `${out.join("\n")}\n`;
  }

  const p = asRecord(payload);
  const ctx = asRecord(p.context);
  const title = sceneTitleOf(ctx);
  const events = Array.isArray(p.events) ? p.events : [];

  switch (name) {
    case "start_world_quest":
    case "new_game":
    case "load_game": {
      const seed = a.seed !== undefined ? ` (seed ${String(a.seed)})` : "";
      head(`▶ start ${String(a.world_quest_id ?? name)}${seed}`);
      if (title) out.push(`   ┌ ${title}`);
      if (typeof ctx.text === "string") out.push(`   ${ctx.text}`);
      break;
    }
    case "step_action": {
      head(`▶ ${String(a.action_id ?? "step")}`);
      const moved = renderEvents(events, out);
      if (p.ok === false && events.length === 0)
        out.push(`   ✗ ${String(p.rejection_reason ?? "not available")}`);
      if (moved && title) {
        out.push(`   → ${title}`);
        if (typeof ctx.text === "string") out.push(`     ${ctx.text}`);
      }
      if (ctx.ended === true) out.push(`   ✦✦ THE END ✦✦`);
      break;
    }
    case "list_legal_actions": {
      const actions = Array.isArray(p.actions) ? p.actions : [];
      const cmds = actions
        .map((x) => (typeof x === "object" && x ? ((x as Json).command ?? (x as Json).id) : x))
        .filter((c): c is string => typeof c === "string");
      head(`· options (${cmds.length}): ${spectateTrim(cmds.join("  |  "), 400)}`);
      break;
    }
    case "get_transcript": {
      const s = asRecord(p.summary);
      head(
        `· transcript — ${String(s.steps ?? "?")} steps${s.ended ? `, ended ${String(s.ending_id ?? "")}` : ""}`,
      );
      break;
    }
    // ── Overworld (the core-game open world) ──────────────────────────────────
    case "start_overworld":
    case "restore_overworld_session": {
      const here = Array.isArray(ctx.here) ? ctx.here : [];
      const loc = typeof here[1] === "string" ? here[1] : "the open world";
      const region = typeof here[2] === "string" ? `, ${here[2]}` : "";
      const time = typeof ctx.time === "string" ? `  (${ctx.time})` : "";
      head(`▶ enter the world — ${loc}${region}${time}`);
      break;
    }
    case "start_overworld_session_quest": {
      const q = asRecord(p.quest);
      const compactQuest = Array.isArray(p.quest) ? p.quest : [];
      const questTitle =
        q.title ??
        (typeof compactQuest[1] === "string" ? compactQuest[1] : undefined) ??
        a.quest_id ??
        "a discovered quest";
      const approach = typeof a.approach_id === "string" ? ` via ${a.approach_id}` : "";
      head(`▶ enter quest: ${String(questTitle)}${approach}`);
      const rctx = asRecord(asRecord(p.rpg_session).context);
      const rtitle = sceneTitleOf(rctx);
      if (rtitle) out.push(`   ┌ ${rtitle}`);
      if (typeof rctx.text === "string") out.push(`   ${rctx.text}`);
      break;
    }
    case "travel_overworld_session": {
      const travel = p.travel;
      const travelRecord = asRecord(travel);
      const minutes = Array.isArray(travel) ? travel[3] : travelRecord.minutes;
      const mins = typeof minutes === "number" && minutes > 0 ? `  [+${minutes}m]` : "";
      head(`▷ travel${mins}`);
      const scene = travelRoadSceneOf(travel);
      if (scene) {
        out.push(`   ${scene.title} (risk ${scene.risk})`);
        out.push(`   ${scene.summary}`);
      }
      if (asRecord(ctx.pending_road).id !== undefined || asRecord(p.pending_road).id !== undefined)
        out.push(`   ⚠ road encounter — resolve before more travel`);
      break;
    }
    case "follow_overworld_session_goal": {
      const passage = asRecord(p.passage);
      const aggregateMinutes = passage.minutes;
      const minutes = Array.isArray(aggregateMinutes) ? aggregateMinutes[2] : aggregateMinutes;
      const mins = typeof minutes === "number" && minutes > 0 ? `  [+${minutes}m]` : "";
      const destination =
        typeof passage.destination === "string" ? passage.destination : "the current objective";
      const stoppedAt = passage.stopped_at ?? passage.stoppedAt;
      const stopReason = passage.stop_reason ?? passage.stopReason;
      head(`▷ goal passage → ${destination}${mins}`);
      if (typeof stoppedAt === "string") {
        out.push(
          `   stopped at ${stoppedAt}${typeof stopReason === "string" ? ` (${stopReason})` : ""}`,
        );
      }
      const legs = Array.isArray(passage.legs) ? passage.legs : [];
      for (const leg of legs) {
        const scene = travelRoadSceneOf(leg);
        if (!scene) continue;
        out.push(`   ${scene.title} (risk ${scene.risk})`);
        out.push(`   ${scene.summary}`);
      }
      if (
        stopReason === "road_encounter" ||
        asRecord(ctx.pending_road).id !== undefined ||
        asRecord(p.pending_road).id !== undefined
      ) {
        out.push(`   ⚠ road encounter — resolve before more travel`);
      }
      break;
    }
    default: {
      // Overworld action results carry a journal `entry` = [kind, title, when]
      // plus optional discovery lists — render that as a readable beat. This
      // covers scout / talk / explore / move / travel / work / investigate /
      // resolve / rest / resupply / road-encounter uniformly.
      const entry = Array.isArray(p.entry) ? p.entry : null;
      const mins = typeof p.m === "number" && p.m > 0 ? `  [+${p.m}m]` : "";
      if (entry && typeof entry[1] === "string") {
        head(`▷ ${name}${mins}`);
        out.push(`   ${entry[1]}`);
        if (typeof p.text === "string" && p.text.trim() !== "") {
          out.push(`   ${p.text}`);
        }
        const discoveries: Array<readonly [string, string]> = [
          ["areas", "area"],
          ["jobs", "job"],
          ["sites", "site"],
          ["quests", "quest lead"],
          ["contacts", "contact"],
          ["events", "event"],
        ];
        for (const [key, label] of discoveries) {
          const arr = p[key];
          if (!Array.isArray(arr) || arr.length === 0) continue;
          const names = arr
            .map((x) => (Array.isArray(x) ? x[1] : x))
            .filter((s): s is string => typeof s === "string");
          if (names.length) out.push(`   ↳ found ${label}: ${names.join(", ")}`);
        }
      } else {
        head(`· ${name}`);
      }
      // A pending road encounter blocks all further travel — flag it loudly.
      if (asRecord(ctx.pending_road).id !== undefined || asRecord(p.pending_road).id !== undefined)
        out.push(`   ⚠ road encounter — resolve before more travel`);
    }
  }
  return `${out.join("\n")}\n`;
}
