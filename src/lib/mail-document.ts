export function mailMessageSrcDoc(html: string) {
  return `<!DOCTYPE html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; form-action 'none'; base-uri 'none';">
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 14px; line-height: 1.5; color: #1c1917; margin: 0; }
  a { color: #0f7a72; }
  img { display: none !important; }
  blockquote { margin: 0.75rem 0; padding-left: 0.75rem; border-left: 2px solid #d6d3d1; }
  pre { white-space: pre-wrap; }
</style>
</head>
<body>${html}</body>
</html>`;
}
