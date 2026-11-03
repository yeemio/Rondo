/**
 * Ambient module declarations for non-TS assets imported by the desktop base.
 * - *.sql: frozen SQLite DDL embedded as text by esbuild (loader .sql=text);
 *   the only DDL location remains adapters/sqlite/schema/** (frozen).
 * - *.yml: the static DSH profile (strict JSON, valid YAML single document)
 *   embedded as text; the same source file is copied to dist/host/cordis.yml
 *   at build time, so the composition audit and boot() read one artifact.
 */
declare module '*.sql' {
  const content: string;
  export default content;
}

declare module '*.yml' {
  const content: string;
  export default content;
}
