/**
 * Synthetic L1/L2 test release fixture (test-only; no donor data).
 *
 * Builds a complete on-disk release directory for the two first-batch task
 * families with the real loader's digest recipe (modules/content/digest), so
 * loadRelease accepts it as-is and negative tests can tamper deliberately.
 *
 * Tasks:
 * - task-l1-guided      r=30 h=80, change radius to 40 (INCREASE scenario)
 * - task-l1-independent r=25 h=120, change radius to 15 (DECREASE scenario)
 * - task-l2-guided      r=30 h=80 net task (S = 15072 mm² exact)
 * - task-l2-highfine    r=5 h=120 (SCENE §4 counterexample: circumference
 *                       edge 31.4 mm SHORTER than height edge 120 mm;
 *                       S = 3768 mm² = 37.68 cm² exact)
 * - task-l2-independent sampled r/h in [10,100]x[10,200], locked dimensions
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { computePublicManifestHash } from '../../modules/content/digest';
import type { ReleaseManifest } from '../../modules/contracts/server/content';

export const SYNTH_RELEASE_ID = 'rel-cyl-synth-0001';
export const TASK_L1_GUIDED = 'task-l1-guided';
export const TASK_L1_INDEPENDENT = 'task-l1-independent';
export const TASK_L2_GUIDED = 'task-l2-guided';
export const TASK_L2_HIGHFINE = 'task-l2-highfine';
export const TASK_L2_INDEPENDENT = 'task-l2-independent';
export const TASK_ORDER = [TASK_L1_GUIDED, TASK_L1_INDEPENDENT, TASK_L2_GUIDED, TASK_L2_HIGHFINE, TASK_L2_INDEPENDENT];

const RENDERER_DECLARATION = { rendererId: 'rondo.cylinder', rendererContractVersion: '1', publicStateSchemaVersion: '1' };
const LATERAL_AREA_FACTORS = [
  { numerator: 157, denominator: 25 },
  { factor: 'radiusMm' },
  { factor: 'heightMm' },
] as const;
const CIRCUMFERENCE_FACTORS = [
  { numerator: 157, denominator: 25 },
  { factor: 'radiusMm' },
] as const;

interface TaskSeed {
  taskId: string;
  taskFamily: 'cylinder.parameters.v1' | 'cylinder.net.v1';
  title: string;
  givens: { radiusMm: number; heightMm: number };
  sampleParams?: boolean;
  lockedDimensions?: boolean;
  allowedOperationIds: string[];
  responseSchemaId: string;
  acceptedUnits: string[];
  sceneObjects?: { cylinderObjectIds: string[]; netEdgeIds: string[] };
  promptGroups: { minVisibility: 'PREDICTION' | 'OBSERVATION' | 'ASSESSMENT' | 'REVIEW'; blocks: unknown[] }[];
}

const TASKS: TaskSeed[] = [
  {
    taskId: TASK_L1_GUIDED,
    taskFamily: 'cylinder.parameters.v1',
    title: '哪些参数决定圆筒（引导）',
    givens: { radiusMm: 30, heightMm: 80 },
    allowedOperationIds: ['SetDimension', 'SetSection'],
    responseSchemaId: 'rondo.response.propertyJudgments.v1',
    acceptedUnits: ['mm', 'cm'],
    promptGroups: [
      {
        minVisibility: 'PREDICTION',
        blocks: [
          { type: 'TEXT', text: '当前圆筒 r=30mm，h=80mm。先把半径改为 40mm 并确认，再提交你的判断。' },
          {
            type: 'MEASUREMENT_TABLE',
            columns: [
              { label: '半径', unitId: 'mm' },
              { label: '高度', unitId: 'mm' },
            ],
            rows: [['30', '80']],
          },
        ],
      },
      { minVisibility: 'OBSERVATION', blocks: [{ type: 'TEXT', text: '观察：直径 = 2 × 半径。' }] },
    ],
  },
  {
    taskId: TASK_L1_INDEPENDENT,
    taskFamily: 'cylinder.parameters.v1',
    title: '哪些参数决定圆筒（独立）',
    givens: { radiusMm: 25, heightMm: 120 },
    allowedOperationIds: ['SetDimension', 'SetSection'],
    responseSchemaId: 'rondo.response.propertyJudgments.v1',
    acceptedUnits: ['mm', 'cm'],
    promptGroups: [
      {
        minVisibility: 'PREDICTION',
        blocks: [
          { type: 'TEXT', text: '当前圆筒 r=25mm，h=120mm。把半径改为 15mm 并确认后，提交判断。' },
          {
            type: 'MEASUREMENT_TABLE',
            columns: [
              { label: '半径', unitId: 'mm' },
              { label: '高度', unitId: 'mm' },
            ],
            rows: [['25', '120']],
          },
        ],
      },
    ],
  },
  {
    taskId: TASK_L2_GUIDED,
    taskFamily: 'cylinder.net.v1',
    title: '展开后哪条边没有变（引导）',
    givens: { radiusMm: 30, heightMm: 80 },
    allowedOperationIds: ['SetDimension', 'SetUnroll', 'SetSection'],
    responseSchemaId: 'rondo.response.netMapping.v1',
    acceptedUnits: ['mm2', 'cm2'],
    sceneObjects: {
      cylinderObjectIds: ['cyl.rim.top', 'cyl.rim.bottom', 'cyl.seam.vertical'],
      netEdgeIds: ['net.edge.a1', 'net.edge.a2', 'net.edge.b1'],
    },
    promptGroups: [
      {
        minVisibility: 'PREDICTION',
        blocks: [
          { type: 'TEXT', text: '把侧面完全展开，配对圆柱对象与展开图边，并提交侧面积（π=3.14）。' },
          {
            type: 'MEASUREMENT_TABLE',
            columns: [
              { label: '半径', unitId: 'mm' },
              { label: '高度', unitId: 'mm' },
            ],
            rows: [['30', '80']],
          },
        ],
      },
      { minVisibility: 'OBSERVATION', blocks: [{ type: 'FORMULA', expression: 'C = 2 × 3.14 × r' }] },
      { minVisibility: 'ASSESSMENT', blocks: [{ type: 'FORMULA', expression: 'S侧 = C × h' }] },
    ],
  },
  {
    taskId: TASK_L2_HIGHFINE,
    taskFamily: 'cylinder.net.v1',
    title: '展开后哪条边没有变（高细反例）',
    givens: { radiusMm: 5, heightMm: 120 },
    allowedOperationIds: ['SetUnroll', 'SetSection'],
    responseSchemaId: 'rondo.response.netMapping.v1',
    acceptedUnits: ['mm2', 'cm2'],
    lockedDimensions: true,
    sceneObjects: {
      cylinderObjectIds: ['cyl.rim.top', 'cyl.rim.bottom', 'cyl.seam.vertical'],
      netEdgeIds: ['net.edge.a1', 'net.edge.a2', 'net.edge.b1'],
    },
    promptGroups: [
      {
        minVisibility: 'PREDICTION',
        blocks: [
          { type: 'TEXT', text: '细高圆筒 r=0.5cm，h=12.0cm。哪条边对应圆周？哪条对应高？展开后配对并提交侧面积。' },
        ],
      },
      { minVisibility: 'OBSERVATION', blocks: [{ type: 'FORMULA', expression: 'C = 2 × 3.14 × r' }] },
    ],
  },
  {
    taskId: TASK_L2_INDEPENDENT,
    taskFamily: 'cylinder.net.v1',
    title: '展开后哪条边没有变（独立）',
    givens: { radiusMm: 50, heightMm: 60 }, // fallback when not sampling
    sampleParams: true,
    allowedOperationIds: ['SetUnroll', 'SetSection'],
    responseSchemaId: 'rondo.response.netMapping.v1',
    acceptedUnits: ['mm2', 'cm2'],
    lockedDimensions: true,
    sceneObjects: {
      cylinderObjectIds: ['cyl.rim.top', 'cyl.rim.bottom', 'cyl.seam.vertical'],
      netEdgeIds: ['net.edge.a1', 'net.edge.a2', 'net.edge.b1'],
    },
    promptGroups: [
      { minVisibility: 'PREDICTION', blocks: [{ type: 'TEXT', text: '服务端给定尺寸的独立任务：展开、配对并提交侧面积。' }] },
    ],
  },
];

function taskFileObject(seed: TaskSeed): Record<string, unknown> {
  const file: Record<string, unknown> = {
    taskId: seed.taskId,
    taskFamily: seed.taskFamily,
    title: seed.title,
    promptGroups: seed.promptGroups,
    responseSchemaId: seed.responseSchemaId,
    numericPolicy: { pi: '3.14', displayDecimals: 2, acceptedUnitIds: seed.acceptedUnits },
    allowedOperationIds: seed.allowedOperationIds,
    givens: seed.givens,
  };
  if (seed.sampleParams) file.sampleParams = true;
  if (seed.lockedDimensions) file.lockedDimensions = true;
  if (seed.sceneObjects) file.sceneObjects = seed.sceneObjects;
  return file;
}

function hintFile(contentRef: string, level: number, revealsAnswer: boolean, text: string): Record<string, unknown> {
  return { contentRef, level, revealsAnswer, version: `hint-v1-l${level}`, text };
}

function rulesFile(): Record<string, unknown> {
  return {
    ruleSets: [
      {
        ruleId: 'rule-l1-increase',
        ruleSet: {
          ruleSetVersion: '1',
          rules: [
            {
              ruleKind: 'PARAMETER_IDENTIFICATION_V1',
              expectedJudgments: [
                { propertyId: 'radius', direction: 'INCREASE' },
                { propertyId: 'diameter', direction: 'INCREASE' },
                { propertyId: 'height', direction: 'UNCHANGED' },
              ],
            },
          ],
        },
      },
      {
        ruleId: 'rule-l1-decrease',
        ruleSet: {
          ruleSetVersion: '1',
          rules: [
            {
              ruleKind: 'PARAMETER_IDENTIFICATION_V1',
              expectedJudgments: [
                { propertyId: 'radius', direction: 'DECREASE' },
                { propertyId: 'diameter', direction: 'DECREASE' },
                { propertyId: 'height', direction: 'UNCHANGED' },
              ],
            },
          ],
        },
      },
      {
        ruleId: 'rule-l2-guided',
        ruleSet: {
          ruleSetVersion: '1',
          rules: [
            {
              ruleKind: 'NUMERIC_RELATION_V1',
              expectedEdgeMapping: [
                { cylinderObjectId: 'cyl.rim.top', netEdgeId: 'net.edge.a1' },
                { cylinderObjectId: 'cyl.rim.bottom', netEdgeId: 'net.edge.a2' },
                { cylinderObjectId: 'cyl.seam.vertical', netEdgeId: 'net.edge.b1' },
              ],
              quantityChecks: [
                {
                  quantityId: 'circumference',
                  expected: { kind: 'RATIONAL_PRODUCT_V1', factors: CIRCUMFERENCE_FACTORS },
                  acceptedUnitIds: ['mm', 'cm'],
                  rounding: { mode: 'HALF_UP', decimalPlaces: 2 },
                  comparison: 'EXACT_AFTER_ROUNDING',
                },
                {
                  quantityId: 'lateralArea',
                  expected: { kind: 'RATIONAL_PRODUCT_V1', factors: LATERAL_AREA_FACTORS },
                  acceptedUnitIds: ['mm2', 'cm2'],
                  rounding: { mode: 'HALF_UP', decimalPlaces: 2 },
                  comparison: 'EXACT_AFTER_ROUNDING',
                },
              ],
            },
          ],
        },
      },
      {
        ruleId: 'rule-l2-highfine',
        ruleSet: {
          ruleSetVersion: '1',
          rules: [
            {
              ruleKind: 'NUMERIC_RELATION_V1',
              // High-fine counterexample: rims pair with the SHORTER (31.4mm)
              // circumference edges, the seam with the 120mm height edge.
              expectedEdgeMapping: [
                { cylinderObjectId: 'cyl.rim.top', netEdgeId: 'net.edge.a1' },
                { cylinderObjectId: 'cyl.rim.bottom', netEdgeId: 'net.edge.a2' },
                { cylinderObjectId: 'cyl.seam.vertical', netEdgeId: 'net.edge.b1' },
              ],
              quantityChecks: [
                {
                  quantityId: 'lateralArea',
                  expected: { kind: 'RATIONAL_PRODUCT_V1', factors: LATERAL_AREA_FACTORS },
                  acceptedUnitIds: ['mm2', 'cm2'],
                  rounding: { mode: 'HALF_UP', decimalPlaces: 2 },
                  comparison: 'EXACT_AFTER_ROUNDING',
                },
              ],
            },
          ],
        },
      },
    ],
  };
}

function hintGateTable(): { taskId: string; hintLevel: number; contentRef: string }[] {
  const gates: { taskId: string; hintLevel: number; contentRef: string }[] = [];
  for (const seed of TASKS) {
    gates.push({ taskId: seed.taskId, hintLevel: 0, contentRef: `hint-${seed.taskId}-0` });
    gates.push({ taskId: seed.taskId, hintLevel: 1, contentRef: `hint-${seed.taskId}-1` });
    gates.push({ taskId: seed.taskId, hintLevel: 2, contentRef: `hint-${seed.taskId}-2` });
  }
  return gates;
}

function hintsMap(): Record<string, Record<string, unknown>> {
  const hints: Record<string, Record<string, unknown>> = {};
  for (const seed of TASKS) {
    hints[`hint-${seed.taskId}-0`] = hintFile(`hint-${seed.taskId}-0`, 0, false, '提示 0：先看看题目给出的测量表。');
    hints[`hint-${seed.taskId}-1`] = hintFile(`hint-${seed.taskId}-1`, 1, false, '提示 1：注意哪些量随半径变化。');
    hints[`hint-${seed.taskId}-2`] = hintFile(`hint-${seed.taskId}-2`, 2, true, '提示 2：答案级提示（会标记为已受答案帮助）。');
  }
  return hints;
}

export interface BuiltRelease {
  readonly rootDir: string;
  readonly releaseId: string;
  readonly manifest: ReleaseManifest;
}

/** Writes the full synthetic release under <rootDir>/<releaseId>/ and returns it. */
export async function writeSyntheticRelease(rootDir: string, releaseId = SYNTH_RELEASE_ID): Promise<BuiltRelease> {
  const releaseDir = join(rootDir, releaseId);
  await mkdir(join(releaseDir, 'public', 'tasks'), { recursive: true });
  await mkdir(join(releaseDir, 'public', 'hints'), { recursive: true });
  await mkdir(join(releaseDir, 'public', 'assets'), { recursive: true });
  await mkdir(join(releaseDir, 'private'), { recursive: true });

  const taskObjects: Record<string, unknown> = {};
  for (const seed of TASKS) {
    const obj = taskFileObject(seed);
    taskObjects[seed.taskId] = obj;
    await writeFile(join(releaseDir, 'public', 'tasks', `${seed.taskId}.json`), JSON.stringify(obj, null, 2));
  }
  const hints = hintsMap();
  for (const [ref, obj] of Object.entries(hints)) {
    await writeFile(join(releaseDir, 'public', 'hints', `${ref}.json`), JSON.stringify(obj, null, 2));
  }
  const assetBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><!-- synth -->\n', 'utf8');
  await writeFile(join(releaseDir, 'public', 'assets', 'figure.svg'), assetBytes);
  const assetDigest = await sha256Of(assetBytes);

  const ruleRefs = [
    { taskId: TASK_L1_GUIDED, ruleId: 'rule-l1-increase', ruleVersion: '1' },
    { taskId: TASK_L1_INDEPENDENT, ruleId: 'rule-l1-decrease', ruleVersion: '1' },
    { taskId: TASK_L2_GUIDED, ruleId: 'rule-l2-guided', ruleVersion: '1' },
    { taskId: TASK_L2_HIGHFINE, ruleId: 'rule-l2-highfine', ruleVersion: '1' },
    { taskId: TASK_L2_INDEPENDENT, ruleId: 'rule-l2-guided', ruleVersion: '1' },
  ];
  const constructionParamDomains = [
    { taskId: TASK_L2_INDEPENDENT, domains: [
      { paramId: 'radiusMm', kind: 'INT_RANGE' as const, min: 10, max: 100 },
      { paramId: 'heightMm', kind: 'INT_RANGE' as const, min: 10, max: 200 },
    ] },
  ];
  const allOps = ['SetDimension', 'SetUnroll', 'SetSection', 'SelectFaces'];
  const publicPart = {
    releaseId,
    taskIds: TASK_ORDER,
    taskVersion: '1',
    rendererDeclarations: [RENDERER_DECLARATION],
    publicAssetHashes: [assetDigest],
    expressionOperationSubsets: [
      { expression: 'WEBGL2' as const, allowedOperationIds: allOps },
      { expression: 'SVG_DOM' as const, allowedOperationIds: allOps },
    ],
  };
  const publicManifestHash = computePublicManifestHash({
    publicHeader: publicPart,
    tasks: taskObjects,
    hints,
    assets: { 'figure.svg': assetDigest },
  });
  const manifest: ReleaseManifest = {
    public: { ...publicPart, publicManifestHash },
    private: { ruleRefs, hintGateTable: hintGateTable(), constructionParamDomains },
  };
  await writeFile(join(releaseDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await writeFile(join(releaseDir, 'private', 'rules.json'), JSON.stringify(rulesFile(), null, 2));
  return { rootDir, releaseId, manifest };
}

async function sha256Of(bytes: Uint8Array): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(bytes).digest('hex');
}
