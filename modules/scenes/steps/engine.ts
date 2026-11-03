/**
 * rondo-step.v1 — the single shared teaching-model interpreter for the
 * cpp.steps.v1 family (GESP2 unit 1, ARCHITECTURE §9).
 *
 * ONE implementation serves both sides (the contract forbids a client copy
 * and a server copy drifting apart):
 *  - the UI (StepsPanel) uses it for the deterministic STEP_TABLE/STATE_TRACE
 *    preview;
 *  - the Host-side judging (modules/scenes/steps/judge.ts, reached via the
 *    learning server / dev-side mock stand-in) recomputes every submission
 *    with the same functions — the preview is never the answer authority.
 *
 * Frozen semantics (GESP2-CONTRACT-DELTA §3, A-1..A-9):
 *  - integers only, |v| <= 10^9, out-of-range hard-stops (no wraparound);
 *  - C++11 division truncates toward zero; `%` sign follows the dividend;
 *  - FOR: from/bound evaluated once before the loop; loop var read-only in
 *    the body (static violation = invalid program); step fixed at +1;
 *  - step budget 200 counts EXECUTED ASSIGN/OUTPUT statements only;
 *    condition checks and loop control never consume steps (A-9);
 *  - no while/do-while/break/continue/nesting-edit/compound-assign/
 *    increment-decrement in the editing surface (A-1/A-7) — the grammar
 *    below simply does not contain them.
 *
 * Pure module: no DOM, no Node APIs, no imports beyond the public contracts.
 */
import {
  STEP_BUDGET,
  STEP_MAX_STATEMENTS,
  STEP_VALUE_LIMIT,
  type StepProgramStateV1,
  type StepSpecV1,
} from '../../contracts/public/scene-steps';

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

export type StepHaltReason =
  | 'STEP_BUDGET_EXHAUSTED'
  | 'VALUE_OUT_OF_RANGE'
  | 'DIVISION_BY_ZERO'
  | 'UNDEFINED_VARIABLE';

export interface StepTraceEntry {
  /** 1-based execution sequence (trace cursor addresses entries by index). */
  readonly seq: number;
  /** Statement path from the program root, e.g. [1] or [1, 0, 0]. */
  readonly path: readonly number[];
  readonly kind: 'ASSIGN' | 'OUTPUT' | 'IF_CHECK' | 'FOR_INIT' | 'FOR_CHECK';
  /** Assigned variable (ASSIGN / FOR_INIT). */
  readonly varName?: string;
  /** Value before the assignment (ASSIGN). */
  readonly fromValue?: number;
  /** Value after the assignment (ASSIGN), loop var value (FOR_CHECK). */
  readonly toValue?: number;
  /** Emitted line (OUTPUT). */
  readonly outputLine?: string;
  /** Condition text + result (IF_CHECK / FOR_CHECK). */
  readonly condText?: string;
  readonly condResult?: boolean;
  /** FOR_INIT: the once-evaluated from/bound values (A-6 evidence). */
  readonly fromBound?: { readonly from: number; readonly bound: number };
}

export interface StepRunResult {
  readonly status: 'COMPLETED' | 'HALTED';
  readonly haltReason?: StepHaltReason;
  /** Halting statement path when status = HALTED. */
  readonly haltPath?: readonly number[];
  /** Emitted lines so far (integers as strings; see normalizeOutputLines). */
  readonly lines: readonly string[];
  /** Variable environment at the end (inputs + assignments). */
  readonly finalVariables: Readonly<Record<string, number>>;
  /** Execution trace (STATE_TRACE timeline; cursor indexes entries). */
  readonly trace: readonly StepTraceEntry[];
  /** Per-checkpoint outcomes in execution order (may repeat inside loops). */
  readonly branchOutcomes: Readonly<Record<string, ReadonlyArray<'TAKEN' | 'SKIPPED'>>>;
  /** Executed ASSIGN/OUTPUT statements (the budget counter, A-9). */
  readonly executedSteps: number;
}

export type StepProgramIssueCode =
  | 'PARSE_ERROR'
  | 'UNKNOWN_STATEMENT'
  | 'LOOP_VAR_READONLY'
  | 'EMPTY_FOR_BODY'
  | 'DUPLICATE_CHECKPOINT'
  | 'PROGRAM_TOO_LONG'
  | 'NESTING_TOO_DEEP';

export interface StepProgramIssue {
  readonly code: StepProgramIssueCode;
  readonly path: readonly number[];
  readonly message: string;
}

export interface StepValidateResult {
  readonly ok: boolean;
  readonly issues: readonly StepProgramIssue[];
}

// ---------------------------------------------------------------------------
// Expression / condition parsing (recursive descent over bounded source text)
// ---------------------------------------------------------------------------

type IntNode =
  | { t: 'num'; v: number }
  | { t: 'var'; name: string }
  | { t: 'bin'; op: '+' | '-' | '*' | '/' | '%'; l: IntNode; r: IntNode }
  | { t: 'neg'; e: IntNode };

