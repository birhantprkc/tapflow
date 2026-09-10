// The opt-out marker switches the changeset gate off, so a body that merely *mentions* it must
// not count. The first version used a `sed` one-liner and fired on any body quoting the syntax —
// including the PR that introduced the rule, and any PR explaining it to a contributor.
import { describe, it, expect } from 'vitest'
import { extractReason } from '../check-changeset.mjs'

describe('extractReason — accepts a genuine opt-out', () => {
  it('reads a marker on its own line', () => {
    expect(extractReason('Fixes a typo.\n\n<!-- no-changeset: comment-only -->\n')).toBe('comment-only')
  })

  it('tolerates surrounding whitespace and CRLF line endings', () => {
    expect(extractReason('a\r\n   <!--  no-changeset:   renamed a local  -->   \r\nb'))
      .toBe('renamed a local')
  })

  it('takes the first marker when there are several', () => {
    expect(extractReason('<!-- no-changeset: first -->\n<!-- no-changeset: second -->')).toBe('first')
  })
})

describe('extractReason — refuses anything that is not one', () => {
  const NOT_AN_OPT_OUT = {
    'no marker at all': 'Just a normal PR body.',
    'inside a fenced block': 'Skip it like this:\n\n```\n<!-- no-changeset: reason -->\n```\n',
    'inside a tilde fence': 'Skip it:\n\n~~~\n<!-- no-changeset: reason -->\n~~~\n',
    'inside an indented block': 'Skip it:\n\n    <!-- no-changeset: reason -->\n',
    'quoted mid-sentence': 'Put `<!-- no-changeset: reason -->` in the body to skip.',
    'trailing prose on the line': '<!-- no-changeset: reason --> and here is why I did it',
    'empty reason': '<!-- no-changeset:  -->',
    'no reason given': '<!-- no-changeset: -->',
    'a different marker': '<!-- no-release: reason -->',
  }

  for (const [name, body] of Object.entries(NOT_AN_OPT_OUT)) {
    it(`ignores: ${name}`, () => {
      expect(extractReason(body)).toBe('')
    })
  }

  // The exact shape this repo's own docs use. If this ever returns a reason, then documenting
  // the escape hatch disables the gate for whoever documents it.
  it('ignores the snippet as CONTRIBUTING.md and AGENTS.md print it', () => {
    const body = [
      'Skip it only by stating why in the PR body:',
      '',
      '```',
      '<!-- no-changeset: comment-only follow-up to #123 -->',
      '```',
      '',
      'That is the whole rule.',
    ].join('\n')
    expect(extractReason(body)).toBe('')
  })

  it.each([
    ['a shorter fence nested inside a longer one', '````md\n```md\n<!-- no-changeset: reason -->\n```\n````\n<!-- no-changeset: real -->\n'],
    ['a closing fence with an info string', '```md\n``` not-a-close\n<!-- no-changeset: reason -->\n```\n<!-- no-changeset: real -->\n'],
  ])('ignores a marker inside %s and resumes after it', (_name, body) => {
    expect(extractReason(body)).toBe('real')
  })

  it('does not open a backtick fence when its info string contains a backtick', () => {
    const body = '```js`\n```\n<!-- no-changeset: reason -->\n```\n'
    expect(extractReason(body)).toBe('')
  })

  it('opens a tilde fence even when its info string contains a backtick', () => {
    // The other half of the clause above: CommonMark forbids a backtick in a backtick fence's
    // info string and permits one in a tilde fence's. Refusing to open here would leave the
    // marker below unquoted, which is #560's leak arriving from the other side.
    const body = '~~~js`\n<!-- no-changeset: reason -->\n~~~\n'
    expect(extractReason(body)).toBe('')
  })
})

describe('extractReason — follows CommonMark indentation', () => {
  it('reads an unindented marker between four-space-indented fence-like lines', () => {
    const body = '    ```md\n<!-- no-changeset: reason -->\n    ```\n'
    expect(extractReason(body)).toBe('reason')
  })
})
