// The shell reader three gates share, tested on its own.
//
// **It had no test file of its own until now.** What existed lived inside `issueParentGate.test.mjs`,
// which is one of its three callers, so a parser change was judged by one gate's fixtures while the
// other two rode along. The cases here are about the reader rather than any gate's verdict.
import { describe, it, expect } from 'vitest'
import {
  ghInvocations, tokenize, tokenizeDetailed, hereStrings, stdinBodies, heredocs,
  bodyFileArg, isProcessSubstitution, apiFlag, flagEntries,
} from '../lib/gh-command.mjs'

const creates = (cmd) => ghInvocations(cmd, 'issue', ['create']).length
const merges = (cmd) => ghInvocations(cmd, 'pr', ['merge']).length

describe('a reserved word is only reserved in command position', () => {
  // bash reads `do`, `then`, `else`, `if`, `while`, `until` and `!` as keywords only where a command
  // may begin. `echo do x` passes `do` to echo as an argument. The parser used to consult one flat
  // separator set at every position, so an argument that happened to spell a keyword ended the
  // invocation it sat in and the words after it were read as a new command.
  const ARGUMENT_KEYWORDS = ['do', 'then', 'else', 'if', 'while', 'until', '!', '{', '}']

  for (const kw of ARGUMENT_KEYWORDS) {
    it(`\`${kw}\` as an argument does not start a new command`, () => {
      expect(creates(`echo ${kw} gh issue create -t x`), kw).toBe(0)
    })
  }

  it('the same word in command position still separates', () => {
    // The mirror case, and the reason the set exists: these take a command as their condition.
    expect(creates('if gh issue create -t x; then echo ok; fi')).toBe(1)
    expect(creates('while gh issue create -t x; do echo ok; done')).toBe(1)
    expect(creates('cmd; then gh issue create -t x')).toBe(1)
  })

  it('operators separate wherever they appear', () => {
    // `;`, `&&`, `|` and the parens are operators rather than keywords: the shell splits on them in
    // any position, so nothing here depends on where they sit.
    expect(creates('true && gh issue create -t x')).toBe(1)
    expect(creates('cd /tmp;gh issue create -t x')).toBe(1)
    expect(creates('echo x|gh issue create -t x')).toBe(1)
    expect(creates('(gh issue create -t x)')).toBe(1)
  })

  it('a backtick opens a command the same way `$(` does', () => {
    // **The two spellings of command substitution disagreed.** The dollar-paren form reached command
    // position because `(` is an operator; the backtick form did not, because the backtick stayed
    // glued to `gh` as one word. bash runs both — verified with a script file: `echo` of a
    // backticked `printf RAN` prints `RAN`.
    const SUB = 'gh issue create -t x'
    expect(creates(`echo \`${SUB}\``), 'backtick').toBe(1)
    expect(creates(`echo $(${SUB})`), 'dollar-paren').toBe(1)
    expect(creates(`URL=\`${SUB}\``), 'assigned from a substitution').toBe(1)
  })

  it('a backtick inside single quotes is literal, as it is to the shell', () => {
    // The reason this can be added without the false blocks the shell matcher avoids backticks for:
    // quoting is already resolved here. bash prints the backticked text verbatim from single quotes
    // and runs nothing.
    expect(creates(`echo 'see \`gh issue create\` in the docs'`)).toBe(0)
  })

  it('a quoted keyword is not a keyword even in command position', () => {
    // `"do" gh …` makes bash look for a command named `do`; the quotes take the word out of the
    // grammar. Treating it as a separator put `gh` in command position, which is a false block.
    expect(creates('echo "do" gh issue create -t x')).toBe(0)
    expect(merges("echo 'then' gh pr merge 1")).toBe(0)
    expect(creates('echo \\do gh issue create -t x')).toBe(0)
  })
})

describe('tokenizeDetailed reports how a word arrived', () => {
  it('marks quoted and escaped words', () => {
    expect(tokenizeDetailed('echo "do" bare').quoted).toEqual([false, true, false])
    expect(tokenizeDetailed("echo 'do'").quoted).toEqual([false, true])
    expect(tokenizeDetailed('echo \\do').quoted).toEqual([false, true])
  })

  it('operators and newlines are never quoted', () => {
    const { words, quoted } = tokenizeDetailed('a && b\nc')
    expect(quoted).toEqual(words.map(() => false))
  })

  it('tokenize stays the word list it was', () => {
    // Every existing caller destructures a flat array; the detail is additive rather than a new
    // shape imposed on all of them.
    expect(tokenize('gh issue create -t "a b"')).toEqual(['gh', 'issue', 'create', '-t', 'a b'])
  })
})

