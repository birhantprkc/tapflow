#include "inline-hook.h"

#include <mach/mach.h>
#include <mach/thread_status.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

// ── instruction forms ────────────────────────────────────────────────────────

/**
 * Can this instruction be moved to a different address unchanged?
 *
 * **A reject list, not an allow list, and the difference is the whole design.** An allow list would
 * have to be complete to be safe; this one only has to name the forms whose meaning depends on where
 * they sit. Anything encoding a PC-relative displacement changes meaning when copied elsewhere, and
 * `RET` means the function is over before our patch ends.
 *
 * Measured on the five targets (iOS 26.5): three start `sub sp, sp, #N`, two start `movz x16, #N`.
 * None is on this list — which is the reason a one-instruction relocation is enough for them, and
 * the reason we can refuse everything else without losing the feature.
 */
static bool tf_relocatable(uint32_t w) {
  if (w == 0xD65F03C0) return false;                      // RET
  if ((w & 0x9F000000) == 0x90000000) return false;       // ADRP
  if ((w & 0x9F000000) == 0x10000000) return false;       // ADR
  if ((w & 0xFC000000) == 0x14000000) return false;       // B
  if ((w & 0xFC000000) == 0x94000000) return false;       // BL
  if ((w & 0xFF000010) == 0x54000000) return false;       // B.cond
  if ((w & 0x7E000000) == 0x34000000) return false;       // CBZ / CBNZ
  if ((w & 0x7E000000) == 0x36000000) return false;       // TBZ / TBNZ
  if ((w & 0x3B000000) == 0x18000000) return false;       // LDR (literal) and friends
  return true;
}

/** `ldr x16, #8` ; `br x16` ; `.quad to` — 16 bytes, any distance. */
static void tf_emit_abs_jump(uint32_t *out, uintptr_t to) {
  out[0] = 0x58000050;
  out[1] = 0xD61F0200;
  memcpy(&out[2], &to, sizeof(to));
}

/** `b to`, or 0 when `to` is out of the ±128MB a single branch can reach. */
static uint32_t tf_emit_rel_branch(uintptr_t from, uintptr_t to) {
  intptr_t delta = (intptr_t)to - (intptr_t)from;
  if (delta < -(intptr_t)(128 << 20) || delta >= (intptr_t)(128 << 20)) return 0;
  return 0x14000000u | (uint32_t)((delta >> 2) & 0x03FFFFFF);
}

// ── memory ───────────────────────────────────────────────────────────────────

#define TF_PATCH_BYTES 16

static size_t tf_page(void) {
  static size_t sz;
  if (sz == 0) sz = (size_t)getpagesize();
  return sz;
}

/** Executable scratch, anywhere. Never released — a thread may be inside it forever. */
static void *tf_alloc_exec(size_t len) {
  void *p = mmap(NULL, len, PROT_READ | PROT_WRITE, MAP_ANON | MAP_PRIVATE, -1, 0);
  return p == MAP_FAILED ? NULL : p;
}

static bool tf_make_exec(void *p, size_t len) {
  return mprotect(p, len, PROT_READ | PROT_EXEC) == 0;
}

/**
 * A page within ±128MB of `near`, so a single `b` can reach it.
 *
 * Searched a page at a time rather than sampled: a coarse stride found nothing for two of the five
 * targets and a fine one confirmed it, which is the difference between "there is none" and "we did
 * not look properly". Those two sit inside the shared cache with the nearest free page 151MB away —
 * they take the suspend path instead.
 */
static void *tf_alloc_island(uintptr_t near) {
  const size_t pg = tf_page();
  for (size_t delta = pg; delta < (128u << 20); delta += pg) {
    for (int dir = 0; dir < 2; dir++) {
      vm_address_t addr = (vm_address_t)((dir ? near + delta : near - delta) & ~(uintptr_t)(pg - 1));
      if (vm_allocate(mach_task_self(), &addr, pg, VM_FLAGS_FIXED) == KERN_SUCCESS) {
        return (void *)addr;
      }
    }
  }
  return NULL;
}

/**
 * Make a mapped page writable — including a shared-cache one, which needs `VM_PROT_COPY`.
 *
 * **Execute is asked for first, and that is not belt-and-braces.** `connect`, `sendto` and
 * `mach_vm_protect` are all syscall stubs in libsystem_kernel and land in the same page, so dropping
 * execute there un-maps the very code performing the call: measured as a `SIGBUS`
 * (`KERN_PROTECTION_FAILURE`) inside `mach_vm_protect` on its way back out, with the app dying in
 * its dyld initialisers.
 *
 * The fallback without execute is kept for the pages where `rwx` is refused — the path functions sit
 * deep in the shared cache and we are never executing from there while we patch them.
 */
