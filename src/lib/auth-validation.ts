export function validateEmail(value: string) {
  if (!value.trim()) {
    return "Email is required.";
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return "Enter a valid email address.";
  }
  return null;
}

export function validatePassword(value: string) {
  if (!value) {
    return "Password is required.";
  }
  if (value.length < 8) {
    return "Password must be at least 8 characters.";
  }
  return null;
}

export function validateName(value: string) {
  if (!value.trim()) {
    return "Name is required.";
  }
  if (value.trim().length < 2) {
    return "Enter your full name.";
  }
  return null;
}

export function validateConfirmPassword(password: string, confirm: string) {
  if (password !== confirm) {
    return "Passwords do not match.";
  }
  return null;
}

export function mapAuthErrorMessage(message: string) {
  const normalized = message.toLowerCase();
  if (
    normalized.includes("invalid email or password") ||
    normalized.includes("invalid_email_or_password") ||
    (normalized.includes("invalid") && normalized.includes("credential"))
  ) {
    return "Invalid email or password.";
  }
  if (normalized.includes("verify") || normalized.includes("not verified")) {
    return "Verify your email before signing in. Check your inbox for a verification link.";
  }
  return "Unable to complete the request. Please try again.";
}
