// Plugin entry for dsh-wsl-file-open.
//
// The cordis loader imports this module (package main or a relative entry) and
// calls `apply` once the injected `sessionController` service is available.
import * as impl from './impl.mjs'

export const inject = impl.inject
export const apply = impl.apply
export const revealInExplorer = impl.revealInExplorer
export default { inject, apply }
