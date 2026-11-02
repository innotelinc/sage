import ReplayKit
import UIKit
import CoreImage

/// The only way iOS lets something record while another app is in front.
///
/// An in-app RPScreenRecorder is suspended with the app — the platform does that
/// deliberately, and no background mode changes it. A broadcast upload extension
/// is a separate process that the system keeps alive while its broadcast runs, so
/// this is where the reading happens: one frame every couple of seconds, posted to
/// Sage, and the reply left in the shared container for the app to collect.
///
/// The extension cannot show a notification (UNUserNotificationCenter is not
/// available to broadcast extensions), so an answer written while the user is in
/// another app is waiting for them when they come back, not overlaid on the exam.
final class SampleHandler: RPBroadcastSampleHandler {
    private static let group = "group.us.innotel.sage"
    private static let endpoint = URL(string: "https://sage.innotel.tech/api/chat")!
    private static let prompt =
        "Frame captured from the screen while the user is in another app. Note only what matters academically; mark exam hints with EXAM:"
    private static let minimumGap: TimeInterval = 2
    private static let maxWidth: CGFloat = 900

    private let context = CIContext(options: [.useSoftwareRenderer: false])
    private lazy var session = URLSession(configuration: .ephemeral)

    private var lastSent = Date.distantPast
    private var inFlight = false
    private var frames = 0
    private var lastError: String?

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        frames = 0
        lastError = nil
        writeState(running: true)
    }

    override func broadcastFinished() {
        writeState(running: false)
        session.invalidateAndCancel()
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        // Only the screen matters; the microphone and app audio arrive on their
        // own channels and the page handles listening when it is in front.
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
        // A broadcast extension has ~50 MB to work with, so the frame is scaled
        // down before it is encoded — the model reads text, not detail.
        let scale = min(1, Self.maxWidth / image.extent.width)
        let scaled = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        guard let cgImage = context.createCGImage(scaled, from: scaled.extent) else { return nil }
        return UIImage(cgImage: cgImage).jpegData(compressionQuality: 0.7)
    }

    private func upload(_ jpeg: Data) {
        var request = URLRequest(url: Self.endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = 25
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        // The app writes the code the user typed into the shared defaults; the
        // extension cannot read the page's storage, and a protected server would
        // reject an unnamed caller.
        if let code = UserDefaults(suiteName: Self.group)?.string(forKey: "accessCode"), !code.isEmpty {
            request.setValue(code, forHTTPHeaderField: "x-access-code")
        }
        let payload: [String: Any] = [
            "mode": "note",
            "text": Self.prompt,
            "images": ["data:image/jpeg;base64," + jpeg.base64EncodedString()],
        ]
        request.httpBody = try? JSONSerialization.data(withJSONObject: payload)

        session.dataTask(with: request) { [weak self] data, response, error in
            guard let self else { return }
            defer { self.inFlight = false }
            if let error {
                self.finish(note: nil, error: error.localizedDescription)
                return
            }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard status == 200, let data,
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let reply = object["reply"] as? String, !reply.isEmpty else {
                let body = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                self.finish(note: nil, error: "HTTP \(status) \(body.prefix(200))")
                return
            }
            self.finish(note: reply.lowercased() == "nothing new" ? nil : reply, error: nil)
        }.resume()
    }

    private func finish(note: String?, error: String?) {
        frames += 1
        lastError = error
        if let note { append(note) }
        writeState(running: true)
    }

    private func container() -> URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: Self.group)
    }

    private func append(_ note: String) {
        guard let url = container()?.appendingPathComponent("broadcast-notes.jsonl") else { return }
        let entry: [String: Any] = ["text": note, "at": Int(Date().timeIntervalSince1970 * 1000)]
        guard var line = try? JSONSerialization.data(withJSONObject: entry) else { return }
        line.append(0x0A)
        if let handle = try? FileHandle(forWritingTo: url) {
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: line)
        } else {
            // First note of this broadcast: the file does not exist yet.
            try? line.write(to: url, options: .atomic)
        }
    }

    private func writeState(running: Bool, error: String? = nil) {
        guard let url = container()?.appendingPathComponent("broadcast-state.json") else { return }
        let state: [String: Any] = [
            "running": running,
            "frames": frames,
            "error": error ?? lastError ?? "",
            "at": Int(Date().timeIntervalSince1970 * 1000),
        ]
        if let data = try? JSONSerialization.data(withJSONObject: state) {
            try? data.write(to: url, options: .atomic)
        }
    }
}