static bool tf_write_code(void *dst, const void *src, size_t len) {
  const size_t pg = tf_page();
  vm_address_t page = (vm_address_t)dst & ~(vm_address_t)(pg - 1);

  // **Refuse a page that holds the code doing the refusing.** Every protection form that keeps the
  // page executable is rejected here (measured three times: `rwx`, `rwx|copy`, and the region's own
  // max of `rwx` — the page always lands `rw-`), so changing it un-maps whatever is executing there.
  // `connect`, `sendto` and `mach_vm_protect` share one 16K page of libsystem_kernel, and the result
  // was an instruction abort inside `mach_vm_protect` on its way back out — the app died in its dyld
  // initialisers, three runs in a row.
  //
  // Refusing is the designed outcome: the caller reports `hooks-not-installed` and nothing pretends
  // to be hooked. A crash in the app under test would be blamed on tapflow, and rightly.
  vm_address_t guard = (vm_address_t)(uintptr_t)&vm_protect & ~(vm_address_t)(pg - 1);
  if (guard == page) return false;
  size_t span = (((uintptr_t)dst + len) > (page + pg)) ? pg * 2 : pg;
  task_t task = mach_task_self();

  // Order matters, and it is not preference — it is which pages each form is allowed on.
  //
  //  1. `rwx` with no `VM_PROT_COPY`. The regions we patch carry `rwx` as their *max* protection, and
  //     this is the only form that keeps the page executable throughout. That is required, not
  //     preferred, whenever the page also holds the code performing the call: `connect`, `sendto` and
  //     `mach_vm_protect` share one 16K page of libsystem_kernel, and dropping execute there faults on
  //     `mach_vm_protect`'s own next instruction — an *instruction* abort, measured, killing the app
  //     inside its dyld initialisers.
  //  2. `rwx` with `VM_PROT_COPY`, for a shared mapping that still needs execute.
  //  3. `rw` with `VM_PROT_COPY` — the shared-cache form. Safe there precisely because we are never
  //     executing from the cache's path functions while we patch them.
  bool opened =
      vm_protect(task, page, span, FALSE,
                 VM_PROT_READ | VM_PROT_WRITE | VM_PROT_EXECUTE) == KERN_SUCCESS ||
      vm_protect(task, page, span, FALSE,
                 VM_PROT_READ | VM_PROT_WRITE | VM_PROT_EXECUTE | VM_PROT_COPY) == KERN_SUCCESS ||
      vm_protect(task, page, span, FALSE,
                 VM_PROT_READ | VM_PROT_WRITE | VM_PROT_COPY) == KERN_SUCCESS;
  if (!opened) return false;

  memcpy(dst, src, len);
  vm_protect(task, page, span, FALSE, VM_PROT_READ | VM_PROT_EXECUTE);
  __builtin___clear_cache((char *)dst, (char *)dst + len);
  return true;
}

// ── the two write strategies ─────────────────────────────────────────────────

/**
 * Stop every other thread and prove none of them is standing in the bytes we are about to replace.
 *
 * **Nothing inside the suspended window may allocate, log, send an Objective-C message, or take a
 * lock.** A suspended thread holding the malloc or `os_log` lock deadlocks us permanently, and
 * `os_log` does both. Everything this needs is prepared before the first `thread_suspend` and
 * reported after the last `thread_resume`.
 *
 * Used only for the two path functions. The socket wrappers take the atomic path instead, because a
 * thread blocked in `connect` is parked on the `svc` at `target+4` — inside exactly the bytes a
 * 16-byte patch overwrites, and it can stay there for the length of a DNS timeout. That is not a
 * rare case: "cut the network while a request is in flight" is what this feature is for.
 */
static bool tf_suspend_and_write(void *target, const void *bytes, size_t len) {
  thread_act_array_t threads = NULL;
  mach_msg_type_number_t count = 0;
  if (task_threads(mach_task_self(), &threads, &count) != KERN_SUCCESS) return false;

  mach_port_t self = mach_thread_self();
  bool clear = true;

  for (mach_msg_type_number_t i = 0; i < count; i++) {
    if (threads[i] == self) continue;
    if (thread_suspend(threads[i]) != KERN_SUCCESS) continue;

    arm_thread_state64_t state;
    mach_msg_type_number_t n = ARM_THREAD_STATE64_COUNT;
    if (thread_get_state(threads[i], ARM_THREAD_STATE64, (thread_state_t)&state, &n) == KERN_SUCCESS) {
      uintptr_t pc = (uintptr_t)arm_thread_state64_get_pc(state);
      if (pc >= (uintptr_t)target && pc < (uintptr_t)target + len) clear = false;
    }
  }

  bool ok = clear && tf_write_code(target, bytes, len);

  for (mach_msg_type_number_t i = 0; i < count; i++) {
    if (threads[i] != self) thread_resume(threads[i]);
    mach_port_deallocate(mach_task_self(), threads[i]);
  }
  vm_deallocate(mach_task_self(), (vm_address_t)threads, count * sizeof(thread_act_t));
  mach_port_deallocate(mach_task_self(), self);
  return ok;
}

