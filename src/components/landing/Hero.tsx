import { Button } from "@/components/ui/button";
import { RouteArt } from "@/components/landing/RouteArt";

export function Hero() {
  return (
    <section className="hero" aria-labelledby="hero-heading">
      <div className="shell">
        <div className="hero-grid">
          <div className="hero-copy">
            <p className="brand-hero">CTN</p>
            <h1 id="hero-heading">Messages that arrive with trust intact.</h1>
            <p className="lead">
              Communication &amp; Technology Network helps organizations send clearer mail, protect
              recipient consent, and run delivery operations without the guesswork.
            </p>
            <div className="hero-actions">
              <Button asChild size="lg" className="btn btn-primary rounded-[0.6rem] px-5 py-3 text-base">
                <a href="#contact">Talk to us</a>
              </Button>
              <Button
                asChild
                variant="secondary"
                size="lg"
                className="btn btn-secondary rounded-[0.6rem] px-5 py-3 text-base"
              >
                <a href="#services">See what we do</a>
              </Button>
            </div>
          </div>
          <div className="hero-visual" aria-hidden="true">
            <RouteArt />
          </div>
        </div>
      </div>
    </section>
  );
}
