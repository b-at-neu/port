// Pure: builds the one aliased GraphQL document the tick needs, per
// plugins/port/skills/pipeline/SKILL.md → "Tick procedure" ("One query, one
// round trip"). No I/O — gh.mjs is the only thing that runs it.
//
// Every issue/pull-request node carries `assignees` (ownership is partitioned
// client-side, never filtered in the query) and every connection carries
// `totalCount` beside `nodes`, so a truncated set is detectable rather than
// silently read as complete.

const escape = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

const ISSUE_FIELDS = 'number title body assignees(first: 5) { nodes { login } }';
const PR_BASE_FIELDS = 'number title body assignees(first: 5) { nodes { login } }';

const ROLLUP = `commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 50) { nodes { __typename ... on CheckRun { name conclusion status startedAt completedAt detailsUrl } ... on StatusContext { context state createdAt targetUrl } } } } } } }`;

function issueSet(alias, labelName, extraFields = '') {
  return `${alias}: issues(first: 100, states: OPEN, filterBy: { labels: ["${escape(labelName)}"] }) { totalCount nodes { ${ISSUE_FIELDS} ${extraFields} } }`;
}

function prSet(alias, labelName, extraFields = '') {
  return `${alias}: pullRequests(first: 100, states: OPEN, labels: ["${escape(labelName)}"]) { totalCount nodes { ${PR_BASE_FIELDS} ${extraFields} } }`;
}

/** `labels` is the resolved vocabulary (scripts/port-tick/config.mjs's
 *  `resolveLabels`). `modules.approvalGate` gates the `allOpenPRs` alias.
 *  `announcedApproved` is `.temp/tick-state.json`'s remembered set of
 *  already-announced approved pull request numbers — each gets its own
 *  `pullRequest(number:)` alias for the merged/approved re-verify, folded
 *  into the same call rather than a follow-up `gh pr view`. */
export function buildQuery({ owner, name, labels, modules, announcedApproved = [] }) {
  const parts = [];

  // --- Trigger sets ------------------------------------------------------
  parts.push(issueSet('ready', labels.ready));
  parts.push(issueSet('planChangesRequested', labels.planChangesRequested));
  parts.push(issueSet('planApproved', labels.planApproved));
  parts.push(
    prSet(
      'readyForReview',
      labels.readyForReview,
      'mergeable headRefOid reviews(first: 30) { nodes { body submittedAt commit { oid } } } comments(last: 20) { nodes { body createdAt } }',
    ),
  );
  parts.push(prSet('needsRevision', labels.needsRevision, 'mergeable reviews(first: 30) { nodes { body } }'));
  parts.push(prSet('refreshBranch', labels.refreshBranch));

  // --- Gate sets ----------------------------------------------------------
  parts.push(issueSet('planReview', labels.planReview));
  parts.push(issueSet('blocked', labels.blocked));
  parts.push(prSet('approved', labels.approved, `mergeable headRefOid ${ROLLUP}`));
  parts.push(prSet('needsHuman', labels.needsHuman));

  // --- In-flight sets -------------------------------------------------------
  parts.push(issueSet('planning', labels.planning));
  parts.push(issueSet('inProgress', labels.inProgress));
  parts.push(prSet('reviewing', labels.reviewing));
  parts.push(prSet('revising', labels.revising));
  parts.push(prSet('refreshing', labels.refreshing));

  // --- Occupied set for the file contention gate ---------------------------
  parts.push(issueSet('prOpened', labels.prOpened));

  // --- Module-gated: ungated sweep -----------------------------------------
  if (modules.approvalGate) {
    parts.push(
      'allOpenPRs: pullRequests(states: OPEN, first: 100) { nodes { number title labels(first: 20) { nodes { name } } assignees(first: 5) { nodes { login } } } }',
    );
  }

  // --- Approved re-verify / merged-PR reconciliation -----------------------
  for (const n of announcedApproved) {
    parts.push(`pr${n}: pullRequest(number: ${n}) { state mergedAt closed headRefOid mergeable ${ROLLUP} }`);
  }

  return `query {
  viewer { login }
  rateLimit { cost remaining }
  repository(owner: "${escape(owner)}", name: "${escape(name)}") {
    ${parts.join('\n    ')}
  }
}`;
}
