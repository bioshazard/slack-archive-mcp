import type { Manifest } from "./model.ts";

export interface Page {
  limit?: number;
  offset?: number;
  generation?: string;
}
export interface SearchOptions extends Page {
  query: string;
  mode?: "all" | "any" | "phrase" | "exact";
  prefix?: boolean;
  channel?: string;
  author?: string;
  after?: string;
  before?: string;
  sort?: "relevance" | "oldest" | "newest";
}
export interface ContextOptions {
  before?: number;
  after?: number;
  generation?: string;
}
export interface MessageResult {
  id: string;
  channel: { id: string; name: string };
  ts: string;
  timestamp: string;
  threadTs: string | null;
  author: { id: string | null; name: string | null };
  subtype: string | null;
  deleted: boolean;
  text: string;
  textLength: number;
  textTruncated: boolean;
  snippet?: string;
  score?: number;
  citation: {
    uri: string;
    generation: string;
    export: string;
    file: string;
    index: number;
    fileSha256: string;
    payloadSha256: string;
    archive?: { file: string; sha256: string; entry: string };
  };
}
export interface ChannelResult {
  id: string;
  name: string;
  messages: number;
  first_ts: string | null;
  last_ts: string | null;
  aliases: string[];
}
export interface ObservationResult {
  observationId: number;
  selected: boolean;
  text: string;
  textTruncated: boolean;
  export: string;
  file: string;
  index: number;
  payloadSha256: string;
  rawJson: string;
  rawJsonTruncated: boolean;
}
export interface SearchResult {
  generation: string;
  results: MessageResult[];
  nextOffset: number | null;
}
export interface ChannelsResult {
  generation: string;
  channels: ChannelResult[];
  nextOffset: number | null;
}
export interface ThreadResult {
  generation: string;
  threadTs: string;
  parentAvailable: boolean;
  messages: MessageResult[];
  nextOffset: number | null;
}
export interface ContextResult {
  generation: string;
  anchorId: string;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  messages: MessageResult[];
}
export interface HistoryResult {
  generation: string;
  message: MessageResult;
  observations?: ObservationResult[];
  nextOffset?: number | null;
}
export type ArchiveStatus = Manifest & { note: string };
