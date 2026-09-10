import {
  ghInvocations, apiEndpoint, apiFlag, flagEntries, isGraphqlEndpoint,
  graphqlDocuments, invokesOperation, API_FIELD_FLAGS, readBodyFile,
} from './gh-command.mjs'

/**
 * Merging and approving, on every road that reaches them.
 *
 * **The `gh pr` forms are judged here rather than by the hook's grep, and that was a correction.**
 * The first draft left them to the shell matcher on the grounds that a noun and a verb are
 * identifiable from the words — true, but the matcher recognises command position as line-start,
 * `;`, `&&`, `|`, `$(`, `then` or `do`, and nothing else. Measured against the shipped hook, all of
 * these passed at exit 0 while the bare form was blocked: an assignment prefix (`GH_REPO=o/r …`),
 * `env`, `sudo`, `command`, `xargs`, `if …; then`, and a background `&`. The parser in this same
 * package already had every one of them — `ASSIGNMENT`, `PASSTHROUGH` and the reserved words — so
 * the shell half was the weaker copy of a question already answered. It stays as a prefilter and as
 * a backstop for when node cannot run.
 *
 * **`gh api` needs parsing rather than matching**, which is the other half of why this file exists:
 * the same path is a read or a write depending on the method, so `GET /pulls/1/merge` asks whether a
 * PR was merged and merges nothing.
 *
 * The threat model is unchanged — these gates guard a cooperative-but-forgetful agent, and an agent
 * that means to bypass one always can. What they must not do is miss the spelling a forgetful agent
 * would actually type.
 */

/** `PUT /repos/{owner}/{repo}/pulls/{n}/merge` — the REST form. */
const MERGE_PATH = /\/pulls\/[^/]+\/merge(\/|$|\?)/
/** `POST /repos/{owner}/{repo}/pulls/{n}/reviews` — the REST form, including `…/reviews/{id}/events`. */
const REVIEW_PATH = /\/pulls\/[^/]+\/reviews(\/|$|\?)/

/**
 * The GraphQL mutations that merge or approve.
 *
 * **Covered here rather than deferred, because the team gate was the one without them.** The first
 * draft left GraphQL out to avoid maintaining a mutation list in two places — but the comment card's
 * list and this one are different sets for different questions, so there was no shared list to
 * duplicate. What there was, measured: `mergePullRequest` and `addPullRequestReview(event: APPROVE)`
 * were refused by nothing in `.claude/settings.json`. The only objection came from the comment-card
 * gate, which is personal (gitignored `settings.local.json`), is absent for anyone else, and objects
 * for a reason that stops applying the moment its card is read.
 *
 * `addPullRequestReview` is both a merge-guard concern and a comment-card concern, for different
 * reasons — approving is the user's, and a review body publishes prose. Two gates may care about one
 * mutation.
 */
const MERGE_MUTATIONS = ['mergePullRequest', 'enablePullRequestAutoMerge']
const REVIEW_MUTATIONS = ['addPullRequestReview', 'submitPullRequestReview']

/** Flags whose presence makes gh send POST when no method is given. */
const IMPLIES_POST = [...API_FIELD_FLAGS, '--input']

/**
 * @returns {{ blocked: boolean, reason?: 'merge' | 'review' }}
 *
 * **A read of the same path is allowed**, the way `--method GET` is on every other `gh api` rule
 * here. `GET /pulls/1/merge` is how you ask whether a PR is merged, and `GET …/reviews` lists them;
 * blocking those would refuse the two calls most likely to precede a legitimate question about a PR.
 * With no method given, gh sends GET unless a field is present, so that is what decides.
 */
export function judge(cmd, cwd = process.cwd(), readFile = readBodyFile) {
  if (ghInvocations(cmd, 'pr', ['merge']).length > 0) return { blocked: true, reason: 'merge' }
  if (ghInvocations(cmd, 'pr', ['review']).length > 0) return { blocked: true, reason: 'review' }

  for (const words of ghInvocations(cmd, 'api', null)) {
    const endpoint = apiEndpoint(words)
    if (!endpoint) continue

    if (isGraphqlEndpoint(endpoint)) {
      const docs = graphqlDocuments(words, cmd, cwd, readFile)
      if (invokesOperation(docs, MERGE_MUTATIONS)) return { blocked: true, reason: 'merge' }
      if (invokesOperation(docs, REVIEW_MUTATIONS)) return { blocked: true, reason: 'review' }
      continue
    }

    const explicit = (apiFlag(words, '--method', '-X') ?? '').toUpperCase()
    const method = explicit || (flagEntries(words, IMPLIES_POST).length > 0 ? 'POST' : 'GET')
    if (method === 'GET' || method === 'HEAD') continue
    if (MERGE_PATH.test(endpoint)) return { blocked: true, reason: 'merge' }
    // Every write to `…/reviews` is refused, not only `event=APPROVE`: a review left pending is
    // still one submitted under the user's name.
    if (REVIEW_PATH.test(endpoint)) return { blocked: true, reason: 'review' }
  }
  return { blocked: false }
}
