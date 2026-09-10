import path from 'node:path'
import { proseLines } from './prose-lines.mjs'
import { ghInvocations, bodyFileArg, bodyArg, stdinBodies, heredocWrittenTo, readBodyFile, isProcessSubstitution }
  from './gh-command.mjs'

/**
 * Does an issue split out of other work name what it came from?
 *
 * **The decision lives here rather than in the hook's shell**, because the first version was shell
 * and three of its four rules were wrong in the same way: they matched text anywhere in the command
 * instead of parsing anything. `gh issue new` — an undocumented alias that works — went straight
 * through, so did `GH_REPO=o/r gh issue create`, `-F "issue body.md"` read the file `issue`, and
 * `Parent: #607` in a `--title` satisfied a gate about bodies. The parsing itself now lives in
 * `gh-command.mjs`, because the language gate needed the same reading and had its own regex.
 *
 * It also means this repo stops keeping a third, weaker copy of "which lines of a markdown body
 * count". `check-changeset.mjs` already had `proseLines`, whose own comment warns that a second copy
 * is how the guard drifts. Both markers here are switches that turn a gate **off**, so a body that
 * merely quotes one must not trip it — the same rule, now shared rather than re-derived.
 */

/** Every `gh issue create` (or `new`) in the command, as the token slice that starts at `gh`. */
export const issueCreateInvocations = (cmd) => ghInvocations(cmd, 'issue', ['create', 'new'])

/**
 * `Parent: #607` on a line of its own.
 *
 * Anchored, because the point of the rule is that a checklist can be regenerated from it. Prose that
 * happens to contain the words — "raised by the review of #647" was the measured case — is exactly
 * what the gate exists to reject, and an unanchored match accepted a sentence with `Parent:` in the
 * middle of it just as readily.
 */
export function hasParent(body) {
  for (const { line } of proseLines(body, { skipFrontmatter: true })) {
    // The optional prefix is one whole `owner/repo`, not any run of the characters that appear in
    // one — `Parent: owner#607` and `Parent: /#607` are neither form and both switched the gate off.
    if (/^Parent:\s*(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+\s*$/.test(line)) return true
  }
  return false
}

/** `<!-- standalone: reason -->`, and the reason has to say something. An empty one is the marker
 *  without the part that makes it a decision. */
export function hasStandalone(body) {
  for (const { line } of proseLines(body, { skipFrontmatter: true })) {
    const m = /^<!--\s*standalone:\s*(.*?)\s*-->$/.exec(line)
    if (m && m[1]) return true
  }
  return false
}

/**
 * @param {string} cmd the Bash command the tool was asked to run
 * @param {(p: string) => string} [readFile] injected for the tests
 * @param {string} [cwd] the directory the command would run in, from the hook payload
 * @returns {{ blocked: boolean, reason?: 'unreadable-body-file' | 'no-body' | 'no-parent'
 *             | 'process-substitution', detail?: string,
 *             file?: string, resolved?: string, code?: string | null }}
 *
 * **`reason` exists because the caller printed one message for three outcomes.** A body file the
 * gate could not open was reported as a body naming no parent, which sends the author to add a line
 * that is already there — measured filing #700, whose body carried `Parent: #609` throughout. The
 * three were distinguished here from the start; only the printing collapsed them.
 */
export function judge(cmd, readFile = readBodyFile, cwd = process.cwd()) {
  const invocations = issueCreateInvocations(cmd)
  if (invocations.length === 0) return { blocked: false }

  for (const words of invocations) {
    // **Only the body is consulted.** `haystack = the whole command` let a `--title` satisfy a rule
    // about bodies, which is the gate agreeing with itself rather than with the issue.
    let body = null
    let unreadable = null
    const file = bodyFileArg(words)
    // **A process substitution is a shape, not a path.** `--body-file <(…)` and `>(…)` leave the
    // parser a bare `<` or `>`, and resolving either produced a report naming a file the author
    // never wrote (`could not read the body file at /tmp/>`). The text cannot be had without running
    // the command, so the honest answer names the shape and stops.
    if (file !== null && isProcessSubstitution(file)) {
      return {
        blocked: true,
        reason: 'process-substitution',
        detail: 'the body comes from a process substitution, which cannot be read without running it',
      }
    }
    if (file && file !== '-') {
      // **Resolved against the session's directory, not the gate's.** The hook runs from the
      // repository root while `gh` runs where the session is, so resolving here is what lets a
      // relative path written from a subdirectory be read at all rather than merely reported.
      const resolved = path.resolve(cwd, file)
      // A heredoc this same command writes to that path is the body; the file on disk, if any, is
      // about to be replaced by it.
      const pending = heredocWrittenTo(cmd, resolved, cwd)
      if (pending !== null) body = pending
      else try { body = readFile(resolved) } catch (err) { unreadable = { file, resolved, code: err?.code ?? null } }
    }
    if (body === null) body = bodyArg(words)
    // A heredoc reaches `--body-file -`; its text is in the command and nowhere else. Reading the
    // whole command for it was the title bypass again one case over — a `Parent:` line in a
    // title-side heredoc satisfied a check about the body — so the payload is extracted, and an
    // ambiguous command is blocked rather than guessed at.
    if (body === null && file === '-') {
      // A heredoc or a here-string reaches `--body-file -`; both put the text in the command and
      // nowhere else, and counting only one of them answered "no body" for a command that has one.
      const docs = stdinBodies(cmd)
      body = docs.length === 1 ? docs[0] : null
    }

    if (body === null && unreadable !== null) {
      return { blocked: true, reason: 'unreadable-body-file', ...unreadable, detail: `could not read the body file at ${unreadable.resolved}` }
    }
    if (body === null) return { blocked: true, reason: 'no-body', detail: 'no body could be read from the command' }
    if (!hasParent(body) && !hasStandalone(body)) {
      return { blocked: true, reason: 'no-parent', detail: 'the body names no parent' }
    }
  }
  return { blocked: false }
}
