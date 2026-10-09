import { Navigate } from "react-router-dom";

import { GuestRoute } from "@/components/auth/GuestRoute";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import { AuthLayout } from "@/components/layout/AuthLayout";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { PublicLayout } from "@/components/layout/PublicLayout";
import { CampaignsPage } from "@/pages/app/CampaignsPage";
import { ComposePage } from "@/pages/app/ComposePage";
import { DraftsPage } from "@/pages/app/DraftsPage";
import { DashboardPage } from "@/pages/app/DashboardPage";
import { HistoryPage } from "@/pages/app/HistoryPage";
import { QueuePage } from "@/pages/app/QueuePage";
import { RecipientsPage } from "@/pages/app/RecipientsPage";
import { SettingsPage } from "@/pages/app/SettingsPage";
import { TemplatesPage } from "@/pages/app/TemplatesPage";
import { ForgotPasswordPage } from "@/pages/ForgotPasswordPage";
import { HomePage } from "@/pages/HomePage";
import { LoginPage } from "@/pages/LoginPage";
import { NotFoundPage } from "@/pages/NotFoundPage";
import { PrivacyPage } from "@/pages/PrivacyPage";
import { RegisterPage } from "@/pages/RegisterPage";
import { ResetPasswordPage } from "@/pages/ResetPasswordPage";
import { TermsPage } from "@/pages/TermsPage";
import { VerifyEmailPage } from "@/pages/VerifyEmailPage";

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
    path: "/register",
    element: <Navigate to="/register/" replace />,
  },
  {
    path: "/forgot-password",
    element: <Navigate to="/forgot-password/" replace />,
  },
  {
    path: "/reset-password",
    element: <Navigate to="/reset-password/" replace />,
  },
  {
    path: "/verify-email",
    element: <Navigate to="/verify-email/" replace />,
  },
  {
    element: (
      <GuestRoute>
        <AuthLayout />
      </GuestRoute>
    ),
    children: [
      { path: "/login/", element: <LoginPage /> },
      { path: "/register/", element: <RegisterPage /> },
      { path: "/forgot-password/", element: <ForgotPasswordPage /> },
    ],
  },
  {
    path: "/reset-password/",
    element: <AuthLayout />,
    children: [{ index: true, element: <ResetPasswordPage /> }],
  },
  {
    path: "/verify-email/",
    element: <AuthLayout />,
    children: [{ index: true, element: <VerifyEmailPage /> }],
  },
  {
    path: "/app",
    element: <Navigate to="/app/" replace />,
  },
  {
    path: "/app/",
    element: (
      <ProtectedRoute>
        <DashboardLayout />
      </ProtectedRoute>
    ),
    children: [
      { index: true, element: <DashboardPage /> },
      { path: "compose/", element: <ComposePage /> },
      { path: "compose/:draftId/", element: <ComposePage /> },
      { path: "drafts/", element: <DraftsPage /> },
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
