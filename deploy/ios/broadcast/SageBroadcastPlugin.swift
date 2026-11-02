import Foundation
import Capacitor
import ReplayKit
import UIKit

/// Starts the broadcast and collects what it read.
///
/// There is no API that begins a broadcast silently: iOS requires the user to
/// confirm it. This shows the system picker, and from then on the recording is
/// owned by the extension rather than by this app — which is exactly why it keeps
/// going when the app is backgrounded.
@objc(SageBroadcastPlugin)
public class SageBroadcastPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SageBroadcastPlugin"
    public let jsName = "SageBroadcast"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "configure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "state", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "drain", returnType: CAPPluginReturnPromise),
    ]

    private let group = "group.us.innotel.sage"
    private let broadcastExtension = "us.innotel.sage.broadcast"

    /// The access code lives in the page's storage; the extension can only read
    /// the shared defaults, so the page has to hand it over.
    @objc func configure(_ call: CAPPluginCall) {
        let code = call.getString("code") ?? ""
        UserDefaults(suiteName: group)?.set(code, forKey: "accessCode")
        call.resolve([:])
    }

    @objc func start(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let picker = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 72, height: 72))
            picker.preferredExtension = self.broadcastExtension
            picker.showsMicrophoneButton = false
            // The picker is a view that draws a button; sending it the touch is the
            // documented-by-practice way to open the sheet without placing the view
            // on screen first.
            for case let button as UIButton in picker.subviews {
                button.sendActions(for: .allTouchEvents)
            }
            call.resolve(["presented": true])
        }
    }

    @objc func state(_ call: CAPPluginCall) {
        call.resolve(readState())
    }

    @objc func drain(_ call: CAPPluginCall) {
        var notes: [[String: Any]] = []
        if let url = container()?.appendingPathComponent("broadcast-notes.jsonl"),
           let text = try? String(contentsOf: url, encoding: .utf8) {
            for line in text.split(separator: "\n") {
                guard let data = line.data(using: .utf8),
                      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let note = object["text"] as? String else { continue }
                notes.append(["text": note, "at": object["at"] ?? 0])
            }
            // Collected once: a note that reappears on every poll would multiply
            // itself in the feed.
            try? FileManager.default.removeItem(at: url)
        }
        var result = readState()
        result["notes"] = notes
        call.resolve(result)
    }

    private func container() -> URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
    }

    private func readState() -> [String: Any] {
        guard let url = container()?.appendingPathComponent("broadcast-state.json"),
              let data = try? Data(contentsOf: url),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return ["running": false, "frames": 0, "error": "", "at": 0]
        }
        return object
    }
}
