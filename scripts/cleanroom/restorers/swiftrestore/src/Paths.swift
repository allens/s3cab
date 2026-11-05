import Foundation

enum PathKind { case posix, drive, share }

func isWinSep(_ b: UInt8) -> Bool { b == 0x2F || b == 0x5C }
func isAsciiLetter(_ b: UInt8) -> Bool { (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A) }

/// A path split into its root and segments, by the spec's "first characters" rule.
struct ParsedPath {
    let kind: PathKind
    let driveLetter: UInt8?       // upper-case ASCII, for a drive path
    let segments: [Bytes]         // as spelled; for a share the server and share name come first
    var isWindows: Bool { kind != .posix }

    /// Segment keys for `@SET DIR` matching: Windows paths lowercased by Unicode's full default mapping, others exact.
    var matchKeys: [Bytes] {
        if isWindows {
            return segments.map { Array(String(decoding: $0, as: UTF8.self).lowercased(with: nil).utf8) }
        }
        return segments
    }
}

private func splitSegments(_ rest: ArraySlice<UInt8>, windows: Bool) -> [Bytes] {
    if rest.isEmpty { return [] }
    var segs: [Bytes] = []
    var cur = Bytes()
    for b in rest {
        if windows ? isWinSep(b) : b == 0x2F {
            segs.append(cur); cur = Bytes()
        } else {
            cur.append(b)
        }
    }
    segs.append(cur)
    return segs
}

/// Decide the kind from the first characters. Returns nil for a path that is not absolute.
/// `stripTrailingSeparators` is for a `@SET DIR`, whose trailing separators are ignored.
func parsePath(_ u: Bytes, stripTrailingSeparators: Bool) -> ParsedPath? {
    var kind: PathKind
    var rootLen: Int
    var drive: UInt8? = nil
    if u.count >= 3, isAsciiLetter(u[0]), u[1] == 0x3A, isWinSep(u[2]) {
        kind = .drive; rootLen = 3; drive = u[0] & 0xDF
    } else if u.count >= 2, isWinSep(u[0]), isWinSep(u[1]) {
        kind = .share; rootLen = 2
    } else if u.count >= 1, u[0] == 0x2F {
        kind = .posix; rootLen = 1
    } else {
        return nil
    }
    var rest = u[rootLen...]
    if stripTrailingSeparators {
        while let last = rest.last, (kind == .posix ? last == 0x2F : isWinSep(last)) { rest = rest.dropLast() }
    }
    return ParsedPath(kind: kind, driveLetter: drive, segments: splitSegments(rest, windows: kind != .posix))
}

/// A `@SET DIR` row, pre-digested for matching. `usable` is false where the spec says the DIR matches nothing.
struct MemberDir {
    let raw: Bytes
    let parsed: ParsedPath?
    let keys: [Bytes]
    let usable: Bool

    init(raw: Bytes) {
        self.raw = raw
        let p = parsePath(raw, stripTrailingSeparators: true)
        self.parsed = p
        guard let p else { keys = []; usable = false; return }
        var ok = !raw.contains(0)
        if p.segments.contains(where: { $0.isEmpty }) { ok = false }          // doubled separator after the root
        if p.kind == .share && p.segments.count < 2 { ok = false }            // no server or no share name
        keys = p.matchKeys
        usable = ok
    }
}

enum DirMatch { case under, equal, no }

func match(path: ParsedPath, pathKeys: [Bytes], dir: MemberDir) -> DirMatch {
    guard dir.usable, let d = dir.parsed, d.kind == path.kind else { return .no }
    if d.kind == .drive && d.driveLetter != path.driveLetter { return .no }
    if pathKeys.count < dir.keys.count { return .no }
    for i in 0..<dir.keys.count where dir.keys[i] != pathKeys[i] { return .no }
    return pathKeys.count == dir.keys.count ? .equal : .under
}

/// Why a file row's path is refused, or nil when it passes every per-row path rule.
func fileRowPathProblem(_ raw: Bytes, parsed: ParsedPath?) -> String? {
    if raw.contains(TAB) { return "path holds a tab" }
    if raw.contains(CR) { return "path holds a carriage return" }
    if raw.contains(0) { return "path holds a NUL" }
    guard let p = parsed else { return "path is not absolute" }
    let nameSegments: ArraySlice<Bytes>
    switch p.kind {
    case .share:
        if p.segments.count < 2 || p.segments[0].isEmpty || p.segments[1].isEmpty { return "share path has no server or no share name" }
        nameSegments = p.segments[2...]
    default:
        nameSegments = p.segments[0...]
    }
    if nameSegments.isEmpty { return "path is a root with no file name" }
    for s in nameSegments {
        if s.isEmpty { return "path has an empty segment (doubled or trailing separator)" }
        if s == [0x2E] { return "path has a '.' segment" }
        if s == [0x2E, 0x2E] { return "path has a '..' segment" }
    }
    return nil
}

/// Where the file lands under <output>: folder names then the file name, joined with the destination's separator.
func destinationComponents(_ p: ParsedPath) -> [Bytes] {
    switch p.kind {
    case .posix: return p.segments
    case .drive: return [[p.driveLetter!]] + p.segments
    case .share: return [Array("UNC".utf8)] + p.segments
    }
}

/// Does `a` run through `b` as a folder: `b` starts with `a` exactly, then a separator of `b`'s kind.
func runsThrough(_ a: Bytes, _ b: Bytes, bIsWindows: Bool) -> Bool {
    if a.count >= b.count { return false }
    if b[0..<a.count] != a[...] { return false }
    let next = b[a.count]
    return bIsWindows ? isWinSep(next) : next == 0x2F
}
