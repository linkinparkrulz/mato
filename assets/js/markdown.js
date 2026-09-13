// Minimal, dependency-free Markdown renderer.
// Supports the subset used by the content/*.md files: headings (#..######),
// paragraphs, unordered lists (- / *), blockquotes (>), and the inline forms
// **bold**, `code`, and [text](url). HTML in the source is escaped, so content
// authors can write plain Markdown without worrying about markup.
//
// ON TRUST. Everything this renders today is written by whoever maintains the
// instance and shipped in the repository: content/about.md and content/faq.md,
// and nothing else calls markdown.render. Under that assumption the escaping
// below is a convenience, not a boundary, because an author who wanted a script
// tag on the page could simply put one in index.html.
//
// It is nonetheless written as though the input were hostile, because the gap
// between "only maintainers write this" and "anyone can" is one call site. If a
// future change renders ANY of the following, this file becomes a real security
// boundary and should be read again with that in mind:
//   - a submission field (node name, jurisdiction, hardware, the operator note)
//   - anything fetched from another instance, including during a bootstrap
//     import or a federated update
//   - a file an operator can drop into content/ without a commit
// Two things in particular were fixed ahead of that day: the quote character
// was not escaped, so a link URL could close the href attribute and open a new
// one (browsers accept `href="x"onfocus=…` without whitespace); and any scheme
// at all was accepted, so javascript: and data: URLs became live links.
(function (global) {
  // Quotes included. Without them, escaping is enough for TEXT but not for an
  // attribute value, and the link rule below interpolates into href="…".
  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // An allowlist, not a denylist of the schemes that happen to be dangerous
  // today. http and https cover every link in the content and every link a
  // reader of an onion site should be following; anything else, including
  // javascript:, data:, vbscript: and file:, renders as plain text so the
  // author can see their link did not work rather than shipping a live one.
  //
  // Applied to the RAW url, before entity-escaping: "java&#115;cript:x" is not
  // a scheme this accepts, and the check must not be fooled by a spelling that
  // only becomes a scheme after the browser decodes it. Leading control
  // characters and whitespace are stripped first for the same reason, since
  // browsers ignore them when resolving a URL.
  function safeUrl(u) {
    const cleaned = u.replace(/[\u0000-\u0020]/g, "");
    // A scheme is everything before the first colon, if that comes before the
    // first slash, question mark or hash. No colon in that position means a
    // relative URL, which cannot execute anything.
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(cleaned);
    if (!m) return !/^\/\//.test(cleaned) ? cleaned : null;   // protocol-relative is not relative
    const scheme = m[1].toLowerCase();
    return scheme === "http" || scheme === "https" ? cleaned : null;
  }

  function inline(s) {
    s = escapeHtml(s);
    s = s.replace(/`([^`]+)`/g, (_, c) => "<code>" + c + "</code>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, t, u) => {
      // u arrives already entity-escaped, and that is fine to judge directly:
      // none of & < > " ' is a legal scheme character, so escaping cannot turn
      // a dangerous scheme into an acceptable one or the reverse. Decoding
      // first, which an earlier version did to "see what the browser sees",
      // bought nothing and introduced a double-unescape (CodeQL js/double-
      // escaping) where &amp;#39; unwound one layer too many.
      if (!safeUrl(u)) return whole;      // leave the markdown visible, unlinked
      return '<a href="' + u + '" target="_blank" rel="noopener">' + t + "</a>";
    });
    return s;
  }
  function render(md) {
    const lines = String(md).replace(/\r\n/g, "\n").split("\n");
    let html = "", i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*$/.test(line)) { i++; continue; }

      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { const l = h[1].length; html += `<h${l}>${inline(h[2].trim())}</h${l}>`; i++; continue; }

      if (/^\s*>/.test(line)) {                       // blockquote (recurses)
        const block = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) { block.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
        html += "<blockquote>" + render(block.join("\n")) + "</blockquote>";
        continue;
      }
      if (/^\s*[-*]\s+/.test(line)) {                 // unordered list
        html += "<ul>";
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          html += "<li>" + inline(lines[i].replace(/^\s*[-*]\s+/, "")) + "</li>"; i++;
        }
        html += "</ul>";
        continue;
      }
      const para = [];                                // paragraph
      while (i < lines.length && !/^\s*$/.test(lines[i]) &&
             !/^(#{1,6})\s/.test(lines[i]) && !/^\s*>/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i])) {
        para.push(lines[i].trim()); i++;
      }
      html += "<p>" + inline(para.join(" ")) + "</p>";
    }
    return html;
  }

  const api = { render };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.markdown = api;
})(typeof window !== "undefined" ? window : globalThis);
