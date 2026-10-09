export function AuthMarketingPanel() {
  return (
    <div className="relative hidden bg-muted md:block">
      <div className="absolute inset-0 flex flex-col justify-end bg-gradient-to-br from-primary/90 via-primary/70 to-[#141821] p-8 text-primary-foreground">
        <p className="text-sm font-semibold tracking-wide uppercase opacity-80">SendStack</p>
        <p className="mt-2 text-2xl font-semibold leading-tight">
          Compose, queue, and send with accountability.
        </p>
        <p className="mt-3 max-w-sm text-sm text-primary-foreground/85">
          Bulk email operations for CTN Slovakia — outbound delivery is handled securely on the
          server.
        </p>
      </div>
    </div>
  );
}
