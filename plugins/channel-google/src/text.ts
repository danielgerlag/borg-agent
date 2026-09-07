import { MAX_INBOUND_CONTENT_LENGTH } from "./protocol";

export function htmlToText(value: string): string {
  return value
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function mailBodyToText(content: string, contentType: string): string {
  const text = /html/i.test(contentType) ? htmlToText(content) : content.trim();
  return text.length <= MAX_INBOUND_CONTENT_LENGTH
    ? text
    : text.slice(0, MAX_INBOUND_CONTENT_LENGTH);
}

export function composeInboundText(
  subject: string | undefined,
  body: string,
): string {
  const trimmedBody = body.trim();
  const trimmedSubject = subject?.trim() ?? "";
  if (trimmedSubject.length > 0 && trimmedBody.length > 0) {
    return `${trimmedSubject}\n\n${trimmedBody}`;
  }
  return trimmedSubject.length > 0 ? trimmedSubject : trimmedBody;
}
