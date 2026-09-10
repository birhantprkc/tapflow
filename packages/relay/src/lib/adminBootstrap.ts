import { isInitialized, createAdminAccount } from './adminAccount.js'

/**
 * Create the first Admin from the environment, once, at boot.
 *
 * **Why this exists at all.** `POST /api/v1/auth/init` requires `resolveClient(req).isLocal`, which
 * stops a public instance being claimed by a stranger between first boot and the owner setting a
 * password. A container is always behind its bridge gateway, so that check can never pass there —
 * measured against the published image: the call answers 403 from the host's own browser and from
 * the LAN alike. The error text points at `tapflow admin init`, but the image is relay-only by
 * design (`pnpm deploy --filter @tapflowio/relay`) and carries no CLI. A Docker install therefore
 * had no way to make its first account at all.
 *
 * This path does not go through HTTP, so the `isLocal` gate is not weakened — it is simply not on
 * this road. Whoever can set the container's environment already controls the install.
 *
 * **Idempotent and silent when there is nothing to do.** It runs on every boot, and an install that
 * already has an owner must not accumulate a log line per restart, nor have its account touched.
 */
export interface BootstrapLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export interface BootstrapEnv {
  TAPFLOW_ADMIN_EMAIL?: string
  TAPFLOW_ADMIN_PASSWORD?: string
}

/** Thrown when the environment asks for a first account and cannot get one. Fatal at boot. */
export class AdminBootstrapError extends Error {}

/**
 * **Misconfiguration refuses to boot, and the first draft had this backwards.**
 *
 * That draft warned and carried on, reasoning that these variables are first-run-only and a typo in
 * them must not keep a running relay down. Review pointed out that the reasoning describes a state
 * this function cannot reach: `isInitialized()` returns above every one of these branches, so an
 * install that already has an owner never gets here whatever its environment says. The only state
 * that does reach them is *the operator asked for a first account, there is none, and the settings
 * are wrong* — and serving anyway leaves the install ownerless and claimable by anything that can
 * reach loopback, indefinitely, behind one line of boot spam.
 *
 * Refusing costs nothing, which is what makes the trade one-sided: an ownerless relay cannot be
 * logged into by anyone legitimate either, so there is no working service to lose, and a container
 * that will not stay up is far louder than a warning.
 *
 * Neither the password nor its length is ever written to the log.
 */
export function bootstrapAdminFromEnv(env: BootstrapEnv, logger: BootstrapLogger): void {
  const email = env.TAPFLOW_ADMIN_EMAIL?.trim()
  const password = env.TAPFLOW_ADMIN_PASSWORD

  // Neither set is the ordinary case — every install that is not a fresh container.
  if (!email && !password) return

  if (isInitialized()) return

  const fail = (message: string): never => {
    logger.error(message)
    throw new AdminBootstrapError(message)
  }

  if (!email || !password) {
    const missing = email ? 'TAPFLOW_ADMIN_PASSWORD' : 'TAPFLOW_ADMIN_EMAIL'
    // `return` so the compiler narrows both to `string` below — `fail` returning `never` is not
    // enough on its own when it is called as a statement.
    return fail(
      `${missing} is not set, so the first admin account could not be created. ` +
      'Set both TAPFLOW_ADMIN_EMAIL and TAPFLOW_ADMIN_PASSWORD, or neither.'
    )
  }

  let result
  try {
    result = createAdminAccount(email, password)
  } catch (err) {
    // **A second container on the same volume is a race, not a misconfiguration.** `users.email` is
    // `UNIQUE`, so two replicas booting together have one of them lose the INSERT. The install ends
    // up with an owner either way, which is the outcome that was asked for — carry on rather than
    // crash-looping whichever replica arrived second.
    if (isInitialized()) {
      logger.warn('Another process created the first admin account while this one was starting.')
      return
    }
    throw err
  }

  switch (result) {
    case 'password-too-short':
      return fail(
        'TAPFLOW_ADMIN_PASSWORD is shorter than 8 characters, so the first admin account could not ' +
        'be created. Set a longer one.'
      )
    case 'missing-fields':
      // Unreachable: both are non-empty by the checks above. Handled so a later change to
      // `createAdminAccount` cannot silently fall through to "created".
      return fail('The first admin account could not be created: the configured email or password was empty.')
    case 'ok':
      logger.info(`Created the first admin account for ${email} from the environment.`)
  }
}
