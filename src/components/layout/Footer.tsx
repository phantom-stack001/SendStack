import { Link } from "react-router-dom";

export function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="site-footer">
      <div className="shell">
        <div className="footer-row">
          <p>&copy; {year} CTN</p>
          <div className="footer-links">
            <Link to="/privacy/">Privacy</Link>
            <Link to="/terms/">Terms</Link>
            <Link to="/app/">Sign in</Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
