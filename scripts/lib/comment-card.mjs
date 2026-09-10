import fs from 'node:fs'
import path from 'node:path'
import { ghInvocations, tokenize, apiEndpoint, apiFlag, flagEntries, isGraphqlEndpoint,
  graphqlDocuments, invokesOperation, API_FIELD_FLAGS, readBodyFile } from './gh-command.mjs'

/**
 * Was the comment card read before writing a comment that goes out under the user's account?
 *
 * **A personal gate, wired locally.** Reviewing is done by two people here, so this fires for them
 * and not for a contributor leaving a note on their own PR — see `judge`'s contract below for the
 * three independent reasons that holds even if someone wires it wrongly.
 *
 * The card is a register, not a template: it exists because comments written from scratch each time
 * read like different people, and the fix is a fixed reference point rather than a rule about
 * adjectives. What it cannot do is judge whether a paragraph belongs; that stays a decision.
 */

/**
 * Every `gh` call that posts prose into a conversation.
 *
 * `create` is not one — a PR body is a different genre with its own template, and the card is about
 * comments. **`close` and `reopen` are**, which review caught: all four of
 * `gh {pr,issue} {close,reopen}` take `-c/--comment` and leave one, verified against the binary.
 * They only count when that flag is present, since closing something silently publishes nothing.
 */
function commentInvocations(cmd) {
  const direct = [
    ...ghInvocations(cmd, 'pr', ['comment', 'review']),
    ...ghInvocations(cmd, 'issue', ['comment']),
  ]
  const withComment = [
    ...ghInvocations(cmd, 'pr', ['close', 'reopen']),
    ...ghInvocations(cmd, 'issue', ['close', 'reopen']),
  ].filter((words) => words.some((w, i) => (w === '-c' || w === '--comment') ? words[i + 1] !== undefined
    : /^(-c|--comment)=/.test(w)))
  return [...direct, ...withComment]
}

/**
 * `gh api …/comments` and `…/replies` that would publish something.
 *
 * Not reachable through `ghInvocations`, whose shape is `gh <noun> <verb>`, so the path argument is
 * what identifies it. What counts as writing took three corrections from review, each against
 * `gh api --help` as the authority:
 *
 * - **`--input` carries a whole body with no field flag at all** — "a request body may be read from
 *   file specified by `--input`" — and it is the natural form for a reply written to a file first.
 *   Reading only field flags missed it entirely.
 * - **A field does not mean a write.** "To send the parameters as a `GET` query string instead, use
 *   `--method GET`" — so `--method GET … -f per_page=100` is a *read*, and blocking it blocks the
 *   first thing the card asks for. Only a field named `body` is a body.
 * - An explicit write method counts on its own, since a `POST` to a comments path is one whatever
 *   else is on the line.
 */
function apiCommentInvocations(cmd) {
  const found = []
  for (const words of ghInvocations(cmd, 'api', null)) {
    // `reviews` is here because a review created with a body publishes prose, which review caught:
    // `POST /repos/{o}/{r}/pulls/{n}/reviews` is the API form of `gh pr review --body`.
    const endpoint = apiEndpoint(words)
    if (!endpoint || !/\/(comments|replies|reviews)(\/|$|\?)/.test(endpoint)) continue
    const method = (apiFlag(words, '--method', '-X') ?? '').toUpperCase()
    if (method === 'GET' || method === 'HEAD') continue
    const hasInput = words.some((w) => w === '--input' || w.startsWith('--input='))
    const hasBody = fieldValues(words, 'body').length > 0
    if (hasInput || hasBody || ['POST', 'PATCH', 'PUT'].includes(method)) found.push(words)
  }
  return found
}


/**
 * GraphQL mutations that publish prose into a conversation.
 *
 * **The list is GitHub's rather than ours**, which is the reason this is an enumeration and not a
 * pattern: `addComment` is the obvious one, but a review, a review comment and a discussion comment
 * all publish too, and `updateIssueComment` republishes. A name GitHub adds later is a name this
 * list has to grow — a `*Comment*` regex would instead catch `deleteIssueComment`, which publishes
 * nothing, and miss `addPullRequestReview`, which does.
 */
const COMMENT_MUTATIONS = [
  'addComment', 'addPullRequestReview', 'addPullRequestReviewComment',
  'addDiscussionComment', 'updateIssueComment',
]

/** Every value given for one field name. Read by name, since only a `body` field is a body. */
const fieldValues = (words, name) =>
  flagEntries(words, API_FIELD_FLAGS)
    .filter((e) => e.value.startsWith(`${name}=`))
    .map((e) => e.value.slice(name.length + 1))

/**
 * `gh api graphql` calls that publish a comment.
 *
 * **A GraphQL call is identified by its contents, not its path.** Every other form the gate knows
 * names what it acts on in the URL; here the path is the constant `graphql` and the operation is a
 * string passed as a field value. So the endpoint check is the cheap half and the mutation name is
 * the decision.
 *
 * A read-only query passes for the same reason `--method GET` does on the REST path: it publishes
 * nothing. That is the whole distinction, and it is why the mutation names are enumerated rather
 * than the word `mutation` being treated as enough — `mutation { addLabel… }` posts no prose.
 */
function graphqlCommentInvocations(cmd, cwd, readFile) {
  const found = []
  for (const words of ghInvocations(cmd, 'api', null)) {
    if (!isGraphqlEndpoint(apiEndpoint(words))) continue
    if (invokesOperation(graphqlDocuments(words, cmd, cwd, readFile), COMMENT_MUTATIONS)) found.push(words)
  }
  return found
}

