import Foundation

// Paths are bytes throughout. Two paths are the same only when their bytes are; the one
// exception the format makes is a Windows path against a @SET DIR, which ignores case.

enum PathKind {
    case posix      // root "/"
    case drive      // root "C:\" or "c:/"            (a Windows path)
    case share      // root: any two of "\" and "/"   (a Windows path)
}

struct ParsedPath {
    let kind: PathKind
    /// The drive letter in upper case, for `.drive`; 0 otherwise.
    let drive: UInt8
    let rootLength: Int
    /// What follows the root, split on the kind's separators. Empty segments are kept, so a
    /// doubled or trailing separator shows up as one.
    let segments: [[UInt8]]

    var isWindows: Bool { kind != .posix }
}

private let slash: UInt8 = 0x2F
private let backslash: UInt8 = 0x5C

func isSeparator(_ b: UInt8, windows: Bool) -> Bool {
    b == slash || (windows && b == backslash)
}

private func isASCIILetter(_ b: UInt8) -> Bool {
    (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A)
}

/// What kind of path this is, told by its first characters alone, and how long its root is.
/// nil when the path is not absolute.
func pathRoot(_ p: [UInt8]) -> (kind: PathKind, rootLength: Int)? {
    if p.count >= 3, isASCIILetter(p[0]), p[1] == 0x3A, isSeparator(p[2], windows: true) { return (.drive, 3) }
    if p.count >= 2, isSeparator(p[0], windows: true), isSeparator(p[1], windows: true) { return (.share, 2) }
    if p.count >= 1, p[0] == slash { return (.posix, 1) }
    return nil
}

/// Splits a path into its root and segments. With `asDirectory`, every separator the path
/// ends with after its root is ignored first, which is how a @SET DIR is read.
func parsePath(_ p: [UInt8], asDirectory: Bool = false) -> ParsedPath? {
    guard let (kind, rootLength) = pathRoot(p) else { return nil }
    let windows = kind != .posix
    var end = p.count
    if asDirectory {
        while end > rootLength && isSeparator(p[end - 1], windows: windows) { end -= 1 }
    }
    var segments = [[UInt8]]()
    if end > rootLength {
        var start = rootLength
        for i in rootLength..<end where isSeparator(p[i], windows: windows) {
            segments.append(Array(p[start..<i]))
            start = i + 1
        }
        segments.append(Array(p[start..<end]))
    }
    let drive: UInt8 = kind == .drive ? (p[0] >= 0x61 ? p[0] - 32 : p[0]) : 0
    return ParsedPath(kind: kind, drive: drive, rootLength: rootLength, segments: segments)
}

/// Unicode's full default lower-casing, Final_Sigma included, never normalized: what
/// JavaScript's toLowerCase() gives. That is ICU's u_strToLower with the root locale, from the
/// system's libicucore. Neither Swift alternative is it: the standard library's lowercased()
/// skips Final_Sigma, and Foundation's lowercased(with: nil) applies it without looking past
/// case-ignorable characters (it makes `ΟΔΟΣ.txt` end its first word in a final sigma, where
/// JavaScript does not).
func lowercasedForMatching(_ segment: [UInt8]) -> [UInt8] {
    if segment.allSatisfy({ $0 < 0x80 }) {
        return segment.map { ($0 >= 0x41 && $0 <= 0x5A) ? $0 + 32 : $0 }
    }
    let source = Array(String(decoding: segment, as: UTF8.self).utf16)
    var lowered = [UInt16](repeating: 0, count: source.count * 3 + 8)
    var status = U_ZERO_ERROR
    let n = u_strToLower(&lowered, Int32(lowered.count), source, Int32(source.count), "", &status)
    precondition(status.rawValue <= U_ZERO_ERROR.rawValue && n >= 0 && Int(n) <= lowered.count, "ICU could not lower-case a name")
    return Array(String(decoding: lowered[0..<Int(n)], as: UTF16.self).utf8)
}

/// A @SET DIR ready for matching. Windows segments are held lower-cased.
struct MemberDir {
    let kind: PathKind
    let drive: UInt8
    let segments: [[UInt8]]

    /// nil for a value that names no directory or can match nothing: empty, not absolute, a
    /// doubled separator after the root, or a share with no server or no share name.
    init?(value: [UInt8]) {
        guard !value.isEmpty, let p = parsePath(value, asDirectory: true) else { return nil }
        if p.segments.contains(where: { $0.isEmpty }) { return nil }
        if p.kind == .share && p.segments.count < 2 { return nil }
        kind = p.kind
        drive = p.drive
        segments = p.isWindows ? p.segments.map(lowercasedForMatching) : p.segments
    }
}

enum DirRelation {
    case outside
    case inside     // strictly under it
    case equal      // the directory itself
}

/// Whole segments, never a string prefix. `rowSegments` are the path's own, lower-cased
/// already when the path is a Windows one.
func relation(of kind: PathKind, drive: UInt8, rowSegments: [[UInt8]], to dir: MemberDir) -> DirRelation {
    guard kind == dir.kind, drive == dir.drive, rowSegments.count >= dir.segments.count else { return .outside }
    for i in 0..<dir.segments.count where rowSegments[i] != dir.segments[i] { return .outside }
    return rowSegments.count == dir.segments.count ? .equal : .inside
}

/// Where a path lands under the output folder: the root turned into a folder (the drive's
/// letter in upper case, `UNC` for a share, nothing for `/`), then every segment as spelled.
func landingComponents(_ p: ParsedPath) -> [[UInt8]] {
    switch p.kind {
    case .posix: return p.segments
    case .drive: return [[p.drive]] + p.segments
    case .share: return [Array("UNC".utf8)] + p.segments
    }
}
