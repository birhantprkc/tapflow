import { describe, it, expect, vi } from 'vitest'
import { PlatformError, ValidationError } from '@tapflowio/agent-core'
import { AdbWrapper } from '../AdbWrapper'
import type { AdbRunner } from '../adb'

function mockRunner(responses: {
  devices?: string
  avds?: string[]
  avdName?: string
  osVersion?: string
  screenSize?: string
  uiDump?: string
} = {}): AdbRunner {
  return {
    exec: vi.fn(async (...args: string[]) => {
      if (args[0] === 'devices') {
        return responses.devices ?? 'List of devices attached\n'
      }
      if (args.includes('emu') && args.includes('avd') && args.includes('name')) {
        return `${responses.avdName ?? ''}\nOK\n`
      }
      if (args.includes('ro.build.version.release')) {
        return `${responses.osVersion ?? '14'}\n`
      }
      if (args.includes('wm') && args.includes('size')) {
        return `Physical size: ${responses.screenSize ?? '1080x2400'}\n`
      }
      if (args.includes('uiautomator')) {
        return responses.uiDump ?? ''
      }
      return ''
    }),
    execBinary: vi.fn().mockResolvedValue(Buffer.from('PNG')),
    listAvds: vi.fn().mockResolvedValue(responses.avds ?? []),
  }
}

