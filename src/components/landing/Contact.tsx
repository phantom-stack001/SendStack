import { Link } from "react-router-dom";

export function Contact() {
  return (
    <section className="contact-section" id="contact" aria-labelledby="contact-heading">
      <div className="shell">
        <div className="contact-panel">
          <div>
            <p className="kicker kicker-light">Contact</p>
            <h2 id="contact-heading">Start a conversation</h2>
            <p className="contact-lead">Reach a monitored inbox, or sign in to the workspace.</p>
          </div>
          <ul className="contact-list">
            <li>
              <span>Email</span>
              <a href="mailto:info@ctn-sk.com">info@ctn-sk.com</a>
            </li>
            <li>
              <span>Workspace</span>
              <Link to="/app/">Sign in</Link>
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}
