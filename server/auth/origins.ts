/** Browser origins allowed to call Better Auth. Includes www when the public site is the apex domain. */
export function authTrustedOrigins(frontendUrl: string) {
  const origins = new Set<string>([frontendUrl]);
  try {
    const url = new URL(frontendUrl);
    if (url.hostname === "ctn-sk.com") origins.add(`${url.protocol}//www.ctn-sk.com`);
    if (url.hostname === "www.ctn-sk.com") origins.add(`${url.protocol}//ctn-sk.com`);
  } catch {
    return [frontendUrl];
  }
  return [...origins];
}
