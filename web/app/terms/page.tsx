import type { Metadata } from "next";
import Link from "next/link";
import { getPublicSiteCopy } from "@/lib/site-identity";
import styles from "../legal.module.css";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: "Terms governing use of this website and related services.",
};

export default function TermsPage() {
  const site = getPublicSiteCopy();
  return (
    <div className={styles.legal}>
      <div className={styles.shell}>
        <Link className={styles.back} href="/">
          &larr; Back to home
        </Link>
        <h1>Terms of Service</h1>
        <p className={styles.updated}>Operator: CTN.</p>

        <h2>Agreement</h2>
        <p>
          By accessing this website or using services operated by CTN, you agree to these terms. If you
          are using the services on behalf of an organization, you represent that you have authority to
          bind that organization.
        </p>

        <h2>Services</h2>
        <p>
          CTN provides digital communications tools and related services. Features, availability, and
          supported volumes may change as the product evolves.
        </p>

        <h2>Acceptable use</h2>
        <p>You agree not to use the services to:</p>
        <ul>
          <li>Send unsolicited bulk messages without appropriate consent</li>
          <li>Violate applicable anti-spam, privacy, or consumer protection laws</li>
          <li>Attempt unauthorized access to systems, accounts, or data</li>
          <li>Interfere with delivery infrastructure or other customers</li>
        </ul>

        <h2>Accounts</h2>
        <p>
          You are responsible for safeguarding credentials and for activity under your account. Notify us
          promptly if you suspect unauthorized access.
        </p>

        <h2>Contact</h2>
        <p>
          {site.displayEmail ? (
            <>
              Questions about these terms:{" "}
              <a href={`mailto:${site.displayEmail}`}>{site.displayEmail}</a>.
            </>
          ) : (
            <>Questions about these terms can be directed through the workspace sign-in flow.</>
          )}
        </p>
        <p>
          This page is operator copy. Replace it with counsel-approved legal text before commercial launch.
        </p>
      </div>
    </div>
  );
}
