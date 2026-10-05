// Raw GraphQL node shapes to the engine's own typed decision inputs — the
// one adapter both the cockpit and apps/desktop share.
import type { ReviewNode } from './gates.ts';
import type { CheckContext } from './checks.ts';

// Flattens a raw review's commit.oid to commitOid; body defaults to ''.
export function toReviewNode(raw: any): ReviewNode {
  return { body: raw?.body ?? '', submittedAt: raw?.submittedAt, commitOid: raw?.commit?.oid ?? null };
}

// A raw statusCheckRollup's contexts.nodes, or null when the rollup is absent.
export function toCheckContexts(rollup: any): readonly CheckContext[] | null {
  return rollup?.contexts?.nodes ?? null;
}

// One raw issue/pull-request node's assignees.nodes[].login.
export function assigneeLoginsOf(node: any): readonly string[] {
  return (node?.assignees?.nodes ?? []).map((a: any) => a.login);
}
