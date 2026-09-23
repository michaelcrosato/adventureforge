/**
 * Mirror the intake queue onto Linear — title join key, priority map, labels.
 *
 * Linear is the human surface (`docs/linear_workflow.md`). The queue JSON remains
 * canonical. Identity on Linear is the `[16-hex]` title prefix, the same id
 * `npm run work -- --claim` uses. Re-pushing must UPDATE that issue, not open a
 * second one the first time a human edits the rest of the title.
 *
 * Auth is local-only: a personal API key (`Authorization: <LINEAR_API_KEY>`, no
 * Bearer) or an OAuth access token (`Authorization: Bearer …`). This module never
 * writes those secrets.
 */
import {
  defaultPriority,
  externalMirrorFor,
  SubmissionKindSchema,
  SubmissionSchema,
  submissionId,
  SUBMISSION_SCHEMA_VERSION,
  titleKey,
  type Submission,
  type SubmissionPriority,
  type SubmissionStatus,
} from "./submission.js";

const LINEAR_GRAPHQL = "https://api.linear.app/graphql";
export const DEFAULT_LINEAR_TEAM = "MIC";
export const DEFAULT_LINEAR_PROJECT = "adventureforge-59cb5298fba1";
const LINEAR_INTAKE_LABEL = "intake-mirror";

/**
 * Which team and project a sync targets, given CLI flags and the environment.
 *
 * A value that is PRESENT BUT BLANK means "unset", not "use the empty string".
 * `.env.example` ships `LINEAR_PROJECT=` blank and tells the reader to copy the file
 * to `.env` and fill in the values — and the only value that actually needs filling is
 * the API key, because the defaults above are already correct for this repo. So the
 * overwhelmingly common `.env` carries a blank LINEAR_PROJECT, and `??` does not fall
 * through on "": the sync would resolve an empty project slug and fail to find the
 * project, reporting an error that names Linear rather than the blank line that caused
 * it. Treating blank as absent is what makes the shipped template correct as it ships,
 * which is the entire point of shipping a template.
 */
export function resolveLinearTarget(
  env: NodeJS.ProcessEnv = process.env,
  overrides: { team?: string | null | undefined; project?: string | null | undefined } = {},
): { teamKey: string; projectSlug: string } {
  const pick = (
    explicit: string | null | undefined,
    fromEnv: string | undefined,
    fallback: string,
  ) => explicit?.trim() || fromEnv?.trim() || fallback;
  return {
    teamKey: pick(overrides.team, env.LINEAR_TEAM, DEFAULT_LINEAR_TEAM),
    projectSlug: pick(overrides.project, env.LINEAR_PROJECT, DEFAULT_LINEAR_PROJECT),
  };
}

/** Linear priority: 0 none, 1 Urgent, 2 High, 3 Medium, 4 Low. */
export const LINEAR_PRIORITY: Readonly<Record<SubmissionPriority, number>> = {
  P0: 1,
  P1: 2,
  P2: 3,
  P3: 4,
};

export function submissionPriorityForLinear(
  priority: number,
  fallback: SubmissionPriority = "P1",
): SubmissionPriority {
  if (priority === 1) return "P0";
  if (priority === 2) return "P1";
  if (priority === 3) return "P2";
  if (priority === 4) return "P3";
  return fallback;
}

const TITLE_ID = /^\s*\[([0-9a-f]{16})\](?:\s|$)/u;

export function linearIssueTitle(submission: Submission): string;
export function linearIssueTitle(id: string, title: string): string;
export function linearIssueTitle(submissionOrId: Submission | string, title?: string): string {
  if (typeof submissionOrId === "string") return `[${submissionOrId}] ${title ?? ""}`;
  return `[${submissionOrId.id}] ${submissionOrId.title}`;
}

export function parseLinearTitleId(title: string): string | null {
  const match = TITLE_ID.exec(title);
  return match ? match[1]! : null;
}

/** Read the title join key, falling back to the body marker used by the GitHub mirror. */
export function readLinearMarker(title: string, description = ""): string | null {
  return (
    parseLinearTitleId(title) ??
    /<!--\s*af-submission-id:\s*([0-9a-f]{16})\s*-->/u.exec(description)?.[1] ??
    null
  );
}

export function linearAvailable(
  env: NodeJS.ProcessEnv = process.env,
): { ok: true } | { ok: false; reason: string } {
  const credentials = linearCredentialsFromEnv(env);
  if (!credentials.apiKey && !credentials.oauthAccessToken) {
    return { ok: false, reason: "LINEAR_API_KEY is not set in the local environment" };
  }
  return { ok: true };
}

