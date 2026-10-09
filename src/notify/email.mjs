// The HTML layout every email from this service shares: the organisation's
// logo and name at the top, a heading, paragraphs, one button-styled link,
// and a footer. Email-client HTML, so tables and inline styles only.
// (The issuer function carries an identical copy; the two functions are
// packaged separately.)

export const ORG_NAME = process.env.ORG_NAME ?? "Digital Credentials Commons";
export const LOGO_URL =
  process.env.LOGO_URL ?? "https://digitalcredentials.github.io/badge-assets/dcc-commons-mark.png";

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// `paragraphs` are HTML strings (escape untrusted text with escapeHtml);
// `button` is { label, url }; `after` is HTML placed under the button.
export function emailHtml({ title, paragraphs, button, after = "" }) {
  return (
    `<!doctype html><html><body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1f2937;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 0;"><tr><td align="center">` +
    `<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:12px;border:1px solid #e5e7eb;">` +
    `<tr><td style="padding:24px 32px 8px 32px;"><img src="${escapeHtml(LOGO_URL)}" alt="" width="44" height="44" style="vertical-align:middle;border:0;">` +
    `<span style="font-size:16px;font-weight:600;vertical-align:middle;margin-left:10px;">${escapeHtml(ORG_NAME)}</span></td></tr>` +
    `<tr><td style="padding:8px 32px 32px 32px;font-size:16px;line-height:1.5;">` +
    `<h1 style="font-size:22px;margin:16px 0;">${escapeHtml(title)}</h1>` +
    paragraphs.map((p) => `<p>${p}</p>`).join("") +
    (button
      ? `<p style="margin:24px 0;"><a href="${escapeHtml(button.url)}" style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;">${escapeHtml(button.label)}</a></p>`
      : "") +
    after +
    `</td></tr>` +
    `<tr><td style="padding:16px 32px;border-top:1px solid #e5e7eb;font-size:13px;color:#6b7280;">${escapeHtml(ORG_NAME)} &middot; Learner Credential Wallet</td></tr>` +
    `</table></td></tr></table></body></html>`
  );
}
