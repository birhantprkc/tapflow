import fs from 'node:fs'
import path from 'node:path'

/**
 * Reading a Bash command well enough to tell a `gh` invocation from the words that spell one.
 *
 * **Two gates needed this and only one had it.** `issue-parent.mjs` was written because a shell
 * regex got three rules wrong in the same way — it matched text anywhere in the command instead of
 * parsing anything — and the language gate next to it in `settings.json` was still a perl regex over
 * the whole command. It refused a `node -e` script that carried `gh issue create` inside a string
 * literal. Rather than write the parser twice, it lives here and both import it; a second, weaker
 * copy is how this kind of guard drifts, which `check-changeset.mjs` already says about `proseLines`.
 */

/**
 * Split a shell command into words the way the shell would, enough for this job: single quotes are
 * literal, double quotes group, a backslash escapes the next character.
 *
 * **Operators are their own tokens even with no space around them.** Splitting on whitespace alone
 * meant an operator glued to `gh` stayed inside that word and command position was never reached, so
 * `true&&gh issue create`, `cd /tmp;gh …`, `(gh …)` and `echo x|gh …` were all invisible. The
 * commonest form was the worst: `URL=$(gh` is a *prefix* match for `ASSIGNMENT`, so the mechanism
 * added to see through `GH_REPO=o/r gh issue create` swallowed the capture form whole.
 *
 * **An unquoted newline becomes a `NEWLINE` token** rather than vanishing into whitespace, because a
 * newline starts a command and the caller has to see that. A NUL is used as the sentinel since it is
 * the one byte that cannot appear in a real argument — `execve` strings are NUL-terminated — so no
 * quoted body can forge one. A backslash before a newline is a line continuation and produces
 * neither a token nor a break.
 *
 * Not a shell parser and not trying to be. It cannot see through `$VAR`, `$(…)` or an alias. It
 * does report how each word arrived — see `tokenizeDetailed` — because whether a word was quoted
 * decides whether it is a keyword at all.
 */
export const NEWLINE = '\0'

/** The here-string operator, tokenized on its own so a quoted `<<<` cannot be read as one. */
export const HERE_STRING_OP = '<<<'

/** Unquoted characters that end a word and begin a new command. `(` and `)` are here so that both
 *  `(gh …)` and `$(gh …)` reach command position.
 *
 *  **A backtick is here for the same reason `(` is.** It opens a command substitution, and bash runs
 *  what is inside one — verified. Leaving it out made the two spellings of one thing disagree: the
 *  dollar-paren form of a merge was refused while the backtick form passed, because the backtick
 *  stayed glued to `gh` as one word and never matched. Quoting still decides, as everywhere else
 *  here: inside single quotes a backtick is literal and never reaches this branch, which is what
 *  keeps prose that names a command from tripping it. */
const OPERATOR = '&|;()`'

export function tokenizeDetailed(cmd) {
  const words = []
  const quoted = []
  let cur = ''
  let started = false
  let curQuoted = false
  let quote = null
  const flush = () => {
    if (started || cur) { words.push(cur); quoted.push(curQuoted) }
    cur = ''; started = false; curQuoted = false
  }
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (quote === "'") {
      if (c === "'") quote = null
      else cur += c
      continue
    }
    if (quote === '"') {
      if (c === '"') quote = null
      else if (c === '\\' && i + 1 < cmd.length && '"\\$`'.includes(cmd[i + 1])) cur += cmd[++i]
      else cur += c
      continue
    }
    if (c === "'" || c === '"') { quote = c; started = true; curQuoted = true; continue }
    // **A here-string operator is its own token.** Scanning the raw text for `<<<` counted one
    // written inside a quoted argument — `--title "docs: explain <<<here-strings"` — as a second
    // body on stdin, and the callers' "exactly one body" rule then switched off and judged nothing.
    // Emitting it here means quoting decides, because inside a quote these characters never reach
    // this branch.
    if (c === '<' && cmd.startsWith('<<<', i)) {
      flush()
      words.push(HERE_STRING_OP)
      quoted.push(false)
      i += 2
      continue
    }
    if (c === '\\' && cmd[i + 1] === '\n') { i++; continue }
    if (c === '\\' && i + 1 < cmd.length) { cur += cmd[++i]; started = true; curQuoted = true; continue }
    if (c === '\n') { flush(); words.push(NEWLINE); quoted.push(false); continue }
    if (OPERATOR.includes(c)) {
      flush()
      // A run of the same operator is one token, so `&&` and `||` stay recognisable rather than
      // arriving as two singles that both happen to be separators anyway.
      let run = c
      while (cmd[i + 1] === c) { run += c; i++ }
      words.push(run)
      quoted.push(false)
      continue
    }
    if (/\s/.test(c)) { flush(); continue }
    cur += c
    started = true
  }
  flush()
  return { words, quoted }
}

