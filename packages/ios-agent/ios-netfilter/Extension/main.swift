import Foundation
import NetworkExtension

// System extensions are standalone executables and need their own entry point.
// startSystemExtensionMode() reads Info.plist NEProviderClasses and instantiates Provider.
//
// **The listener is vended here, once, for the life of the process** — not from `startFilter`, which
// runs again every time the filter is stopped and restarted inside one process. A second
// `NSXPCListener` on the same mach service is a name collision, and a listener owned by a provider
// would answer for one that has been replaced. What it reports comes from `ProviderBox`, which the
// provider fills and empties, so "is anything enforcing" survives the provider's whole lifecycle.
autoreleasepool {
    NEProvider.startSystemExtensionMode()
    IPCListener.shared.start()
}
dispatchMain()
