// Where each file lands, as format.md describes s3cab's restore to a chosen directory.

struct PlannedFile {
    let row: FileRow
    let dest: [Bytes]   // segments under the output directory
}

enum PlanRefusal: Error, CustomStringConvertible {
    case unnamedBeside(Bytes)
    case nameCollision(Bytes, Bytes, Bytes)

    var description: String {
        switch self {
        case .unnamedBeside(let d):
            return "@SET DIR \(quote(d)) has no folder name of its own, so its files land straight in the output, "
                + "where they could mix with another DIR's folder; refusing the restore"
        case .nameCollision(let a, let b, let n):
            return "@SET DIR rows \(quote(a)) and \(quote(b)) both want the folder \(quote(n)) (ignoring case); "
                + "refusing the restore rather than merging them"
        }
    }
}

/// `<output>/<name of the DIR that matched>/<the rest of the path below that DIR>`. A DIR is
/// reached when a file row that passed every check counts for it (its deepest DIR).
func plan(_ snap: Snapshot) throws -> [PlannedFile] {
    let reached = Set(snap.files.map(\.dirIndex)).sorted()
    if reached.count > 1, let u = reached.first(where: { snap.dirs[$0].name == nil }) {
        throw PlanRefusal.unnamedBeside(snap.dirs[u].raw)
    }
    var byName = [Bytes: Int]()
    for i in reached {
        guard let n = snap.dirs[i].name else { continue }
        if let j = byName[foldCase(n)] { throw PlanRefusal.nameCollision(snap.dirs[j].raw, snap.dirs[i].raw, n) }
        byName[foldCase(n)] = i
    }
    return snap.files.map { f in
        let dir = snap.dirs[f.dirIndex]
        var dest: [Bytes] = []
        if let n = dir.name { dest.append(n) }
        dest += f.path.segments[dir.parsed!.segments.count...]
        return PlannedFile(row: f, dest: dest)
    }
}