/** The words alone, for the callers that read arguments rather than structure. */
export const tokenize = (cmd) => tokenizeDetailed(cmd).words

/** `FOO=bar`, the form that let `GH_REPO=o/r gh issue create` past a matcher anchored on `gh`. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** Wrappers that keep the next word in command position. */
const PASSTHROUGH = new Set(['env', 'sudo', 'command', 'nohup', 'time', 'xargs'])

/**
 * Separators after which a new command begins, in the two kinds the shell distinguishes.
 *
 * **An operator splits wherever it appears; a reserved word only where a command may begin.** They
 * were one set, consulted at every position, so an argument that happened to spell a keyword ended
 * the invocation it sat in: `echo do gh issue create` was reported as an issue creation and blocked,
 * because `do` was read as a separator and the words after it as a new command. bash reads that `do`
 * as an argument to `echo`. Every case this cost was a false block rather than a miss, which is why
 * it survived as long as it did.
 *
 * **The control-flow keywords are here because they take a command as their condition.** `if`,
 * `elif`, `while` and `until` left `atStart` false, so `if gh issue create …; then` was invisible to
 * both gates — the mirror of `then`/`do`/`else`, which were in the set from the start.
 */
const OPERATOR_SEP = new Set([NEWLINE, ';', ';;', '&', '&&', '|', '||', '(', ')', '`'])
const RESERVED = new Set(['{', '}', 'if', 'elif', 'then', 'while', 'until', 'do', 'else', '!'])

/**
 * Does this token end the command before it?
 *
 * **Quoting takes a word out of the grammar entirely.** `"do" gh issue create` makes bash look for a
 * command named `do`, so the quoted word is neither keyword nor operator. Reading it as a separator
 * put `gh` in command position and refused a command that creates nothing.
 */
const separates = (word, isQuoted, atStart) =>
  !isQuoted && (OPERATOR_SEP.has(word) || (atStart && RESERVED.has(word)))

/**
 * The opening of a heredoc: `<<EOF`, `<<-EOF`, `<<'EOF'`, `<<"EOF"`.
 *
 * **Anchored to the end of the line.** Unanchored it fired on a `<<` written inside an argument —
 * `grep -n "<<EOF" file` — and the strip below then deleted every line up to whatever terminator a
 * later, genuine heredoc supplied, taking a real invocation with it. A real opener is the last thing
 * on its line in every shape this repo writes; one followed by a further redirection is treated as
 * no heredoc at all, which leaves its text scanned rather than skipped.
 */
// **Not preceded by a third `<`.** Unanchored on the left, this matched from the second `<` of
// `cat <<<EOF`, so a here-string was read as a heredoc opener and `withoutHeredocPayloads` deleted
// every following line up to a matching terminator — taking real commands with it. Verified against
// bash: `cat <<<EOF` newline `echo hi` runs `echo hi` as a command.
const HEREDOC_OPEN = /(?<!<)<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2\s*$/


/** Split on either line ending. A CRLF command reaching `'\n'` alone left `EOF\r` never matching its
 *  delimiter, so every payload read as unterminated and the prose regression came back. */
const lines = (cmd) => cmd.split(/\r?\n/)

/**
 * Every heredoc payload in a command, in order.
 *
 * The caller blocks when a command carries more than one, because picking is guessing. A heredoc
 * that is never terminated has no payload anyone can read and is skipped.
 */
export const heredocs = (cmd) => heredocEntries(cmd).map((e) => e.body)

/**
 * A here-string's text: `<<< word`, `<<<"text"`, `<<<'text'`.
 *
 * **It reaches `--body-file -` exactly as a heredoc does**, and was read as neither. A gate that
 * only knew heredocs answered `no body could be read from the command` for a command that has one,
 * which sends the author to add a body that is already there.
 *
 * **Read from tokens rather than from the raw text.** Matching `<<<` in the text found one inside a
 * quoted argument and invented a second body, which turned the callers' sole-body rule off; and a
 * regex arm of `"([^"]*)"` truncated a body at an escaped quote. The tokenizer already resolves both
 * questions, so it answers them here. Heredoc payloads are stripped first, for the reason
 * `ghInvocations` strips them: a payload is text, not a command.
 */