export function linearIssueLabels(submission: Pick<Submission, "source" | "labels">): string[] {
  const labels = [LINEAR_INTAKE_LABEL, `source:${submission.source}`];
  const lane = submission.labels.find((label) => label.startsWith("lane:"));
  if (lane) labels.push(lane);
  return labels;
}

/**
 * Personal API keys are sent raw. OAuth access tokens take the Bearer scheme.
 * Mixing them is a 401 even when the secret is valid.
 */
export function linearAuthorization(input: {
  apiKey?: string | null;
  oauthAccessToken?: string | null;
}): { ok: true; header: string } | { ok: false; reason: string } {
  if (input.oauthAccessToken && input.oauthAccessToken.length > 0) {
    return { ok: true, header: `Bearer ${input.oauthAccessToken}` };
  }
  if (input.apiKey && input.apiKey.length > 0) {
    return { ok: true, header: input.apiKey };
  }
  return { ok: false, reason: "LINEAR_API_KEY unset and no OAuth access token" };
}

export function linearCredentialsFromEnv(env: NodeJS.ProcessEnv = process.env): {
  apiKey: string | null;
  oauthAccessToken: string | null;
} {
  return {
    apiKey: env.LINEAR_API_KEY && env.LINEAR_API_KEY.length > 0 ? env.LINEAR_API_KEY : null,
    oauthAccessToken:
      env.LINEAR_OAUTH_TOKEN && env.LINEAR_OAUTH_TOKEN.length > 0 ? env.LINEAR_OAUTH_TOKEN : null,
  };
}

type LinearExistingIssue = { id: string; title: string; description?: string | null };

export function linearUpsertPlan(
  existing: readonly LinearExistingIssue[],
  submissionId: string,
): { action: "create" } | { action: "update"; issueId: string } {
  const found = existing.find(
    (issue) => readLinearMarker(issue.title, issue.description ?? "") === submissionId,
  );
  if (found) return { action: "update", issueId: found.id };
  return { action: "create" };
}

export function linearIssueBody(submission: Submission): string {
  const refs =
    submission.evidence.refs.length > 0
      ? `\n\n**Evidence**\n${submission.evidence.refs.map((ref) => `- \`${ref}\``).join("\n")}`
      : "";
  const lineages =
    submission.evidence.lineages.length > 0
      ? `\n\nCorroborated by ${submission.evidence.lineages.length} independent model lineage(s): ${submission.evidence.lineages.join(", ")}.`
      : "";
  return [
    submission.body,
    `\n\n---\n`,
    `**Source** \`${submission.source}\` · **Kind** \`${submission.kind}\` · `,
    `**Priority** \`${submission.priority}\` · **Observations** ${submission.evidence.observations}`,
    submission.area ? ` · **Area** \`${submission.area}\`` : "",
    `\n\n> ${submission.evidence.summary}`,
    refs,
    lineages,
    `\n\n<!-- af-submission-id: ${submission.id} -->\n`,
  ].join("");
}

export type LinearIssueSnapshot = {
  id: string;
  identifier: string;
  url: string;
  title: string;
  priority: number;
  state: string;
  labels: string[];
  description?: string | null;
  stateId?: string;
  stateType?: string;
  projectId?: string | null;
  assignee?: {
    id: string;
    name: string;
    displayName?: string;
    email?: string | null;
  } | null;
  createdAt?: string;
  updatedAt?: string;
};

type LinearGraphqlResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: string; status?: number };

async function linearGraphql<T>(
  authorization: string,
  query: string,
  variables: Record<string, unknown> = {},
  fetchImpl: typeof fetch = fetch,
): Promise<LinearGraphqlResult<T>> {
  let response: Response;
  try {
    response = await fetchImpl(LINEAR_GRAPHQL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization,
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: message };
  }
  const text = await response.text();
  if (!response.ok) {
    return {
      ok: false,
      reason: `Linear GraphQL HTTP ${response.status}: ${text.slice(0, 300)}`,
      status: response.status,
    };
  }
  let payload: { data?: T; errors?: Array<{ message: string }> };
  try {
    payload = JSON.parse(text) as { data?: T; errors?: Array<{ message: string }> };
  } catch {
    return { ok: false, reason: `Linear GraphQL returned non-JSON: ${text.slice(0, 200)}` };
  }
  if (payload.errors && payload.errors.length > 0) {
    return { ok: false, reason: payload.errors.map((err) => err.message).join("; ") };
  }
  if (payload.data === undefined) {
    return { ok: false, reason: "Linear GraphQL returned no data" };
  }
  return { ok: true, data: payload.data };
}

