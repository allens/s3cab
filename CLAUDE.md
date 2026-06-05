# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

s3cab is an "eternally open S3 content addressable backup" tool written in Node.js. It creates snapshots of directories, storing file metadata (hash, size, mtime) in compressed TSV files, designed to eventually sync with S3 for backup purposes.

## Commands

### Running Tests
```bash
npm test                    # Run all tests
npm run test:watch         # Run tests in watch mode
npm run test:snapshot      # Update test snapshots
npm run test:coverage      # Run tests with coverage report
```

### Linting
```bash
npm run lint               # Check for linting errors
npm run lint:fix          # Auto-fix linting errors
```

### Building
```bash
npm run build             # Build the bundled executable (bin/s3cab.cjs)
```

### Cleaning
```bash
npm run clean             # Clear test S3 bucket (requires AWS profile: s3cab-test)
npm run clean:config      # Erase local configuration
```

### Running the CLI
The CLI entry point is `src/cli.mjs`. Commands are defined in `src/commands/`:

```bash
node src/cli.mjs snapshot <dir>           # Create snapshot of directory
node src/cli.mjs tree <dir>               # List files in directory (respects exclude rules)
node src/cli.mjs compare <dir> <current> <previous>  # Compare two snapshots
node src/cli.mjs list <dir>               # List snapshots in directory
node src/cli.mjs prop <file>              # Show file properties (hash, size, mtime)
```

All commands support a `--debug` flag for detailed output.

## Architecture

### Core Components

**CLI Layer** (`src/cli.mjs`)
- Command-line argument parsing using Node's `util.parseArgs`
- Command registry with standardized option/argument structure
- Error handling and usage display
- All commands return data structures (not just side effects)

**Commands** (`src/commands/`)
- `tree.mjs`: File discovery with glob-based exclusion patterns (reads `.s3cab/exclude.txt`)
- `snapshot.mjs`: Creates timestamped snapshots, compares with previous snapshot
- `compare.mjs`: Diffs two snapshots to find added/modified/deleted/moved files
- `list.mjs`: Lists available snapshots in chronological order
- `prop.mjs`: Computes file properties (SHA-256 hash, size, mtime) with optional lookup from previous snapshot

**Snapshot System** (`src/snapshot-file.mjs`)
- Snapshot file format: TSV with fixed-width columns (43-char hash, 11-char size, 24-char ISO timestamp, path)
- Snapshots stored in `.s3cab/snapshots/` as `YYYY-MM-DDTHHMM.tsv.gz`
- Comment lines start with `#` (e.g., `#ERROR` for file read failures)
- Reading/writing uses streaming for memory efficiency

**Utilities**
- `logger.mjs`: Logging helpers, byte/duration formatting, dual output (console + file stream)
- `read-lines.mjs`: Line-by-line file reading with comment filtering
- `error.mjs`: Custom error types (e.g., `ParseArgsError`)

### Data Flow

1. **Snapshot creation**: `tree()` → `prop()` (with optional previous snapshot lookup) → write `.s3cab/snapshots/*.tsv.gz` → `compare()` with previous
2. **Exclude system**: `.s3cab/exclude.txt` uses glob patterns (`*`, `**`, `/` separator) to filter files during tree walk
3. **File hashing**: SHA-256 in base64url format (43 chars), computed via streaming for large files
4. **Temporal**: Uses `@js-temporal/polyfill` for precise timestamp handling

### Key Patterns

- **Streaming everywhere**: File reads/writes use Node streams to handle large files
- **Lookup optimization**: When creating snapshots, unchanged files (by mtime/size) reuse hashes from previous snapshot
- **Immutable snapshots**: Snapshots are never modified after creation (comparison creates new snapshot)
- **Module organization**: Each command is self-contained with co-located tests (`*.test.mjs`)

## File Structure

```
src/
  cli.mjs              # CLI entry point
  commands/            # Command implementations
    snapshot.mjs       # Snapshot creation
    compare.mjs        # Snapshot comparison
    tree.mjs           # File tree walking with exclusions
    prop.mjs           # File property computation
    list.mjs           # Snapshot listing
    *.test.mjs         # Co-located tests
  snapshot-file.mjs    # Snapshot file format I/O
  logger.mjs           # Logging utilities
  read-lines.mjs       # Line reading utility
  error.mjs            # Custom error types
  _deprecated/         # Old code kept for reference

.s3cab/
  exclude.txt          # Glob patterns to exclude from snapshots
  snapshots/           # Timestamped snapshot files (*.tsv.gz)

test/
  fixtures/            # Test fixture directories
  *.mjs                # Test files
```

## Important Implementation Details

- **Node version**: Requires Node.js >=25.2.1 (see `engines` in package.json, `.nvmrc`)
- **Module system**: ES Modules (`"type": "module"` in package.json, `.mjs` extensions)
- **Testing**: Uses Node's built-in test runner with `--experimental-test-module-mocks`
- **AWS SDK**: Dependencies include `@aws-sdk/client-s3`, `@aws-sdk/lib-storage` (S3 integration not yet fully implemented)
- **Path handling**: All paths normalized with `realpathSync.native()`, uses `/` as separator in snapshots
- **Concurrency**: No lock file yet (TODO in snapshot.mjs:34) - concurrent snapshots can collide

## Testing Patterns

Tests use Node's built-in test runner with:
- Test files named `*.test.mjs` (excluded from snapshots via `.s3cab/exclude.txt`)
- Fixtures in `test/fixtures/`
- Environment variables loaded from `.env.testing`
- Mock support via `--experimental-test-module-mocks`