type CondNode =
  | { t: 'cmp'; op: '==' | '!=' | '<' | '<=' | '>' | '>='; l: IntNode; r: IntNode }
  | { t: 'and'; l: CondNode; r: CondNode }
  | { t: 'or'; l: CondNode; r: CondNode }
  | { t: 'not'; e: CondNode };

class ParseError extends Error {}

class Parser {
  private pos = 0;
  constructor(private readonly src: string) {}

  atEnd(): boolean {
    this.skipWs();
    return this.pos >= this.src.length;
  }

  private peek(): string {
    this.skipWs();
    return this.src[this.pos] ?? '';
  }

  private skipWs(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos]!)) this.pos += 1;
  }

  private eat(token: string): boolean {
    this.skipWs();
    if (this.src.startsWith(token, this.pos)) {
      this.pos += token.length;
      return true;
    }
    return false;
  }

  private expect(token: string): void {
    if (!this.eat(token)) throw new ParseError(`expected '${token}' near position ${this.pos}`);
  }

  private ident(): string {
    this.skipWs();
    const m = /^[A-Za-z_][A-Za-z_0-9]*/.exec(this.src.slice(this.pos));
    if (!m) throw new ParseError(`expected identifier near position ${this.pos}`);
    this.pos += m[0].length;
    return m[0];
  }

  private number(): number {
    this.skipWs();
    const m = /^[0-9]+/.exec(this.src.slice(this.pos));
    if (!m) throw new ParseError(`expected integer near position ${this.pos}`);
    this.pos += m[0].length;
    const v = Number(m[0]);
    if (!Number.isSafeInteger(v) || v > STEP_VALUE_LIMIT) {
      throw new ParseError(`integer literal out of teaching-model range: ${m[0]}`);
    }
    return v;
  }

  parseExpr(): IntNode {
    let left = this.parseTerm();
    for (;;) {
      if (this.eat('+')) left = { t: 'bin', op: '+', l: left, r: this.parseTerm() };
      else if (this.eat('-')) left = { t: 'bin', op: '-', l: left, r: this.parseTerm() };
      else return left;
    }
  }

  private parseTerm(): IntNode {
    let left = this.parseFactor();
    for (;;) {
      const c = this.peek();
      if (c === '*') {
        this.pos += 1;
        left = { t: 'bin', op: '*', l: left, r: this.parseFactor() };
      } else if (c === '/') {
        this.pos += 1;
        left = { t: 'bin', op: '/', l: left, r: this.parseFactor() };
      } else if (c === '%') {
        this.pos += 1;
        left = { t: 'bin', op: '%', l: left, r: this.parseFactor() };
      } else return left;
    }
  }

  private parseFactor(): IntNode {
    if (this.eat('-')) return { t: 'neg', e: this.parseFactor() };
    const c = this.peek();
    if (c === '(') {
      this.pos += 1;
      const e = this.parseExpr();
      this.expect(')');
      return e;
    }
    if (/[0-9]/.test(c)) return { t: 'num', v: this.number() };
    if (/[A-Za-z_]/.test(c)) return { t: 'var', name: this.ident() };
    throw new ParseError(`unexpected character '${c}' near position ${this.pos}`);
  }

  parseCond(): CondNode {
    let left = this.parseAnd();
    while (this.eat('||')) left = { t: 'or', l: left, r: this.parseAnd() };
    return left;
  }

  /** Root entry: parses a full condition and requires the source to be consumed. */
  parseCondRoot(): CondNode {
    const node = this.parseCond();
    if (!this.atEnd()) throw new ParseError(`trailing input near position ${this.pos}`);
    return node;
  }

  private parseAnd(): CondNode {
    let left = this.parseNot();
    while (this.eat('&&')) left = { t: 'and', l: left, r: this.parseNot() };
    return left;
  }

  private parseNot(): CondNode {
    if (this.eat('!')) return { t: 'not', e: this.parseNot() };
    if (this.peek() === '(' && this.startsCondGroup()) {
      this.pos += 1;
      const e = this.parseCond();
      this.expect(')');
      return e;
    }
    return this.parseComparison();
  }

  /** '(' opens a condition group iff the matching ')' is followed by end/&&/|| — otherwise it is arithmetic parenthesization inside a comparison. */
  private startsCondGroup(): boolean {
    let depth = 0;
    for (let i = this.pos; i < this.src.length; i += 1) {
      const ch = this.src[i]!;
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          const rest = this.src.slice(i + 1).trimStart();
          return rest === '' || rest.startsWith('&&') || rest.startsWith('||');
        }
      }
    }
    return false;
  }

  private parseComparison(): CondNode {
    const l = this.parseExpr();
    this.skipWs();
    for (const op of ['==', '!=', '<=', '>=', '<', '>'] as const) {
      if (this.src.startsWith(op, this.pos)) {
        this.pos += op.length;
        return { t: 'cmp', op, l, r: this.parseExpr() };
      }
    }
    throw new ParseError(`expected comparison operator near position ${this.pos}`);
  }
}