// ── install ──────────────────────────────────────────────────────────────────

/**
 * Take the slot back when an install is refused after it was filled.
 *
 * Publishing early is what closes the window in the header; it opens a smaller one in the other
 * direction, because three refusals happen *after* that line — an island that would not turn
 * executable, a thread parked in the patch site, a page that would not take the write. Leaving the
 * trampoline visible there would make a non-NULL slot mean "installed" when nothing was installed.
 *
 * Safe on every one of those paths because none of them has written a byte to the target yet: the
 * only `memcpy` into it is inside `tf_write_code`, past the point where all three have returned.
 */
static void tf_unpublish(void **original) {
  if (original != NULL) *original = NULL;
}

bool tf_hook_install(void *target, void *replacement, void **original, tf_hook_error_t *err) {
  tf_hook_error_t ignored;
  if (err == NULL) err = &ignored;

  uint32_t i0;
  memcpy(&i0, target, sizeof(i0));
  if (!tf_relocatable(i0)) { *err = TF_HOOK_ERR_UNRELOCATABLE; return false; }

  // Prepared before anything is patched, and before any thread is suspended.
  uint32_t *tramp = tf_alloc_exec(tf_page());
  if (tramp == NULL) { *err = TF_HOOK_ERR_NO_MEMORY; return false; }

  void *island = tf_alloc_island((uintptr_t)target);
  uint32_t branch = 0;
  if (island != NULL) {
    branch = tf_emit_rel_branch((uintptr_t)target, (uintptr_t)island);
    if (branch == 0) { island = NULL; }   // allocated out of reach; fall through to the suspend path
  }

  // The trampoline holds the displaced instruction and returns to whatever we did not overwrite.
  const size_t displaced = island ? 4 : TF_PATCH_BYTES;
  tramp[0] = i0;
  tf_emit_abs_jump(&tramp[1], (uintptr_t)target + displaced);
  if (!island) {
    // The 16-byte patch displaces four instructions, so all four move to the trampoline — and all
    // four have to be relocatable, not just the first.
    uint32_t rest[3];
    memcpy(rest, (uint8_t *)target + 4, sizeof(rest));
    for (int i = 0; i < 3; i++) {
      if (!tf_relocatable(rest[i])) { *err = TF_HOOK_ERR_UNRELOCATABLE; return false; }
    }
    memcpy(&tramp[1], rest, sizeof(rest));
    tf_emit_abs_jump(&tramp[4], (uintptr_t)target + TF_PATCH_BYTES);
  }
  if (!tf_make_exec(tramp, tf_page())) { *err = TF_HOOK_ERR_NO_MEMORY; return false; }
  __builtin___clear_cache((char *)tramp, (char *)tramp + tf_page());

  // **Published before the patch, never after.** From the store below, another thread can be inside
  // `replacement` on its next instruction; a replacement that tail-calls through this slot would
  // branch to zero. Everything above this line is preparation nothing can observe, so the last
  // moment the slot can be filled unobserved is here.
  if (original != NULL) *original = tramp;

  bool ok;
  if (island != NULL) {
    // Island first: it must be complete before anything branches to it.
    uint32_t jump[4];
    tf_emit_abs_jump(jump, (uintptr_t)replacement);
    memcpy(island, jump, sizeof(jump));
    if (!tf_make_exec(island, tf_page())) { tf_unpublish(original); *err = TF_HOOK_ERR_NO_MEMORY; return false; }
    __builtin___clear_cache((char *)island, (char *)island + sizeof(jump));

    // **One aligned four-byte store**, which arm64 does not tear. A thread inside the function sees
    // either the old instruction or the new branch, never a mixture — and a thread parked further in
    // is untouched, so it wakes and runs the original instructions it was always going to run.
    ok = tf_write_code(target, &branch, sizeof(branch));
  } else {
    uint32_t jump[4];
    tf_emit_abs_jump(jump, (uintptr_t)replacement);
    ok = tf_suspend_and_write(target, jump, sizeof(jump));
    if (!ok) { tf_unpublish(original); *err = TF_HOOK_ERR_BUSY; return false; }
  }

  if (!ok) { tf_unpublish(original); *err = TF_HOOK_ERR_WRITE; return false; }
  *err = TF_HOOK_OK;
  return true;
}

const char *tf_hook_strerror(tf_hook_error_t err) {
  switch (err) {
    case TF_HOOK_OK: return "ok";
    case TF_HOOK_ERR_UNRELOCATABLE: return "prologue cannot be relocated";
    case TF_HOOK_ERR_NO_MEMORY: return "no trampoline or island";
    case TF_HOOK_ERR_BUSY: return "a thread is inside the patch site";
    case TF_HOOK_ERR_WRITE: return "the page would not take a write";
  }
  return "unknown";
}
