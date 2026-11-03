/**
 * Public-tree digest recipe for release manifests.
 *
 * B defines the digest recipe (the manifest field name and its coverage are
 * frozen by the contract; the exact recipe is the loader's documented
 * convention used by both the loader and the test fixture builder):
 *
 *   publicDigestInput = canonical({
 *     publicHeader: manifest.public without publicManifestHash,
 *     tasks:   { [taskId]: parsed task-file object },
 *     hints:   { [contentRef]: parsed hint-file object },
 *     assets:  { [assetFileName]: sha256Hex(fileBytes) },   // names sorted
 *   })
 *   publicManifestHash = sha256Hex(publicDigestInput)
 *
 * canonical() is the frozen canonical serializer from contracts/public
 * (recursive key sort, no whitespace), so any byte-level tampering with the
 * public tree changes the digest and loadRelease rejects the release.
 */
import { createHash } from 'node:crypto';
import { canonicalize } from '../contracts/public/canonical';
import type { ReleaseManifestPublic } from '../contracts/server/content';

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

export interface PublicTreeMaterial {
  readonly publicHeader: Omit<ReleaseManifestPublic, 'publicManifestHash'>;
  readonly tasks: Readonly<Record<string, unknown>>;
  readonly hints: Readonly<Record<string, unknown>>;
  readonly assets: Readonly<Record<string, string>>;
}

export function computePublicManifestHash(material: PublicTreeMaterial): string {
  const input = canonicalize({
    publicHeader: material.publicHeader,
    tasks: material.tasks,
    hints: material.hints,
    assets: material.assets,
  });
  return sha256Hex(input);
}
