// arm64 inline hooking for the iOS simulator (#607).
//
// **Why this exists rather than fishhook.** fishhook rewrites a Mach-O image's indirect symbol
// pointers, which reaches only images outside the dyld shared cache. Measured in a real `.app`:
// every system framework calls its neighbours with direct branches inside the cache, so neither the
// socket layer nor the path layer was reachable — the hooks that appeared to work were our own
// dylib's imports, which is also what made the first self-check a false positive.
//
// This patches the **target function's own body**, so it does not care how the call site reached it.
//
// **It refuses more than it handles, on purpose.** tapflow signs off on other people's apps, and the
// worst failure here is not a crash — it is lying: a tester reporting "offline handling works" for an
// app that was never offline. A hook that cannot be installed correctly is not installed, and says so.

#ifndef TAPFLOW_INLINE_HOOK_H
#define TAPFLOW_INLINE_HOOK_H

#include <stdbool.h>
#include <stdint.h>

/** Why an install was refused. Present on failure, `NULL` on success. */
typedef enum {
  TF_HOOK_OK = 0,
  TF_HOOK_ERR_UNRELOCATABLE,   // the first instruction is PC-relative or a return
  TF_HOOK_ERR_NO_MEMORY,       // trampoline or island could not be allocated
  TF_HOOK_ERR_BUSY,            // a thread is parked inside the bytes we must overwrite
  TF_HOOK_ERR_WRITE,           // the page refused to become writable
} tf_hook_error_t;

/**
 * Route `target` to `replacement`, publishing the way back through `*original`.
 *
 * Returns `false` and sets `*err` when it refuses. **Refusal is a normal outcome** — the caller
 * reports it rather than proceeding as if the hook were live.
 *
 * **`original` is a parameter and not a return value, and that is the whole design of this call.**
 * A replacement reaches the real function through that slot, and the patch goes live inside here —
 * so any arrangement where the caller stores the pointer *afterwards* leaves a window in which
 * another thread enters the replacement and tail-calls address zero. The earlier shape handed back
 * a handle to read the pointer out of, which made the correct order something the caller had to
 * know rather than something the signature required; a crash of exactly this class already shipped
 * on this branch, from a different slot published late. Written before the store that activates the
 * patch, it is never observed empty by a caller that is running.
 *
 * **A refusal leaves the slot `NULL`, whether or not it was briefly filled.** Three of the refusals
 * happen after the publish, and none of them has touched the target — so a non-NULL slot means the
 * hook is live, in both directions, and the caller needs no rule of its own about the order.
 *
 * The slot must outlive the process's use of the hook — a static or a global, never a local. There
 * is no uninstall: the patch and its trampoline are permanent.
 */
bool tf_hook_install(void *target, void *replacement, void **original, tf_hook_error_t *err);

/** Human-readable reason, for logging **after** any thread suspension has ended. */
const char *tf_hook_strerror(tf_hook_error_t err);

#endif