export function parseIntExpr(source: string): IntNode {
  const p = new Parser(source);
  const node = p.parseExpr();
  if (!p.atEnd()) throw new ParseError(`trailing input in expression: ${source}`);
  return node;
}

export function parseCond(source: string): CondNode {
  return new Parser(source).parseCondRoot();
}

export function tryParseIntExpr(source: string): { ok: true; node: IntNode } | { ok: false; message: string } {
  try {
    return { ok: true, node: parseIntExpr(source) };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export function tryParseCond(source: string): { ok: true; node: CondNode } | { ok: false; message: string } {
  try {
    return { ok: true, node: parseCond(source) };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

type Halt = { reason: StepHaltReason; path: readonly number[] };

function isHalt(v: unknown): v is Halt {
  return typeof v === 'object' && v !== null && 'reason' in v && 'path' in v;
}

class Env {
  private readonly vars = new Map<string, number>();
  constructor(inputs: Readonly<Record<string, number>>) {
    for (const [k, v] of Object.entries(inputs)) {
      if (!Number.isInteger(v) || Math.abs(v) > STEP_VALUE_LIMIT) {
        throw new ParseError(`input out of teaching-model domain: ${k}=${v}`);
      }
      this.vars.set(k, v);
    }
  }
  get(name: string): number | undefined {
    return this.vars.get(name);
  }
  set(name: string, value: number): void {
    this.vars.set(name, value);
  }
  snapshot(): Record<string, number> {
    return Object.fromEntries([...this.vars.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
  }
}

const inDomain = (v: number): boolean => Number.isSafeInteger(v) && Math.abs(v) <= STEP_VALUE_LIMIT;

function evalInt(node: IntNode, env: Env, path: readonly number[]): number {
  switch (node.t) {
    case 'num':
      return node.v;
    case 'var': {
      const v = env.get(node.name);
      if (v === undefined) throw { reason: 'UNDEFINED_VARIABLE', path } as Halt;
      return v;
    }
    case 'neg': {
      const v = -evalInt(node.e, env, path);
      if (!inDomain(v)) throw { reason: 'VALUE_OUT_OF_RANGE', path } as Halt;
      return v;
    }
    case 'bin': {
      const a = evalInt(node.l, env, path);
      const b = evalInt(node.r, env, path);
      let v: number;
      switch (node.op) {
        case '+':
          v = a + b;
          break;
        case '-':
          v = a - b;
          break;
        case '*':
          v = a * b;
          break;
        case '/':
          if (b === 0) throw { reason: 'DIVISION_BY_ZERO', path } as Halt;
          v = Math.trunc(a / b); // C++11: truncation toward zero
          break;
        case '%':
          if (b === 0) throw { reason: 'DIVISION_BY_ZERO', path } as Halt;
          v = a - Math.trunc(a / b) * b; // C++11: sign follows the dividend
          break;
      }
      if (!inDomain(v)) throw { reason: 'VALUE_OUT_OF_RANGE', path } as Halt;
      return v;
    }
  }
}

function evalCond(node: CondNode, env: Env, path: readonly number[]): boolean {
  switch (node.t) {
    case 'cmp': {
      const a = evalInt(node.l, env, path);
      const b = evalInt(node.r, env, path);
      switch (node.op) {
        case '==':
          return a === b;
        case '!=':
          return a !== b;
        case '<':
          return a < b;
        case '<=':
          return a <= b;
        case '>':
          return a > b;
        case '>=':
          return a >= b;
      }
    }
    case 'and':
      return evalCond(node.l, env, path) && evalCond(node.r, env, path); // short-circuit
    case 'or':
      return evalCond(node.l, env, path) || evalCond(node.r, env, path);
    case 'not':
      return !evalCond(node.e, env, path);
  }
}

interface RunContext {
  env: Env;
  trace: StepTraceEntry[];
  lines: string[];
  branchOutcomes: Map<string, Array<'TAKEN' | 'SKIPPED'>>;
  executedSteps: number;
  budget: number;
}

function execBlock(steps: readonly StepSpecV1[], ctx: RunContext, path: readonly number[]): Halt | null {
  for (let i = 0; i < steps.length; i += 1) {
    const halt = execStep(steps[i]!, ctx, [...path, i]);
    if (halt) return halt;
  }
  return null;
}

/** Parses with the pre-validated grammar; unreachable for validated programs. */
function parsedExpr(source: string): IntNode {
  return parseIntExpr(source);
}

function parsedCond(source: string): CondNode {
  return parseCond(source);
}

function execStep(step: StepSpecV1, ctx: RunContext, path: readonly number[]): Halt | null {
  switch (step.kind) {
    case 'ASSIGN': {
      if (ctx.executedSteps >= ctx.budget) return { reason: 'STEP_BUDGET_EXHAUSTED', path };
      let value: number;
      try {
        value = evalInt(parsedExpr(step.expr), ctx.env, path);
      } catch (halt) {
        return isHalt(halt) ? halt : { reason: 'UNDEFINED_VARIABLE', path };
      }
      const from = ctx.env.get(step.var);
      ctx.env.set(step.var, value);
      ctx.executedSteps += 1;
      ctx.trace.push({
        seq: ctx.trace.length + 1,
        path,
        kind: 'ASSIGN',
        varName: step.var,
        fromValue: from,
        toValue: value,
      });
      return null;
    }
    case 'OUTPUT': {
      if (ctx.executedSteps >= ctx.budget) return { reason: 'STEP_BUDGET_EXHAUSTED', path };
      let value: number;
      try {
        value = evalInt(parsedExpr(step.expr), ctx.env, path);
      } catch (halt) {
        return isHalt(halt) ? halt : { reason: 'UNDEFINED_VARIABLE', path };
      }
      ctx.executedSteps += 1;
      const line = String(value);
      ctx.lines.push(line);
      ctx.trace.push({ seq: ctx.trace.length + 1, path, kind: 'OUTPUT', outputLine: line, toValue: value });
      return null;
    }
    case 'IF': {
      let taken: boolean;
      try {
        taken = evalCond(parsedCond(step.cond), ctx.env, path);
      } catch (halt) {
        return isHalt(halt) ? halt : { reason: 'UNDEFINED_VARIABLE', path };
      }
      ctx.trace.push({ seq: ctx.trace.length + 1, path, kind: 'IF_CHECK', condText: step.cond, condResult: taken });
      if (step.checkpointId !== undefined) {
        const list = ctx.branchOutcomes.get(step.checkpointId) ?? [];
        list.push(taken ? 'TAKEN' : 'SKIPPED');
        ctx.branchOutcomes.set(step.checkpointId, list);
      }
      return execBlock(taken ? step.then : step.else, ctx, path);
    }
    case 'FOR': {
      // A-6: from/bound are evaluated ONCE before the loop starts.
      let fromValue: number;
      let boundValue: number;
      try {
        fromValue = evalInt(parsedExpr(step.from), ctx.env, path);
        boundValue = evalInt(parsedExpr(step.bound), ctx.env, path);
      } catch (halt) {
        return isHalt(halt) ? halt : { reason: 'UNDEFINED_VARIABLE', path };
      }
      ctx.env.set(step.var, fromValue);
      ctx.trace.push({
        seq: ctx.trace.length + 1,
        path,
        kind: 'FOR_INIT',
        varName: step.var,
        fromBound: { from: fromValue, bound: boundValue },
      });
      for (;;) {
        const i = ctx.env.get(step.var)!;
        const holds = step.cmp === '<=' ? i <= boundValue : i < boundValue;
        ctx.trace.push({
          seq: ctx.trace.length + 1,
          path,
          kind: 'FOR_CHECK',
          condText: `${step.var} ${step.cmp} ${boundValue}`,
          condResult: holds,
          varName: step.var,
          toValue: i,
        });
        if (!holds) return null;
        const halt = execBlock(step.body, ctx, path);
        if (halt) return halt;
        ctx.env.set(step.var, i + 1); // fixed +1 step; the loop var write is engine-owned
      }
    }
  }
}

export interface RunOptions {
  /** Default 200 (ARCHITECTURE §9 / A-9). */
  stepBudget?: number;
}

/**
 * Runs a (pre-validated) program with frozen inputs. Programs should pass
 * validateStepProgram first; grammar breaks cannot occur for validated
 * programs and map defensively to UNDEFINED_VARIABLE, never a crash.
 */
export function runStepProgram(
  program: readonly StepSpecV1[],
  inputs: Readonly<Record<string, number>>,
  options: RunOptions = {},
): StepRunResult {
  // Total-function guard: never crash on an unvalidated program — validate
  // first and hard-stop defensively (callers that need issue details use
  // validateStepProgram / checkProgramRunnable).
  if (!validateStepProgram(program).ok) {
    return {
      status: 'HALTED',
      haltReason: 'UNDEFINED_VARIABLE',
      haltPath: [],
      lines: [],
      finalVariables: {},
      trace: [],
      branchOutcomes: {},
      executedSteps: 0,
    };
  }
  let env: Env;
  try {
    env = new Env(inputs);
  } catch (err) {
    return {
      status: 'HALTED',
      haltReason: 'VALUE_OUT_OF_RANGE',
      haltPath: [],
      lines: [],
      finalVariables: {},
      trace: [],
      branchOutcomes: {},
      executedSteps: 0,
    };
  }
  const ctx: RunContext = {
    env,
    trace: [],
    lines: [],
    branchOutcomes: new Map(),
    executedSteps: 0,
    budget: options.stepBudget ?? STEP_BUDGET,
  };
  const halt = execBlock(program, ctx, []);
  const branchOutcomes: Record<string, ReadonlyArray<'TAKEN' | 'SKIPPED'>> = {};
  for (const [k, v] of ctx.branchOutcomes) branchOutcomes[k] = v;
  return {
    status: halt === null ? 'COMPLETED' : 'HALTED',
    haltReason: halt?.reason,
    haltPath: halt?.path,
    lines: [...ctx.lines],
    finalVariables: ctx.env.snapshot(),
    trace: [...ctx.trace],
    branchOutcomes,
    executedSteps: ctx.executedSteps,
  };
}

// ---------------------------------------------------------------------------
// Static program validation (grammar + teaching-model invariants)
// ---------------------------------------------------------------------------

const MAX_DEPTH = 6;

export function countStatements(program: readonly StepSpecV1[]): number {
  let n = 0;
  const walk = (steps: readonly StepSpecV1[]): void => {
    for (const s of steps) {
      n += 1;
      if (s.kind === 'IF') {
        walk(s.then);
        walk(s.else);
      } else if (s.kind === 'FOR') {
        walk(s.body);
      }
    }
  };
  walk(program);
  return n;
}

export function countOutputs(program: readonly StepSpecV1[]): number {
  let n = 0;
  const walk = (steps: readonly StepSpecV1[]): void => {
    for (const s of steps) {
      if (s.kind === 'OUTPUT') n += 1;
      if (s.kind === 'IF') {
        walk(s.then);
        walk(s.else);
      } else if (s.kind === 'FOR') {
        walk(s.body);
      }
    }
  };
  walk(program);
  return n;
}

/**
 * Validates a step program: grammar (exprs/conds parse) plus the budget-
 * independent teaching-model invariants (loop var read-only in body, non-
 * empty FOR bodies, unique checkpoint ids, statement count, nesting depth).
 * Literal domain is enforced by the parser itself.
 */
export function validateStepProgram(program: readonly StepSpecV1[]): StepValidateResult {
  const issues: StepProgramIssue[] = [];
  const checkpoints = new Set<string>();

  const walk = (steps: readonly StepSpecV1[], path: readonly number[], depth: number, loopVars: readonly string[]): void => {
    if (depth > MAX_DEPTH) {
      issues.push({ code: 'NESTING_TOO_DEEP', path, message: `嵌套超过教学模型上限（${MAX_DEPTH} 层）` });
      return;
    }
    for (let i = 0; i < steps.length; i += 1) {
      const s = steps[i]!;
      const p = [...path, i];
      switch (s.kind) {
        case 'ASSIGN': {
          const r = tryParseIntExpr(s.expr);
          if (!r.ok) issues.push({ code: 'PARSE_ERROR', path: p, message: `${s.var} := ${s.expr}：${r.message}` });
          if (loopVars.includes(s.var)) {
            issues.push({ code: 'LOOP_VAR_READONLY', path: p, message: `循环变量 ${s.var} 在循环体内只读（教学模型约定）` });
          }
          break;
        }
        case 'OUTPUT': {
          const r = tryParseIntExpr(s.expr);
          if (!r.ok) issues.push({ code: 'PARSE_ERROR', path: p, message: `OUTPUT ${s.expr}：${r.message}` });
          break;
        }
        case 'IF': {
          const r = tryParseCond(s.cond);
          if (!r.ok) issues.push({ code: 'PARSE_ERROR', path: p, message: `IF (${s.cond})：${r.message}` });
          if (s.checkpointId !== undefined) {
            if (checkpoints.has(s.checkpointId)) {
              issues.push({ code: 'DUPLICATE_CHECKPOINT', path: p, message: `判断标记 ${s.checkpointId} 重复` });
            }
            checkpoints.add(s.checkpointId);
          }
          walk(s.then, p, depth + 1, loopVars);
          walk(s.else, p, depth + 1, loopVars);
          break;
        }
        case 'FOR': {
          for (const [label, src] of [
            ['from', s.from],
            ['bound', s.bound],
          ] as const) {
            const r = tryParseIntExpr(src);
            if (!r.ok) issues.push({ code: 'PARSE_ERROR', path: p, message: `FOR ${label} ${src}：${r.message}` });
          }
          if (s.body.length === 0) {
            issues.push({ code: 'EMPTY_FOR_BODY', path: p, message: 'FOR 的循环体不能为空（教学模型约定）' });
          }
          walk(s.body, p, depth + 1, [...loopVars, s.var]);
          break;
        }
        default:
          issues.push({
            code: 'UNKNOWN_STATEMENT',
            path: p,
            message: `未知语句类型 ${JSON.stringify((s as { kind?: unknown }).kind)}`,
          });
      }
    }
  };

  if (countStatements(program) > STEP_MAX_STATEMENTS) {
    issues.push({ code: 'PROGRAM_TOO_LONG', path: [], message: `程序超过教学模型语句数上限（${STEP_MAX_STATEMENTS}）` });
  }
  walk(program, [], 1, []);
  return { ok: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// Line normalization (A-3): in-line spaces significant; trailing per-line
// whitespace and trailing empty lines ignored; different line counts never
// match.
// ---------------------------------------------------------------------------

export function normalizeOutputLines(lines: readonly string[]): string[] {
  const trimmed = lines.map((l) => l.replace(/\s+$/, ''));
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === '') trimmed.pop();
  return trimmed;
}

export function outputLinesEqual(a: readonly string[], b: readonly string[]): boolean {
  const na = normalizeOutputLines(a);
  const nb = normalizeOutputLines(b);
  return na.length === nb.length && na.every((l, i) => l === nb[i]);
}

// ---------------------------------------------------------------------------
// Edit validation: slot-level structural diff against the current card
// ---------------------------------------------------------------------------

export interface StepEditConstraints {
  readonly editableSlots: readonly string[];
  readonly slotDomains?: Readonly<Record<string, readonly number[]>>;
  readonly insertableKinds: readonly ('ASSIGN' | 'OUTPUT' | 'IF' | 'FOR')[];
  readonly deletableSteps: readonly number[];
  readonly maxProgramSteps: number;
  readonly maxOutputLines: number;
}

export type EditRejectionCode =
  | 'MAX_PROGRAM_STEPS'
  | 'MAX_OUTPUT_LINES'
  | 'STEP_BUDGET_EXHAUSTED'
  | 'RUN_HALTED'
  | 'SLOT_NOT_EDITABLE'
  | 'SLOT_DOMAIN'
  | 'INSERT_NOT_ALLOWED'
  | 'DELETE_NOT_ALLOWED'
  | 'STRUCTURAL_REWRITE'
  | 'INVALID_PROGRAM';

export interface EditRejection {
  readonly code: EditRejectionCode;
  readonly message: string;
}

export type EditValidation = { ok: true; run: StepRunResult } | { ok: false; rejection: EditRejection };

/** Slot paths look like step[3].expr or step[1].body[0].cond (current card positions). */
export function slotPathOf(pathPrefix: string, index: number, member?: string): string {
  return member === undefined ? `${pathPrefix}[${index}]` : `${pathPrefix}[${index}].${member}`;
}

/** Collects changed scalar members between two same-kind statements. */
function changedScalarSlots(prev: StepSpecV1, next: StepSpecV1, path: string, changed: string[]): boolean {
  if (prev.kind !== next.kind) {
    changed.push('__kind__');
    return false;
  }
  switch (prev.kind) {
    case 'ASSIGN': {
      const nb = next as Extract<StepSpecV1, { kind: 'ASSIGN' }>;
      if (prev.var !== nb.var) {
        changed.push(`${path}.var`);
        return false;
      }
      if (prev.expr !== nb.expr) changed.push(`${path}.expr`);
      return true;
    }
    case 'OUTPUT': {
      const nb = next as Extract<StepSpecV1, { kind: 'OUTPUT' }>;
      if (prev.expr !== nb.expr) changed.push(`${path}.expr`);
      return true;
    }
    case 'IF': {
      const nb = next as Extract<StepSpecV1, { kind: 'IF' }>;
      if (prev.cond !== nb.cond) changed.push(`${path}.cond`);
      if ((prev.checkpointId ?? '') !== (nb.checkpointId ?? '')) {
        changed.push(`${path}.checkpointId`);
        return false;
      }
      return diffBlocks(prev.then, nb.then, `${path}.then`, changed) && diffBlocks(prev.else, nb.else, `${path}.else`, changed);
    }
    case 'FOR': {
      const nb = next as Extract<StepSpecV1, { kind: 'FOR' }>;
      if (prev.var !== nb.var) {
        changed.push(`${path}.var`);
        return false;
      }
      if (prev.from !== nb.from) changed.push(`${path}.from`);
      if (prev.bound !== nb.bound) changed.push(`${path}.bound`);
      if (prev.cmp !== nb.cmp) changed.push(`${path}.cmp`);
      return diffBlocks(prev.body, nb.body, `${path}.body`, changed);
    }
  }
}

function statementsEqual(a: StepSpecV1, b: StepSpecV1): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'ASSIGN': {
      const bb = b as Extract<StepSpecV1, { kind: 'ASSIGN' }>;
      return a.var === bb.var && a.expr === bb.expr;
    }
    case 'OUTPUT':
      return a.expr === (b as Extract<StepSpecV1, { kind: 'OUTPUT' }>).expr;
    case 'IF': {
      const bb = b as Extract<StepSpecV1, { kind: 'IF' }>;
      return a.cond === bb.cond && (a.checkpointId ?? '') === (bb.checkpointId ?? '');
    }
    case 'FOR': {
      const bb = b as Extract<StepSpecV1, { kind: 'FOR' }>;
      return (
        a.var === bb.var &&
        a.from === bb.from &&
        a.bound === bb.bound &&
        a.cmp === bb.cmp &&
        a.body.length === bb.body.length &&
        a.body.every((s, i) => statementsEqual(s, bb.body[i]!))
      );
    }
  }
}

/**
 * Structural diff of one block via weighted LCS alignment (programs are
 * tiny; exact statement matches weigh 2, same-identity matches weigh 1).
 * Matched pairs contribute scalar-slot changes (authorized per slot);
 * prev-only runs are deletions, next-only runs insertions.
 */
function blocksMatchIdentity(a: StepSpecV1, b: StepSpecV1): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'ASSIGN':
      return a.var === (b as Extract<StepSpecV1, { kind: 'ASSIGN' }>).var;
    case 'OUTPUT':
      return true;
    case 'IF':
      return (a.checkpointId ?? '') === ((b as Extract<StepSpecV1, { kind: 'IF' }>).checkpointId ?? '');
    case 'FOR':
      return a.var === (b as Extract<StepSpecV1, { kind: 'FOR' }>).var;
  }
}

function pairWeight(a: StepSpecV1, b: StepSpecV1): number {
  if (statementsEqual(a, b)) return 2;
  if (blocksMatchIdentity(a, b)) return 1;
  return 0;
}

function diffBlocks(prev: readonly StepSpecV1[], next: readonly StepSpecV1[], pathPrefix: string, changed: string[]): boolean {
  const n = prev.length;
  const m = next.length;
  // dp[i][j] = best weight aligning prev[i..] with next[j..]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      const w = pairWeight(prev[i]!, next[j]!);
      const take = w > 0 ? w + dp[i + 1]![j + 1]! : -1;
      dp[i]![j] = Math.max(take, dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  let ok = true;
  while (i < n && j < m) {
    const w = pairWeight(prev[i]!, next[j]!);
    const take = w > 0 ? w + dp[i + 1]![j + 1]! : -1;
    if (take >= Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)) {
      // aligned pair — collect its scalar slot changes under the NEXT index
      if (!changedScalarSlots(prev[i]!, next[j]!, `${pathPrefix}[${j}]`, changed)) ok = false;
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      changed.push(`__delete__:${pathPrefix}:${i}..${i}`);
      i += 1;
    } else {
      changed.push(`__insert__:${pathPrefix}[${j}]:${next[j]!.kind}`);
      j += 1;
    }
  }
  while (i < n) {
    changed.push(`__delete__:${pathPrefix}:${i}..${i}`);
    i += 1;
  }
  while (j < m) {
    changed.push(`__insert__:${pathPrefix}[${j}]:${next[j]!.kind}`);
    j += 1;
  }
  return ok;
}

const isNumericLiteral = (s: string): boolean => /^-?\d+$/.test(s.trim());

/** Reads the numeric literal stored at a slot path (null for compound expressions / unknown paths). */
export function readSlotLiteral(program: readonly StepSpecV1[], slot: string): number | null {
  const m = /^step\[(\d+)\]((?:\.(?:then|else|body)\[\d+\])*)\.(expr|from|bound)$/.exec(slot);
  if (!m) return null;
  const indices = [Number(m[1]), ...[...m[2]!.matchAll(/\[(\d+)\]/g)].map((x) => Number(x[1]))];
  const branchSegs = [...m[2]!.matchAll(/\.(then|else|body)/g)].map((x) => x[1]);
  let list: readonly StepSpecV1[] = program;
  let stmt: StepSpecV1 | undefined;
  for (let k = 0; k < indices.length; k += 1) {
    stmt = list[indices[k]!];
    if (!stmt) return null;
    if (k < indices.length - 1) {
      const seg = branchSegs[k];
      if (stmt.kind === 'IF') list = seg === 'else' ? stmt.else : stmt.then;
      else if (stmt.kind === 'FOR') list = stmt.body;
      else return null;
    }
  }
  if (!stmt) return null;
  const member = m[3]!;
  let text: string | undefined;
  if (member === 'expr') text = stmt.kind === 'ASSIGN' || stmt.kind === 'OUTPUT' ? stmt.expr : undefined;
  else if (member === 'from') text = stmt.kind === 'FOR' ? stmt.from : undefined;
  else if (member === 'bound') text = stmt.kind === 'FOR' ? stmt.bound : undefined;
  if (text === undefined || !isNumericLiteral(text)) return null;
  return Number(text.trim());
}

/**
 * Validates an EditStepProgram against the current card and the task's
 * constraints, then runs the resulting program (must complete within the
 * teaching-model budget and the card's output-line cap). Server-side
 * re-validation and UI preview gating call the SAME function.
 */
export function validateStepEdit(
  currentProgram: readonly StepSpecV1[],
  nextProgram: readonly StepSpecV1[],
  inputs: Readonly<Record<string, number>>,
  constraints: StepEditConstraints,
): EditValidation {
  const validation = validateStepProgram(nextProgram);
  if (!validation.ok) {
    return { ok: false, rejection: { code: 'INVALID_PROGRAM', message: validation.issues[0]!.message } };
  }
  if (countStatements(nextProgram) > constraints.maxProgramSteps) {
    return {
      ok: false,
      rejection: { code: 'MAX_PROGRAM_STEPS', message: `这张卡的语句数上限是 ${constraints.maxProgramSteps} 条。` },
    };
  }
  if (countOutputs(nextProgram) > constraints.maxOutputLines) {
    return {
      ok: false,
      rejection: { code: 'MAX_OUTPUT_LINES', message: `这张卡最多 ${constraints.maxOutputLines} 行输出（教学模型约定）。` },
    };
  }

  const changed: string[] = [];
  const shapeOk = diffBlocks(currentProgram, nextProgram, 'step', changed);
  if (!shapeOk) {
    return {
      ok: false,
      rejection: { code: 'STRUCTURAL_REWRITE', message: '本次确认只能改动允许的槽位或插入/删除允许的语句，不能整卡改写。' },
    };
  }
  const editable = new Set(constraints.editableSlots);
  const deletableTop = new Set(constraints.deletableSteps);
  for (const token of changed) {
    if (token.startsWith('__insert__')) {
      const kinds = token.split(':').pop()!.split('+');
      for (const k of kinds) {
        if (!(constraints.insertableKinds as readonly string[]).includes(k)) {
          return { ok: false, rejection: { code: 'INSERT_NOT_ALLOWED', message: `本题不能插入 ${k} 语句。` } };
        }
      }
      continue;
    }
    if (token.startsWith('__delete__')) {
      const m = /^__delete__:(.*):(\d+)\.\.(\d+)$/.exec(token);
      const prefix = m?.[1] ?? '';
      if (prefix === 'step' && m) {
        const from = Number(m[2]);
        const to = Number(m[3]);
        for (let i = from; i <= to; i += 1) {
          if (!deletableTop.has(i)) {
            return { ok: false, rejection: { code: 'DELETE_NOT_ALLOWED', message: '本题不能删除这条语句。' } };
          }
        }
      } else {
        return { ok: false, rejection: { code: 'DELETE_NOT_ALLOWED', message: '本题不能删除这条语句。' } };
      }
      continue;
    }
    if (token === '__kind__' || token.endsWith('.var') || token.endsWith('.checkpointId')) {
      return { ok: false, rejection: { code: 'STRUCTURAL_REWRITE', message: '这条语句的骨架不能改动（只开放指定槽位）。' } };
    }
    if (!editable.has(token)) {
      return {
        ok: false,
        rejection: { code: 'SLOT_NOT_EDITABLE', message: '这个位置不在本题可编辑的槽位里。' },
      };
    }
    const domain = constraints.slotDomains?.[token];
    if (domain) {
      const lit = readSlotLiteral(nextProgram, token);
      if (lit !== null && !domain.includes(lit)) {
        return { ok: false, rejection: { code: 'SLOT_DOMAIN', message: '这个数值不在本题允许的选择里。' } };
      }
    }
  }

  const run = runStepProgram(nextProgram, inputs, { stepBudget: STEP_BUDGET });
  if (run.status === 'HALTED') {
    if (run.haltReason === 'STEP_BUDGET_EXHAUSTED') {
      return {
        ok: false,
        rejection: {
          code: 'STEP_BUDGET_EXHAUSTED',
          message: '步数用尽（教学模型上限 200 步）：这样改后程序走不完，先缩小范围再试。',
        },
      };
    }
    return {
      ok: false,
      rejection: {
        code: 'RUN_HALTED',
        message:
          run.haltReason === 'VALUE_OUT_OF_RANGE'
            ? '值超出教学模型范围（教学模型只接受绝对值不超过 1,000,000,000 的整数）。'
            : run.haltReason === 'DIVISION_BY_ZERO'
              ? '教学模型里除以 0 会停下：检查一下除数。'
              : '程序用到了还没有值的变量，教学模型停下了。',
      },
    };
  }
  if (run.lines.length > constraints.maxOutputLines) {
    return {
      ok: false,
      rejection: {
        code: 'MAX_OUTPUT_LINES',
        message: `运行后会输出 ${run.lines.length} 行，超过这张卡 ${constraints.maxOutputLines} 行的上限（教学模型约定）。`,
      },
    };
  }
  return { ok: true, run };
}

/**
 * Trace length for cursor clamping (SetTraceCursor AT index) — a halted card
 * still exposes its partial trace for stepping.
 */
export function traceLength(program: readonly StepSpecV1[], inputs: Readonly<Record<string, number>>): number {
  const v = validateStepProgram(program);
  if (!v.ok) return 0;
  return runStepProgram(program, inputs).trace.length;
}

/** Convenience: run a scene state (UI preview + judge both use this). */
export function runStepProgramState(state: StepProgramStateV1, options: RunOptions = {}): StepRunResult {
  return runStepProgram(state.program, state.inputs, options);
}
