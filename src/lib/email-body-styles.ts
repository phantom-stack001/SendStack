/** Email-safe body CSS for sandboxed preview iframes (lists, headings, links). */
export const EMAIL_BODY_PREVIEW_CSS = `
  body {
    margin: 0;
    padding: 16px;
    font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
    font-size: 15px;
    line-height: 1.6;
    color: #141821;
    background: #ffffff;
  }
  a { color: #0f7a72; text-decoration: underline; }
  h1, h2, h3 { line-height: 1.25; margin: 1rem 0 0.5rem; font-weight: 600; }
  p { margin: 0 0 0.75rem; }
  ul {
    list-style-type: disc;
    margin: 0.75rem 0;
    padding-left: 1.5rem;
  }
  ol {
    list-style-type: decimal;
    margin: 0.75rem 0;
    padding-left: 1.5rem;
  }
  li { margin: 0.25rem 0; }
  li > p { margin: 0; }
  ul ul { list-style-type: circle; }
  ul ul ul { list-style-type: square; }
  ol ol { list-style-type: lower-alpha; }
  blockquote {
    margin: 0 0 0.75rem;
    padding-left: 0.75rem;
    border-left: 3px solid #dcecea;
    color: #5b6578;
  }
`;
