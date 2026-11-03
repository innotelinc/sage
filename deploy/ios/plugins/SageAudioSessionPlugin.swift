import Foundation
import Capacitor
import AVFoundation

/// Holds the audio session while Sage is listening, so capture survives the app
/// leaving the screen and an audiobook keeps playing underneath it.
///
/// A WebView's microphone borrows the app's one audio session. Left alone that
/// session is play-and-record without mixWithOthers, which means opening the
/// microphone interrupts whatever was playing, and switching apps deactivates
/// it, which ends the capture.
@objc(SageAudioSessionPlugin)
public class SageAudioSessionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SageAudioSessionPlugin"
    public let jsName = "SageAudio"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "begin", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "end", returnType: CAPPluginReturnPromise),
    ]

    private var observing = false

    private var options: AVAudioSession.CategoryOptions {
        // mixWithOthers: never silence what the person was already playing.
        // defaultToSpeaker: notes read aloud do not go to the earpiece.
        [.mixWithOthers, .defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP]
    }

    @objc func begin(_ call: CAPPluginCall) {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .default, options: options)
            try session.setActive(true, options: [])
            observe(session)
            call.resolve(["category": session.category.rawValue, "active": true])
        } catch {
            call.reject("Could not hold the audio session: \(error.localizedDescription)")
        }
    }

    /// Deliberately does not deactivate: the session is shared with playback, so
    /// tearing it down would stop audio this plugin never started.
    @objc func end(_ call: CAPPluginCall) {
        call.resolve()
    }

    private func observe(_ session: AVAudioSession) {
        guard !observing else { return }
        observing = true
        NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: session,
            queue: .main
        ) { [weak self] notification in
            guard let self,
                  let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  AVAudioSession.InterruptionType(rawValue: raw) == .ended
            else { return }
            let flags = (notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt)
                .map(AVAudioSession.InterruptionOptions.init) ?? []
            guard flags.contains(.shouldResume) else { return }
            // A call or an alarm took the session; take it back so a lecture being
            // recorded is still being recorded.
            try? session.setCategory(.playAndRecord, mode: .default, options: self.options)
            try? session.setActive(true, options: [])
        }
    }
}