function snapshotIssue(issue: {
  id: string;
  identifier: string;
  url: string;
  title: string;
  priority?: number;
  description?: string | null;
  state?: { id?: string; name: string; type?: string } | null;
  labels?: { nodes: Array<{ id?: string; name: string }> };
  project?: { id: string } | null;
  assignee?: {
    id: string;
    name: string;
    displayName?: string;
    email?: string | null;
  } | null;
  createdAt?: string;
  updatedAt?: string;
}): LinearIssueSnapshot {
  return {
    id: issue.id,
    identifier: issue.identifier,
    url: issue.url,
    title: issue.title,
    priority: issue.priority ?? 0,
    state: issue.state?.name ?? "",
    labels: (issue.labels?.nodes ?? []).map((node) => node.name),
    ...(issue.description !== undefined ? { description: issue.description } : {}),
    ...(issue.state?.id ? { stateId: issue.state.id } : {}),
    ...(issue.state?.type ? { stateType: issue.state.type } : {}),
    ...(issue.project !== undefined ? { projectId: issue.project?.id ?? null } : {}),
    ...(issue.assignee !== undefined ? { assignee: issue.assignee } : {}),
    ...(issue.createdAt !== undefined ? { createdAt: issue.createdAt } : {}),
    ...(issue.updatedAt !== undefined ? { updatedAt: issue.updatedAt } : {}),
  };
}

const ISSUE_FIELDS = `{
  id identifier url title description priority
  state { id name type }
  labels { nodes { id name } }
  assignee { id name displayName email }
  project { id }
  createdAt updatedAt
}`;

