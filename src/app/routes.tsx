import { Navigate } from "react-router-dom";

import { AuthLayout } from "@/components/layout/AuthLayout";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { PublicLayout } from "@/components/layout/PublicLayout";
import { CampaignsPage } from "@/pages/app/CampaignsPage";
import { ComposePage } from "@/pages/app/ComposePage";
import { DashboardPage } from "@/pages/app/DashboardPage";
import { HistoryPage } from "@/pages/app/HistoryPage";
import { QueuePage } from "@/pages/app/QueuePage";
import { RecipientsPage } from "@/pages/app/RecipientsPage";
import { SettingsPage } from "@/pages/app/SettingsPage";
import { TemplatesPage } from "@/pages/app/TemplatesPage";
import { HomePage } from "@/pages/HomePage";
import { LoginPage } from "@/pages/LoginPage";
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
    path: "/login",
    element: <Navigate to="/login/" replace />,
  },
  {
    path: "/login/",
    element: <AuthLayout />,
    children: [{ index: true, element: <LoginPage /> }],
  },
  {
    path: "/app",
    element: <Navigate to="/app/" replace />,
  },
  {
    path: "/app/",
    element: <DashboardLayout />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: "compose/", element: <ComposePage /> },
      { path: "campaigns/", element: <CampaignsPage /> },
      { path: "recipients/", element: <RecipientsPage /> },
      { path: "templates/", element: <TemplatesPage /> },
      { path: "queue/", element: <QueuePage /> },
      { path: "history/", element: <HistoryPage /> },
      { path: "settings/", element: <SettingsPage /> },
    ],
  },
  {
    path: "*",
    element: <NotFoundPage />,
  },
];
