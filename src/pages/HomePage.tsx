import { About } from "@/components/landing/About";
import { Contact } from "@/components/landing/Contact";
import { Hero } from "@/components/landing/Hero";
import { Services } from "@/components/landing/Services";
import { PageMeta } from "@/components/layout/PageMeta";
import { useSmoothHashScroll } from "@/hooks/use-smooth-hash-scroll";

export function HomePage() {
  useSmoothHashScroll();

  return (
    <>
      <PageMeta
        title="CTN | Communication & Technology Network"
        description="CTN helps organizations deliver clear, reliable digital communications with practical tools, careful operations, and accountable support."
        canonicalPath="/"
      />
      <main>
        <Hero />
        <Services />
        <About />
        <Contact />
      </main>
    </>
  );
}
