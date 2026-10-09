import { Navigate } from "react-router-dom";

import { PublicLayout } from "@/components/layout/PublicLayout";
import { AppPlaceholderPage } from "@/pages/AppPlaceholderPage";
import { HomePage } from "@/pages/HomePage";
import { NotFoundPage } from "@/pages/NotFoundPage";
import { PrivacyPage } from "@/pages/PrivacyPage";
import { TermsPage } from "@/pages/TermsPage";

export const appRoutes = [
  {
    path: "/",
    element: <PublicLayout />,
    children: [{ index: true, element: <HomePage /> }],
  },
  {
    path: "/privacy",
    element: <Navigate to="/privacy/" replace />,
  },
  {
    path: "/privacy/",
    element: <PrivacyPage />,
  },
  {
    path: "/terms",
    element: <Navigate to="/terms/" replace />,
  },
  {
    path: "/terms/",
    element: <TermsPage />,
  },
  {
    path: "/app",
    element: <Navigate to="/app/" replace />,
  },
  {
    path: "/app/",
    element: <AppPlaceholderPage />,
  },
  {
    path: "*",
    element: <NotFoundPage />,
  },
];
