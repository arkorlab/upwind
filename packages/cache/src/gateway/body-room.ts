/**
 * The room an isolate of the gateway keeps for the bodies it reads whole for a write: a value to
 * store (`PUT /data`) and an artifact's upload (`PUT /attempts/:attemptId/artifacts/:sha256`). Each
 * may be as long as an artifact may be, 25 MiB by default, and is held until storage has it —
 * hashed first, since its key there is its digest, and an upload counted against its scope by the
 * authority. An isolate serves every deployment whose requests reach it: six such writes at once,
 * whoever made them, held more than its 128 MB, and its reset failed every request it was
 * answering. Every other body the gateway reads is bounded by the contract at a mebibyte or less —
 * a commit, a batch of small artifacts — and is read beside these as before, and so is a write
 * whose body is no longer (`UNCOUNTED_BODY_BYTES`).
 *
 * The room is the isolate's (`IsolateRoom`): a write waits for it in its own request's time, asking
 * again every few milliseconds, and a write whose request the runtime cancels, its sender gone,
 * gives its place and its room up once its claim lapses rather than holding the room for good.
 */

import { IsolateRoom } from '../isolate-room.ts';

const KIB = 1024;
const BODY_ROOM_MIB = 32;
/**
 * As much as one write alone holds of a body, near enough, and no more: the largest value's body,
 * some 33 MiB, is parsed whole into as much again twice over before its value is decoded, which
 * leaves the isolate no room for a second beside it. A write alone always has room, whatever its
 * body's length: its claim is the whole budget at the most.
 */
export const BODY_ROOM_BYTES = BODY_ROOM_MIB * KIB * KIB;
const UNCOUNTED_MIB = 1;
/**
 * A write whose body may hold no more than this takes no room, and is read as it comes: no more
 * than a commit's (`COMMIT_BODY_BYTES`, `routes/attempts.ts`), which is read without any already.
 * Most values and many artifacts are this small, and they go ahead of a large write that waits for
 * room rather than behind it.
 */
export const UNCOUNTED_BODY_BYTES = UNCOUNTED_MIB * KIB * KIB;
/** The room every write the isolate reads takes its body's bytes from: the module's. */
const room = new IsolateRoom(BODY_ROOM_BYTES);

/**
 * What `write` comes to, made once the isolate has room for the `bytes` its body may hold, and the
 * room given back as it ends, whatever it came to; what `refuse` makes, and nothing written, where
 * none came within `waitMs`. Room is taken at once where there is some and no write waits ahead;
 * otherwise the write waits in the order it asked. A body of `UNCOUNTED_BODY_BYTES` or less takes
 * none, and the write is made at once.
 */
export async function withBodyRoom<T>(
  bytes: number,
  waitMs: number,
  write: () => Promise<T>,
  refuse: () => T,
): Promise<T> {
  if (bytes <= UNCOUNTED_BODY_BYTES) {
    return write();
  }
  const giveBack = await room.takeWithin(bytes, waitMs);
  if (giveBack === undefined) {
    return refuse();
  }
  try {
    return await write();
  } finally {
    giveBack();
  }
}
