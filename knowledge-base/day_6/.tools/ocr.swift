import Foundation
import Vision
import AppKit

// Usage: ocr <image-path> [<image-path> ...]
// Prints recognized text (zh-Hans/zh-Hant/English) for each image to stdout.

let args = Array(CommandLine.arguments.dropFirst())
if args.isEmpty {
    FileHandle.standardError.write("usage: ocr <image> [...]\n".data(using: .utf8)!)
    exit(1)
}

func ocr(imagePath: String) -> String {
    guard let img = NSImage(contentsOfFile: imagePath),
          let tiff = img.tiffRepresentation,
          let rep = NSBitmapImageRep(data: tiff),
          let cg = rep.cgImage else {
        return "!! failed to load \(imagePath)"
    }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]

    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    do {
        try handler.perform([request])
    } catch {
        return "!! OCR error for \(imagePath): \(error)"
    }

    guard let observations = request.results, !observations.isEmpty else {
        return "!! no text found in \(imagePath)"
    }

    // Sort top-to-bottom (Vision origin is bottom-left), then left-to-right.
    let sorted = observations.sorted { a, b in
        let ay = a.boundingBox.midY, by = b.boundingBox.midY
        if abs(ay - by) > 0.012 { return ay > by }   // different line
        return a.boundingBox.minX < b.boundingBox.minX
    }

    var out: [String] = []
    for obs in sorted {
        if let candidate = obs.topCandidates(1).first {
            out.append(candidate.string)
        }
    }
    return out.joined(separator: "\n")
}

for path in args {
    print("===== \(path) =====")
    print(ocr(imagePath: path))
    print("")
}
