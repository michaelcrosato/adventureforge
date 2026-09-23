import type { CompiledRpgSource } from "../rpg/source.js";
import type { ValidationReport } from "../validate/report.js";
import { resolveWorldQuestSourceId, type WorldQuestSourceArgs } from "../world/source.js";
import type { RpgWorldQuestReportSource } from "./rpg_source_runtime.js";

type WorldQuestReportLoader = (worldQuestId: string) => RpgWorldQuestReportSource;

type WorldQuestValidationReportResponse = {
  ok: boolean;
  world_quest_id: string | null;
  report: ValidationReport;
};

type WorldQuestLoadReportResponse = {
  ok: boolean;
  world_quest_id: string | null;
  meta?: CompiledRpgSource["pack"]["meta"];
  content_hash?: string;
  report: ValidationReport;
};

export function validateWorldQuestReport(
  args: WorldQuestSourceArgs,
  operation: string,
  loadWorldQuest: WorldQuestReportLoader,
): WorldQuestValidationReportResponse {
  const requestedWorldQuestId = resolveWorldQuestSourceId(args, operation);
  const source = loadWorldQuest(requestedWorldQuestId);
  const lr = source.result;
  return {
    ok: lr.report.ok,
    world_quest_id: source.questId,
    report: lr.report,
  };
}

export function loadWorldQuestReport(
  args: WorldQuestSourceArgs,
  operation: string,
  loadWorldQuest: WorldQuestReportLoader,
): WorldQuestLoadReportResponse {
  const requestedWorldQuestId = resolveWorldQuestSourceId(args, operation);
  const source = loadWorldQuest(requestedWorldQuestId);
  const lr = source.result;
  if (!lr.ok) {
    return {
      ok: false,
      world_quest_id: source.questId,
      report: lr.report,
    };
  }
  return {
    ok: lr.report.ok,
    world_quest_id: source.questId,
    meta: lr.compiled.pack.meta,
    content_hash: lr.compiled.contentHash,
    report: lr.report,
  };
}
