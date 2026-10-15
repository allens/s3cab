/**
 * Make this test machine the holder of a set, as `setup` or `takeover` would
 * (ADR-0108): write the bucket's marker and keep the pair locally. For a test
 * that builds its set with `writeSet` and then publishes a snapshot, which is
 * refused without it.
 *
 * Imports set-marker.mjs on first call, not at load: a test that mocks s3.mjs
 * registers the mock before its own dynamic imports, and a static import here
 * would bind the real one first.
 * @param {string} bucket
 * @param {string} name - The set's name
 * @param {string} claimPath - Where the set keeps its pair (`BackupSet.claimPath`)
 * @returns {Promise<void>}
 */
export async function holdSet(bucket, name, claimPath) {
  const { freshInfo, writeClaim, writeRemoteInfo } =
    await import("../../src/lib/set-marker.mjs");
  const info = freshInfo();
  await writeRemoteInfo(bucket, name, info);
  writeClaim(claimPath, info);
}
