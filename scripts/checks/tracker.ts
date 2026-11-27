import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, readJson } from '#lib/files.ts';
import type { Reporter } from '#lib/report.ts';

type Run = (bin: string, args: string[]) => { status: number | null; stdout: string; stderr: string };

// The vendor-neutral tracker CLI and the /port:scope skill that calls it.
export default async function ({ expect }: Reporter) {
  const cliRel = 'plugins/port/bin/tracker.mjs';
  const cliText = readFileSync(join(root, cliRel), 'utf8');

  expect(!/\bexecSync\b/.test(cliText), 'tracker-template', `${cliRel} uses execSync — every child process must use spawnSync with an explicit argv array`);
  expect(!/shell:\s*true/.test(cliText), 'tracker-template', `${cliRel} passes shell: true to a child process`);
  expect(!/['"]--jq['"]/.test(cliText), 'tracker-template', `${cliRel} passes --jq to gh — parse the JSON in Node instead`);

  const mod = await import(pathToFileURL(join(root, cliRel)).href);
  const { parseKey, issueNumberFromUrl, graphqlFailure, backendFor, createGithubBackend } = mod;

  const keyCases: [string, number | null][] = [['#12', 12], ['12', 12], ['ENG-1', null], ['#0', null], ['', null], ['12a', null], ['#-1', null]];
  for (const [input, want] of keyCases) {
    expect(parseKey(input) === want, 'tracker-parse-key', `parseKey(${JSON.stringify(input)}) should be ${want}, got ${parseKey(input)}`);
  }

  expect(issueNumberFromUrl('https://github.com/o/r/issues/42\n') === 42, 'tracker-issue-number', 'issueNumberFromUrl must read the number past a trailing newline');
  expect(issueNumberFromUrl('no url here') === null, 'tracker-issue-number', 'issueNumberFromUrl must return null when there is no issue URL');

  const gqlCases: [string, string, string | null][] = [
    ['errors beside data', JSON.stringify({ data: { addBlockedBy: { clientMutationId: null } }, errors: [{ message: 'boom' }] }), 'boom'],
    ['null data', JSON.stringify({ data: { addBlockedBy: null } }), 'no data'],
    ['success', JSON.stringify({ data: { addBlockedBy: { clientMutationId: null } } }), null],
    ['unparsable', 'not json', 'unparsable response'],
  ];
  for (const [name, stdout, want] of gqlCases) {
    expect(graphqlFailure(stdout) === want, 'tracker-graphql-failure', `graphqlFailure (${name}) should be ${want}, got ${graphqlFailure(stdout)}`);
  }

  expect(/no backend/.test(backendFor({ tracker: 'linear', repo: 'o/r' }, () => null).error ?? ''), 'tracker-backend', "backendFor({ tracker: 'linear' }) must return the no-backend error");
  expect(backendFor({ repo: 'o/r' }, () => null).backend !== undefined, 'tracker-backend', 'backendFor({}) must resolve to the github backend');

  // The three identifier kinds: the database id for sub_issues, node ids for blocked-by.
  {
    const calls: string[][] = [];
    const run: Run = (_bin, args) => {
      calls.push(args);
      if (args[0] === 'api' && args[1]?.startsWith('repos/o/r/issues/') && args.length === 2) return { status: 0, stdout: JSON.stringify({ id: 9001, node_id: 'I_x' }), stderr: '' };
      if (args[1] === 'graphql') return { status: 0, stdout: JSON.stringify({ data: { addBlockedBy: { clientMutationId: null } } }), stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const backend = createGithubBackend({ repo: 'o/r', run });
    backend.linkChild({ parent: 1, child: 2 });
    expect(calls.some((a) => a.includes('sub_issue_id=9001')), 'tracker-identifiers', 'linkChild must post the database id as sub_issue_id, not the issue number');
    calls.length = 0;
    backend.addBlockedBy({ blocked: 3, by: 2 });
    const gql = calls.find((a) => a[1] === 'graphql') ?? [];
    expect(gql.includes('issueId=I_x') && gql.includes('blockingIssueId=I_x'), 'tracker-identifiers', 'addBlockedBy must pass both node ids as -f variables');
    expect(!gql.some((a) => a.startsWith('query=') && a.includes('I_x')), 'tracker-identifiers', 'addBlockedBy must not splice an id into the query text');

    calls.length = 0;
    const create: Run = (_bin, args) => {
      calls.push(args);
      return { status: 0, stdout: 'https://github.com/o/r/issues/7\n', stderr: '' };
    };
    createGithubBackend({ repo: 'o/r', run: create }).createIssue({ title: 't', bodyFile: 'b.md' });
    expect(calls.length === 1 && !calls[0].includes('--label') && !calls[0].includes('--assignee'), 'tracker-create', 'createIssue must pass no --label and no --assignee');
  }

  // --- Skill pins ---
  const scopeText = readFileSync(join(root, 'plugins/port/skills/scope/SKILL.md'), 'utf8');
  const scopeFront = /^---\n([\s\S]*?)\n---/.exec(scopeText)?.[1] ?? '';
  expect(!/(^|[\s`])gh /m.test(scopeText), 'tracker-skill', 'skills/scope/SKILL.md must not invoke gh — tickets go through commands.tracker');
  expect(!scopeText.includes('api.github.com'), 'tracker-skill', 'skills/scope/SKILL.md must not name api.github.com');
  expect(!scopeFront.includes('Bash(gh'), 'tracker-skill', "skills/scope/SKILL.md's frontmatter must not grant Bash(gh …)");
  expect(scopeText.includes('commands.tracker'), 'tracker-skill', 'skills/scope/SKILL.md must name commands.tracker');
  const initText = readFileSync(join(root, 'plugins/port/skills/init/SKILL.md'), 'utf8');
  expect(initText.includes('bin/tracker.mjs') && initText.includes('Bash(node scripts/port-tracker.mjs *)'), 'tracker-install', 'skills/init/SKILL.md must install bin/tracker.mjs and add Bash(node scripts/port-tracker.mjs *)');

  // --- Schema and template ---
  const schema = readJson('schema/port.config.schema.json');
  const prop = schema.properties?.commands?.properties?.tracker;
  expect(JSON.stringify(prop?.type) === JSON.stringify(['string', 'null']) && prop?.default === null, 'tracker-schema', 'commands.tracker must be string|null defaulting to null in the generated schema');
  const template = readJson('plugins/port/templates/port.config.json');
  expect(template.commands?.tracker === null, 'tracker-schema', "plugins/port/templates/port.config.json's commands.tracker must be null");
}
