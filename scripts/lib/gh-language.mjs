import path from 'node:path'
import { ghInvocations, titleArg, bodyArg, bodyFileArg, stdinBodies, heredocWrittenTo, readBodyFile }
  from './gh-command.mjs'

/**
 * Are this PR's or issue's title and body in English, as AGENTS.md requires?
 *
 * **This replaces a perl regex over the whole command**, which was wrong in both directions. It
 * refused a `node -e` script carrying `gh issue create` inside a string literal, because the pattern
 * matched text rather than a command — the same mistake `issue-parent.mjs` exists to have fixed, in
 * the hook sitting next to it. And it never saw a `--body-file`, so Korean in the form CONTRIBUTING
 * tells everyone to use went straight through while Korean typed inline was caught.
 *
 * What is judged is what reaches GitHub: the title, the body, the body file's contents, and the
 * heredoc behind `--body-file -`. Everything else in the command is somebody else's text.
 */

const HANGUL = /\p{Script=Hangul}/u
const LATIN = /\p{Script=Latin}/u

/**
 * The first line whose prose is Korean, or null.
 *
 * **Judged per line and by predominance, not by any Hangul at all.** The rule AGENTS.md states is
 * that the prose is English so contributors of any language can read it, and an English sentence
 * that *names* a Korean string satisfies it. Merged PR #660 carries
 * `Renamed sidebar labels to "Network Control" and "네트워크 제어."` in an otherwise English body;
 * a codepoint test blocks it and then advises rewriting the label in English, which would make the
 * sentence false. The repo ships `docs/ko/`, so naming Korean labels and paths is a live workflow.
 *
 * A line counts as Korean when its Hangul outnumbers its Latin letters — a quoted label inside an
 * English sentence never does, and a Korean sentence always does.
 */
export function koreanLine(text) {
  for (const line of String(text).split(/\r?\n/)) {
    if (!HANGUL.test(line)) continue
    let hangul = 0
    let latin = 0
    for (const ch of line) {
      if (HANGUL.test(ch)) hangul++
      else if (LATIN.test(ch)) latin++
    }
    if (hangul > latin) return line.trim()
  }
  return null
}

/** Every `gh` call that writes a title or body to GitHub. `comment` is not one: a review comment is
 *  a conversation, and the rule AGENTS.md states is about PR and issue titles and bodies. */
export function authoringInvocations(cmd) {
  return [
    ...ghInvocations(cmd, 'issue', ['create', 'new', 'edit']),
    ...ghInvocations(cmd, 'pr', ['create', 'edit']),
  ]
}

/**
 * @param {string} cmd the Bash command the tool was asked to run
 * @param {(p: string) => string} [readFile] injected for the tests
 * @param {string} [cwd] the directory the command would run in, from the hook payload
 * @returns {{ blocked: boolean, where?: string, line?: string }}
 */
export function judge(cmd, readFile = readBodyFile, cwd = process.cwd()) {
  for (const words of authoringInvocations(cmd)) {
    for (const [where, text] of textsReachingGitHub(words, cmd, readFile, cwd)) {
      const line = koreanLine(text)
      if (line !== null) return { blocked: true, where, line }
    }
  }
  return { blocked: false }
}

/**
 * Every piece of prose this invocation would publish, paired with what to call it in the message.
 *
 * **A body file the same command is about to write does not exist yet**, and that is the natural
 * single-call shape: a heredoc writes the body, then `gh pr create --body-file` sends it. Reading
 * the file then fails and the Korean sits unread in the payload — the very hole the port was for.
 * So an unreadable body file falls back to the command's sole heredoc, which is where that body is.
 *
 * With no heredoc to fall back to, an unreadable file is skipped rather than blocked, and that limit
 * is real: the gate resolves against the session's directory while the command may `cd` first, so a
 * path can be readable to `gh` and not to this. Blocking every such path would refuse correct work
 * over a file the gate merely could not open. A floor, not a fence.
 */
function* textsReachingGitHub(words, cmd, readFile, cwd) {
  const title = titleArg(words)
  if (title !== null) yield ['--title', title]

  const body = bodyArg(words)
  if (body !== null) yield ['--body', body]

  const file = bodyFileArg(words)
  if (file !== null && file !== '-') {
    const resolved = path.resolve(cwd, file)
    // **What the command is about to write outranks what is on disk.** A heredoc overwriting an
    // existing body file was losing to the stale text, so a Korean body replacing an English one
    // reached GitHub unjudged; and with no target to match on, an unrelated heredoc was blamed on a
    // body file whose contents were never read.
    const pending = heredocWrittenTo(cmd, resolved, cwd)
    if (pending !== null) yield [`the heredoc written to ${file}`, pending]
    else {
      let contents = null
      try { contents = readFile(resolved) } catch { contents = null }
      if (contents !== null) yield [`the body file ${file}`, contents]
    }
  }
  if (file === '-') {
    const docs = stdinBodies(cmd)
    // Stdin has no redirection target to match on, so the sole-body rule still applies here — to
    // heredocs and here-strings alike, since both put their text in the command and nowhere else.
    // Several means the command builds text elsewhere too and picking would be guessing — the parent
    // gate blocks on that ambiguity because a wrong guess there is permissive; here a wrong guess
    // would refuse someone else's prose, so it is left alone.
    if (docs.length === 1) yield ['the body on stdin', docs[0]]
  }
}
