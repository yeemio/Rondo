/**
 * Ambient declaration for importing A-owned migration SQL as text.
 *
 * The test build (esbuild) passes `--loader:.sql=text`; the schema files stay
 * byte-for-byte A-owned -- B never edits them, only reads them through this
 * import so the migration runner works from bundled test builds as well.
 */
declare module '*.sql' {
  const content: string;
  export default content;
}
