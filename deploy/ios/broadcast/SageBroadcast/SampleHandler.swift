import AVFoundation
import CoreImage
import ReplayKit
import UIKit

/// The only way iOS lets something record while another app is in front.
///
/// An in-app RPScreenRecorder is suspended with the app — the platform does that
/// deliberately, and no background mode changes it. A broadcast upload extension
/// is a separate process the system keeps alive while its broadcast runs, so the
/// reading happens here: one frame every couple of seconds, and the microphone in
/// five-second chunks, both posted to Sage.
///
/// The microphone is the point of the audio half. iOS has no API that hands an app
/// another app's output, so an audiobook on the iPhone is only ever audible through
/// the air: this captures it from the room and posts the words, and it keeps doing
/// that after the person returns to the book they are listening to. Sage's own
/// voice (`.audioApp`, its read-aloud) is deliberately not captured — feeding the
/// app's notes back in as lecture material would be a loop, not a transcript.
///
/// There is no shared container to hand notes back through — an App Group cannot
/// be created through the App Store Connect API, which is all CI signing has — so
/// the server is the meeting point. The app opens a session for this device before
/// the broadcast starts; frames and chunks are accepted for it and the app reads
/// the replies.
///
/// The extension cannot raise a notification either, so an answer written while
/// the user is inside another app is waiting when they come back rather than
/// overlaid on the exam.
final class SampleHandler: RPBroadcastSampleHandler {
    private static let frameEndpoint = URL(string: "https://sage.inotell.tech/api/broadcast/frame")!
    private static let audioEndpoint = URL(string: "https://sage.inotell.tech/api/broadcast/audio")!
    private static let modeEndpoint = URL(string: "https://sage.inotell.tech/api/broadcast/mode")!
    private static let minimumGap: TimeInterval = 2
    private static let maxWidth: CGFloat = 900
    /// Five seconds of 16 kHz mono is ~160 KB before base64, comfortably inside
    /// what the server accepts and what the extension's memory allows.
    private static let audioChunkSeconds: TimeInterval = 5
    /// 0.012 of full scale, the same threshold the page's level watcher uses: a
    /// silent share costs one open stream there, and no request at all here.
    private static let audiblePeak: Float = 0.012
    /// Without a cap, a stalled upload plus a long chapter would grow without end.
    private static let audioBacklogSeconds: TimeInterval = 20

    private let context = CIContext(options: [.useSoftwareRenderer: false])
    private lazy var session = URLSession(configuration: .ephemeral)

    private var lastSent = Date.distantPast
    private var inFlight = false
    /// An audiobook session is sound only. The app says so when it opens the session;
    /// this is the extension's copy of that answer, so an audiobook run never spends
    /// an upload (or a model call) on a screenshot nobody asked for.
    private var audioOnly = false
    private var modeCheckedAt = Date.distantPast

