import { useCallback, useState } from 'react'
import type { SessionInfo } from '@/lib/types'

export function useDeviceSelector(
  selectedSession: SessionInfo | undefined,
  os: string,
) {
  const [osVersion, setOsVersion] = useState('')
  const [deviceSearch, setDeviceSearch] = useState('')
  const [resetMode, setResetMode] = useState<'app-only' | 'full-erase'>('app-only')
  // What the device currently on screen was actually booted with. Held apart from `resetMode`
  // because picking a device disarms the toggle immediately, and the viewer still has to know
  // which mode it was launched under.
  const [appliedResetMode, setAppliedResetMode] = useState<'app-only' | 'full-erase'>('app-only')

  /** Whether the agent holding this device honours `resetMode: 'full-erase'`.
   *
   *  This was `os !== 'android'`, which says "Android cannot" when what it means is "this agent did
   *  not say it can" — and the two differ in both directions (#447). An iOS agent too old to
   *  implement Full reset still reports `platform: 'ios'`, so the platform check offered a control
   *  that agent has no code for; and `AndroidAgent` implements `-wipe-data` now, which the platform
   *  check would still be hiding. That second half landed without touching this file, which is the
   *  argument for gating this way rather than a prediction about it.
   *
   *  No session picked yet means nothing known yet, so the control stays hidden. */
  const fullResetSupported = selectedSession?.capabilities.includes('full-reset') ?? false

  /** Full reset is a one-shot intent — "erase the next device I pick" — not a setting that stays
   *  on. Leaving a session is a conditional re-render, not an unmount, so without this the toggle
   *  survives back-to-the-list and silently erases the *next* device too (#439). */
  const consumeResetMode = useCallback(() => {
    // Applying a mode the agent does not honour would disarm the toggle having erased nothing,
    // which reads as "done"; the UI hides the switch for the same reason, and this keeps the two
    // from drifting apart.
    setAppliedResetMode(fullResetSupported ? resetMode : 'app-only')
    setResetMode('app-only')
  }, [resetMode, fullResetSupported])

  const filteredDevices = selectedSession?.devices.filter((d) => d.platform === os) ?? []

  const osVersions = [
    ...new Set(filteredDevices.map((d) => d.osVersion).filter(Boolean)),
  ].sort((a, b) => {
    const parts = (s: string) => s.replace(/^[^\d]*/, '').split('.').map(Number)
    const [aParts, bParts] = [parts(a as string), parts(b as string)]
    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
      const diff = (bParts[i] ?? 0) - (aParts[i] ?? 0)
      if (diff !== 0) return diff
    }
    return 0
  }) as string[]

  const versionedDevices = (osVersion
    ? filteredDevices.filter((d) => d.osVersion === osVersion)
    : filteredDevices
  ).filter((d) => !deviceSearch || d.name.toLowerCase().includes(deviceSearch.toLowerCase()))

  return {
    filteredDevices,
    osVersions,
    osVersion,
    setOsVersion,
    deviceSearch,
    setDeviceSearch,
    versionedDevices,
    resetMode,
    setResetMode,
    appliedResetMode,
    consumeResetMode,
    fullResetSupported,
  }
}