describe('a here-string is a body', () => {
  it('is read like the heredoc it stands in for', () => {
    expect(hereStrings('gh issue create -t x --body-file - <<< "Parent: #1"')).toEqual(['Parent: #1'])
    expect(hereStrings("cmd <<<'one two'")).toEqual(['one two'])
    expect(hereStrings('cmd <<<bare')).toEqual(['bare'])
  })

  it('is not confused with a heredoc opener, in either direction', () => {
    // `<<EOF` and `<<<text` differ by one character, and **both directions have to be asserted.**
    // The first version of this test checked only that a heredoc is not read as a here-string, while
    // the reverse was the broken one: `HEREDOC_OPEN` was unanchored on the left, so it matched from
    // the second `<` of `cat <<<EOF` and `withoutHeredocPayloads` then deleted every following line
    // up to a matching terminator — swallowing real commands. Bash runs them:
    //   $ bash -c 'cat <<<EOF
    //   echo SHOULD-RUN
    //   EOF'    →  EOF / SHOULD-RUN / bash: EOF: command not found
    expect(hereStrings('cmd <<EOF\nbody\nEOF')).toEqual([])
    expect(stdinBodies('cmd <<EOF\nbody\nEOF')).toEqual(['body'])
    expect(heredocs('cmd <<<EOF\necho hi\nEOF')).toEqual([])
    expect(ghInvocations('cat <<<EOF\ngh issue create -t x\nEOF', 'issue', ['create'])).toHaveLength(1)
  })

  it('a <<< inside a quoted argument is text, not a second body', () => {
    // **Scanning the raw command text counted this one**, so a title that merely mentions
    // here-strings made `stdinBodies` return two — and every caller's "exactly one body" rule then
    // switched off and judged nothing. That direction is a miss, not a false block: the Korean body
    // below reached GitHub unjudged. Bash sees one stdin body here.
    const cmd = 'gh pr create --title "docs: explain <<<here-strings" --body-file - <<EOF\nbody text\nEOF'
    expect(stdinBodies(cmd)).toEqual(['body text'])
    expect(hereStrings(cmd)).toEqual([])
  })

  it('reads a body through the quoting the shell would resolve', () => {
    // Matching raw text with `"([^"]*)"` stopped at an escaped quote and handed the caller a
    // fragment of the body that actually reaches GitHub. Tokens resolve it.
    expect(hereStrings('cmd <<<"a\\"b"')).toEqual(['a"b'])
    expect(hereStrings('cmd <<<"one two"')).toEqual(['one two'])
  })

  it('stdinBodies carries both, so an ambiguous command stays ambiguous', () => {
    // The callers block when a command offers more than one body, because picking one is guessing.
    // That rule only holds if both kinds are counted together.
    expect(stdinBodies('cmd <<EOF\na\nEOF\nother <<< "b"')).toEqual(['a', 'b'])
  })
})

describe('a process substitution is a shape, not a path', () => {
  it('is recognisable from the argument the parser produces', () => {
    // `<(…)` cannot be read without running it, so the honest answer names the shape. Reporting it
    // as a file that could not be opened invents a path — the parser's `<` — and sends the author
    // looking for it.
    expect(bodyFileArg(tokenize('gh issue create -t x --body-file <(echo hi)'))).toBe('<')
    expect(bodyFileArg(tokenize('gh issue create -t x -F<(echo hi)'))).toBe('<')
  })

  it('recognises both directions, which are one keystroke apart', () => {
    // Comparing against `<` alone left `>(…)` doing exactly what this check exists to stop:
    // `could not read the body file at /tmp/>`.
    expect(isProcessSubstitution(bodyFileArg(tokenize('gh issue create -t x --body-file <(cat)')))).toBe(true)
    expect(isProcessSubstitution(bodyFileArg(tokenize('gh issue create -t x --body-file >(cat)')))).toBe(true)
  })

  it('an ordinary path is unaffected', () => {
    expect(bodyFileArg(tokenize('gh issue create -t x --body-file body.md'))).toBe('body.md')
    expect(bodyFileArg(tokenize('gh issue create -t x --body-file -'))).toBe('-')
    expect(isProcessSubstitution('body.md')).toBe(false)
    expect(isProcessSubstitution('-')).toBe(false)
  })
})

describe('a flag argument is read in every spelling pflag accepts', () => {
  // **Two rules that a second, weaker copy of this reader was missing**, each a live bypass of a
  // gate built on it. `gh api -Xput …/pulls/1/merge` inferred GET and passed; a method given twice
  // was read as the first, so `--method GET --method PUT` passed while bash sends PUT.
  it('takes the value attached to a shorthand', () => {
    expect(apiFlag(tokenize('gh api -Xput x'), '--method', '-X')).toBe('put')
    expect(apiFlag(tokenize('gh api -XPUT x'), '--method', '-X')).toBe('PUT')
  })

  it('takes the last occurrence, because that is what pflag does', () => {
    expect(apiFlag(tokenize('gh api --method GET --method PUT x'), '--method', '-X')).toBe('PUT')
  })

  it('works for a flag with no shorthand', () => {
    expect(apiFlag(tokenize('gh api x --input b.json'), '--input')).toBe('b.json')
  })

  it('reads a field in all four spellings', () => {
    const F = ['-f', '-F', '--field', '--raw-field']
    for (const cmd of ['gh api x -f body=hi', 'gh api x -fbody=hi', 'gh api x --field body=hi', 'gh api x --field=body=hi']) {
      expect(flagEntries(tokenize(cmd), F).map((e) => e.value), cmd).toEqual(['body=hi'])
    }
  })

  it('does not read a long flag as an attached shorthand', () => {
    // `--field=x` starts with `-f`; the `--` guard is what keeps it from being read as one.
    expect(flagEntries(tokenize('gh api x --field=body=hi'), ['-f', '--field']).map((e) => e.flag)).toEqual(['--field'])
  })
})
