import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, readJson } from '#lib/files.ts';
import type { Reporter } from '#lib/report.ts';

const SHIPPED_REL = 'plugins/port/data/labels.json';
const DESKTOP_REL = 'apps/desktop/src/utils/labels/labels.json';
const GATE_TEMPLATE_REL = 'plugins/port/templates/approval-check.yml';
const SCHEMA_REL = 'schema/port.config.schema.json';

// The seven-label display vocabulary: the data file, its app copy, and the schema's two override maps.
export default async function ({ expect, fail, ok }: Reporter) {
  const labels: { key: string; name: string; color: string; previousColors: string[]; role: string; palette: string | null }[] = readJson(SHIPPED_REL).labels;
  const keys = labels.map((l) => l.key);

  // pin: plugins/port/data/labels.json ↔ apps/desktop/src/utils/labels/labels.json, byte-identical
  {
    const shipped = readFileSync(join(root, SHIPPED_REL), 'utf8');
    const desktop = readFileSync(join(root, DESKTOP_REL), 'utf8');
    expect(shipped === desktop, 'labels-display-copy', `${SHIPPED_REL} and ${DESKTOP_REL} differ — copy one over the other so they are byte-identical`);
  }

  // pin: the schema's `labels` ∪ `states` keys ↔ `labels.json`'s keys, both directions, with disjoint maps
  {
    const schema = readJson(SCHEMA_REL);
    const labelProps = schema.properties.labels.properties as Record<string, { default: string }>;
    const stateProps = schema.properties.states.properties as Record<string, { default: string }>;
    const schemaKeys = [...Object.keys(labelProps), ...Object.keys(stateProps)];

    for (const k of keys) expect(schemaKeys.includes(k), 'labels-display-schema', `'${k}' is in labels.json but in neither the schema's labels nor its states`);
    for (const k of schemaKeys) expect(keys.includes(k), 'labels-display-schema', `'${k}' is in the schema's labels or states but not labels.json`);
    for (const k of Object.keys(labelProps)) expect(!(k in stateProps), 'labels-display-schema', `'${k}' is in both the schema's labels and its states`);

    // `labels` holds exactly the marker and gate roles; `states` the rest.
    for (const l of labels) {
      const inLabels = l.key in labelProps;
      const wantsLabels = l.role === 'marker' || l.role === 'gate';
      expect(inLabels === wantsLabels, 'labels-display-schema', `'${l.key}' (role ${l.role}) is in the schema's ${inLabels ? 'labels' : 'states'}, but ${wantsLabels ? 'labels holds the marker and gate roles' : 'states holds every other role'}`);
      const entry = labelProps[l.key] ?? stateProps[l.key];
      if (entry !== undefined) expect(entry.default === l.name, 'labels-display-schema', `the schema's default for '${l.key}' is '${entry.default}', labels.json says '${l.name}'`);
    }
  }

  // --- Colours are well-formed and distinct, and only the marker has a null palette ---
  {
    const seen = new Map<string, string>();
    for (const l of labels) {
      if (!/^[0-9A-F]{6}$/.test(l.color)) {
        fail('labels-display-colors', `'${l.key}' has a malformed color '${l.color}', expected six uppercase hex digits`);
        continue;
      }
      const other = seen.get(l.color);
      if (other !== undefined) fail('labels-display-colors', `'${l.key}' and '${other}' share color '${l.color}'`);
      seen.set(l.color, l.key);
      expect((l.role === 'marker') === (l.palette === null), 'labels-display-colors', `'${l.key}' (role ${l.role}) has palette ${JSON.stringify(l.palette)} — only the marker has none`);
    }
  }

  // --- previousColors never carries the entry's own colour, or /port:init would treat the current one as stale ---
  {
    for (const l of labels) {
      const previous = Array.isArray(l.previousColors) ? l.previousColors : null;
      if (previous === null) {
        fail('labels-display-previous', `'${l.key}' has no previousColors array — use [] when port never shipped another colour for it`);
        continue;
      }
      const malformed = previous.filter((c) => typeof c !== 'string' || !/^[0-9A-F]{6}$/.test(c));
      expect(malformed.length === 0, 'labels-display-previous', `'${l.key}' has malformed previousColors entries ${JSON.stringify(malformed)}, expected six uppercase hex digits`);
      expect(!previous.includes(l.color), 'labels-display-previous', `'${l.key}' lists its own current color '${l.color}' in previousColors`);
    }
  }

  // pin: the merge gate's blocking set, derived from roles, and the template's case-insensitive matching
  {
    const blocking = labels.filter((l) => l.role === 'in-flight' || l.role === 'gate').map((l) => l.key).sort();
    const want = ['implementing', 'needsYou', 'planning', 'reviewing', 'revising'];
    expect(blocking.join(',') === want.join(','), 'labels-display-gate', `the in-flight and gate keys are ${JSON.stringify(blocking)}, the merge gate must block on exactly ${JSON.stringify(want)}`);
    expect(labels.find((l) => l.key === 'approved')?.role === 'terminal', 'labels-display-gate', `'approved' must have role terminal`);
    expect(labels.find((l) => l.key === 'port')?.role === 'marker', 'labels-display-gate', `'port' must have role marker`);

    const template = readFileSync(join(root, GATE_TEMPLATE_REL), 'utf8');
    expect(!template.includes('grep -Fxq'), 'labels-display-gate', `${GATE_TEMPLATE_REL} matches a label case-sensitively with 'grep -Fxq' — use 'grep -Fixq'`);
    expect(template.split('grep -Fixq').length - 1 >= 2, 'labels-display-gate', `${GATE_TEMPLATE_REL} must match both the blocking and approved labels with 'grep -Fixq'`);
    expect(/^\s*if:.*\{\{markerLabel\}\}/m.test(template), 'labels-display-gate', `${GATE_TEMPLATE_REL}'s job 'if:' must name {{markerLabel}}`);
  }

  ok();
}
