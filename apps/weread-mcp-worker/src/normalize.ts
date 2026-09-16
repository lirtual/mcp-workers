function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function boolFromHasMore(value: unknown): boolean {
  return value === true || value === 1;
}

export function normalizeSearch(payload: Record<string, unknown>) {
  const groups = array(payload.results);
  let lastIdx: number | undefined;
  for (const groupValue of groups) {
    const group = record(groupValue);
    for (const bookValue of array(group.books)) {
      const idx = number(record(bookValue).searchIdx);
      if (idx != null) lastIdx = idx;
    }
  }

  const hasMore = boolFromHasMore(payload.hasMore);
  return {
    sid: string(payload.sid),
    groups,
    hasMore,
    continuation: hasMore && lastIdx != null ? { maxIdx: lastIdx } : undefined,
  };
}

export function normalizeBookshelf(payload: Record<string, unknown>) {
  const books = array(payload.books);
  const albums = array(payload.albums);
  const mp = payload.mp ?? null;
  return {
    books,
    albums,
    mp,
    visibleItemCount: books.length + albums.length + (mp == null ? 0 : 1),
  };
}

export function normalizeNotebooks(payload: Record<string, unknown>) {
  const books = array(payload.books).map((entry) => {
    const item = record(entry);
    const reviewCount = number(item.reviewCount) ?? 0;
    const noteCount = number(item.noteCount) ?? 0;
    const bookmarkCount = number(item.bookmarkCount) ?? 0;
    return {
      ...item,
      totalNoteCount: reviewCount + noteCount + bookmarkCount,
    };
  });
  const last = record(books.at(-1));
  const lastSort = number(last.sort);
  const hasMore = boolFromHasMore(payload.hasMore);
  return {
    totalBookCount: number(payload.totalBookCount),
    totalNoteCount: number(payload.totalNoteCount),
    books,
    hasMore,
    continuation: hasMore && lastSort != null ? { lastSort } : undefined,
  };
}

export function normalizeBookNotes(
  highlightsPayload: Record<string, unknown>,
  thoughtsPayload: Record<string, unknown>,
) {
  const hasMore = boolFromHasMore(thoughtsPayload.hasMore);
  const synckey = number(thoughtsPayload.synckey);
  return {
    book: highlightsPayload.book ?? null,
    chapters: array(highlightsPayload.chapters),
    highlights: array(highlightsPayload.updated),
    thoughts: array(thoughtsPayload.reviews),
    totalThoughtCount: number(thoughtsPayload.totalCount),
    hasMore,
    continuation: hasMore && synckey != null ? { synckey } : undefined,
  };
}

export function normalizePopularHighlights(payload: Record<string, unknown>) {
  return {
    synckey: number(payload.synckey),
    totalCount: number(payload.totalCount),
    chapters: array(payload.chapters),
    highlights: array(payload.items),
  };
}

export function normalizeHighlightThoughts(payload: Record<string, unknown>) {
  const reviews = array(payload.reviews).map((value) => {
    const item = record(value);
    const hasMore = boolFromHasMore(item.hasMore);
    const continuation = hasMore
      ? {
          maxIdx: number(item.maxIdx),
          synckey: number(item.synckey),
        }
      : undefined;
    return { ...item, hasMore, continuation };
  });
  return {
    bookId: string(payload.bookId),
    chapterUid: number(payload.chapterUid),
    reviews,
  };
}

export function normalizePublicReviews(payload: Record<string, unknown>) {
  const reviews = array(payload.reviews);
  const last = record(reviews.at(-1));
  const hasMore = boolFromHasMore(payload.reviewsHasMore ?? payload.hasMore);
  const maxIdx = number(payload.maxIdx) ?? number(last.idx);
  const synckey = number(payload.synckey);
  return {
    reviews,
    reviewsCnt: number(payload.reviewsCnt),
    recentTotalCnt: number(payload.recentTotalCnt),
    friendCommentCount: number(payload.friendCommentCount),
    hasMore,
    continuation:
      hasMore && (maxIdx != null || synckey != null)
        ? { maxIdx, synckey }
        : undefined,
  };
}

export function normalizeRecommendations(
  mode: "personalized" | "similar",
  payload: Record<string, unknown>,
) {
  if (mode === "personalized") {
    const books = array(payload.books);
    const last = record(books.at(-1));
    const maxIdx = number(last.searchIdx);
    return {
      mode,
      books,
      hasMore: typeof payload.hasMore === "undefined" ? undefined : boolFromHasMore(payload.hasMore),
      continuation: maxIdx == null ? undefined : { maxIdx },
    };
  }

  const similar = record(payload.booksimilar);
  const books = array(similar.books);
  const last = record(books.at(-1));
  const maxIdx = number(last.idx);
  const sessionId = string(similar.sessionId);
  return {
    mode,
    books,
    hasMore: typeof similar.hasMore === "undefined" ? undefined : boolFromHasMore(similar.hasMore),
    continuation:
      maxIdx == null && sessionId == null ? undefined : { maxIdx, sessionId },
  };
}
