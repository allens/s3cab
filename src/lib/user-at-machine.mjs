import { hostname, userInfo } from "node:os";

/**
 * Who is acting, as `user@machine`: the form every s3cab record of who did
 * something takes — a set's `OWNER`, a deletion record's last column
 * ([ADR-0098](../../docs/adr/0098-snapshot-row-layout.md)).
 * @returns {string}
 */
export const userAtMachine = () => `${userInfo().username}@${hostname()}`;
