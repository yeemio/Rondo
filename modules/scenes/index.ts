/**
 * Scene registry: statically compiled registrations only (SCENE-CONTRACTS §1
 * — components load registered items; the front end never picks renderer URLs
 * or versions; unknown renderer/version is rejected by the Host).
 */
import type { SceneDescriptor, KeyboardCommandMap } from '../contracts/public/scene';
import { CYLINDER_KEYBOARD_COMMAND_MAP } from './cylinder/keyboard';

export interface SceneRegistration {
  descriptor: SceneDescriptor;
  expressions: readonly ('WEBGL2' | 'SVG_DOM')[];
  keyboardMap: KeyboardCommandMap;
}

const CYLINDER_REGISTRATION: SceneRegistration = {
  descriptor: {
    rendererId: 'rondo.cylinder',
    rendererContractVersion: '1',
    publicStateSchemaVersion: '1',
    publicAssetHashes: [],
    // SelectFaces is part of frozen CylinderOperationV1; with L3 shipping on
    // @1 (L34-2) the renderer-level capability list now includes it. L1/L2
    // tasks still never whitelist it — task-level narrowing is unchanged.
    allowedOperations: ['SetDimension', 'SetUnroll', 'SetSection', 'SelectFaces'],
  },
  expressions: ['WEBGL2', 'SVG_DOM'],
  keyboardMap: CYLINDER_KEYBOARD_COMMAND_MAP,
};

/** rondo.cylinder@2 (L34-1): V1 operations plus the layer pair. */
const CYLINDER_REGISTRATION_V2: SceneRegistration = {
  descriptor: {
    rendererId: 'rondo.cylinder',
    rendererContractVersion: '2',
    publicStateSchemaVersion: '2',
    publicAssetHashes: [],
    allowedOperations: ['SetDimension', 'SetUnroll', 'SetSection', 'SelectFaces', 'SetLayerCount', 'SetVisibleLayerCount'],
  },
  expressions: ['WEBGL2', 'SVG_DOM'],
  keyboardMap: CYLINDER_KEYBOARD_COMMAND_MAP,
};

const REGISTRY: ReadonlyMap<string, SceneRegistration> = new Map([
  ['rondo.cylinder@1', CYLINDER_REGISTRATION],
  ['rondo.cylinder@2', CYLINDER_REGISTRATION_V2],
]);

export function lookupScene(rendererId: string, rendererContractVersion: string): SceneRegistration | null {
  return REGISTRY.get(`${rendererId}@${rendererContractVersion}`) ?? null;
}

export function allSceneRegistrations(): readonly SceneRegistration[] {
  return [...REGISTRY.values()];
}

export { CYLINDER_KEYBOARD_COMMAND_MAP };