export async function listTeamIssuesByPrefix(
  authorization: string,
  teamKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LinearGraphqlResult<LinearIssueSnapshot[]>> {
  // Full ISSUE_FIELDS × 250 trips Linear's complexity cap (~86k vs 10k).
  // Prefix matching only needs id + title; project { id } keeps the AdventureForge filter.
  const result = await linearGraphql<{
    teams: {
      nodes: Array<{
        issues: { nodes: Array<Parameters<typeof snapshotIssue>[0]> };
      }>;
    };
  }>(
    authorization,
    `query TeamIssues($key: String!) {
      teams(filter: { key: { eq: $key } }) {
        nodes { issues(first: 100) { nodes { id identifier url title project { id } } } }
      }
    }`,
    { key: teamKey },
    fetchImpl,
  );
  if (!result.ok) return result;
  const team = result.data.teams.nodes[0];
  if (!team) return { ok: false, reason: `no Linear team with key ${teamKey}` };
  return { ok: true, data: team.issues.nodes.map(snapshotIssue) };
}

export type LinearWorkflowStateSnapshot = {
  id: string;
  name: string;
  type: string;
  teamId: string;
};

/** Read team workflow states once so local lifecycle changes can be pushed explicitly. */
export async function listLinearWorkflowStates(
  authorization: string,
  teamId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LinearGraphqlResult<LinearWorkflowStateSnapshot[]>> {
  const result = await linearGraphql<{
    workflowStates: {
      nodes: Array<{ id: string; name: string; type: string; team: { id: string } | null }>;
    };
  }>(
    authorization,
    `query WorkflowStates {
      workflowStates(first: 250) {
        nodes { id name type team { id } }
      }
    }`,
    {},
    fetchImpl,
  );
  if (!result.ok) return result;
  return {
    ok: true,
    data: result.data.workflowStates.nodes
      .filter((state) => state.team?.id === teamId)
      .map((state) => ({ ...state, teamId })),
  };
}

/** Select the Linear state that represents the local queue status. */
export function linearStateForStatus(
  states: readonly LinearWorkflowStateSnapshot[],
  status: SubmissionStatus,
): LinearWorkflowStateSnapshot | null {
  const wanted =
    status === "done" || status === "declined" || status === "stale"
      ? ["completed"]
      : status === "in_progress"
        ? ["started", "unstarted", "backlog"]
        : ["unstarted", "backlog", "started"];
  for (const type of wanted) {
    const found = states.find((state) => state.type.toLowerCase() === type);
    if (found) return found;
  }
  // A few older workspaces expose human names but not the workflow type. Keep the
  // fallback conservative and only use an unmistakably terminal name for closes.
  if (status === "done" || status === "declined" || status === "stale") {
    return states.find((state) => /^(done|completed|closed)$/iu.test(state.name.trim())) ?? null;
  }
  return null;
}

export function linearAssigneeName(issue: LinearIssueSnapshot): string | null {
  if (!issue.assignee) return null;
  return (
    issue.assignee.displayName || issue.assignee.name || issue.assignee.email || issue.assignee.id
  );
}

export function assigneeMatchesClaim(issue: LinearIssueSnapshot, submission: Submission): boolean {
  const claim = submission.claimed_by?.trim().toLowerCase();
  if (!claim || !issue.assignee) return false;
  return [issue.assignee.id, issue.assignee.name, issue.assignee.displayName, issue.assignee.email]
    .filter((value): value is string => Boolean(value))
    .some((value) => value.toLowerCase() === claim);
}

/** Adopt an unmarked issue as open work; Linear's state is deliberately not imported. */
export function submissionFromLinearIssue(issue: LinearIssueSnapshot): Submission {
  const kindLabel = issue.labels.find((label) => label.startsWith("kind:"));
  const parsedKind = SubmissionKindSchema.safeParse(kindLabel?.slice("kind:".length));
  const kind: Submission["kind"] = parsedKind.success ? parsedKind.data : "feature";
  const now = new Date().toISOString();
  const createdAt =
    issue.createdAt && !Number.isNaN(new Date(issue.createdAt).getTime())
      ? new Date(issue.createdAt).toISOString()
      : now;
  const updatedAt =
    issue.updatedAt && !Number.isNaN(new Date(issue.updatedAt).getTime())
      ? new Date(issue.updatedAt).toISOString()
      : createdAt;
  return SubmissionSchema.parse({
    schema_version: SUBMISSION_SCHEMA_VERSION,
    id: submissionId({ source: "human", kind, key: titleKey(issue.title) }),
    title: issue.title,
    body: issue.description?.trim() || issue.title,
    source: "human",
    kind,
    priority: submissionPriorityForLinear(issue.priority, defaultPriority("human", kind)),
    status: "open",
    labels: issue.labels.filter(
      (label) =>
        label !== LINEAR_INTAKE_LABEL && !label.startsWith("source:") && !label.startsWith("kind:"),
    ),
    area: null,
    evidence: {
      summary: `Filed by a person in Linear as ${issue.identifier}.`,
      refs: [issue.url],
      lineages: [],
      observations: 1,
    },
    created_at: createdAt,
    updated_at: updatedAt,
    external: null,
    mirrors: [
      {
        provider: "linear",
        id: issue.id,
        identifier: issue.identifier,
        url: issue.url,
        synced_status: "open",
      },
    ],
  });
}

export async function resolveLinearProject(
  authorization: string,
  teamKey: string,
  projectSlug: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LinearGraphqlResult<{ teamId: string; projectId: string; projectName: string }>> {
  const result = await linearGraphql<{
    teams: {
      nodes: Array<{
        id: string;
        projects: { nodes: Array<{ id: string; name: string; slugId: string; url: string }> };
      }>;
    };
  }>(
    authorization,
    `query TeamProjects($key: String!) {
      teams(filter: { key: { eq: $key } }) {
        nodes {
          id
          projects { nodes { id name slugId url } }
        }
      }
    }`,
    { key: teamKey },
    fetchImpl,
  );
  if (!result.ok) return result;
  const team = result.data.teams.nodes[0];
  if (!team) return { ok: false, reason: `no Linear team with key ${teamKey}` };
  const project = team.projects.nodes.find(
    (node) =>
      node.slugId === projectSlug || node.url.includes(projectSlug) || node.id === projectSlug,
  );
  if (!project) {
    return {
      ok: false,
      reason: `no Linear project ${projectSlug} on team ${teamKey}`,
    };
  }
  return { ok: true, data: { teamId: team.id, projectId: project.id, projectName: project.name } };
}

async function findLabelId(
  authorization: string,
  name: string,
  fetchImpl: typeof fetch,
): Promise<LinearGraphqlResult<string | null>> {
  const listed = await linearGraphql<{
    issueLabels: { nodes: Array<{ id: string; name: string }> };
  }>(
    authorization,
    `query LabelByName($name: String!) {
      issueLabels(filter: { name: { eq: $name } }, first: 10) {
        nodes { id name }
      }
    }`,
    { name },
    fetchImpl,
  );
  if (!listed.ok) return listed;
  return { ok: true, data: listed.data.issueLabels.nodes[0]?.id ?? null };
}

export async function ensureLinearLabels(
  authorization: string,
  teamId: string,
  names: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<LinearGraphqlResult<string[]>> {
  const ids: string[] = [];
  for (const name of names) {
    const found = await findLabelId(authorization, name, fetchImpl);
    if (!found.ok) return found;
    if (found.data) {
      ids.push(found.data);
      continue;
    }
    const created = await linearGraphql<{
      issueLabelCreate: { success: boolean; issueLabel: { id: string; name: string } | null };
    }>(
      authorization,
      `mutation CreateLabel($teamId: String!, $name: String!) {
        issueLabelCreate(input: { teamId: $teamId, name: $name }) {
          success
          issueLabel { id name }
        }
      }`,
      { teamId, name },
      fetchImpl,
    );
    if (!created.ok) {
      if (created.reason.includes("duplicate")) {
        const retry = await findLabelId(authorization, name, fetchImpl);
        if (!retry.ok) return retry;
        if (retry.data) {
          ids.push(retry.data);
          continue;
        }
      }
      return created;
    }
    const label = created.data.issueLabelCreate.issueLabel;
    if (!created.data.issueLabelCreate.success || !label) {
      const retry = await findLabelId(authorization, name, fetchImpl);
      if (retry.ok && retry.data) {
        ids.push(retry.data);
        continue;
      }
      return { ok: false, reason: `could not create Linear label ${name}` };
    }
    ids.push(label.id);
  }
  return { ok: true, data: ids };
}

/** List labels without creating anything; used by --dry-run and pull-only checks. */
export async function listLinearLabels(
  authorization: string,
  teamId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LinearGraphqlResult<Array<{ id: string; name: string }>>> {
  const listed = await linearGraphql<{
    issueLabels: { nodes: Array<{ id: string; name: string }> };
  }>(
    authorization,
    `query Labels($teamId: ID) {
      issueLabels(filter: { team: { id: { eq: $teamId } } }, first: 250) {
        nodes { id name }
      }
    }`,
    { teamId },
    fetchImpl,
  );
  if (!listed.ok) return listed;
  return { ok: true, data: listed.data.issueLabels.nodes };
}

type LinearPushResult =
  | { ok: true; action: "created" | "updated"; issue: LinearIssueSnapshot }
  | { ok: false; reason: string; status?: number };

export async function pushLinearIssue(
  authorization: string,
  input: {
    teamId: string;
    projectId: string;
    labelIds: string[];
    existing: readonly LinearExistingIssue[];
    submission: Submission;
    stateId?: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<LinearPushResult> {
  const title = linearIssueTitle(input.submission.id, input.submission.title);
  const description = linearIssueBody(input.submission);
  const priority = LINEAR_PRIORITY[input.submission.priority];
  const storedMirror = externalMirrorFor(input.submission, "linear");
  const storedIssue =
    storedMirror?.provider === "linear"
      ? input.existing.find((issue) => issue.id === storedMirror.id)
      : undefined;
  const plan = storedIssue
    ? { action: "update" as const, issueId: storedIssue.id }
    : linearUpsertPlan(input.existing, input.submission.id);
  if (plan.action === "create") {
    const created = await linearGraphql<{
      issueCreate: { success: boolean; issue: Parameters<typeof snapshotIssue>[0] | null };
    }>(
      authorization,
      `mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) { success issue ${ISSUE_FIELDS} }
      }`,
      {
        input: {
          teamId: input.teamId,
          projectId: input.projectId,
          title,
          description,
          priority,
          labelIds: input.labelIds,
          ...(input.stateId ? { stateId: input.stateId } : {}),
        },
      },
      fetchImpl,
    );
    if (!created.ok) return created;
    const issue = created.data.issueCreate.issue;
    if (!created.data.issueCreate.success || !issue) {
      return { ok: false, reason: "issueCreate did not return an issue" };
    }
    return { ok: true, action: "created", issue: snapshotIssue(issue) };
  }
  const updated = await linearGraphql<{
    issueUpdate: { success: boolean; issue: Parameters<typeof snapshotIssue>[0] | null };
  }>(
    authorization,
    `mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success issue ${ISSUE_FIELDS} }
    }`,
    {
      id: plan.issueId,
      input: {
        title,
        description,
        priority,
        projectId: input.projectId,
        labelIds: input.labelIds,
        ...(input.stateId ? { stateId: input.stateId } : {}),
      },
    },
    fetchImpl,
  );
  if (!updated.ok) return updated;
  const issue = updated.data.issueUpdate.issue;
  if (!updated.data.issueUpdate.success || !issue) {
    return { ok: false, reason: "issueUpdate did not return an issue" };
  }
  return { ok: true, action: "updated", issue: snapshotIssue(issue) };
}
