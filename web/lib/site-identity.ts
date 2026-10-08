import { publicSiteIdentity } from "./sending-identity";

/** Values safe to render on public marketing/legal pages. Never invent legal facts. */
export function getPublicSiteCopy() {
  const identity = publicSiteIdentity();
  return {
    displayCompany: "CTN",
    displayEmail: identity.contactEmail,
    setupRequired: !identity.configured,
  };
}