export function hereStrings(cmd) {
  const { words, quoted } = tokenizeDetailed(withoutHeredocPayloads(cmd))
  const out = []
  for (let i = 0; i < words.length; i++) {
    if (words[i] === HERE_STRING_OP && !quoted[i] && i + 1 < words.length) out.push(words[i + 1])
  }
  return out
}

/**
 * Every body this command feeds to stdin, heredocs and here-strings together.
 *
 * The callers block when there is more than one, because choosing is guessing — a rule that only
 * holds if both kinds are counted in the same list.
 */
export const stdinBodies = (cmd) => [...heredocs(cmd), ...hereStrings(cmd)]

/**
 * The argument a process substitution leaves behind.
 *
 * `(` is an operator token, so `<(…)` and `>(…)` arrive as the bare `<` or `>` that preceded them.
 * Neither is a path and neither can become one without running the command, so a caller that
 * resolves it reports a file the author never wrote — `could not read the body file at /tmp/>`.
 *
 * **Both directions, because they are one keystroke apart.** Comparing against `<` alone left `>(…)`
 * doing exactly what this export exists to stop.
 */
export const isProcessSubstitution = (arg) => arg === '<' || arg === '>'

/**
 * The redirection target on a line, or null — the last one, since a later `>` wins.
 *
 * `&` is excluded so `2>&1` is not read as a filename, and `<`/`|`/`;` cannot appear in the target.
 */
const REDIRECT = /(?:^|\s)\d?>>?\s*(?!&)("[^"]*"|'[^']*'|[^\s<>|&;]+)/g

function redirectTarget(line) {
  let target = null
  for (const m of line.matchAll(REDIRECT)) target = m[1].replace(/^['"]|['"]$/g, '')
  return target
}

/**
 * Every heredoc payload with the file its opening line redirects to, if any.
 *
 * **Which heredoc is the body is a question about the redirection, not about how many there are.**
 * Treating the command's only heredoc as the body did two wrong things at once: an unrelated one was
 * blamed on a body file whose contents were never read, and a heredoc *overwriting* an existing body
 * file was ignored in favour of the stale text on disk — so a body the command was about to replace
 * is what got judged, and the replacement reached GitHub unread.
 */
export function heredocEntries(cmd) {
  const src = lines(cmd)
  const out = []
  for (let i = 0; i < src.length; i++) {
    const m = HEREDOC_OPEN.exec(src[i])
    if (!m) continue
    const [, dash, , delim] = m
    const body = []
    let j = i + 1
    for (; j < src.length; j++) {
      const candidate = dash ? src[j].replace(/^\t+/, '') : src[j]
      if (candidate === delim) break
      body.push(src[j])
    }
    if (j >= src.length) continue
    out.push({ target: redirectTarget(src[i]), body: body.join('\n') })
    i = j
  }
  return out
}

/** The payload of a heredoc this command writes to `resolvedPath`, or null. What a command is about
 *  to write is what reaches GitHub, so it outranks whatever is on disk now. */
export function heredocWrittenTo(cmd, resolvedPath, cwd) {
  for (const { target, body } of heredocEntries(cmd)) {
    if (target !== null && path.resolve(cwd, target) === resolvedPath) return body
  }
  return null
}

/**
 * The same command with every heredoc payload removed, leaving the lines that are commands.
 *
 * **A payload is text, and it was being read as a command.** Quoting is what keeps
 * `echo "gh issue create"` from counting; a heredoc body is unquoted, so its words tokenize as bare
 * words and any line inside one could land in command position. Found by being blocked from writing
 * the plan document for this change, whose prose carried the example `&& gh issue create …`.
 *
 * The opening line stays — the invocation lives there — and so does an unterminated heredoc, whose
 * text keeps being scanned. That direction costs a false block rather than a miss.
 */
export function withoutHeredocPayloads(cmd) {
  const src = lines(cmd)
  const kept = []
  for (let i = 0; i < src.length; i++) {
    kept.push(src[i])
    const m = HEREDOC_OPEN.exec(src[i])
    if (!m) continue
    const [, dash, , delim] = m
    let j = i + 1
    for (; j < src.length; j++) {
      const candidate = dash ? src[j].replace(/^\t+/, '') : src[j]
      if (candidate === delim) break
    }
    if (j >= src.length) continue          // unterminated: nothing to strip, keep scanning it
    i = j                                  // skip the payload and its terminator
  }
  return kept.join('\n')
}

/**
 * Every `gh <noun> <verb>` in the command, as the token slice that starts at `gh`.
 *
 * Command position is tracked rather than pattern-matched, so this repo's own docs — which print
 * these commands inside prose, inside `echo`, and inside heredocs — do not trip it, while the
 * wrapped, prefixed and unspaced forms do.
 *
 * **`verbs: null` matches any third token**, which is what `gh api` needs: it takes a path where the
 * other nouns take a verb, so there is nothing to enumerate.
 */
export function ghInvocations(cmd, noun, verbs) {
  const { words, quoted } = tokenizeDetailed(withoutHeredocPayloads(cmd))
  const anyVerb = verbs === null
  const wanted = new Set(verbs ?? [])
  const found = []
  let atStart = true
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (separates(w, quoted[i], atStart)) { atStart = true; continue }
    if (!atStart) continue
    let j = i
    while (j < words.length && (ASSIGNMENT.test(words[j]) || PASSTHROUGH.has(words[j]))) j++
    if (words[j] === 'gh' && words[j + 1] === noun && (anyVerb ? words[j + 2] !== undefined : wanted.has(words[j + 2]))) {
      // **Stop at the next separator.** Running to the end of the token list meant a later command's
      // flags counted as this one's: `gh issue create --web && echo --body "Parent: #607"` was
      // allowed, because `bodyArg` found `echo`'s argument.
      // **Only an operator ends the argument list.** Everything after `gh` is an argument
      // position, where a reserved word is an ordinary word — and the shell requires a `;` or a
      // newline before a keyword anyway, so an operator is what actually arrives.
      let end = j
      while (end < words.length && !(!quoted[end] && OPERATOR_SEP.has(words[end]))) end++
      found.push(words.slice(j, end))
    }
    atStart = false
  }
  return found
}

/**
 * Read a flag's argument, in every spelling gh accepts for it.
 *
 * **Including the value attached to the shorthand**, which pflag takes and this read none of:
 * verified against the binary, `gh issue list -Lx` answers `invalid argument "x" for "-L, --limit"`.
 * The prefix rule refuses a double dash, or `--title` — which does start with `-t` — would come back
 * as `itle`.
 *
 * **The last occurrence wins, because that is what pflag does.** A scalar flag given twice overwrites,
 * so reading the first let `--body "Parent: #607" --body "a bug"` satisfy the gate with text GitHub
 * would never receive.
 */
export function flagArg(words, long, short) {
  const eq = new RegExp(`^${long}=([\\s\\S]*)$`)
  let found = null
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (w === long || (short !== undefined && w === short)) { found = words[i + 1] ?? null; continue }
    const m = eq.exec(w)
    if (m) { found = m[1]; continue }
    if (short !== undefined && !w.startsWith('--') && w.startsWith(short) && w.length > short.length) {
      found = w.slice(short.length)
    }
  }
  return found
}

