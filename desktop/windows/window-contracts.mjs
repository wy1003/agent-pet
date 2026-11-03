/**
 * Structural interfaces implemented by the window facades. Native handles are private.
 *
 * @typedef {Object} WindowPort
 * @property {() => Promise<void>} ensureCreated
 * @property {(options?: {focus?: boolean}) => Promise<boolean>} show
 * @property {() => void} hide
 * @property {() => void} destroy
 * @property {() => boolean} isVisible
 * @property {() => boolean} isFocused
 * @property {() => boolean} isDestroyed
 * @property {() => ({x:number,y:number,width:number,height:number}|null)} getBounds
 * @property {(bounds: Object) => void} setBounds
 * @property {(value: boolean) => void} setAlwaysOnTop
 * @property {(event: Object) => boolean} ownsSender
 *
 * @typedef {WindowPort & {render: (state: Object) => Promise<boolean>,
 * acknowledge: (revision: number) => void}} PetMenuWindowPort
 *
 * @typedef {WindowPort & {verticalAlignment: (badgeHeight: number) => string,
 * resize: (size: Object) => void}} TaskWindowPort
 *
 * @typedef {WindowPort & {refresh: () => void, resize: (size: Object) => void}} UsageWindowPort
 *
 * @typedef {WindowPort & {applyAppearance: () => void,
 * getAppearance: () => {style: string}, getBackground: () => Promise<Object|null>,
 * setCollapsed: (value: boolean) => void, getPresentation: () => {collapsed: boolean}}} NotebookWindowPort
 */

export const TASK_WINDOW_SIZE = Object.freeze({ width: 350, height: 380, minHeight: 58 });
export const USAGE_WINDOW_SIZE = Object.freeze({ width: 314, height: 150, minHeight: 118, maxHeight: 300 });
export const NOTEBOOK_WINDOW_SIZE = Object.freeze({ width: 380, height: 460 });
export const NOTEBOOK_ORB_SIZE = Object.freeze({ width: 76, height: 76 });
export const PET_MENU_SIZE = Object.freeze({ width: 176, height: 198 });
