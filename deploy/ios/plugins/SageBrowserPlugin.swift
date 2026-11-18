import Foundation
import Capacitor
import SafariServices
import UIKit

/// A web page shown inside the app, with its own Done button.
///
/// The app's pages are bundled, so `capacitor://localhost` knows nothing about the
/// documents the web origin serves — `/about` comes out of the landing tree and is not
/// in the bundle at all. Sending the WebView there navigated to a path that does not
/// exist, which is a blank screen with no way back. This opens such a page in an
/// `SFSafariViewController` instead: it loads from the origin, keeps the reader in the
/// app, and closes back to where they were.
@objc(SageBrowserPlugin)
public class SageBrowserPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SageBrowserPlugin"
    public let jsName = "SageBrowser"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
    ]

    @objc public func open(_ call: CAPPluginCall) {
        guard
            let raw = call.getString("url")?.trimmingCharacters(in: .whitespacesAndNewlines),
            let url = URL(string: raw),
            let scheme = url.scheme?.lowercased(),
            scheme == "https" || scheme == "http",
            url.host != nil
        else {
            call.reject("A http(s) url with a host is required")
            return
        }
        DispatchQueue.main.async { [weak self] in
            guard let presenting = Self.topController(from: self?.bridge?.viewController) else {
                call.reject("There is no view controller to present from")
                return
            }
            let browser = SFSafariViewController(url: url)
            browser.dismissButtonStyle = .done
            presenting.present(browser, animated: true) { call.resolve() }
        }
    }

    /// Whatever is on top, so a sheet already open does not swallow the page.
    private static func topController(from base: UIViewController?) -> UIViewController? {
        var current = base
        while let presented = current?.presentedViewController {
            current = presented
        }
        return current
    }
}
