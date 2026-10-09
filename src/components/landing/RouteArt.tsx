export function RouteArt() {
  return (
    <svg className="route-art" viewBox="0 0 420 420" fill="none" aria-hidden="true">
      <circle className="orbit" cx="210" cy="210" r="168" />
      <circle className="orbit orbit-soft" cx="210" cy="210" r="118" />
      <path
        className="route-path"
        d="M72 250C118 170 168 140 210 140c52 0 96 46 138 110"
      />
      <circle className="node" cx="72" cy="250" r="10" />
      <circle className="node" cx="210" cy="140" r="14" />
      <circle className="node node-accent" cx="348" cy="250" r="12" />
      <rect className="packet" x="188" y="196" width="54" height="38" rx="8" />
      <path className="packet-fold" d="M188 208h54L215 224 188 208Z" />
    </svg>
  );
}
