import type { Metadata } from "next";
import { Fraunces, Manrope } from "next/font/google";
import Link from "next/link";
import styles from "./page.module.css";

const display = Fraunces({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

const sans = Manrope({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "CTN | Communication & Technology Network",
  description:
    "CTN helps organizations deliver clear, reliable digital communications with practical tools, careful operations, and accountable support.",
};

const services = [
  {
    title: "Campaign delivery",
    body: "Plan and send transactional and marketing messages with clear ownership, consent tracking, and delivery feedback.",
  },
  {
    title: "Operations support",
    body: "Keep sending domains authenticated, lists clean, and suppression rules applied so everyday delivery stays predictable.",
  },
  {
    title: "Content systems",
    body: "Build reusable templates and review flows so teams publish consistent messages without reinventing every send.",
  },
  {
    title: "Advisory",
    body: "Get practical guidance on DNS authentication, warmup, and deliverability hygiene before volume ramps up.",
  },
];

export default function LandingPage() {
  return (
    <div className={`${styles.page} ${display.variable} ${sans.variable}`}>
      <div className={styles.atmosphere} aria-hidden="true">
        <div className={styles.glowA} />
        <div className={styles.glowB} />
        <div className={styles.gridlines} />
      </div>

      <header className={styles.header}>
        <div className={styles.shell}>
          <div className={styles.headerRow}>
            <Link className={styles.brand} href="/">
              <span className={styles.brandMark} aria-hidden="true">
                C
              </span>
              <span className={styles.brandName}>CTN</span>
            </Link>
            <nav className={styles.nav} aria-label="Primary">
              <a href="#services">Services</a>
              <a href="#about">About</a>
              <a href="#contact">Contact</a>
              <Link className={styles.navCta} href="/app">
                Sign in
              </Link>
            </nav>
          </div>
        </div>
      </header>

      <main>
        <section className={styles.hero} aria-labelledby="hero-heading">
          <div className={styles.shell}>
            <div className={styles.heroGrid}>
              <div className={styles.heroCopy}>
                <p className={styles.brandHero}>CTN</p>
                <h1 id="hero-heading">Messages that arrive with trust intact.</h1>
                <p className={styles.lead}>
                  Communication &amp; Technology Network helps organizations send clearer mail,
                  protect recipient consent, and run delivery operations without the guesswork.
                </p>
                <div className={styles.heroActions}>
                  <a className={styles.cta} href="#contact">
                    Talk to us
                  </a>
                  <a className={styles.secondary} href="#services">
                    See what we do
                  </a>
                </div>
              </div>

              <div className={styles.heroVisual} aria-hidden="true">
                <svg className={styles.routeArt} viewBox="0 0 420 420" fill="none">
                  <circle className={styles.orbit} cx="210" cy="210" r="168" />
                  <circle className={styles.orbitSoft} cx="210" cy="210" r="118" />
                  <path
                    className={styles.routePath}
                    d="M72 250C118 170 168 140 210 140c52 0 96 46 138 110"
                  />
                  <circle className={styles.node} cx="72" cy="250" r="10" />
                  <circle className={styles.node} cx="210" cy="140" r="14" />
                  <circle className={styles.nodeAccent} cx="348" cy="250" r="12" />
                  <rect className={styles.packet} x="188" y="196" width="54" height="38" rx="8" />
                  <path className={styles.packetFold} d="M188 208h54L215 224 188 208Z" />
                </svg>
              </div>
            </div>
          </div>
        </section>

        <section className={styles.section} id="services" aria-labelledby="services-heading">
          <div className={styles.shell}>
            <div className={styles.sectionHead}>
              <p className={styles.kicker}>Services</p>
              <h2 id="services-heading">What we help with</h2>
              <p className={styles.sectionIntro}>
                Practical capabilities for teams that need reliable outbound communication—not another
                black-box marketing suite.
              </p>
            </div>
            <ol className={styles.serviceList}>
              {services.map((service, index) => (
                <li className={styles.serviceItem} key={service.title}>
                  <span className={styles.serviceIndex}>{String(index + 1).padStart(2, "0")}</span>
                  <div>
                    <h3>{service.title}</h3>
                    <p>{service.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className={styles.section} id="about" aria-labelledby="about-heading">
          <div className={styles.shell}>
            <div className={styles.aboutSplit}>
              <div>
                <p className={styles.kicker}>About</p>
                <h2 id="about-heading">A real operator behind every send</h2>
              </div>
              <div className={styles.aboutCopy}>
                <p>
                  Communication &amp; Technology Network is building accountable delivery for teams
                  that care about inbox placement, consent, and clear ownership. Replace this copy
                  with your market, geography, and proof points.
                </p>
                <p>
                  A public site, working contact details, and published policies help recipients and
                  mailbox providers recognize a legitimate business behind your sending domain.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className={styles.contactSection} id="contact" aria-labelledby="contact-heading">
          <div className={styles.shell}>
            <div className={styles.contactPanel}>
              <div>
                <p className={styles.kickerLight}>Contact</p>
                <h2 id="contact-heading">Start a conversation</h2>
                <p className={styles.contactLead}>
                  Reach a monitored inbox. Update the postal line with your registered address before
                  launch.
                </p>
              </div>
              <ul className={styles.contactList}>
                <li>
                  <span>Email</span>
                  <a href="mailto:hello@ctn-sk.com">hello@ctn-sk.com</a>
                </li>
                <li>
                  <span>Postal</span>
                  <span>[Street], [City], [Country]</span>
                </li>
                <li>
                  <span>Workspace</span>
                  <Link href="/app">Sign in</Link>
                </li>
              </ul>
            </div>
          </div>
        </section>
      </main>

      <footer className={styles.footer}>
        <div className={styles.shell}>
          <div className={styles.footerRow}>
            <p>&copy; {new Date().getFullYear()} Communication &amp; Technology Network</p>
            <div className={styles.footerLinks}>
              <Link href="/privacy">Privacy</Link>
              <Link href="/terms">Terms</Link>
              <Link href="/app">Sign in</Link>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
