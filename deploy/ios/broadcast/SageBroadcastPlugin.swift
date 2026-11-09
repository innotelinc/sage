import Foundation
import Capacitor
import ReplayKit
import UIKit

/// Starts the system broadcast sheet and reports the device identifier the
/// extension posts under.
///
/// There is no API that begins a broadcast silently — iOS requires the person to
/// confirm it — and from that point the recording belongs to the extension rather
/// than to this app, which is exactly why it survives the app going to the
/// background. The app's part is to open the session on the server and collect the
/// notes afterwards.
@objc(SageBroadcastPlugin)
public class SageBroadcastPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SageBroadcastPlugin"
    public let jsName = "SageBroadcast"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "device", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
    ]

    private let broadcastExtension = "us.innotel.sage.broadcast"

    /// Identical to what the extension sees: iOS vendors an app and its extensions
    /// together, so this is the one value both sides can compute.
    @objc func device(_ call: CAPPluginCall) {
        let id = UIDevice.current.identifierForVendor?.uuidString ?? ""
        call.resolve(["device": id])
    }

    @objc func start(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let picker = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 72, height: 72))
            picker.preferredExtension = self.broadcastExtension
            // The extension reads the microphone as well as the screen: that is the
            // only way an audiobook playing out loud reaches Sage on the iPhone, and
            // Apple's own sheet is where the person grants it.
            picker.showsMicrophoneButton = true
            // The picker is a view that draws a button; sending it the touch is how
            // the sheet is opened without placing the view on screen first.
            for case let button as UIButton in picker.subviews {
                button.sendActions(for: .allTouchEvents)
            }
            call.resolve(["presented": true])
        }
    }
}
