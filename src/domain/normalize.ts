import { Schema } from "effect";
import {
  messageId,
  object,
  searchableText,
  sha256,
  timestamp,
  timestampOrder,
} from "./model.ts";

const isMessage = Schema.is(Schema.Struct({ type: Schema.Literal("message") }));

export function normalizeObservation(
  record: unknown,
  workspace: string,
  channel: string,
  users: Map<string, string>,
) {
  const rawJson = JSON.stringify(record);
  if (!object(record))
    return { _tag: "Rejected" as const, reason: "not_object", rawJson };
  if (!isMessage(record))
    return { _tag: "Rejected" as const, reason: "not_message", rawJson };
  const deleted = record.subtype === "message_deleted";
  const ts = timestamp(deleted ? record.deleted_ts : record.ts);
  if (!ts)
    return { _tag: "Rejected" as const, reason: "invalid_timestamp", rawJson };
  const edited = object(record.edited) ? timestamp(record.edited.ts) : null;
  const version = deleted ? (timestamp(record.ts) ?? ts) : (edited ?? ts);
  return {
    _tag: "Accepted" as const,
    id: messageId(workspace, channel, ts),
    channel,
    ts,
    tsOrder: timestampOrder(ts),
    versionOrder: timestampOrder(version),
    threadTs: timestamp(record.thread_ts),
    author:
      typeof record.user === "string"
        ? record.user
        : typeof record.bot_id === "string"
          ? record.bot_id
          : null,
    subtype: typeof record.subtype === "string" ? record.subtype : null,
    deleted: deleted ? 1 : 0,
    text: typeof record.text === "string" ? record.text : "",
    searchText: searchableText(record, users),
    payloadSha256: sha256(rawJson),
    rawJson,
  };
}
