// Loader entry for the WSL native file open shim.
//
// The cordis loader imports a relative entry through a plain import(url) with
// no cache-buster, so a running service keeps the first module instance. Keep
// this file as the stable entry and put evolving logic in impl.mjs; if entry.mjs
// itself must change, rename it and update the profile patch (or restart).
import * as impl from './impl.mjs'

export const inject = impl.inject
export const apply = impl.apply
export const revealInExplorer = impl.revealInExplorer
export default { inject, apply }