export function postsAComment(cmd, { cwd = process.cwd(), readFile = readBodyFile } = {}) {
  return commentInvocations(cmd).length
    + apiCommentInvocations(cmd).length
    + graphqlCommentInvocations(cmd, cwd, readFile).length > 0
}

/**
 * The same file, allowing for symlinks.
 *
 * `path.resolve` normalises `..` and makes a path absolute; it does not follow links, and on macOS
 * `/var` is one — so a checkout reached through a symlinked parent produced two spellings of the
 * same card and the comparison said no. Falls back to the resolved strings when a path no longer
 * exists, which a transcript's record often does.
 */
function samePath(a, b) {
  if (path.resolve(a) === path.resolve(b)) return true
  try { return fs.realpathSync(a) === fs.realpathSync(b) } catch { return false }
}

/**
 * Does this tool input name the card — by the path the gate resolved, or by the repo-relative form a
 * shell command would use?
 *
 * **A relative mention is resolved against the record's own directory.** Every transcript record
 * carries the `cwd` the call ran in, and this project's carry 22 distinct ones. Without using it,
 * `cat .work/COMMENT-CARD.md` counted the same whether it ran at the repo root, in
 * `packages/relay` where it fails, or in a different checkout entirely — so a command that never
 * read the card satisfied the gate. A record with no `cwd` cannot resolve a relative mention and
 * does not get one; the absolute form still counts, since it needs no directory to be unambiguous.
 */
function namesCard(input, cardPath, relative, recordCwd) {
  if (input == null) return false
  const fp = input.file_path
  if (typeof fp === 'string') return samePath(fp, cardPath)
  const text = JSON.stringify(input)
  if (text.includes(cardPath)) return true
  if (!recordCwd || !text.includes(relative)) return false
  return samePath(path.resolve(recordCwd, relative), cardPath)
}

/**
 * Did this session put the card in front of itself?
 *
 * **Any tool call naming the card counts; a mention in prose does not.** Every way the content
 * reaches the context goes through a tool call that names the path — `Read`, a `Write` that authored
 * it, an `Edit`, a `cat` in Bash — and narrowing to `Read` alone excluded three of those for no
 * reason. What the rule has to exclude is the gate's own block message, which names the card and
 * would otherwise let it fire exactly once ever.
 *
 * A floor, not a fence, and the boundary is narrower than it was: a command naming the card in the
 * directory that holds it counts whether or not it read anything — `ls .work/COMMENT-CARD.md` does.
 * Whether the read *succeeded* is not checked, because that needs the result rather than the call.
 * That direction costs a missed prompt for a cooperative reader, which is the threat model these
 * gates state.
 *
 * Parses the transcript rather than matching its serialisation — the lesson `docs-aitells-gate.sh`
 * paid for, where a matcher assuming key order saw 6 of 34. Only lines that mention the card are
 * parsed, so a 35 MB transcript costs a substring scan and a handful of `JSON.parse` calls.
 */
export function cardWasRead(transcriptPath, cardPath) {
  const cardName = path.basename(cardPath)
  const relative = path.join(path.basename(path.dirname(cardPath)), cardName)
  let text
  try { text = fs.readFileSync(transcriptPath, 'utf8') } catch { return false }
  if (!text.includes(cardName)) return false
  for (const line of text.split('\n')) {
    if (!line.includes(cardName)) continue
    let rec
    try { rec = JSON.parse(line) } catch { continue }
    // **An `@path` mention is not a tool call and carries no `message` at all** — it arrives as its
    // own record with an `attachment`, 64 of them in this project's transcripts. It is the most
    // direct way the card's content reaches the context, and reading only `message.content` blocked
    // the person who had just supplied it.
    const att = rec?.attachment
    for (const p of [att?.filename, att?.content?.file?.filePath]) {
      if (typeof p === 'string' && samePath(p, cardPath)) return true
    }
    for (const c of rec?.message?.content ?? []) {
      // The `input` test is what excludes a text block naming the card — today's non-tool blocks
      // carry no `input` at all, so the type guard cannot currently change an answer. It stays for
      // block shapes that do not exist yet, and is named here rather than asserted, because a
      // fixture invented to make it fail would be testing the fixture.
      if (c?.type === 'tool_use' && namesCard(c.input, cardPath, relative, rec?.cwd)) return true
    }
  }
  return false
}

/**
 * @returns {{ blocked: boolean, reason?: 'card-not-read' }}
 *
 * **Three independent reasons a contributor is unaffected**, and the third is the one that matters:
 * the card lives under gitignored `.work/`, the wiring lives in gitignored `settings.local.json`,
 * and this returns `blocked: false` when the card is absent. The first two are "it was not wired for
 * them"; only the third survives someone wiring it by mistake.
 */
export function judge(cmd, { cardPath, transcriptPath, cwd, exists = (p) => fs.existsSync(p) } = {}) {
  if (!postsAComment(cmd, cwd ? { cwd } : {})) return { blocked: false }
  if (!cardPath || !exists(cardPath)) return { blocked: false }
  if (cardWasRead(transcriptPath ?? '', path.resolve(cardPath))) return { blocked: false }
  return { blocked: true, reason: 'card-not-read' }
}

export { tokenize }