/** The `--body-file` / `-F` argument, quoting resolved. `-` means stdin, which is not a path. */
export const bodyFileArg = (words) => flagArg(words, '--body-file', '-F')

/** The `--body` / `-b` argument, quoting resolved. */
export const bodyArg = (words) => flagArg(words, '--body', '-b')

/** The `--title` / `-t` argument, quoting resolved. */
export const titleArg = (words) => flagArg(words, '--title', '-t')

/**
 * `gh api` is a different shape from `gh <noun> <verb>`: what it acts on is a path in argument
 * position, so a caller has to read the endpoint and the method rather than a verb. Two gates need
 * that now — the comment card and the merge guard — which is why it lives here rather than in
 * whichever one grew it first.
 */
/** `gh api` flags that consume the next token, so it is not the endpoint. */
const API_VALUE_FLAGS = new Set([
  '--method', '-X', '--field', '-f', '--raw-field', '-F', '--input', '--header', '-H',
  '--jq', '-q', '--template', '-t', '--hostname', '--preview', '-p', '--cache',
])

/**
 * The positional endpoint of a `gh api` call — the first word that is neither a flag nor a flag's
 * value.
 *
 * **Scanning every token for a comments-shaped path picked field values.** A quoted field stays one
 * token, so `gh api repos/o/r/issues -f 'body=See /comments/123'` looked like a call to a comments
 * endpoint and was blocked; it creates an issue. The endpoint is a position, so it is read as one.
 */
export function apiEndpoint(words) {
  for (let i = 2; i < words.length; i++) {
    const w = words[i]
    if (API_VALUE_FLAGS.has(w)) { i++; continue }
    if (w.startsWith('-')) continue
    return w
  }
  return null
}

