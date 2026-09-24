import type { Metadata } from "next";
import Link from "next/link";
import styles from "../legal.module.css";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: "Terms governing use of the Communication & Technology Network website and services.",
};

export default function TermsPage() {
  return (
    <div className={styles.legal}>
      <div className={styles.shell}>
        <Link className={styles.back} href="/">
          &larr; Back to home
        </Link>
        <h1>Terms of Service</h1>
        <p className={styles.updated}>Last updated: September 24, 2026. Placeholder text for legal review.</p>

        <h2>Agreement</h2>
        <p>
          By accessing ctn-sk.com or using CTN services, you agree to these terms. If you are using the
          services on behalf of an organization, you represent that you have authority to bind that
          organization.
        </p>

        <h2>Services</h2>
        <p>
          CTN provides digital communications tools and related advisory services. Features, availability,
          and supported volumes may change as the product evolves. Replace this section with your actual
          service description and any service-level commitments.
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

        <h2>Disclaimer</h2>
        <p>
          The website and services are provided on an &quot;as available&quot; basis. To the fullest extent
          permitted by law, CTN disclaims warranties of merchantability, fitness for a particular purpose,
          and non-infringement.
        </p>

        <h2>Limitation of liability</h2>
        <p>
          To the fullest extent permitted by law, CTN is not liable for indirect, incidental, special, or
          consequential damages arising from use of the website or services. Replace this with counsel-
          approved liability language before commercial launch.
        </p>

        <h2>Contact</h2>
        <p>
          Questions about these terms: <a href="mailto:hello@ctn-sk.com">hello@ctn-sk.com</a>. Postal
          address: [Street], [City], [Country].
        </p>
      </div>
    </div>
  );
}
