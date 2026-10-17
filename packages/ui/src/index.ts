/**
 * Host half of the remote-workspace UI plugin: it mounts so the browser half
 * (`exports["./client"]`) has a row to hang off. All behavior lives in the
 * client bundle.
 * @module @dsh-ssh-workspace/ui
 */

import type { Context } from '@deepseek-ai/cordis'

/** No host-side behavior: the browser half owns the whole surface. */
export function apply(_ctx: Context): void {}
