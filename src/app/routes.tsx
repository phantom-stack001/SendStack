import { Navigate } from "react-router-dom";

import { GuestRoute } from "@/components/auth/GuestRoute";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import { AuthLayout } from "@/components/layout/AuthLayout";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { PublicLayout } from "@/components/layout/PublicLayout";
import { CampaignDetailsPage } from "@/pages/app/CampaignDetailsPage";
import { CampaignsPage } from "@/pages/app/CampaignsPage";
import { CreateCampaignPage } from "@/pages/app/CreateCampaignPage";
import { EditCampaignPage } from "@/pages/app/EditCampaignPage";
import { ComposePage } from "@/pages/app/ComposePage";
import { DraftsPage } from "@/pages/app/DraftsPage";
import { DashboardPage } from "@/pages/app/DashboardPage";
import { HistoryPage } from "@/pages/app/HistoryPage";
import { InboxPage } from "@/pages/app/InboxPage";
import { MailMessagePage } from "@/pages/app/MailMessagePage";
import { SentPage } from "@/pages/app/SentPage";
import { QueueJobDetailsPage } from "@/pages/app/QueueJobDetailsPage";
import { QueuePage } from "@/pages/app/QueuePage";
import { ContactListDetailsPage } from "@/pages/app/ContactListDetailsPage";
import { ContactListsPage } from "@/pages/app/ContactListsPage";
import { ImportContactsPage } from "@/pages/app/ImportContactsPage";
import { RecipientsPage } from "@/pages/app/RecipientsPage";
import { SuppressionsPage } from "@/pages/app/SuppressionsPage";
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
      { path: "inbox/", element: <InboxPage /> },
      { path: "inbox/:uid/", element: <MailMessagePage /> },
      { path: "sent/", element: <SentPage /> },
      { path: "sent/:uid/", element: <MailMessagePage /> },
      { path: "drafts/", element: <DraftsPage /> },
      { path: "campaigns/", element: <CampaignsPage /> },
      { path: "campaigns/new/", element: <CreateCampaignPage /> },
      { path: "campaigns/:campaignId/", element: <CampaignDetailsPage /> },
      { path: "campaigns/:campaignId/edit/", element: <EditCampaignPage /> },
      { path: "recipients/", element: <RecipientsPage /> },
      { path: "recipients/lists/", element: <ContactListsPage /> },
      { path: "recipients/lists/:listId/", element: <ContactListDetailsPage /> },
      { path: "recipients/import/", element: <ImportContactsPage /> },
      { path: "recipients/suppressions/", element: <SuppressionsPage /> },
      { path: "templates/", element: <TemplatesPage /> },
      { path: "queue/", element: <QueuePage /> },
      { path: "queue/jobs/:jobId/", element: <QueueJobDetailsPage /> },
      { path: "history/", element: <HistoryPage /> },
      { path: "settings/", element: <SettingsPage /> },
    ],
  },
  {
    path: "*",
    element: <NotFoundPage />,
  },
];
