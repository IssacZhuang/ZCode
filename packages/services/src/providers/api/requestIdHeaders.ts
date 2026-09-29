import { createUuid } from "@zcode/shared";

const REQUEST_ID_HEADER_NAME = "x-request-id";

export function withRequestIdHeader(headers: RequestInit["headers"] | undefined): Headers {
  const next = new Headers(headers);
  if (!next.has(REQUEST_ID_HEADER_NAME)) {
    next.set(REQUEST_ID_HEADER_NAME, createUuid());
  }
  return next;
}
