// s3cab-restore <bucket> <set> <dir> [<snapshot>]
//
// An independent restorer for the s3cab repository format (format.md, spec of 2026-10-20).
// Credentials and region come from AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN
// and AWS_REGION; HTTPS goes through the system libcurl, which honours HTTPS_PROXY.
//
// Development aids, not part of a restore:
//   s3cab-restore --list <bucket> [<prefix>]      list keys and common prefixes one level down
//   s3cab-restore --get <bucket> <key> <file>     download one key's bytes as stored
//   s3cab-restore --parse [--record] <file>       offline: what a restore would make of a local file
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)
let args = Array(CommandLine.arguments.dropFirst())

func usage() -> Never {
    err("usage: s3cab-restore <bucket> <set> <dir> [<snapshot>]")
    exit(2)
}

do {
    switch args.first {
    case "--list":
        guard args.count == 2 || args.count == 3 else { usage() }
        let s3 = try S3Client(bucket: args[1], creds: try Credentials.fromEnvironment())
        let r = try s3.list(prefix: args.count == 3 ? args[2] : "")
        for p in r.prefixes { print("PREFIX \(p)") }
        for k in r.keys { print("KEY    \(k)") }
    case "--get":
        guard args.count == 4 else { usage() }
        let s3 = try S3Client(bucket: args[1], creds: try Credentials.fromEnvironment())
        guard let bytes = try s3.getBytes(args[2]) else { err("\(args[2]): 404 Not Found"); exit(1) }
        try Data(bytes).write(to: URL(fileURLWithPath: args[3]))
    case "--parse":
        // Offline: read a local snapshot (.tsv.gz or plain) or record and print what a restore would do.
        guard args.count == 2 || (args.count == 3 && args[1] == "--record") else { usage() }
        let path = args.last!
        var data = Array(try Data(contentsOf: URL(fileURLWithPath: path)))
        if data.starts(with: [0x1f, 0x8b]) {
            let (text, members) = try gunzip(data)
            print("gzip members: \(members)")
            data = text
        }
        if args[1] == "--record" {
            let r = try parseRecord(data, name: path)
            for x in r.refusedRows { print("REFUSED \(x)") }
            for (h, ds) in r.rows.sorted(by: { $0.key < $1.key }) {
                for d in ds { print("DELETED \(h) \(String(decoding: d.date, as: UTF8.self)) \(quote(d.who))") }
            }
        } else {
            let snap = try parseSnapshot(data)
            for d in snap.dirs { print("DIR \(quote(d.raw)) name=\(d.name.map { quote($0) } ?? "-")") }
            for n in snap.notes { print("NOTE \(n)") }
            for r in snap.refused { print("REFUSED line \(r.line) \(r.path.map { quote($0) } ?? "-"): \(r.why)") }
            do {
                for p in try plan(snap) {
                    print("FILE line \(p.row.line) \(p.row.hash.prefix(8)) \(p.row.mtime.seconds).\(p.row.mtime.millis) -> "
                          + p.dest.map { quote($0) }.joined(separator: "/"))
                }
            } catch { print("PLAN-REFUSED \(error)") }
        }
    default:
        guard args.count == 3 || args.count == 4 else { usage() }
        let s3 = try S3Client(bucket: args[0], creds: try Credentials.fromEnvironment())
        let r = Restorer(s3: s3, set: args[1], output: args[2], snapshot: args.count == 4 ? args[3] : nil)
        exit(r.run())
    }
} catch {
    err("error: \(error)")
    exit(2)
}
