import { banner } from '../lib/print.js'
import { migrateDataDir } from '../lib/migrate-data-dir.js'
import { installNetFilter, NET_FILTER_APP } from '../lib/net-filter.js'

// `tapflow migrate data-dir` — one-shot move of a legacy .tapflow-data/ into the unified .tapflow/data/.
export function cmdMigrateDataDir(): void {
  const result = migrateDataDir(process.cwd())
  switch (result.status) {
    case 'migrated': {
      const lines = ['Moved .tapflow-data/ → .tapflow/data/.']
      if (result.configUpdated) lines.push('Repointed local.dataDir in tapflow.config.json.')
      if (result.gitignoreUpdated) lines.push('Added the runtime paths to .gitignore.')
      lines.push('Start tapflow as usual: tapflow start')
      banner('success', 'DATA DIRECTORY MIGRATED', lines)
      return
    }
    case 'noop-already':
      banner('success', 'ALREADY MIGRATED', ['.tapflow/data/ is in place and no legacy .tapflow-data/ remains.'])
      return
    case 'noop-no-legacy':
      banner('success', 'NOTHING TO MIGRATE', ['No legacy .tapflow-data/ found in this directory.'])
      return
    case 'conflict':
      banner('error', 'MIGRATION BLOCKED', [
        'Both .tapflow-data/ (legacy) and .tapflow/data/ exist.',
        'Reconcile by hand — keep the directory with your real data, remove the other, then re-run.',
      ])
      process.exit(1)
      break
    case 'exdev':
      banner('error', 'CROSS-FILESYSTEM MOVE', [
        '.tapflow-data/ and .tapflow/data/ are on different filesystems, so an atomic move is not possible.',
        'Move it by hand: mv .tapflow-data .tapflow/data',
        'Then set local.dataDir to .tapflow/data in tapflow.config.json if it was pinned to the old path.',
      ])
      process.exit(1)
      break
  }
}

/**
 * `tapflow migrate net-filter` — put the iOS network filter on a Mac that was set up before it existed.
 *
 * **`setup` cannot cover this and that is the whole reason this exists.** Setup is a first-run
 * command; someone who ran it a year ago and then upgraded never runs it again, so the filter would
 * arrive in their `node_modules` and never reach their Mac. `migrate data-dir` was written for the
 * same shape of problem.
 *
 * The install itself is `installNetFilter`, shared with setup — one routine, because two would
 * eventually answer the same question differently.
 */
export function cmdMigrateNetFilter(opts: { ignoreRunningDevices?: boolean } = {}): void {
  const outcome = installNetFilter(opts)
  switch (outcome.status) {
    case 'installed':
      banner('success', 'NETWORK FILTER INSTALLED', [
        `Installed to ${NET_FILTER_APP} and activated.`,
        'iOS network control is available now: tapflow doctor ios',
      ])
      return
    case 'installed-unconfirmed':
      // **Not a failure, and not a success either.** The app is in place and the extension is
      // activated; what could not be confirmed is that a provider came back up and started
      // enforcing. Saying "available now" here would be the claim this whole check exists to stop
      // making.
      banner('error', 'INSTALLED, BUT NOTHING IS FILTERING YET', [
        `Installed to ${NET_FILTER_APP}, and macOS accepted it — but no filter reported itself`,
        'as running within 30 seconds, so iOS network control may not work yet.',
        '',
        'Your network is unaffected either way: a filter that is not running blocks nothing.',
        '',
        'Check whether it caught up on its own, and what to do if not:',
        '  tapflow doctor ios',
      ])
      process.exit(1)
      break
    case 'already-current':
      banner('success', 'ALREADY UP TO DATE', ['The Mac is already running the filter this tapflow carries.'])
      return
    case 'needs-approval':
      banner('success', 'APPROVAL NEEDED', [
        `Installed to ${NET_FILTER_APP}, and macOS is waiting for you to allow it.`,
        'System Settings → General → Login Items & Extensions → Network Extensions, and switch tapflow on.',
        'Then check it took: tapflow doctor ios',
        ...(outcome.filterLeftDisabled ? [
          'The filter is switched off until you do — your network is unaffected, and iOS network'
          + ' control stays unavailable.',
        ] : []),
      ])

      return
    case 'needs-reboot':
      banner('success', 'RESTART TO FINISH', [
        'Installed. macOS replaces a running filter only on restart, so the previous version keeps running until then.',
        'Restart the Mac, then: tapflow doctor ios',
      ])
      return
    case 'not-macos':
      banner('success', 'NOTHING TO MIGRATE', ['The iOS network filter is macOS only.'])
      return
    case 'no-artifact':
      banner('error', 'NO FILTER TO INSTALL', [
        'This tapflow install carries no usable filter app, so there is nothing to migrate.',
        'Reinstalling tapflow restores it.',
      ])
      process.exit(1)
      break
    case 'refused-devices-busy':
      // Not an error the way a failed install is: nothing is broken, the moment is wrong. Naming what
      // is running is the point — the person at the keyboard may not be the person testing.
      banner('error', 'DEVICES ARE IN USE', [
        'Replacing the network filter interrupts every new connection on this Mac while it happens,',
        'so it is not done while something is running:',
        ...outcome.busy.map((b) => `  · ${b}`),
        '',
        'Stop them and run this again, or replace it anyway:',
        '  tapflow migrate net-filter --ignore-running-devices',
      ])
      process.exit(1)
      break
    case 'refused-host-unknown':
      // The command whose whole purpose is this repair, so it has to explain why it will not do it.
      banner('error', 'CANNOT TELL WHAT THIS MAC IS RUNNING', [
        `Extension ${outcome.activated} is enforcing, but ${NET_FILTER_APP} is gone.`,
        'The extension version says which filter is running, not which app it came from, so tapflow',
        'cannot tell whether this Mac was set up by a newer tapflow than this one. Installing over it',
        'would replace a working filter somebody else depends on.',
        '',
        'Either reinstall from the tapflow whose version matches, or clear the extension and start over:',
        '  systemextensionsctl uninstall 6FBS3QP893 dev.tapflow.netfilter.ext',
      ])
      process.exit(1)
      break
    case 'refused-downgrade':
      banner('error', 'MIGRATION REFUSED', [
        `This Mac runs filter ${outcome.installed} and this tapflow carries ${outcome.shipped}.`,
        'Installing would replace a newer filter another tapflow on this Mac depends on.',
        'Upgrade this checkout instead.',
      ])
      process.exit(1)
      break
    case 'failed':
      banner('error', 'MIGRATION FAILED', [
        `The filter could not be installed (exit ${outcome.code}).`,
        outcome.detail,
        'packages/ios-agent/ios-netfilter/README.md has what each exit code means.',
        // **The state matters more than the failure.** A filter left off is a working Mac with no iOS
        // network control, and it stays that way silently — `doctor ios` reports versions, and every
        // version here is correct.
        ...(outcome.filterLeftDisabled ? [
          '',
          'The filter is switched OFF. Your network works; iOS network control does not.',
          'Run this again to turn it back on.',
        ] : []),
      ])
      process.exit(1)
      break
    default: {
      // **The compiler cannot see a missing case here, and that is why this line exists.** `setup`'s
      // switch returns a value, so an unhandled member is a type error there; this one returns void,
      // and `refused-host-unknown` fell straight through it — printing nothing and exiting 0 in the
      // one state the outcome was invented for.
      const unhandled: never = outcome
      throw new Error(`unhandled install outcome: ${JSON.stringify(unhandled)}`)
    }
  }
}
