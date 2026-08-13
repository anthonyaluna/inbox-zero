import { load } from "cheerio";
import type { ParsedMessage } from "@/utils/types";
import {
  buildQuotedPlainText,
  quotePlainTextContent,
} from "@/utils/email/quoted-plain-text";
import {
  convertNewlinesToBr,
  escapeHtml,
  textToHtmlParagraphs,
} from "@/utils/string";

export const createOutlookReplyContent = ({
  textContent,
  htmlContent,
  textColor = "#000000",
  signatureHtml,
  message,
}: {
  textContent?: string;
  htmlContent?: string;
  textColor?: string;
  signatureHtml?: string;
  message: Pick<ParsedMessage, "headers" | "textPlain" | "textHtml">;
}): {
  html: string;
  text: string;
} => {
  const quotedDate = formatEmailDate(new Date(message.headers.date));
  const quotedHeader = `On ${quotedDate}, ${message.headers.from} wrote:`;

  // Detect text direction from original message
  const textDirection = detectTextDirection(textContent || "");
  const dirAttribute = `dir="${textDirection}"`;

  // Format plain text version with proper quoting
  const quotedContent = quotePlainTextContent(message.textPlain);
  const safeSignature = signatureHtml
    ? sanitizeStandaloneSignatureHtml(signatureHtml)
    : "";
  const signatureText = safeSignature ? load(safeSignature).text().trim() : "";
  const plainText = buildQuotedPlainText({
    textContent: signatureText
      ? `${textContent ?? ""}\n\n${signatureText}`
      : textContent,
    quotedHeader,
    quotedContent,
  });

  const messageContent =
    message.textHtml ||
    (message.textPlain ? convertNewlinesToBr(message.textPlain) : "");

  const contentHtml =
    htmlContent || (textContent ? renderMixedContentAsHtml(textContent) : "");

  // Coastline drafts use the same compact font family as Anthony's Outlook signature.
  const verifiedTextColor = /^#[0-9a-f]{6}$/i.test(textColor)
    ? textColor.toLowerCase()
    : "#000000";
  const outlookFontStyle = `font-family: Verdana, Arial, Helvetica, sans-serif; font-size: 10pt; color: ${verifiedTextColor};`;
  const signatureBlock = safeSignature
    ? `<div style="${outlookFontStyle} margin-top: 14px;">${safeSignature}</div>`
    : "";

  // Format HTML version with Outlook-style formatting
  const html = [
    `<div ${dirAttribute} style="${outlookFontStyle}">${contentHtml}</div>`,
    ...(signatureBlock ? [signatureBlock] : []),
    "<br>",
    `<div style="border-top: 1px solid #e1e1e1; padding-top: 10px; margin-top: 10px;">
  <div ${dirAttribute} style="font-size: 11pt; color: rgb(0, 0, 0);">${escapeHtml(quotedHeader)}<br></div>
  <div style="margin-top: 10px;">
    ${messageContent}
  </div>
</div>`,
  ]
    .join("\n")
    .trim();

  return {
    text: plainText,
    html,
  };
};

/**
 * Render a standalone Outlook draft with the same deterministic typography as
 * replies. Meeting-recorder drafts do not have a source message to quote, so
 * they use this renderer instead of the reply renderer.
 */
export function createOutlookStandaloneDraftContent({
  textContent,
  textColor = "#000000",
  signatureHtml,
}: {
  textContent: string;
  textColor?: string;
  signatureHtml?: string;
}): { html: string; text: string } {
  const verifiedTextColor = /^#[0-9a-f]{6}$/i.test(textColor)
    ? textColor.toLowerCase()
    : "#000000";
  const dir = detectTextDirection(textContent);
  const style = `font-family: Verdana, Arial, Helvetica, sans-serif; font-size: 10pt; color: ${verifiedTextColor};`;
  const safeSignature = signatureHtml
    ? sanitizeStandaloneSignatureHtml(signatureHtml)
    : "";
  const html = [
    `<div dir="${dir}" style="${style}">${textToHtmlParagraphs(textContent)}</div>`,
    safeSignature ? `<div style="${style}">${safeSignature}</div>` : "",
  ]
    .filter(Boolean)
    .join("\n")
    .trim();

  return {
    html,
    text: safeSignature
      ? `${textContent.trim()}\n\n${load(safeSignature).text().trim()}`
      : textContent.trim(),
  };
}

function detectTextDirection(text: string): "ltr" | "rtl" {
  // Basic RTL detection - checks for RTL characters at the start of the text
  const rtlRegex =
    /[\u0591-\u07FF\u200F\u202B\u202E\uFB1D-\uFDFD\uFE70-\uFEFC]/;
  return rtlRegex.test(text.trim().charAt(0)) ? "rtl" : "ltr";
}

function renderMixedContentAsHtml(content: string): string {
  const $ = load(content, null, false);

  $.root()
    .contents()
    .each((_index, node) => {
      if (node.type !== "text") return;

      $(node).replaceWith(convertNewlinesToBr(escapeHtml(node.data)));
    });

  return $.root().html() ?? "";
}

function sanitizeStandaloneSignatureHtml(signatureHtml: string): string {
  const $ = load(signatureHtml, null, false);
  $("script, iframe, object, embed, form").remove();
  $("*").each((_index, element) => {
    $(element).removeAttr("onerror");
    $(element).removeAttr("onclick");
    $(element).removeAttr("onload");
  });
  return $.root().html() ?? "";
}

export function formatEmailDate(date: Date): string {
  const weekday = date.toLocaleString("en-US", { weekday: "short" });
  const month = date.toLocaleString("en-US", { month: "short" });
  const day = date.getDate();
  const year = date.getFullYear();
  const hour = date.getHours();
  const minute = date.getMinutes();

  // Format: "Thu, 6 Feb 2025 at 23:23"
  return `${weekday}, ${day} ${month} ${year} at ${hour}:${minute.toString().padStart(2, "0")}`;
}
