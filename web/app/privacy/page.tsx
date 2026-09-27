import type { Metadata } from "next";
import Link from "next/link";
import { getPublicSiteCopy } from "@/lib/site-identity";
import styles from "../legal.module.css";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "How this service collects, uses, and protects information.",
};

export default function PrivacyPage() {
  const site = getPublicSiteCopy();
  return (
    <div className={styles.legal}>
      <div className={styles.shell}>
        <Link className={styles.back} href="/">
          &larr; Back to home
        </Link>
        <h1>Privacy Policy</h1>
        {site.setupRequired ? (
          <>
            <p className={styles.updated}>Legal content unavailable</p>
            <p>
              A privacy policy cannot be published until SENDSTACK_COMPANY_NAME, SENDSTACK_POSTAL_ADDRESS,
              and a monitored contact email are configured. Live sending remains disabled until those
              settings are present.
            </p>
          </>
        ) : (
          <>
            <p className={styles.updated}>Operator identity loaded from application configuration.</p>

            <h2>Who we are</h2>
            <p>
              {site.displayCompany} operates this website and related services. Contact{" "}
              <a href={`mailto:${site.displayEmail}`}>{site.displayEmail}</a>. Postal address:{" "}
              {site.displayPostal}.
            </p>

            <h2>Information we collect</h2>
            <p>Depending on how you use our services, we may process:</p>
            <ul>
              <li>Contact details you provide, such as name, email address, and organization</li>
              <li>Message and campaign metadata needed to deliver and measure communications</li>
              <li>Technical logs such as IP address, browser type, and request timestamps</li>
              <li>Support correspondence and account activity for authenticated users</li>
            </ul>

            <h2>How we use information</h2>
            <p>
              We use personal information to operate our services, respond to inquiries, maintain security,
              meet legal obligations, and improve delivery reliability. We do not sell personal information.
            </p>

            <h2>Sharing</h2>
            <p>
              We may share information with processors that help us host, send, or secure services, and when
              required by law.
            </p>

            <h2>Retention</h2>
            <p>
              We retain information only as long as needed for the purposes above, including suppression and
              compliance records that must remain available to prevent unwanted future messages.
            </p>

            <h2>Your rights</h2>
            <p>
              Depending on your location, you may have rights to access, correct, delete, or restrict
              processing of your personal information. Contact{" "}
              <a href={`mailto:${site.displayEmail}`}>{site.displayEmail}</a> to make a request.
            </p>

            <h2>Contact</h2>
            <p>
              Questions about this policy: <a href={`mailto:${site.displayEmail}`}>{site.displayEmail}</a>.
              Postal address: {site.displayPostal}.
            </p>
            <p>
              This page surfaces configured operator identity only. Replace it with counsel-approved legal
              text before relying on it as a formal privacy policy.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