/**
 * The value of a `gh api` flag.
 *
 * **This is `flagArg`, and it used to be a second, weaker copy.** The copy compared tokens for
 * equality and for a `--flag=` prefix, and so missed the two rules `flagArg` had already been
 * corrected on, each against the binary: pflag takes the value attached to a shorthand
 * (`gh api -Xput …` is a PUT), and a flag given twice takes the **last** occurrence. Both were live
 * bypasses of gates built on it — `-Xput repos/o/r/pulls/1/merge` inferred `GET` and passed.
 */
export const apiFlag = (words, long, short) => flagArg(words, long, short)

/**
 * Every value given for a field flag, with the flag that carried it, in all four spellings gh
 * accepts: `-f k=v`, `-fk=v`, `--field k=v`, `--field=k=v`.
 *
 * Two gates read fields — the comment card looks for a `query` or a `body`, the merge guard only
 * asks whether any field is present — and both were reading three of the four spellings.
 */
export function flagEntries(words, flags) {
  const out = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (flags.includes(w)) { out.push({ flag: w, value: words[i + 1] ?? '' }); continue }
    for (const f of flags) {
      if (w.startsWith(`${f}=`)) { out.push({ flag: f, value: w.slice(f.length + 1) }); break }
      if (!f.startsWith('--') && !w.startsWith('--') && w.startsWith(f) && w.length > f.length) {
        out.push({ flag: f, value: w.slice(f.length) }); break
      }
    }
  }
  return out
}

/** `gh api` field flags. `-F`/`--field` expand a leading `@` to a file; `-f`/`--raw-field` do not. */
export const API_FIELD_FLAGS = ['-f', '-F', '--field', '--raw-field']
const READS_FILE = new Set(['-F', '--field'])

/**
 * Is this endpoint GitHub's GraphQL one?
 *
 * Matched as a path segment rather than by equality: gh sends any endpoint containing `://`
 * verbatim, so a full URL reaches the same place and is the spelling a docs page hands you.
 */
export const isGraphqlEndpoint = (endpoint) => !!endpoint && /(^|\/)graphql(\?|$)/.test(endpoint)

/**
 * Every GraphQL document a `gh api graphql` call would send, following the file and stdin forms.
 *
 * **Two gates ask the same question of it** — the comment card asks whether it publishes prose, the
 * merge guard whether it merges or approves — so the reading lives here and each gate brings its own
 * list of operation names. A document it cannot read is omitted rather than blocking: both gates
 * allow what they cannot judge.
 */
export function graphqlDocuments(words, cmd, cwd, readFile = readBodyFile) {
  const out = []
  const fromStdin = () => {
    const bodies = stdinBodies(cmd)
    return bodies.length === 1 ? bodies[0] : null
  }
  const readAt = (ref) => {
    try { return readFile(path.resolve(cwd, ref)) } catch { return null }
  }
  for (const { flag, value } of flagEntries(words, API_FIELD_FLAGS)) {
    if (!value.startsWith('query=')) continue
    const text = value.slice('query='.length)
    if (!text.startsWith('@') || !READS_FILE.has(flag)) { out.push(text); continue }
    const ref = text.slice(1)
    out.push(ref === '-' ? fromStdin() : readAt(ref))
  }
  // `--input` carries the whole request body, query included, and needs no field flag at all.
  const input = flagArg(words, '--input')
  if (input === '-') out.push(fromStdin())
  else if (input) out.push(readAt(input))
  return out.filter((t) => typeof t === 'string')
}

/**
 * Does any of these documents invoke one of `names`?
 *
 * `\b<name>\s*[({]` rather than a bare substring: a mutation is a field call, so the name is
 * followed by its arguments or its selection set. That form survives an alias (`x: addComment(…)`),
 * a variable-based document, and a newline before the paren — all verified.
 */
export const invokesOperation = (docs, names) =>
  docs.some((d) => names.some((n) => new RegExp(`\\b${n}\\s*[({]`).test(d)))

/**
 * The reader both gates use for a `--body-file`.
 *
 * **It stats before it reads**, because `readFileSync` on a FIFO with no writer blocks until the
 * hook times out — a gate that hangs is worse than one that blocks, and the language gate reaching
 * body files put that on the `gh pr create` path for the first time. `statSync` does not open, so it
 * answers immediately. A directory keeps its own errno so the message can name it.
 */
export function readBodyFile(p) {
  const st = fs.statSync(p)
  if (!st.isFile()) {
    const err = new Error(`not a regular file: ${p}`)
    err.code = st.isDirectory() ? 'EISDIR' : 'ENOTFILE'
    throw err
  }
  return fs.readFileSync(p, 'utf8')
}
