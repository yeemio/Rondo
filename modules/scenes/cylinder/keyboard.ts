/**
 * Keyboard equivalent declarations for rondo.cylinder@1 (C-side open question
 #3 decision). Every domain operation exposed to a learner and every ViewState
 * control has a non-pointer entry point (SCENE-CONTRACTS §3/§6).
 *
 * Discipline: arrow keys rotate ONLY while the scene container is focused;
 * inside inputs/sliders the native editing behavior is preserved (checked by
 * isSceneKeyEvent). Keys and mouse produce identical typed intent.
 */
import type { KeyboardCommandMap } from '../../contracts/public/scene';

export const CYLINDER_KEYBOARD_COMMAND_MAP: KeyboardCommandMap = [
  {
    operationId: 'view.rotate',
    keys: ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'],
    description: '场景聚焦时：左右方向键水平旋转，上下方向键俯仰；输入框内不劫持',
  },
  {
    operationId: 'view.zoom',
    keys: ['+', '-', '='],
    description: '场景聚焦时：加号放大、减号缩小',
  },
  {
    operationId: 'view.reset',
    keys: ['0'],
    description: '场景聚焦时：复位视角',
  },
  {
    operationId: 'view.preset.front',
    keys: ['f'],
    description: '前视图',
  },
  {
    operationId: 'view.preset.side',
    keys: ['s'],
    description: '侧视图',
  },
  {
    operationId: 'view.preset.top',
    keys: ['t'],
    description: '俯视图',
  },
  {
    operationId: 'SetUnroll',
    keys: ['ArrowRight', 'ArrowLeft', 'Home', 'End'],
    description: '展开进度 slider：方向键离散步进（50‰），Home 完全卷起、End 完全展开',
  },
  {
    operationId: 'SetUnroll.full',
    keys: ['u'],
    description: '完全展开按钮（u 键等价）',
  },
  {
    operationId: 'SetUnroll.zero',
    keys: ['r'],
    description: '完全卷起按钮（r 键等价）',
  },
  {
    operationId: 'SetDimension',
    keys: ['ArrowUp', 'ArrowDown'],
    description: '尺寸数字输入：原生方向键行为；步进按钮可 Tab 到达',
  },
  {
    operationId: 'SetSection',
    keys: ['ArrowUp', 'ArrowDown'],
    description: '截面 radio 组：方向键原生切换',
  },
  {
    operationId: 'SelectFaces',
    keys: ['Tab', ' ', 'Spacebar'],
    description: '面清单 checkbox 组：Tab 逐面到达、空格切换勾选（草稿）；「确认选面」按钮可 Tab 到达并发送整集命令（L3，SCENE §6）',
  },
  {
    operationId: 'SetLayerCount',
    keys: ['ArrowUp', 'ArrowDown'],
    description: '层数数字输入：原生方向键行为；步进按钮可 Tab 到达（L4）',
  },
  {
    operationId: 'SetVisibleLayerCount',
    keys: ['ArrowUp', 'ArrowDown', 'Home'],
    description: '层推进：场景聚焦时方向键逐层 +1/−1（草稿），Home 复位到 0；「装一层/确认」按钮同意图（L4）',
  },
];

/**
 * Guard: key events originating from text inputs, number inputs, sliders or
 * textareas follow native behavior and must NOT trigger scene rotation.
 */
export function isSceneKeyEvent(event: {
  target: EventTarget | null;
  defaultPrevented: boolean;
}): boolean {
  if (event.defaultPrevented) return false;
  const t = event.target as HTMLElement | null;
  if (!t) return false;
  const tag = (t.tagName ?? '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable) {
    return false;
  }
  // The scene container itself (or non-form children) may drive the camera.
  return true;
}

/** Keys consumed by scene view controls; returns true when handled. */
export function isViewControlKey(key: string): boolean {
  return [
    'ArrowLeft',
    'ArrowRight',
    'ArrowUp',
    'ArrowDown',
    '+',
    '=',
    '-',
    '0',
    'f',
    's',
    't',
  ].includes(key);
}
