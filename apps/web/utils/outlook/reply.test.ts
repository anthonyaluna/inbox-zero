import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  createOutlookReplyContent,
  createOutlookStandaloneDraftContent,
} from "@/utils/outlook/reply";
import type { ParsedMessage } from "@/utils/types";

describe("Outlook email formatting", () => {
  // Set a specific timezone offset for consistent testing
  const testDate = new Date("2025-02-06T22:35:00.000Z");

  // Thanks to the LLM for helping mock this
  beforeEach(() => {
    // Mock the date to a fixed UTC timestamp
    vi.useFakeTimers();
    vi.setSystemTime(testDate);

    // Mock all date methods to use UTC values
    vi.spyOn(Date.prototype, "getHours").mockImplementation(function (
      this: Date,
    ) {
      return this.getUTCHours();
    });

    vi.spyOn(Date.prototype, "getMinutes").mockImplementation(function (
      this: Date,
    ) {
      return this.getUTCMinutes();
    });

    vi.spyOn(Date.prototype, "getDate").mockImplementation(function (
      this: Date,
    ) {
      return this.getUTCDate();
    });

    // Mock individual toLocaleString calls used by formatEmailDate
    const mockToLocaleString = vi.spyOn(Date.prototype, "toLocaleString");
    mockToLocaleString.mockImplementation(function (
      this: Date,
      _locales?: Intl.LocalesArgument,
      options?: Intl.DateTimeFormatOptions,
    ) {
      if (options?.weekday === "short") return "Thu";
      if (options?.month === "short") return "Feb";
      if (options?.year === "numeric") return "2025";
      if (options?.day === "numeric") return "6";
      return ""; // Default case
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("formats reply email with Coastline Outlook formatting", () => {
    const textContent = "This is my reply";
    const message: Pick<ParsedMessage, "headers" | "textPlain" | "textHtml"> = {
      headers: {
        date: "Thu, 6 Feb 2025 23:23:47 +0200",
        from: "John Doe <john@example.com>",
        subject: "Test Email",
        to: "jane@example.com",
        "message-id": "<123@example.com>",
      },
      textPlain: "Original message content",
      textHtml: "<div>Original message content</div>",
    };

    const { html } = createOutlookReplyContent({
      textContent,
      htmlContent: "",
      textColor: "#0f172a",
      message,
    });

    expect(html).toBe(
      `<div dir="ltr" style="font-family: Verdana, Arial, Helvetica, sans-serif; font-size: 10pt; color: #0f172a;">This is my reply</div>
<br>
<div style="border-top: 1px solid #e1e1e1; padding-top: 10px; margin-top: 10px;">
  <div dir="ltr" style="font-size: 11pt; color: rgb(0, 0, 0);">On Thu, 6 Feb 2025 at 21:23, John Doe &lt;john@example.com&gt; wrote:<br></div>
  <div style="margin-top: 10px;">
    <div>Original message content</div>
  </div>
</div>`.trim(),
    );
  });

  it("preserves source newlines inside an HTML signature", () => {
    const textContent = `Thanks for your email.

<table cellspacing="0" cellpadding="0">
  <tr>
    <td>
      <img src="https://example.com/logo.jpg" width="262" height="109" alt="Company logo" />
    </td>
    <td>
      <div>Employee Name</div>
      <div>Job Title</div>
    </td>
  </tr>
</table>`;
    const message: Pick<ParsedMessage, "headers" | "textPlain" | "textHtml"> = {
      headers: {
        date: "Thu, 6 Feb 2025 23:23:47 +0200",
        from: "John Doe <john@example.com>",
        subject: "Test Email",
        to: "jane@example.com",
        "message-id": "<123@example.com>",
      },
      textPlain: "Original message content",
      textHtml: "<div>Original message content</div>",
    };

    const { html } = createOutlookReplyContent({
      textContent,
      message,
    });

    expect(html).toContain(
      'Thanks for your email.<br><br><table cellspacing="0" cellpadding="0">',
    );
    expect(html).toContain(
      '<img src="https://example.com/logo.jpg" width="262" height="109" alt="Company logo">',
    );
    expect(html).not.toMatch(/<table[^>]*><br>/);
    expect(html).not.toMatch(/<tr><br>/);
    expect(html).not.toMatch(/<td><br>/);
  });

  it("accepts only a normalized signature text color at the HTML renderer boundary", () => {
    const { html } = createOutlookReplyContent({
      textContent: "Draft",
      textColor: "#000000; background:url(unsafe)",
      message: {
        headers: {
          date: "2025-02-06",
          from: "a@example.com",
          subject: "S",
          to: "b@example.com",
        },
        textPlain: "Original",
        textHtml: "",
      },
    });
    expect(html).toContain("color: #000000;");
    expect(html).not.toContain("background:url");
  });

  it("keeps escaped markup in text content escaped", () => {
    const message: Pick<ParsedMessage, "headers" | "textPlain" | "textHtml"> = {
      headers: {
        date: "Thu, 6 Feb 2025 23:23:47 +0200",
        from: "John Doe <john@example.com>",
        subject: "Test Email",
        to: "jane@example.com",
        "message-id": "<123@example.com>",
      },
      textPlain: "Original message content",
      textHtml: "<div>Original message content</div>",
    };

    const { html } = createOutlookReplyContent({
      textContent:
        'Use &lt;script&gt;alert("unsafe")&lt;/script&gt;\nNext line',
      message,
    });

    expect(html).toContain(
      'Use &lt;script&gt;alert("unsafe")&lt;/script&gt;<br>Next line',
    );
    expect(html).not.toContain("<script>");
  });

  it("renders standalone meeting drafts with Verdana, signature color, and a sanitized signature", () => {
    const { html, text } = createOutlookStandaloneDraftContent({
      textContent: "Thanks for the discussion.",
      textColor: "#123456",
      signatureHtml: '<p>Anthony A. Luna</p><script>alert("unsafe")</script>',
    });

    expect(html).toContain(
      "font-family: Verdana, Arial, Helvetica, sans-serif; font-size: 10pt; color: #123456;",
    );
    expect(html).toContain("Anthony A. Luna");
    expect(html).not.toContain("<script>");
    expect(text).toContain("Anthony A. Luna");
  });

  it("formats reply email correctly for RTL content with Outlook styling", () => {
    const textContent = "שלום, מה שלומך?"; // "Hello, how are you?" in Hebrew
    const message: Pick<ParsedMessage, "headers" | "textPlain" | "textHtml"> = {
      headers: {
        date: "Thu, 6 Feb 2025 23:23:47 +0200",
        from: "David Cohen <david@example.com>",
        subject: "Test Email",
        to: "sarah@example.com",
        "message-id": "<123@example.com>",
      },
      textPlain: "תוכן ההודעה המקורית", // "Original message content" in Hebrew
      textHtml: "<div>תוכן ההודעה המקורית</div>",
    };

    const { html } = createOutlookReplyContent({
      textContent,
      htmlContent: "",
      message,
    });

    expect(html).toBe(
      `<div dir="rtl" style="font-family: Verdana, Arial, Helvetica, sans-serif; font-size: 10pt; color: #000000;">שלום, מה שלומך?</div>
<br>
<div style="border-top: 1px solid #e1e1e1; padding-top: 10px; margin-top: 10px;">
  <div dir="rtl" style="font-size: 11pt; color: rgb(0, 0, 0);">On Thu, 6 Feb 2025 at 21:23, David Cohen &lt;david@example.com&gt; wrote:<br></div>
  <div style="margin-top: 10px;">
    <div>תוכן ההודעה המקורית</div>
  </div>
</div>`.trim(),
    );
  });

  it("generates proper plain text format", () => {
    const textContent = "This is my reply";
    const message: Pick<ParsedMessage, "headers" | "textPlain" | "textHtml"> = {
      headers: {
        date: "Thu, 6 Feb 2025 23:23:47 +0200",
        from: "John Doe <john@example.com>",
        subject: "Test Email",
        to: "jane@example.com",
        "message-id": "<123@example.com>",
      },
      textPlain: "Original message content",
      textHtml: "<div>Original message content</div>",
    };

    const { text } = createOutlookReplyContent({
      textContent,
      htmlContent: "",
      message,
    });

    expect(text).toBe(
      `This is my reply

On Thu, 6 Feb 2025 at 21:23, John Doe <john@example.com> wrote:

> Original message content`,
    );
  });
});
