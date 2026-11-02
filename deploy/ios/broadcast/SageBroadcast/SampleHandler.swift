import ReplayKit
import UIKit
import CoreImage

/// The only way iOS lets something record while another app is in front.
///
/// An in-app RPScreenRecorder is suspended with the app — the platform does that
/// deliberately, and no background mode changes it. A broadcast upload extension
/// is a separate process the system keeps alive while its broadcast runs, so the
/// reading happens here: one frame every couple of seconds, posted to Sage.
///
/// There is no shared container to hand notes back through — an App Group cannot
/// be created through the App Store Connect API, which is all CI signing has — so
/// the server is the meeting point. The app opens a session for this device before
/// the broadcast starts; frames are accepted for it and the app reads the replies.
///
/// The extension cannot raise a notification either, so an answer written while
/// the user is inside another app is waiting when they come back rather than
/// overlaid on the exam.
final class SampleHandler: RPBroadcastSampleHandler {
    private static let endpoint = URL(string: "https://sage.innotel.tech/api/broadcast/frame")!
    private static let minimumGap: TimeInterval = 2
    private static let maxWidth: CGFloat = 900

    private let context = CIContext(options: [.useSoftwareRenderer: false])
    private lazy var session = URLSession(configuration: .ephemeral)

    private var lastSent = Date.distantPast
    private var inFlight = false

    /// The app and its extensions share this value, which is what lets the two
    /// sides agree on a session without sharing storage.
    private var device: String {
        UIDevice.current.identifierForVendor?.uuidString ?? "unknown-device"
    }

    override func broadcastFinished() {
        session.invalidateAndCancel()
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        // Only the screen matters here; audio arrives on its own channels and the
        // page handles listening whenever it is in front.
        guard sampleBufferType == .video, !inFlight else { return }
        guard Date().timeIntervalSince(lastSent) >= Self.minimumGap else { return }
        lastSent = Date()
        guard let jpeg = jpegData(from: sampleBuffer) else { return }
        inFlight = true
        upload(jpeg)
    }

    private func jpegData(from sampleBuffer: CMSampleBuffer) -> Data? {
        guard let pixel = CMSampleBufferGetImageBuffer(sampleBuffer) else { return nil }
        let image = CIImage(cvImageBuffer: pixel)
        guard image.extent.width > 0, image.extent.height > 0 else { return nil }
        // A broadcast extension has roughly 50 MB to work with, so the frame is
        // scaled down before encoding: the model needs the text, not the detail.
        let scale = min(1, Self.maxWidth / image.extent.width)
        let scaled = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        guard let cgImage = context.createCGImage(scaled, from: scaled.extent) else { return nil }
        return UIImage(cgImage: cgImage).jpegData(compressionQuality: 0.68)
    }

    private func upload(_ jpeg: Data) {
        var request = URLRequest(url: Self.endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = 25
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        let payload: [String: Any] = [
            "device": device,
            "image": "data:image/jpeg;base64," + jpeg.base64EncodedString(),
        ]
        request.httpBody = try? JSONSerialization.data(withJSONObject: payload)

        session.dataTask(with: request) { [weak self] _, _, _ in
            // A frame the server refused (the session closed, the network gone)
            // is not worth ending the broadcast for: the next one may work, and
            // the app is what decides whether to stop.
            self?.inFlight = false
        }.resume()
    }
}