    private var audio = Data()
    private var audioPeak: Float = 0
    private var audioSeconds: Double = 0
    private var audioSeq = 0
    private var audioInFlight = false
    private lazy var targetFormat: AVAudioFormat? = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: 16000,
        channels: 1,
        interleaved: true
    )
    private var converter: AVAudioConverter?
    private var converterSource: AVAudioFormat?

    /// The app and its extensions share this value, which is what lets the two
    /// sides agree on a session without sharing storage.
    private var device: String {
        UIDevice.current.identifierForVendor?.uuidString ?? "unknown-device"
    }

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        // The app opens the session before the sheet is presented, so the answer is
        // already there when the broadcast begins — no frame has to be spent on it.
        refreshMode()
    }

    override func broadcastFinished() {
        // Whatever was captured before the person stopped the broadcast is still
        // worth sending; nothing after this is.
        flushAudio(force: true)
        session.invalidateAndCancel()
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        switch sampleBufferType {
        case .video:
            guard !audioOnly else { return }
            // The mode can change without the broadcast ending (the app closes the
            // session and opens another), so it is re-read rather than trusted.
            refreshMode()
            handleVideo(sampleBuffer)
        case .audioMic:
            handleAudio(sampleBuffer)
        case .audioApp:
            // Sage reading its own notes aloud. Transcribing it would put the
            // app's voice into the lecture it is supposed to be listening to.
            break
        @unknown default:
            break
        }
    }

    // MARK: - Mode

    /// Asks the server whether this session wants pictures. Once a minute is enough:
    /// a wrong answer costs at most a minute of frames, and the session is the only
    /// thing that can change it.
    private func refreshMode() {
        guard Date().timeIntervalSince(modeCheckedAt) >= 60 else { return }
        modeCheckedAt = Date()
        var components = URLComponents(url: Self.modeEndpoint, resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "device", value: device)]
        guard let url = components?.url else { return }
        var request = URLRequest(url: url)
        request.timeoutInterval = 10
        session.dataTask(with: request) { [weak self] data, _, _ in
            // No answer means no change: a network blip must not silently turn an
            // audiobook run into a screen recording, or the other way round.
            guard let self,
                  let data,
                  let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let answer = body["audioOnly"] as? Bool
            else { return }
            self.audioOnly = answer
        }.resume()
    }

    // MARK: - Video

    private func handleVideo(_ sampleBuffer: CMSampleBuffer) {
        guard !inFlight else { return }
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
        var request = URLRequest(url: Self.frameEndpoint)
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

    // MARK: - Microphone

    private func handleAudio(_ sampleBuffer: CMSampleBuffer) {
        guard let converted = pcm16(from: sampleBuffer) else { return }
        audio.append(converted.data)
        audioPeak = max(audioPeak, converted.peak)
        audioSeconds += converted.seconds

        if audioInFlight && audioSeconds > Self.audioBacklogSeconds {
            // The upload has stalled; a queue of stale chapters is worse than a gap.
            audio.removeAll(keepingCapacity: true)
            audioPeak = 0
            audioSeconds = 0
            return
        }
        guard audioSeconds >= Self.audioChunkSeconds else { return }
        flushAudio()
    }

    /// Converts whatever the microphone delivers to the one format the route takes.
    private func pcm16(from sampleBuffer: CMSampleBuffer) -> (data: Data, peak: Float, seconds: Double)? {
        guard let target = targetFormat else { return nil }
        guard let description = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(description),
              let source = AVAudioFormat(streamDescription: asbd) else { return nil }

        let frames = AVAudioFrameCount(CMSampleBufferGetNumSamples(sampleBuffer))
        guard frames > 0, let input = AVAudioPCMBuffer(pcmFormat: source, frameCapacity: frames) else { return nil }
        input.frameLength = frames
        let copied = CMSampleBufferCopyPCMDataIntoAudioBufferList(
            sampleBuffer,
            at: 0,
            frameCount: Int32(frames),
            into: input.mutableAudioBufferList
        )
        guard copied == noErr else { return nil }

        // The converter holds state across calls, and a source format that changes
        // mid-broadcast (a route switch to AirPods) gets a new one rather than
        // silent nonsense.
        if converter == nil || converterSource != source {
            converter = AVAudioConverter(from: source, to: target)
            converterSource = source
        }
        guard let converter = converter else { return nil }

        let capacity = AVAudioFrameCount(Double(frames) * target.sampleRate / source.sampleRate) + 1024
        guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return nil }
        var supplied = false
        var failure: NSError?
        let status = converter.convert(to: output, error: &failure) { _, outStatus in
            if supplied {
                outStatus.pointee = .noDataNow
                return nil
            }
            supplied = true
            outStatus.pointee = .haveData
            return input
        }
        guard status != .error, failure == nil, output.frameLength > 0 else { return nil }
        guard let samples = output.int16ChannelData?[0] else { return nil }

        let count = Int(output.frameLength)
        var peak: Float = 0
        for index in 0..<count {
            let level = abs(Float(samples[index]) / 32768)
            if level > peak { peak = level }
        }
        let data = Data(bytes: samples, count: count * MemoryLayout<Int16>.size)
        return (data, peak, Double(count) / target.sampleRate)
    }

    private func flushAudio(force: Bool = false) {
        guard !audioInFlight else { return }
        guard audioSeconds >= (force ? 0.5 : Self.audioChunkSeconds) else { return }

        let pcm = audio
        let peak = audioPeak
        let seconds = audioSeconds
        audio.removeAll(keepingCapacity: true)
        audioPeak = 0
        audioSeconds = 0

        // Silence is not sent. The route would spend a request to learn that nobody
        // was talking, once every five seconds, for the length of a quiet room.
        guard peak >= Self.audiblePeak else { return }

        audioSeq += 1
        let wav = Self.wav(from: pcm)
        var request = URLRequest(url: Self.audioEndpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        let payload: [String: Any] = [
            "device": device,
            "seq": audioSeq,
            "seconds": seconds,
            "peak": Double(peak),
            "audio": "data:audio/wav;base64," + wav.base64EncodedString(),
        ]
        request.httpBody = try? JSONSerialization.data(withJSONObject: payload)

        audioInFlight = true
        session.dataTask(with: request) { [weak self] _, _, _ in
            // One in flight at a time: a failed chunk is dropped rather than queued,
            // because the next five seconds matter more than the last one.
            self?.audioInFlight = false
        }.resume()
    }

    /// A 44-byte RIFF header around the PCM the converter produced. No encoder is
    /// available to an extension worth carrying, and the route reads WAV natively.
    private static func wav(from pcm: Data) -> Data {
        let rate: UInt32 = 16000
        let channels: UInt16 = 1
        let bits: UInt16 = 16
        let blockAlign = channels * (bits / 8)
        let byteRate = rate * UInt32(blockAlign)

        var header = Data()
        func put<T>(_ value: T) {
            var copy = value
            withUnsafeBytes(of: &copy) { header.append(contentsOf: $0) }
        }
        header.append(contentsOf: Array("RIFF".utf8))
        put(UInt32(36 + pcm.count))
        header.append(contentsOf: Array("WAVEfmt ".utf8))
        put(UInt32(16))
        put(UInt16(1)) // PCM
        put(channels)
        put(rate)
        put(byteRate)
        put(blockAlign)
        put(bits)
        header.append(contentsOf: Array("data".utf8))
        put(UInt32(pcm.count))
        return header + pcm
    }
}
