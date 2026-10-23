import Foundation

enum PathKind { case posix, windows }

/// A path split by the spec's rules: the kind is told by the first characters alone;
/// a Windows path splits on `/` and `\`, a POSIX path on `/` only.
struct ParsedPath {
    let kind: PathKind
    let isShare: Bool            // Windows path rooted at two separators
    let rootKey: [UInt8]         // comparison form of the root
    let driveLetter: UInt8?      // as written, for a drive root's folder name
    let rootLength: Int          // bytes of the root
    let segments: [[UInt8]]      // as written
    let cmpSegments: [[UInt8]]   // comparison form: exact for POSIX, full lowercase for Windows

    static func isSep(_ b: UInt8, _ kind: PathKind) -> Bool {
        b == UInt8(ascii: "/") || (kind == .windows && b == UInt8(ascii: "\\"))
    }
    static func isLetter(_ b: UInt8) -> Bool {
        (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A)
    }
    static func kind(of p: [UInt8]) -> PathKind {
        if p.count >= 3, isLetter(p[0]), p[1] == UInt8(ascii: ":"), isSep(p[2], .windows) { return .windows }
        if p.count >= 2, isSep(p[0], .windows), isSep(p[1], .windows) { return .windows }
        return .posix
    }
    static func isAbsolute(_ p: [UInt8]) -> Bool {
        kind(of: p) == .windows || (p.first == UInt8(ascii: "/"))
    }

    /// Unicode's full default lowercase mapping with Final_Sigma, as JavaScript's
    /// toLowerCase(): Foundation's lowercased(with: nil) goes through ICU's root locale.
    static func windowsLower(_ bytes: [UInt8]) -> [UInt8] {
        Array(String(decoding: bytes, as: UTF8.self).lowercased(with: nil).utf8)
    }

    /// `trailing`: strip the separators the path ends with first (for a `@SET DIR`).
    /// Returns nil for a path that isn't absolute.
    static func parse(_ p: [UInt8], stripTrailingSeparators: Bool) -> ParsedPath? {
        let k = kind(of: p)
        var rootLength = 0
        var isShare = false
        var driveLetter: UInt8? = nil
        var rootKey: [UInt8]
        switch k {
        case .windows:
            if p[1] == UInt8(ascii: ":") {
                rootLength = 3; driveLetter = p[0]
                rootKey = windowsLower([p[0]]) + [UInt8(ascii: ":")]
            } else {
                rootLength = 2; isShare = true; rootKey = Array("\\\\".utf8)
            }
        case .posix:
            guard p.first == UInt8(ascii: "/") else { return nil }
            rootLength = 1; rootKey = [UInt8(ascii: "/")]
        }
        var rest = Array(p[rootLength...])
        if stripTrailingSeparators {
            while let l = rest.last, isSep(l, k) { rest.removeLast() }
        }
        var segments: [[UInt8]] = []
        if !rest.isEmpty {
            var cur: [UInt8] = []
            for b in rest {
                if isSep(b, k) { segments.append(cur); cur = [] } else { cur.append(b) }
            }
            segments.append(cur)
        }
        let cmp = k == .windows ? segments.map { windowsLower($0) } : segments
        return ParsedPath(kind: k, isShare: isShare, rootKey: rootKey, driveLetter: driveLetter,
                          rootLength: rootLength, segments: segments, cmpSegments: cmp)
    }

    var hasEmptySegment: Bool { segments.contains { $0.isEmpty } }
    var hasDotSegment: Bool { segments.contains { $0 == [0x2E] || $0 == [0x2E, 0x2E] } }

    func sameRoot(as o: ParsedPath) -> Bool { kind == o.kind && isShare == o.isShare && rootKey == o.rootKey }

    /// Whether `self` (a DIR) holds `path` strictly inside it.
    func contains(_ path: ParsedPath) -> Bool {
        guard sameRoot(as: path), cmpSegments.count < path.cmpSegments.count else { return false }
        return Array(path.cmpSegments[0..<cmpSegments.count]) == cmpSegments
    }
    func equals(_ path: ParsedPath) -> Bool { sameRoot(as: path) && cmpSegments == path.cmpSegments }
}
