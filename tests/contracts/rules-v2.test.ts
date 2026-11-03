/**
 * B-D10 contract coverage: the v2 private rule DSL (RULE_DSL_VERSION '2',
 * ruleBodyV2Schema) and the v2 private release bindings manifest
 * (privateReleaseBindingsV2Schema) must accept every artifact C actually
 * ships under content/cylinder/private, with zero unclassified fields.
 *
 * Normative data: integrated/content/cylinder/private (C line). The C rule
 * files carry no `kind` field of their own; the test maps each file to its
 * v2 kind by a fixed table (the `kind` discriminator is the only v2-added
 * field) and lifts every other field verbatim from body.rules / pendingDsl.
 * A residual-field walk then proves nothing in the files falls outside the
 * formalized truth plus the explicitly tolerated envelope/prose fields
 * (ruleId, file, boundTasks, ruleSetVersion, ruleKind tags, note, reasons,
 * the null quantityChecks slot). If C adds or renames a private rule /
 * bindings field, this test fails and forces a v2 schema decision.
 *
 * Negatives: an unknown kind and out-of-domain snapshot values must be
 * rejected (strict, unknown-rejecting, integer-mm domains r∈[5,100] /
 * h∈[10,200]).
 */
import * as assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  RULE_DSL_VERSION,
  RULE_V2_KINDS,
  ruleBodyV2Schema,
  type RuleBodyV2Kind,
} from '../../modules/contracts/server/rules';
import { safeParsePrivateReleaseBindingsV2 } from '../../modules/contracts/server/content';
import { RULE_KIND_BY_FILE } from '../../modules/content';
import { safeParseRuleBodyL34V1 } from '../../modules/contracts/server/rules-l34';

const PRIVATE_DIR = fileURLToPath(new URL('../../content/cylinder/private', import.meta.url));
const RULES_DIR = join(PRIVATE_DIR, 'rules');
const BINDINGS_DIR = join(PRIVATE_DIR, 'bindings');

/** Fixed file→kind table: the only field v2 adds on top of the C data. */
const KIND_BY_RULE_FILE: Readonly<Record<string, RuleBodyV2Kind>> = {
  'rule.cylParam.changeClassify.v1.json': 'PARAM_CHANGE_CLASSIFY',
  'rule.cylParam.readback.v1.json': 'NUMERIC_READBACK',
  'rule.cylParam.identify.v1.json': 'PARAM_IDENTIFY',
  'rule.cylNet.direction.v1.json': 'EDGE_DIRECTION',
  'rule.cylNet.pairing.v1.json': 'EDGE_PAIRING',
  'rule.cylNet.area.v1.json': 'LATERAL_AREA',
  'rule.cylNet.transfer.v1.json': 'TRANSFER_CHECK',
};

/** Field prefixes whose values are lifted verbatim into the RuleBodyV2 input. */
const CONSUMED_PREFIXES: Readonly<Record<RuleBodyV2Kind, readonly string[]>> = {
  PARAM_CHANGE_CLASSIFY: ['body.rules'],
  NUMERIC_READBACK: ['body.rules', 'pendingDsl.numericReadback', 'pendingDsl.feedback'],
  PARAM_IDENTIFY: ['body.rules', 'pendingDsl.numericReadback', 'pendingDsl.feedback'],
  EDGE_DIRECTION: ['pendingDsl.numericRelationShape.expectedEdgeMapping', 'pendingDsl.feedback'],
  EDGE_PAIRING: [
    'pendingDsl.numericRelationShape.expectedEdgeMapping',
    'pendingDsl.diagnostics',
    'pendingDsl.feedback',
  ],
  LATERAL_AREA: ['pendingDsl.quantityChecks', 'pendingDsl.diagnostics', 'pendingDsl.feedback'],
  TRANSFER_CHECK: ['body.rules'],
};

const EXPECTED_RULE_FILES = Object.keys(KIND_BY_RULE_FILE).sort();

/**
 * L3/L4 formalized rule files (integration W1, H0-DELTA-INTEGRATION-20261027-3):
 * the five former pendingDsl truths are now FORMAL family kinds
 * (modules/contracts/server/rules-l34.ts). They parse under ruleBodyL34V1Schema;
 * the Host's loadRelease loads them through the family body path — the v2
 * RULE_KIND_BY_FILE table stays cylinder-only by design.
 */
const EXPECTED_FORMAL_L34_FILES = [
  'rule.cylFaces.area.v1.json',
  'rule.cylFaces.set.v1.json',
  'rule.cylLayers.stack.v1.json',
  'rule.cylLayers.transfer.v1.json',
  'rule.cylLayers.volume.v1.json',
].sort();
const EXPECTED_BINDING_FILES = [
  'l1-r1.bindings.private.json',
  'l2-r1.bindings.private.json',
  'l3-r1.bindings.private.json',
  'l4-r1.bindings.private.json',
].sort();

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `expected object at ${label}`);
  return value as Record<string, unknown>;
}

/** Collect every leaf path (objects/arrays traversed, scalars incl. null are leaves). */
function leafPaths(value: unknown, base: string, out: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => leafPaths(item, `${base}[${index}]`, out));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      leafPaths((value as Record<string, unknown>)[key], base === '' ? key : `${base}.${key}`, out);
    }
    return;
  }
  out.push(base);
}

function underPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`);
}

/** Envelope/prose fields deliberately excluded from the v2 truth body. */
function toleratedPaths(file: Record<string, unknown>, fileName: string): Set<string> {
  const tolerated = new Set<string>(['ruleId', 'file', 'body.ruleSetVersion', 'body.note']);
  const boundTasks = file.boundTasks;
  assert.ok(Array.isArray(boundTasks), `${fileName}: boundTasks must be an array`);
  boundTasks.forEach((_taskId, index) => tolerated.add(`boundTasks[${index}]`));
  const body = asRecord(file.body, `${fileName}:body`);
  if (Array.isArray(body.rules)) {
    body.rules.forEach((_rule, index) => tolerated.add(`body.rules[${index}].ruleKind`));
  }
  if (file.pendingDsl === null) {
    tolerated.add('pendingDsl');
    return tolerated;
  }
  const pending = asRecord(file.pendingDsl, `${fileName}:pendingDsl`);
  if (Array.isArray(pending.reasons)) {
    pending.reasons.forEach((_reason, index) => tolerated.add(`pendingDsl.reasons[${index}]`));
  }
  if (pending.numericRelationShape !== undefined) {
    const shape = asRecord(pending.numericRelationShape, `${fileName}:pendingDsl.numericRelationShape`);
    assert.ok('quantityChecks' in shape, `${fileName}: numericRelationShape must declare quantityChecks`);
    tolerated.add('pendingDsl.numericRelationShape.ruleKind');
    tolerated.add('pendingDsl.numericRelationShape.quantityChecks');
  }
  return tolerated;
}

/** Build the RuleBodyV2 input for one C rule file, lifting fields verbatim. */
function toRuleBodyV2Input(fileName: string, file: Record<string, unknown>): Record<string, unknown> {
  const kind = KIND_BY_RULE_FILE[fileName];
  assert.ok(kind !== undefined, `no v2 kind mapped for ${fileName}`);
  const body = asRecord(file.body, `${fileName}:body`);
  const pending = file.pendingDsl === null ? null : asRecord(file.pendingDsl, `${fileName}:pendingDsl`);
  switch (kind) {
    case 'PARAM_CHANGE_CLASSIFY':
    case 'TRANSFER_CHECK':
      return { kind, rules: body.rules };
    case 'NUMERIC_READBACK':
    case 'PARAM_IDENTIFY': {
      assert.ok(pending !== null, `${fileName}: ${kind} carries its numeric truth in pendingDsl`);
      return { kind, rules: body.rules, numericReadback: pending.numericReadback, feedback: pending.feedback };
    }
    case 'EDGE_DIRECTION':
    case 'EDGE_PAIRING': {
      assert.ok(pending !== null, `${fileName}: ${kind} carries its mapping truth in pendingDsl`);
      const shape = asRecord(pending.numericRelationShape, `${fileName}:pendingDsl.numericRelationShape`);
      return {
        kind,
        expectedEdgeMapping: shape.expectedEdgeMapping,
        ...(kind === 'EDGE_PAIRING' ? { diagnostics: pending.diagnostics } : {}),
        feedback: pending.feedback,
      };
    }
    case 'LATERAL_AREA': {
      assert.ok(pending !== null, `${fileName}: LATERAL_AREA carries its quantity truth in pendingDsl`);
      return {
        kind,
        quantityChecks: pending.quantityChecks,
        diagnostics: pending.diagnostics,
        feedback: pending.feedback,
      };
    }
  }
}

function issueSummary(error: { issues: readonly { path: (string | number)[]; code: string; message: string }[] }): string {
  return JSON.stringify(error.issues.map((issue) => ({ path: issue.path, code: issue.code, message: issue.message })));
}

test('v2 rule DSL accepts the seven frozen-family C rule files with zero unclassified fields', () => {
  assert.equal(RULE_DSL_VERSION, '2');
  assert.equal(new Set(RULE_V2_KINDS).size, 7);
  assert.deepEqual(
    [...RULE_V2_KINDS].sort(),
    Object.values(KIND_BY_RULE_FILE).sort(),
    'every mapped file kind must be a declared v2 kind',
  );

  const ruleFiles = readdirSync(RULES_DIR).filter((name) => name.endsWith('.json')).sort();
  assert.deepEqual(
    ruleFiles,
    [...EXPECTED_RULE_FILES, ...EXPECTED_FORMAL_L34_FILES].sort(),
    'private/rules must contain exactly the seven frozen-family files plus the five formalized L3/L4 files',
  );
  const covered = EXPECTED_RULE_FILES;

  const residue: string[] = [];
  for (const fileName of covered) {
    const raw = loadJson(join(RULES_DIR, fileName));
    const file = asRecord(raw, fileName);
    const input = toRuleBodyV2Input(fileName, file);
    const parsed = ruleBodyV2Schema.safeParse(input);
    if (!parsed.success) {
      assert.fail(`${fileName}: RuleBodyV2 (${KIND_BY_RULE_FILE[fileName]}) parse failed: ${issueSummary(parsed.error)}`);
    }
    assert.equal(parsed.data.kind, KIND_BY_RULE_FILE[fileName]);

    const leaves: string[] = [];
    leafPaths(raw, '', leaves);
    const consumed = CONSUMED_PREFIXES[KIND_BY_RULE_FILE[fileName]];
    const tolerated = toleratedPaths(file, fileName);
    for (const path of leaves) {
      if (!consumed.some((prefix) => underPrefix(path, prefix)) && !tolerated.has(path)) {
        residue.push(`${fileName}: ${path}`);
      }
    }
  }
  assert.deepEqual(
    residue,
    [],
    'every field in the C rule files must be consumed by RuleBodyV2 or tolerated as envelope/prose; unclassified fields above are C-line rework items',
  );
});

test('v2 private bindings manifest accepts all four C bindings files loss-free', () => {
  const bindingFiles = readdirSync(BINDINGS_DIR).filter((name) => name.endsWith('.json')).sort();
  assert.deepEqual(bindingFiles, EXPECTED_BINDING_FILES, 'private/bindings must contain exactly the two C bindings files');

  for (const fileName of bindingFiles) {
    const raw = loadJson(join(BINDINGS_DIR, fileName));
    const parsed = safeParsePrivateReleaseBindingsV2(raw);
    if (!parsed.success) {
      assert.fail(`${fileName}: privateReleaseBindingsV2 parse failed: ${issueSummary(parsed.error)}`);
    }
    assert.deepStrictEqual(
      parsed.data,
      raw,
      `${fileName}: strict parse must be loss-free (no unknown fields, no transformation)`,
    );
  }
});

test('L3/L4 formalized rules parse as RuleBodyL34V1 and stay outside the frozen v2 table', () => {
  const ruleFiles = readdirSync(RULES_DIR).filter((name) => name.endsWith('.json')).sort();
  assert.deepEqual(ruleFiles.filter((n) => EXPECTED_FORMAL_L34_FILES.includes(n)), EXPECTED_FORMAL_L34_FILES);
  for (const fileName of EXPECTED_FORMAL_L34_FILES) {
    const file = asRecord(loadJson(join(RULES_DIR, fileName)), fileName);
    // no frozen-family expressibility faked in body.rules
    assert.equal((file['body'] as Record<string, unknown>)['rules'], undefined, `${fileName}: body.rules must stay empty (formal family body only)`);
    assert.equal(file['pendingDsl'], undefined, `${fileName}: the pendingDsl sidecar is gone (formalized)`);
    const parsed = safeParseRuleBodyL34V1(file['body']);
    assert.ok(parsed.success, `${fileName}: body must parse under ruleBodyL34V1Schema`);
    // the Host's v2 kind table stays cylinder-only; L34 files load through the family path
    assert.equal(RULE_KIND_BY_FILE[fileName], undefined, `${fileName}: must not sneak into the frozen v2 kind table`);
  }
});

test('v2 rejects an unknown rule kind', () => {
  const parsed = ruleBodyV2Schema.safeParse({
    kind: 'PARAM_BOGUS_CLASSIFY',
    rules: [
      {
        ruleKind: 'PARAMETER_IDENTIFICATION_V1',
        expectedJudgments: [{ propertyId: 'radius', direction: 'UNCHANGED' }],
      },
    ],
  });
  assert.equal(parsed.success, false, 'an unknown kind must be rejected, not coerced');
});

test('v2 rejects out-of-domain snapshot values (integer mm, r in [5,100], h in [10,200])', () => {
  const base = {
    kind: 'NUMERIC_READBACK',
    rules: [
      {
        ruleKind: 'PARAMETER_IDENTIFICATION_V1',
        expectedJudgments: [{ propertyId: 'radius', direction: 'INCREASE' }],
      },
    ],
    numericReadback: {
      'cyl.param.g2.radius-change.v1': {
        snapshot: { radiusMm: 40, heightMm: 80 },
        quantityId: 'diameter',
        acceptedUnitIds: ['cm', 'mm'],
        expectedCm: '8.0',
      },
    },
  };
  assert.equal(ruleBodyV2Schema.safeParse(base).success, true, 'in-domain control must parse');

  const radiusTooSmall = structuredClone(base);
  radiusTooSmall.numericReadback['cyl.param.g2.radius-change.v1'].snapshot.radiusMm = 4;
  assert.equal(ruleBodyV2Schema.safeParse(radiusTooSmall).success, false, 'radiusMm=4 must be rejected');

  const heightTooTall = structuredClone(base);
  heightTooTall.numericReadback['cyl.param.g2.radius-change.v1'].snapshot.heightMm = 250;
  assert.equal(ruleBodyV2Schema.safeParse(heightTooTall).success, false, 'heightMm=250 must be rejected');

  const fractionalRadius = structuredClone(base);
  fractionalRadius.numericReadback['cyl.param.g2.radius-change.v1'].snapshot.radiusMm = 40.5;
  assert.equal(ruleBodyV2Schema.safeParse(fractionalRadius).success, false, 'non-integer radiusMm must be rejected');
});
