import { Outlet } from "react-router-dom";

import { Atmosphere } from "@/components/layout/Atmosphere";
import { Footer } from "@/components/layout/Footer";
import { Header } from "@/components/layout/Header";

export function PublicLayout() {
  return (
    <div className="page">
      <Atmosphere />
      <Header />
      <Outlet />
      <Footer />
    </div>
  );
}