describe('AdbWrapper', () => {
  describe('listDevices', () => {
    it('returns empty array when no AVDs exist', async () => {
      const wrapper = new AdbWrapper(mockRunner({ avds: [] }))
      expect(await wrapper.listDevices()).toEqual([])
    })

    it('returns shutdown device when AVD exists but emulator not running', async () => {
      const wrapper = new AdbWrapper(mockRunner({
        avds: ['Pixel_8_API_34'],
        devices: 'List of devices attached\n',
      }))
      const devices = await wrapper.listDevices()
      expect(devices).toHaveLength(1)
      expect(devices[0]).toMatchObject({
        id: 'avd:Pixel_8_API_34',
        name: 'Pixel_8_API_34',
        platform: 'android',
        status: 'shutdown',
      })
    })

    it('returns booted device when emulator is running and AVD name matches', async () => {
      const wrapper = new AdbWrapper(mockRunner({
        avds: ['Pixel_8_API_34'],
        devices: 'List of devices attached\nemulator-5554\tdevice\n',
        avdName: 'Pixel_8_API_34',
        osVersion: '14',
      }))
      const devices = await wrapper.listDevices()
      expect(devices).toHaveLength(1)
      expect(devices[0]).toMatchObject({
        id: 'avd:Pixel_8_API_34',
        status: 'booted',
        osVersion: 'Android 14',
      })
    })

    it('uses avd: prefix as stable id regardless of serial', async () => {
      const wrapper = new AdbWrapper(mockRunner({
        avds: ['Pixel_8_API_34'],
        devices: 'List of devices attached\nemulator-5556\tdevice\n',
        avdName: 'Pixel_8_API_34',
      }))
      const devices = await wrapper.listDevices()
      expect(devices[0].id).toBe('avd:Pixel_8_API_34')
    })

    it('tracks serial in serialMap after listDevices', async () => {
      const wrapper = new AdbWrapper(mockRunner({
        avds: ['Pixel_8_API_34'],
        devices: 'List of devices attached\nemulator-5554\tdevice\n',
        avdName: 'Pixel_8_API_34',
      }))
      await wrapper.listDevices()
      expect(wrapper.getSerial('avd:Pixel_8_API_34')).toBe('emulator-5554')
    })

    it('clears stale serial when emulator is no longer running', async () => {
      const wrapper = new AdbWrapper(mockRunner({
        avds: ['Pixel_8_API_34'],
        devices: 'List of devices attached\nemulator-5554\tdevice\n',
        avdName: 'Pixel_8_API_34',
      }))
      await wrapper.listDevices()
      expect(wrapper.getSerial('avd:Pixel_8_API_34')).toBe('emulator-5554')

      // Emulator shuts down externally
      const runner2 = mockRunner({ avds: ['Pixel_8_API_34'], devices: 'List of devices attached\n' })
      const wrapper2 = new AdbWrapper(runner2)
      wrapper2.setSerial('avd:Pixel_8_API_34', 'emulator-5554')
      await wrapper2.listDevices()
      expect(wrapper2.getSerial('avd:Pixel_8_API_34')).toBeUndefined()
    })
  })

  describe('installApp', () => {
    it('calls adb install -r with serial and path', async () => {
      const runner = mockRunner()
      const wrapper = new AdbWrapper(runner)
      await wrapper.installApp('emulator-5554', '/tmp/app.apk')
      expect(runner.exec).toHaveBeenCalledWith('-s', 'emulator-5554', 'install', '-r', '/tmp/app.apk')
    })

    it('throws ValidationError when adb returns INSTALL_FAILED code', async () => {
      const runner = mockRunner()
      ;(runner.exec as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
        stderr: 'Failure [INSTALL_FAILED_VERSION_DOWNGRADE]',
      })
      const wrapper = new AdbWrapper(runner)
      await expect(wrapper.installApp('emulator-5554', '/tmp/app.apk')).rejects.toBeInstanceOf(ValidationError)
    })
  })

  describe('launchApp', () => {
    it('calls adb shell monkey with LAUNCHER intent', async () => {
      const runner = mockRunner()
      const wrapper = new AdbWrapper(runner)
      await wrapper.launchApp('emulator-5554', 'com.example.app')
      expect(runner.exec).toHaveBeenCalledWith(
        '-s', 'emulator-5554', 'shell', 'monkey',
        '-p', 'com.example.app', '-c', 'android.intent.category.LAUNCHER', '1',
      )
    })
  })

  describe('getScreenSize', () => {
    it('parses wm size output correctly', async () => {
      const wrapper = new AdbWrapper(mockRunner({ screenSize: '1080x2400' }))
      const size = await wrapper.getScreenSize('emulator-5554')
      expect(size).toEqual({ width: 1080, height: 2400 })
    })

    it('throws PlatformError when wm size output is malformed', async () => {
      const wrapper = new AdbWrapper(mockRunner({ screenSize: 'unknown' }))
      await expect(wrapper.getScreenSize('emulator-5554')).rejects.toBeInstanceOf(PlatformError)
    })
  })

  describe('serial map', () => {
    it('setSerial / getSerial / clearSerial work correctly', () => {
      const wrapper = new AdbWrapper(mockRunner())
      wrapper.setSerial('avd:Pixel_8', 'emulator-5554')
      expect(wrapper.getSerial('avd:Pixel_8')).toBe('emulator-5554')
      wrapper.clearSerial('avd:Pixel_8')
      expect(wrapper.getSerial('avd:Pixel_8')).toBeUndefined()
    })
  })

  describe('openUrl', () => {
    it('calls adb shell am start with VIEW intent and url', async () => {
      const runner = mockRunner()
      const wrapper = new AdbWrapper(runner)
      await wrapper.openUrl('emulator-5554', 'myapp://home')
      expect(runner.exec).toHaveBeenCalledWith(
        '-s', 'emulator-5554', 'shell', 'am', 'start',
        '-a', 'android.intent.action.VIEW', '-d', 'myapp://home',
      )
    })
  })

  describe('setRotation', () => {
    it('locks display to landscape via wm user-rotation', async () => {
      const runner = mockRunner()
      const wrapper = new AdbWrapper(runner)
      await wrapper.setRotation('emulator-5554', 3)
      expect(runner.exec).toHaveBeenCalledWith(
        '-s', 'emulator-5554', 'shell', 'wm', 'user-rotation', 'lock', '3',
      )
    })

    it('locks display back to portrait via wm user-rotation', async () => {
      const runner = mockRunner()
      const wrapper = new AdbWrapper(runner)
      await wrapper.setRotation('emulator-5554', 0)
      expect(runner.exec).toHaveBeenCalledWith(
        '-s', 'emulator-5554', 'shell', 'wm', 'user-rotation', 'lock', '0',
      )
    })

    // Legacy `settings put system user_rotation` is silently ignored on newer Android
    // (API 37): the display does not rotate, only a rotation-suggestion appears. wm
    // user-rotation lock works on API 34 and 37, and locks regardless of auto-rotate,
    // so the legacy settings writes are dropped entirely.
    it('does not use legacy settings user_rotation / accelerometer_rotation', async () => {
      const runner = mockRunner()
      const wrapper = new AdbWrapper(runner)
      await wrapper.setRotation('emulator-5554', 3)
      const calls = (runner.exec as ReturnType<typeof vi.fn>).mock.calls
      expect(calls.every((c) => !c.includes('user_rotation') && !c.includes('accelerometer_rotation'))).toBe(true)
    })
  })

  describe('inputText', () => {
    it('sends `input text` with spaces encoded as %s', async () => {
      const runner = mockRunner()
      const wrapper = new AdbWrapper(runner)
      await wrapper.inputText('emulator-5554', 'user@example.com pw')
      expect(runner.exec).toHaveBeenCalledWith('-s', 'emulator-5554', 'shell', 'input', 'text', 'user@example.com%spw')
    })

    it('backslash-escapes shell metacharacters', async () => {
      const runner = mockRunner()
      const wrapper = new AdbWrapper(runner)
      await wrapper.inputText('emulator-5554', 'a(b)&c;d')
      expect(runner.exec).toHaveBeenCalledWith('-s', 'emulator-5554', 'shell', 'input', 'text', 'a\\(b\\)\\&c\\;d')
    })

    it('escapes a literal % so it is not re-expanded as %s (space)', async () => {
      const runner = mockRunner()
      const wrapper = new AdbWrapper(runner)
      await wrapper.inputText('emulator-5554', '50% off')
      // % → \% (literal), space → %s
      expect(runner.exec).toHaveBeenCalledWith('-s', 'emulator-5554', 'shell', 'input', 'text', '50\\%%soff')
    })

    it('rejects non-ASCII text instead of silently typing nothing', async () => {
      const runner = mockRunner()
      const wrapper = new AdbWrapper(runner)
      await expect(wrapper.inputText('emulator-5554', '안녕')).rejects.toThrow(PlatformError)
      expect(runner.exec).not.toHaveBeenCalled()
    })
  })

  // #607. Measured on Pixel_6_tapflow (API 34): `enable` exits 0, the state reads back as `enabled`
  // with no delay, and `dumpsys connectivity` reports "Active default network: none" — so the OS is
  // genuinely offline and the app's own connectivity callbacks fire without anything being faked.
  describe('airplane mode', () => {
    /** `cmd connectivity airplane-mode …` — set with an argument, read without one. */
    const connectivity = (state: string, opts: { setExit?: Error } = {}) => {
      const runner = mockRunner()
      ;(runner.exec as ReturnType<typeof vi.fn>).mockImplementation(async (...args: string[]) => {
        if (!args.includes('airplane-mode')) return ''
        const isSet = args.includes('enable') || args.includes('disable')
        if (isSet && opts.setExit) throw opts.setExit
        return isSet ? '' : `${state}
`
      })
      return runner
    }

    it('reads the state with no argument', async () => {
      const runner = connectivity('enabled')
      expect(await new AdbWrapper(runner).airplaneMode('emulator-5554')).toBe(true)
      expect(runner.exec).toHaveBeenCalledWith(
        '-s', 'emulator-5554', 'shell', 'cmd', 'connectivity', 'airplane-mode',
      )
    })

    it('reads disabled as false', async () => {
      expect(await new AdbWrapper(connectivity('disabled')).airplaneMode('emulator-5554')).toBe(false)
    })

    it('sets it on, then verifies by reading back', async () => {
      const runner = connectivity('enabled')
      await new AdbWrapper(runner).setAirplaneMode('emulator-5554', true)
      expect(runner.exec).toHaveBeenCalledWith(
        '-s', 'emulator-5554', 'shell', 'cmd', 'connectivity', 'airplane-mode', 'enable',
      )
      // The read-back is the point, not decoration — see the test below.
      expect(runner.exec).toHaveBeenCalledWith(
        '-s', 'emulator-5554', 'shell', 'cmd', 'connectivity', 'airplane-mode',
      )
    })

    it('sets it off with disable', async () => {
      const runner = connectivity('disabled')
      await new AdbWrapper(runner).setAirplaneMode('emulator-5554', false)
      expect(runner.exec).toHaveBeenCalledWith(
        '-s', 'emulator-5554', 'shell', 'cmd', 'connectivity', 'airplane-mode', 'disable',
      )
    })

    it('confirms the state when the read agrees', async () => {
      const r = await new AdbWrapper(connectivity('enabled')).setAirplaneMode('emulator-5554', true)
      expect(r).toEqual({ confirmed: true, offline: true })
    })

    // **The reason the read-back exists.** An image whose `cmd connectivity` does not know
    // `airplane-mode` answers non-zero and throws from the write — but a command that succeeds and
    // does nothing would otherwise be reported as a device taken offline. tapflow is a QA tool: a
    // false "offline" gets signed off, and the bug it hides is filed against the app under test.
    // `clearAppData` above guards the same shape for `pm clear`.
    //
    // **Reports rather than throws**, and `offline` is what the *device* said, not what was asked
    // for. A caller that only learned "it failed" would have to guess which of the two states it is
    // looking at, and guessing wrong here is exactly the false "offline" above.
    it('reports unconfirmed, with the device state, when the write has no effect', async () => {
      const r = await new AdbWrapper(connectivity('disabled')).setAirplaneMode('emulator-5554', true)
      expect(r).toEqual({ confirmed: false, offline: false })
    })

    it('reports the same way when asked to turn it off and it stays on', async () => {
      const r = await new AdbWrapper(connectivity('enabled')).setAirplaneMode('emulator-5554', false)
      expect(r).toEqual({ confirmed: false, offline: true })
    })

    // **The write landed and the confirmation did not.** The device has probably already changed,
    // so the requested value is the best evidence there is — falling back to the old one would
    // report an offline device as online, the failure this whole path exists to prevent.
    it('reports the requested state when the read-back itself fails', async () => {
      const runner = mockRunner()
      ;(runner.exec as ReturnType<typeof vi.fn>).mockImplementation(async (...args: string[]) => {
        if (!args.includes('airplane-mode')) return ''
        if (args.includes('enable') || args.includes('disable')) return ''   // write lands
        return 'Connectivity service commands:'                             // read is unreadable
      })
      const r = await new AdbWrapper(runner).setAirplaneMode('emulator-5554', true)
      expect(r).toEqual({ confirmed: false, offline: true })
    })

    // A write that fails is different: the device is unchanged, so the caller's own before-state is
    // still true and there is nothing to report back — it throws.
    it('throws when the write itself fails, leaving the caller its own state', async () => {
      const runner = connectivity('disabled', { setExit: new Error('exit 255') })
      await expect(new AdbWrapper(runner).setAirplaneMode('emulator-5554', true)).rejects.toThrow()
    })

    // Output tapflow cannot read is not "off" — reporting it as off is the same false negative the
    // read-back exists to prevent, arrived at from the other side.
    it('refuses to read an answer it does not recognise', async () => {
      const runner = connectivity('Connectivity service commands:')   // the help text
      await expect(new AdbWrapper(runner).airplaneMode('emulator-5554')).rejects.toThrow(PlatformError)
    })
  })

  describe('clearAppData', () => {
    it('runs pm clear and succeeds on "Success" output', async () => {
      const runner = mockRunner()
      ;(runner.exec as ReturnType<typeof vi.fn>).mockImplementation(async (...args: string[]) =>
        args.includes('clear') ? 'Success\n' : '')
      const wrapper = new AdbWrapper(runner)
      await wrapper.clearAppData('emulator-5554', 'com.example.app')
      expect(runner.exec).toHaveBeenCalledWith('-s', 'emulator-5554', 'shell', 'pm', 'clear', 'com.example.app')
    })

    it('throws PlatformError when pm clear reports Failed (exit code 0)', async () => {
      const runner = mockRunner()
      ;(runner.exec as ReturnType<typeof vi.fn>).mockImplementation(async (...args: string[]) =>
        args.includes('clear') ? 'Failed\n' : '')
      const wrapper = new AdbWrapper(runner)
      await expect(wrapper.clearAppData('emulator-5554', 'unknown.pkg')).rejects.toThrow(PlatformError)
    })
  })

  describe('dumpUiHierarchy', () => {
    const XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>\n<hierarchy rotation="0"><node bounds="[0,0][1080,2400]" /></hierarchy>`

    it('runs uiautomator dump under the device-side timeout command', async () => {
      const runner = mockRunner({ uiDump: XML })
      const wrapper = new AdbWrapper(runner)
      await wrapper.dumpUiHierarchy('emulator-5554')
      expect(runner.exec).toHaveBeenCalledWith(
        '-s', 'emulator-5554', 'exec-out',
        'timeout', '10', 'uiautomator', 'dump', '/dev/tty',
      )
    })

    it('strips the trailing status line and returns clean XML', async () => {
      const runner = mockRunner({ uiDump: `${XML}UI hierarchy dumped to: /dev/tty\n` })
      const wrapper = new AdbWrapper(runner)
      const xml = await wrapper.dumpUiHierarchy('emulator-5554')
      expect(xml).toBe(XML)
    })

    it('throws PlatformError when the timed-out dump produced no XML', async () => {
      const runner = mockRunner({ uiDump: '' })
      const wrapper = new AdbWrapper(runner)
      await expect(wrapper.dumpUiHierarchy('emulator-5554')).rejects.toThrow(PlatformError)
    })

    it('throws PlatformError on truncated XML (dump killed mid-write)', async () => {
      const runner = mockRunner({ uiDump: `<?xml version='1.0'?>\n<hierarchy rotation="0"><node ` })
      const wrapper = new AdbWrapper(runner)
      await expect(wrapper.dumpUiHierarchy('emulator-5554')).rejects.toThrow(PlatformError)
    })
  })
})
