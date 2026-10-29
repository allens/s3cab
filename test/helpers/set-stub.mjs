/**
 * The set an upload runs for, for an integration test that keeps no s3cab
 * home: the names and paths `uploadSnapshot` reads. The real lock (ADR-0112)
 * runs over it.
 * @param {object} args
 * @param {string} args.name - The set's name
 * @param {string} args.bucket - Its bucket
 * @param {string} args.snapshotsDir - The temp folder holding its snapshots
 * @param {string} args.claimPath - Its `claim` file
 */
export const setStub = ({ name, bucket, snapshotsDir, claimPath }) => ({
  name,
  bucket,
  snapshotsDir,
  claimPath,
});
